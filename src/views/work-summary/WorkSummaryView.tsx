import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDownIcon, ClipboardCopyIcon, SparklesIcon } from 'lucide-react'
import WindowTitleBar from '@/components/WindowTitleBar'
import DayRangeField from '@/components/DayRangeField'
import { useOffScreen } from '@/components/on-screen-context'
import { useOnScreenToast } from '@/components/on-screen-toast'
import { Button } from '@/components/ui/button'
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuTrigger,
} from '@/components/ui/menu'
import { Toaster } from '@/components/ui/sonner'
import {
  journalDayFor,
  rangeForDays,
  rangeForPreset,
  type Clock,
  type DayRange,
  type FilterPreset,
  type Journal,
} from '@/journal/journal'
import {
  createWorkSummarySession,
  type WorkSummaryState,
} from '@/journal/work-summary-session'
import {
  buildWorkSummaryMaterial,
  workSummaryRefuses,
  type WorkSummarySelection,
} from '@/journal/work-summary'
import type { Desktop, WorkSummaryFailure } from '@/platform/desktop'
import type { AppSettings } from '@/settings/app-settings'
import { workSummarySystemPrompt } from '@/settings/settings'

/**
 * The prose a model writes from the selected period's accomplishments and the
 * current commitments, read before it is copied — and, beside Generate, the
 * Work Summary Material itself, copyable with no key, no network and no
 * waiting (see
 * docs/adr/0041-work-summary-combines-a-selected-period-with-current-commitments.md).
 * The material is read by the session; the summary itself is this view's — it
 * lives as long as the Main Window that showed it, Generate again replaces
 * it, and nothing of it is ever persisted.
 *
 * The model call is made from Rust so the API Key never enters this window —
 * see docs/adr/0026-the-api-key-lives-in-the-keychain-and-rust-makes-the-call.md.
 */
export default function WorkSummaryView({
  desktop,
  settings,
  journal,
  clock,
  onOpenSettings,
}: {
  desktop: Desktop
  settings: AppSettings
  journal: Promise<Journal>
  clock: Clock
  /**
   * The Model Access failure points at Settings; who hosts the switch is the
   * Main Window's to say, exactly as the sidebar's own items are.
   */
  onOpenSettings: () => void
}) {
  const [state, setState] = useState<WorkSummaryState>({ state: 'loading' })
  // The range this section is about, held as the view's own control state: it
  // opens on the This-week preset — Monday through today — and every preset
  // or calendar pick replaces it with a concrete inclusive range that never
  // rolls forward on its own. Owned here rather than in the session, since a
  // surface holding only its own controls keeps them in React: it survives
  // navigating to another section and back, and a closed window discards it
  // with everything else. It never touches History's Filter, and History never
  // touches it. The session only sequences the reads each choice asks for.
  const [range, setRangeState] = useState<DayRange>(() =>
    rangeForPreset('this-week', journalDayFor(clock.now())),
  )
  const [session] = useState(() =>
    createWorkSummarySession({
      journal,
      desktop,
      clock,
      range,
      onChange: setState,
    }),
  )
  // The summary on screen: what the model wrote, and which model wrote it —
  // the latter so a replacement summary can say so. Nothing else about a call
  // is kept, and nothing here is persisted.
  const [summary, setSummary] = useState<{
    markdown: string
    model: string
  } | null>(null)
  // The last copy's claim, said twice — a toast for whoever is looking, and
  // a live region for whoever is not — and naming its subject in the button's
  // own words. One claim, not one per copy: each landed copy replaces the
  // last, so there is never an older claim waiting behind it to be
  // re-announced. A material claim is held as the selection it was made
  // for, so it retires itself the moment the session pushes another: focus,
  // wake, a journal or Task change, and the midnight rollover all re-read
  // the selection, and a claim about material that re-read may have
  // replaced is not true anymore. A summary claim has no selection behind
  // it — the prose lives here — so this view is its only retire path besides
  // a failed copy: Generate replacing the prose.
  const [copyClaim, setCopyClaim] = useState<{
    subject: Subject
    selection: WorkSummarySelection | null
    count: number
  } | null>(null)
  // What the one live region says, derived, never held: '' until a copy lands
  // and gone the moment its claim is. Deriving is what retires a claim that
  // a re-read has made untrue — there is no state to forget to clear.
  const copyLive =
    copyClaim !== null &&
    (copyClaim.subject === 'summary' ||
      (state.state === 'ready' &&
        copyClaim.selection === state.selection))
      ? copyClaim
      : null
  const copySaid =
    copyLive !== null ? said(copyLive.subject, copyLive.count) : ''
  // Between a range move and its read landing, the control already reads the
  // new range while the selection on screen is still the old one. Spending or
  // copying then would spend the previous period, so both wait for the read:
  // the selection carries its own ends, which is what catches the move up.
  const stale =
    state.state === 'ready' &&
    (state.selection.from !== range.from || state.selection.to !== range.to)
  // The model being asked, while a call is in flight. Naming it is the whole
  // point: ten silent seconds read as broken without it.
  const [pending, setPending] = useState<string | null>(null)
  // Why there is no summary, when there is not — one of the few kinds the
  // call answers with, rendered as one line. A previous summary stays on
  // screen.
  const [failure, setFailure] = useState<WorkSummaryFailure | null>(null)
  // The chevron menu is portalled out of the section, so it leaves the screen
  // with this view rather than being hidden with it. Nothing is copied by
  // closing it.
  const [copyMenuOpen, setCopyMenuOpen] = useState(false)
  useOffScreen(() => setCopyMenuOpen(false))
  const says = useOnScreenToast()
  // A call is in flight, before the pending state has reached the button: a
  // double click must not spend the user's money twice.
  const inFlight = useRef(false)

  useEffect(() => {
    void session.start()

    return () => {
      session.stop()
    }
  }, [session])

  /**
   * The one move that sets both ends of the date axis: the control shows the
   * new range at once, and the session re-reads within it. Reading is not
   * generating — no model call follows a move, an opened calendar, or a
   * return from another section.
   */
  function chooseRange(next: DayRange): void {
    setRangeState(next)
    session.setRange(next)
  }

  /** Both ends of the date axis, in the one move that sets them. */
  function pick(from: string, to: string): void {
    chooseRange(rangeForDays(from, to))
  }

  /**
   * A one-shot named range. The clock is read here and only here; nothing
   * holds the Preset afterwards, so the picked range stays the source of
   * truth for what is on screen.
   */
  function applyPreset(preset: FilterPreset): void {
    chooseRange(rangeForPreset(preset, journalDayFor(clock.now())))
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    if (event.key === 'Escape') void desktop.closeWindow()
  }

  /**
   * Spends the call. What is sent is the selection on screen's own Digest
   * and Tasks, so the model hears exactly what the section showed. Only a
   * period with neither half is refused, and it is refused here, before
   * anything could be spent.
   */
  async function generate(): Promise<void> {
    if (state.state !== 'ready' || inFlight.current) return
    inFlight.current = true
    setFailure(null)

    try {
      const stored = await settings.load()
      // Nothing to name the pending state with and nothing the call could do:
      // Model Access is the three parts together and useless apart. Whether
      // they are there is settings validation, which lives in TypeScript —
      // see ADR 0026; Rust only holds the Key. Refused here, so the section
      // can say so and point at Settings.
      if (stored.modelBaseUrl.trim() === '' || stored.model.trim() === '') {
        setFailure({ kind: 'model-access' })
        return
      }

      if (workSummaryRefuses(state.selection)) return

      setPending(stored.model)
      const response = await desktop.generateWorkSummary({
        baseUrl: stored.modelBaseUrl,
        model: stored.model,
        // The user's voice, or the shipped one whenever nothing of theirs is
        // stored — `readSettings` resolves a cleared field to the default, so
        // a model is never asked under an empty system prompt — always under
        // the mandatory grounding rules, which no customization edits out.
        systemPrompt: workSummarySystemPrompt(stored.workSummaryPrompt),
        userContent: buildWorkSummaryMaterial(state.selection),
      })

      if (response.state === 'generated') {
        setSummary({ markdown: response.markdown, model: stored.model })
        // A new summary retires the copy claim with the prose it was about —
        // and only that one: a material claim outlives the prose.
        setCopyClaim((claim) =>
          claim !== null && claim.subject === 'summary' ? null : claim,
        )
      } else {
        setFailure(response.failure)
      }
    } catch (error) {
      // The call's own failures arrive as `Failed` answers; this catch is
      // this window's side only — a settings file that would not open, a
      // journal read that failed — so it says so rather than blaming the
      // network.
      console.error('could not ask for a Work Summary', error)
      setFailure({ kind: 'local' })
    } finally {
      inFlight.current = false
      setPending(null)
    }
  }

  /**
   * One copy, whichever of the two it is: the Markdown onto the clipboard and
   * the toast that says how it went. Answers whether it landed, so the caller
   * can keep or retire the claim its own live region is rendered from — the
   * line beside a button may never say the opposite of the toast.
   */
  async function putOnClipboard(
    subject: Subject,
    read: () => Promise<string>,
  ): Promise<boolean> {
    try {
      await desktop.copyToClipboard(await read())
      says.success(landed(subject))
      return true
    } catch (error) {
      console.error(`could not copy ${subject}`, error)
      says.failure(failed(subject))
      return false
    }
  }

  /**
   * Claims the landed copy, replacing whatever the last one said. A repeat
   * of the same live copy counts up, so its region says something new — a
   * region announces on change, and identical text is silence. Counted from
   * the claim as it stands rather than as this click first saw it, so two
   * copies that overlap still count as two. A copy that fails retires the
   * earlier claim rather than saying the opposite.
   */
  function claimCopy(
    subject: Subject,
    selection: WorkSummarySelection | null,
    copied: boolean,
  ): void {
    setCopyClaim((claim) =>
      copied
        ? {
            subject,
            selection,
            count:
              claim !== null &&
              claim.subject === subject &&
              (subject === 'summary' || claim.selection === selection)
                ? claim.count + 1
                : 1,
          }
        : null,
    )
  }

  /** The summary onto the clipboard, and a confirmation naming it once there. */
  async function copySummary(): Promise<void> {
    if (summary === null) return
    const { markdown } = summary

    claimCopy(
      'summary',
      null,
      await putOnClipboard('summary', async () => markdown),
    )
  }

  /**
   * The selected period's material as Markdown onto the clipboard, and a
   * confirmation naming it once there. No Model Access is read and no call is
   * made: the Markdown is built from the selection already on screen, so this
   * works with no key, no network and no waiting — and stays exactly as live
   * after a summary exists, because the lossless rendering is there precisely
   * when the prose turns out to be wrong.
   */
  async function copyMaterial(): Promise<void> {
    if (state.state !== 'ready') return
    const { selection } = state

    // Claimed for this very selection: any re-read retires it by
    // construction, since a new one is a new object.
    claimCopy(
      'material',
      selection,
      await putOnClipboard('material', async () =>
        buildWorkSummaryMaterial(selection),
      ),
    )
  }

  return (
    <div
      tabIndex={-1}
      onKeyDown={onKeyDown}
      data-section="work-summary"
      className="relative flex h-screen flex-col bg-background outline-none"
    >
      <WindowTitleBar />

      <header className="shrink-0 px-6 py-4">
        <h1 className="type-section">Work Summary</h1>
        <p className="pt-1 type-meta text-muted-foreground">
          Prose a model writes from the selected period&apos;s accomplishments
          and your current commitments, for you to read and then use — or the
          period&apos;s material as Markdown, with no key, no network and no
          waiting.
        </p>
      </header>

      <main className="flex-1 overflow-y-auto px-6 pb-5">
        <div className="flex max-w-xl flex-col gap-6">
          {/*
            Above the read state, not inside it: a range that would not read
            is still a range the reader can leave, and a window still reading
            is still one whose days can be moved.
          */}
          <div>
            <DayRangeField
              range={range}
              onPick={pick}
              onChoosePreset={applyPreset}
            />
          </div>

          {state.state === 'loading' && (
            <p role="status" className="type-meta text-muted-foreground">
              Reading the journal…
            </p>
          )}

          {state.state === 'unreadable' && (
            <p role="alert" className="type-meta text-destructive">
              The selected period could not be read.
            </p>
          )}

          {state.state === 'ready' && (
            <>
              {/*
                Said while a moved range's read is still catching up: the
                counts below are still the previous range's, and the greyed
                Generate beside them waits for the same read.
              */}
              {stale && (
                <p role="status" className="type-meta text-muted-foreground">
                  Reading the journal…
                </p>
              )}
              <MaterialSummary selection={state.selection} />

              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  onClick={() => void generate()}
                  disabled={
                    pending !== null ||
                    stale ||
                    workSummaryRefuses(state.selection)
                  }
                >
                  <SparklesIcon data-icon="inline-start" />
                  Generate
                </Button>

              {/*
                The one copy control: the selected period's notes and tasks as
                Markdown — what the user pastes when there is no Model Access,
                the endpoint is down, or the prose came back wrong — and, once
                generated, the summary itself in the menu. A split button
                rather than two: copying is a default with an escape hatch
                rather than a decision every time. The primary is always the
                material: the copy that works with no key, no network and no
                waiting, so the button never changes identity under the
                reader. Refused under the same gate as Generate, which is a
                period with nothing in either half, not anything about the
                model.
              */}
              <CopySplit
                summaryExists={summary !== null}
                materialRefused={stale || workSummaryRefuses(state.selection)}
                open={copyMenuOpen}
                onOpenChange={setCopyMenuOpen}
                onCopyMaterial={() => void copyMaterial()}
                onCopySummary={() => void copySummary()}
              />

              {/*
                The copy confirmation, naming whichever subject landed — never
                the other. A repeat says its number: a region announces on
                change, so identical text would leave the second copy
                unannounced.
              */}
              <span
                role="status"
                aria-live="polite"
                className="type-meta text-muted-foreground"
              >
                {copySaid}
              </span>

              {pending !== null && (
                <p role="status" className="type-meta text-muted-foreground">
                  Writing with {pending}…
                </p>
              )}
            </div>
            </>
          )}

          {/*
            Outside the read state, exactly as the date control is: paid-for
            prose and the reason a call failed outlive whatever the current
            read says — a range that would not read must not take them with
            it. (Whether the prose still matches the range on screen is #240's
            outdated marking to say; never silent loss.)
          */}
          {failure !== null && (
            <FailureLine failure={failure} onOpenSettings={onOpenSettings} />
          )}

          {summary !== null && (
            <section className="flex flex-col gap-2">
              <h2 className="type-section">Written by {summary.model}</h2>
              <div className="rounded-md border border-border bg-card px-4 py-3 whitespace-pre-wrap type-body">
                {summary.markdown}
              </div>
            </section>
          )}
        </div>
      </main>

      <Toaster />
    </div>
  )
}

/**
 * What the section is about to send: the counts for both halves — the range
 * itself reads on the date control above, so it is not repeated here. Always
 * on screen, so the user sees what a call would spend before spending it —
 * and a period with neither half says so here, which is what makes the
 * Generate button's refusal read as an explanation rather than a mystery.
 *
 * Task Occurrences completed in the range are counted on their own line
 * rather than folded into Completed Tasks: a Task Occurrence is not a
 * Completed Task and never joins them, so two record types that behave
 * differently are two counts.
 */
function MaterialSummary({ selection }: { selection: WorkSummarySelection }) {
  return (
    <div className="flex flex-col gap-6">
      <section
        aria-labelledby="work-summary-accomplishments-heading"
        className="flex flex-col gap-2"
      >
        <h2 id="work-summary-accomplishments-heading" className="type-section">
          Selected period
        </h2>
        <p className="type-meta text-muted-foreground">
          {count(selection.digest.noteCount, 'Note')}
        </p>
        <p className="type-meta text-muted-foreground">
          {count(selection.completedTasks.length, 'Completed Task')}
        </p>
        <p className="type-meta text-muted-foreground">
          {count(selection.completedOccurrences.length, 'recurring completion')}
        </p>
      </section>

      <section
        aria-labelledby="work-summary-open-heading"
        className="flex flex-col gap-2"
      >
        <h2 id="work-summary-open-heading" className="type-section">
          Currently open
        </h2>
        <p className="type-meta text-muted-foreground">
          {count(selection.openTasks.length, 'Open Task')}
        </p>
      </section>

      {workSummaryRefuses(selection) && (
        <p className="type-section text-muted-foreground">Nothing to say yet.</p>
      )}
    </div>
  )
}

/**
 * Why there is no summary, as one line — the few kinds the call answers with,
 * each with its own words. The two whose fix lives in Settings carry the
 * way there — a missing half of Model Access, and a Base URL the API Key
 * must not travel over; the rest name what happened and leave the retry to
 * the user, who is the only one who may spend the call again.
 */
function FailureLine({
  failure,
  onOpenSettings,
}: {
  failure: WorkSummaryFailure
  onOpenSettings: () => void
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <p role="alert" className="type-meta text-destructive">
        {describeFailure(failure)}
      </p>
      {(failure.kind === 'model-access' || failure.kind === 'https-required') && (
        <Button variant="outline" size="sm" onClick={onOpenSettings}>
          Open Settings
        </Button>
      )}
    </div>
  )
}

/**
 * One of the few lines: what happened, in the fewest words that explain it.
 * No failure is retried automatically — a model call is billable — so nothing
 * here says the app will try again; the user deciding to click Generate is
 * the retry, and the one who may spend the call.
 */
function describeFailure(failure: WorkSummaryFailure): string {
  switch (failure.kind) {
    case 'local':
      return 'Could not ask for a Work Summary. Try again.'
    case 'model-access':
      return 'Model Access is not configured. Open Settings to add a Base URL, a Model and an API Key.'
    case 'https-required':
      return 'The Base URL must be https to send the API Key. Open Settings to change it.'
    case 'keychain':
      return 'macOS is not letting Work Journal reach the API Key in your Keychain. Unlock your login keychain and try again.'
    case 'offline':
      return 'The model could not be reached. Check your internet connection and try again.'
    case 'unauthorized':
      return 'The model refused the API Key (401). Check the Key in Settings and try again.'
    case 'rate-limited':
      return 'The model is rate limited (429). Wait a moment and try again.'
    case 'timeout':
      return 'The model took longer than 60 seconds to answer. Try again.'
    case 'other':
      return `The model answered with an error (${failure.status}). Try again.`
    case 'empty-response':
      return 'The model returned nothing. Try again.'
  }
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`
}

/**
 * The section's one copy control: a split button whose primary is always the
 * selected period's material — the copy that works with no key, no network
 * and no waiting — and whose chevron menu holds the summary once one exists.
 * One visible button rather than two copy buttons on one screen, and one
 * whose identity never changes under the reader.
 */
function CopySplit({
  summaryExists,
  materialRefused,
  open,
  onOpenChange,
  onCopyMaterial,
  onCopySummary,
}: {
  summaryExists: boolean
  materialRefused: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onCopyMaterial: () => void
  onCopySummary: () => void
}) {
  const summaryRuleId = useId()
  return (
    <div className="flex shrink-0 items-center">
      <Button
        variant="outline"
        size="sm"
        className="rounded-r-none border-r-0"
        onClick={onCopyMaterial}
        disabled={materialRefused}
      >
        <ClipboardCopyIcon data-icon="inline-start" />
        Copy material
      </Button>
      {/*
        A real menu rather than a popover with buttons: arrow keys,
        typeahead and focus management come with it. The summary row carries
        its reason as a group hint beneath the item while there is no summary
        to copy, so the item's own name stays exactly what it does.
      */}
      <Menu open={open} onOpenChange={onOpenChange}>
        <MenuTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              aria-label="More copy options"
              className="rounded-l-none px-1.5"
            />
          }
        >
          <ChevronDownIcon data-icon="inline-start" />
        </MenuTrigger>
        <MenuContent align="end" className="w-64">
          <MenuGroup className="flex flex-col gap-1">
            <MenuItem
              onClick={() => onCopySummary()}
              disabled={!summaryExists}
              aria-describedby={!summaryExists ? summaryRuleId : undefined}
            >
              <ClipboardCopyIcon data-icon="inline-start" />
              Copy summary
            </MenuItem>
            {!summaryExists && (
              <p
                id={summaryRuleId}
                className="px-2 pb-1 type-micro text-muted-foreground"
              >
                Generate a summary first.
              </p>
            )}
          </MenuGroup>
        </MenuContent>
      </Menu>
    </div>
  )
}

/**
 * Which of the two artifacts a copy is about, in the buttons' own words.
 * There are exactly two, and every sentence either of them says is built
 * from this one subject, so the toast and the live region beside the button
 * cannot drift apart.
 */
type Subject = 'summary' | 'material'

/**
 * What the material copy is: the button says "material" for brevity, but the
 * confirmation says what that word covers — "material" alone reads as
 * nothing the user would recognize.
 */
const MATERIAL = 'the selected notes and tasks' as const

/** The one sentence a landed copy says, wherever it says it. */
function landed(subject: Subject): string {
  return subject === 'summary'
    ? 'Copied summary to the clipboard.'
    : `Copied ${MATERIAL} to the clipboard.`
}

/** The one sentence a failed copy says, wherever it says it. */
function failed(subject: Subject): string {
  return subject === 'summary'
    ? 'Could not copy summary.'
    : `Could not copy ${MATERIAL}.`
}

/**
 * What a copy's live region says. The same words twice are not said twice —
 * a region announces on change, so an identical repeat would be silence,
 * exactly when the reader most needs telling — so a repeat carries its own
 * number. The first copy reads plainly; the second says it is the second.
 */
function said(subject: Subject, count: number): string {
  return count === 1 ? landed(subject) : `${landed(subject)} (${count})`
}
