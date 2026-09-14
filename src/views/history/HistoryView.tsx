import { useEffect, useId, useRef, useState } from 'react'
import {
  CalendarIcon,
  CalendarRangeIcon,
  ChevronDownIcon,
  ClipboardCopyIcon,
  HashIcon,
  NotebookPenIcon,
  PencilIcon,
  SearchIcon,
  Trash2Icon,
  TriangleAlertIcon,
  type LucideIcon,
} from 'lucide-react'
import { Combobox as ComboboxPrimitive } from '@base-ui/react/combobox'
import ProjectChip from '@/components/ProjectChip'
import DayRangeField from '@/components/DayRangeField'
import SearchField from '@/components/SearchField'
import WindowTitleBar from '@/components/WindowTitleBar'
import { useOffScreen } from '@/components/on-screen-context'
import { useOnScreenToast } from '@/components/on-screen-toast'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Input } from '@/components/ui/input'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@/components/ui/combobox'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuTrigger,
} from '@/components/ui/menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Kbd, KbdGroup } from '@/components/ui/kbd'
import { Toaster } from '@/components/ui/sonner'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  createHistorySession,
  openingSnapshot,
  type HistorySnapshot,
} from '@/journal/history-session'
import { REVIEW_PROJECT_RULE } from '@/journal/review'
import {
  constraintOf,
  dayAsDate,
  decideKeystroke,
  formatJournalDay,
  formatProject,
  formatTimeOfDay,
  isProjectName,
  journalDayFor,
  projectChoice,
  projectConstraintFor,
  projectName,
  rangeForDays,
  rangeForJournalDay,
  rangeForPreset,
  type Filter,
  type FilterPreset,
  type Journal,
  type ProjectConstraint,
  type Note,
} from '@/journal/journal'
import type { Desktop } from '@/platform/desktop'
import { keysOfHotkey, type HotkeyStatuses } from '@/settings/hotkey'

/**
 * Reading back what you did. Every rule of reading back — where the Filter
 * opens, what an arrival does to it, what a correction re-reads — belongs to
 * the History session; this view renders its snapshot and calls its verbs.
 *
 * The window behind the view is created on demand and genuinely closed on
 * dismiss, so the session is built once per window and needs no reset — see
 * docs/adr/0002-capture-window-is-hidden-never-closed.md.
 */
export default function HistoryView({
  desktop,
  journal,
  reveal = null,
}: {
  desktop: Desktop
  journal: Promise<Journal>
  /**
   * A practice Note to reveal: its Journal Day, shown with Project = Any
   * whatever the Filter said before. A new object per request, so asking for
   * the same day twice still lands.
   */
  reveal?: { day: string } | null
}) {
  const [snapshot, setSnapshot] = useState<HistorySnapshot>(openingSnapshot)
  const [session] = useState(() =>
    createHistorySession({
      journal,
      clipboard: (text) => desktop.copyToClipboard(text),
      // The tray count is kept by another window entirely, and a correction
      // here is the only way it learns that today holds one Note fewer.
      announceChange: () => void desktop.announceJournalChanged(),
      onChange: setSnapshot,
    }),
  )
  const {
    filter,
    projects,
    history,
    term,
    searching,
    nudgedDay,
    noteCount,
    confirmation,
    problem,
  } = snapshot

  // The one Note being reworded, and the one waiting on a confirmed deletion.
  // Both are single, and both are about this screen rather than the session: a
  // list only ever has one correction in progress.
  const [editing, setEditing] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Note | null>(null)
  // Only the empty state reads this, and only to teach the fastest way in.
  // Null until the OS has been asked, and after a question it refused.
  const [hotkeys, setHotkeys] = useState<HotkeyStatuses | null>(null)
  // A copy the reader asked for and has not been told about yet. What makes a
  // toast is that a copy was asked for, not that the confirmation reads
  // differently: copying the same Filter twice says the same words both times,
  // and both times the reader asked to be told.
  const copying = useRef(false)
  const says = useOnScreenToast()
  const page = useRef<HTMLDivElement>(null)
  // The one Project being renamed, and the one waiting on a confirmed rename.
  // Like `deleting`, a single portalled question about this screen rather than
  // the session — the session does not know a dialog was ever open.
  const [renaming, setRenaming] = useState<string | null>(null)

  // A confirmation is portalled to the end of the document, so hiding this
  // view leaves it standing over whatever is showing instead — see
  // docs/adr/0024-a-view-is-told-whether-it-is-on-screen.md. It goes when this
  // view does, and going is dismissing: a question the reader was taken away
  // from is not one they still have open, and the Note is untouched. A reword
  // in progress is not this — it is drawn in the list itself, and what has
  // been typed into it survives the trip. A copy the reader walked away from
  // is the same: they are no longer waiting to be told, and the confirmation
  // they have already been given goes with the view — see `on-screen-toast`.
  useOffScreen(() => {
    setDeleting(null)
    setRenaming(null)
    copying.current = false
  })

  useEffect(() => {
    // A Dock-less app does not reliably hand focus to a new window, and Escape
    // has to reach this view for the window to close.
    page.current?.focus()

    void session.open()
  }, [session])

  useEffect(() => {
    // A practice Note to reveal, asked from Onboarding: its Journal Day with
    // Project = Any, whatever the Filter said before manual replay left it.
    // One call through the session boundary, so both axes move atomically and
    // a day the reader picks mid-read still wins.
    if (reveal === null) return
    void session.reveal(reveal.day)
  }, [reveal, session])

  useEffect(() => {
    // Every session update is a new snapshot, so a copy is heard even when it
    // confirms in exactly the words the last one did.
    if (!copying.current || snapshot.confirmation === null) return

    copying.current = false
    says.say(snapshot.confirmation)
  }, [snapshot, says])

  useEffect(() => {
    desktop.hotkeyStatus().then(setHotkeys, (error: unknown) => {
      // The Hotkey is not what this window is for: a status that cannot be
      // read leaves the empty state on the Tray Menu wording rather than
      // saying anything about it.
      console.error('could not read the hotkeys', error)
    })
  }, [desktop])

  useEffect(() => {
    const subscription = desktop.onNoteCaptured((journalDay) => {
      void session.noteArrived(journalDay)
    })

    return () => {
      void subscription.then((stop) => stop())
    }
  }, [desktop, session])

  useEffect(() => {
    // The other way the list stops being true: a sweep imported today's
    // meetings, which never nudges. This window's own corrections are heard
    // here too, and cost one extra read that finds the list exactly as it left
    // it — cheaper than a second event that means almost the same thing.
    const subscription = desktop.onJournalChanged(() => {
      void session.refresh()
    })

    return () => {
      void subscription.then((stop) => stop())
    }
  }, [desktop, session])

  // Escape belongs to whatever has taken the screen over: a correction first,
  // then an open Filter popup, then a Search, and the window when none has.
  // Dismissing the window closes it — History is not kept resident.
  function onKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (
      event.key !== 'Escape' ||
      editing !== null ||
      deleting !== null ||
      renaming !== null
    ) {
      return
    }
    // A popup — the day picker, the Project picker — is portalled out of the
    // page and closes itself on Escape, but the keystroke still arrives here
    // through the React tree. It belongs to whatever it was typed into.
    if (!page.current?.contains(event.target as Node)) return

    if (searching) {
      // Clears the results and empties the field; the window stays open.
      void session.search('')
      return
    }

    void desktop.closeWindow()
  }

  function commitEdit(note: Note, body: string) {
    setEditing(null)
    void session.editBody(note.id, body)
  }

  function refile(note: Note, journalDay: string) {
    void session.refile(note.id, journalDay)
  }

  function editProject(note: Note, project: string | null) {
    void session.editProject(note.id, project)
  }

  /** The one irreversible operation, and the only one that is confirmed. */
  function confirmDelete(note: Note) {
    setDeleting(null)
    void session.delete(note.id)
  }

  /** Filing, not wording — but still one decision about the whole stream. */
  function confirmRename(from: string, to: string) {
    setRenaming(null)
    void session.renameProject(from, to)
  }

  /** Both ends of the day axis, in the one move that sets them. */
  function pick(from: string, to: string) {
    void session.moveTo(rangeForDays(from, to))
  }

  /**
   * A one-shot named range. The clock is read here and only here; nothing
   * holds the Preset afterwards, so the picked range stays the source of
   * truth for what is on screen.
   */
  function applyPreset(preset: FilterPreset) {
    void session.moveTo(rangeForPreset(preset, journalDayFor(new Date())))
  }

  /** The Digest onto the clipboard, and a toast once it is there. */
  function copyDigest() {
    copying.current = true
    session.copy()
  }

  /** Review Material onto the clipboard, and a toast once it is there. */
  function copyReviewMaterial() {
    copying.current = true
    void session.copyReviewMaterial()
  }

  return (
    // Every tooltip on the page shares one provider, so a reader moving along
    // a row's actions is told what the next one is without waiting again.
    <TooltipProvider delay={400}>
      <div
        ref={page}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex h-screen flex-col bg-background outline-none"
      >
        <WindowTitleBar />

        {/*
          The header wraps rather than clips: the Filter's controls, the Search
          field and the Digest are each the whole of something the reader needs,
          so a narrow window gets a second row instead of a row with its end cut
          off. Nothing up here is optional enough to hide.
        */}
        {filter !== null && (
          <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-6 py-4 type-meta text-muted-foreground">
            <DayRangeField
              range={filter}
              onPick={pick}
              onChoosePreset={applyPreset}
            />
            <ProjectConstraintField
              constraint={constraintOf(filter)}
              projects={projects}
              onNarrow={(constraint) => void session.narrowTo(constraint)}
              onRename={setRenaming}
            />
            <SearchField
              term={term}
              onType={(typed) => void session.search(typed)}
            />
            {/*
              Gone while a Search is showing: the Digest is bound to the Filter,
              and a button that copies something not on screen is how the wrong
              month reaches a standup thread.
            */}
            {!searching && (
              <Copies
                filter={filter}
                confirmation={confirmation}
                noteCount={noteCount}
                onCopyDigest={copyDigest}
                onCopyReviewMaterial={copyReviewMaterial}
              />
            )}
          </header>
        )}

        {problem !== null && <Problem>{problem}</Problem>}

        <main className="flex-1 overflow-y-auto px-6 pb-5">
          {history.state === 'empty' && <NoNotesYet hotkeys={hotkeys} />}
          {history.state === 'unreadable' && (
            <EmptyState
              icon={TriangleAlertIcon}
              heading="The journal could not be read."
            />
          )}
          {history.state === 'notes' && history.days.length === 0 && (
            <EmptyState
              icon={CalendarRangeIcon}
              heading={nothingHere(filter)}
            />
          )}
          {history.state === 'results' && history.notes.length === 0 && (
            <EmptyState
              icon={SearchIcon}
              heading={`No Notes say “${history.term}”.`}
            />
          )}
          {history.state === 'results' && history.notes.length > 0 && (
            <ol className="flex flex-col gap-1">
              {history.notes.map((note) => (
                <ResultLine
                  key={note.id}
                  note={note}
                  onShow={() =>
                    void session.moveTo(rangeForJournalDay(note.journalDay))
                  }
                />
              ))}
            </ol>
          )}
          {history.state === 'notes' &&
            history.days.map((day) => (
              <section key={day.journalDay} className="mb-6 last:mb-0">
                {/*
                  Pulled out to the window's edges and stuck to the top of the
                  scroller, so a long day scrolls under its own heading rather
                  than out from under it. The hairline is what keeps a heading
                  that has caught up with the list above it legible.
                */}
                <h2 className="sticky top-0 z-10 -mx-6 mb-3 border-b border-border bg-background px-6 py-2 type-section text-muted-foreground">
                  {formatJournalDay(day.journalDay)}
                </h2>
                <ol className="flex flex-col gap-1">
                  {day.notes.map((note) => (
                    <NoteLine
                      key={note.id}
                      note={note}
                      journal={journal}
                      editing={editing === note.id}
                      onEdit={() => setEditing(note.id)}
                      onCommit={(body) => commitEdit(note, body)}
                      onAbandon={() => setEditing(null)}
                      onRefile={(journalDay) => refile(note, journalDay)}
                      onEditProject={(project) => editProject(note, project)}
                      onDelete={() => setDeleting(note)}
                    />
                  ))}
                </ol>
              </section>
            ))}
        </main>

        {nudgedDay !== null && (
          <Nudge
            journalDay={nudgedDay}
            onShow={() => void session.moveTo(rangeForJournalDay(nudgedDay))}
            onDismiss={() => session.dismissNudge()}
          />
        )}

        <ConfirmDelete
          note={deleting}
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(null)}
        />

        <RenameProject
          source={renaming}
          projects={projects}
          onConfirm={confirmRename}
          onCancel={() => setRenaming(null)}
        />

        {/* Where a copy says what it did. Nothing else toasts. */}
        <Toaster />
      </div>
    </TooltipProvider>
  )
}

/**
 * An empty list, and which axis emptied it. The day range is what a reader
 * moved last unless they have also narrowed to a Project, and a message
 * naming one axis reads as though the other were not there.
 */
function nothingHere(filter: Filter | null): string {
  if (filter === null) return 'No Notes in these days.'

  const constraint = constraintOf(filter)
  switch (constraint.kind) {
    case 'any':
      return 'No Notes in these days.'
    case 'unfiled':
      return 'No Unfiled Notes in these days.'
    case 'named':
      return `No Notes under #${constraint.name} in these days.`
  }
}

/**
 * A correction the record refused. Above the list rather than inside it: the
 * Note it is about may have moved or may not be on screen at all, and a reader
 * with no devtools to hand has nowhere else to learn that nothing happened.
 */
function Problem({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="shrink-0 px-6 pb-3 type-meta text-destructive">
      {children}
    </p>
  )
}

/**
 * One Note as it reads now, and the ways to correct it: a leading gutter for
 * the Captured At, the Body with its filing, and a trailing gutter for the
 * three corrections.
 *
 * Both gutters are permanent. The trailing one holds its width whether or not
 * anything is showing in it, so the Body is laid out once and never rewraps
 * under the cursor — which is what an overlay reconstructing the row's own
 * background used to be for.
 *
 * The actions are up on the row's hover, and otherwise only on their own
 * focus: what appears at the end of a line has to be something the reader
 * asked for, and tabbing to the Body is asking to read it. Invisible is not
 * the same as gone, though — they stay focusable, and untouchable until they
 * are visible, because a control nobody can see is not one to click by
 * accident.
 */
function NoteLine({
  note,
  journal,
  editing,
  onEdit,
  onCommit,
  onAbandon,
  onRefile,
  onEditProject,
  onDelete,
}: {
  note: Note
  journal: Promise<Journal>
  editing: boolean
  onEdit: () => void
  onCommit: (body: string) => void
  onAbandon: () => void
  onRefile: (journalDay: string) => void
  onEditProject: (project: string | null) => void
  onDelete: () => void
}) {
  return (
    <li className="group flex items-start gap-3 rounded-md py-1.5 pl-2 pr-1 type-body hover:bg-muted/40 focus-within:bg-muted/40">
      <time
        dateTime={note.capturedAt}
        className="w-16 shrink-0 pt-1 tabular-nums type-meta text-muted-foreground"
      >
        {formatTimeOfDay(note.capturedAt)}
      </time>

      {editing ? (
        <EditBody note={note} onCommit={onCommit} onAbandon={onAbandon} />
      ) : (
        // A button, and deliberately one: pressing the Body starts a reword,
        // which is an action and not a place to put a cursor. What it is not
        // is a control — it is styled as the line the reader is reading, and
        // the caret is the only thing that says it can be typed into.
        <button
          type="button"
          onClick={onEdit}
          className={`min-w-0 flex-1 cursor-text rounded-sm py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/30 ${
            // A Note nobody typed reads quieter than one they did, so a
            // scan-and-delete pass down the day is fast. No icon and no
            // label: the weight is the whole of the difference, and a Digest
            // shows none of it — see docs/adr/0010-notes-have-two-origins.md.
            note.origin === 'import' ? 'text-muted-foreground' : ''
          }`}
        >
          <ProjectChip project={note.project} className="mr-2" />
          {note.body}
          {note.editedAt !== null && <EditedMark />}
        </button>
      )}

      {/*
        Up on the row's hover, on these controls' own focus, and for as long as
        one of them has a popup open: a calendar is portalled away from the
        row, so the button the reader just pressed would otherwise fade out
        from under the popup it opened.
      */}
      <div className="flex shrink-0 items-center gap-0.5 pointer-events-none opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100 has-aria-expanded:pointer-events-auto has-aria-expanded:opacity-100">
        <DayField
          value={note.journalDay}
          onPick={onRefile}
          label={`File “${note.body}” under another day`}
        />
        <ProjectField
          value={note.project}
          journal={journal}
          onPick={onEditProject}
          label={`File “${note.body}” under a Project`}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onDelete}
                aria-label={`Delete “${note.body}”`}
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2Icon />
              </Button>
            }
          />
          <TooltipContent>Delete</TooltipContent>
        </Tooltip>
      </div>
    </li>
  )
}

/**
 * Provenance for the reader: the wording is not necessarily the one that was
 * typed at Captured At. A mark rather than the word, because it is said on
 * every corrected Note and the Note is what the line is for — but it is still
 * said, to whoever is listening rather than looking, and it still explains
 * itself on hover.
 */
function EditedMark() {
  return (
    <span
      title="Changed since it was captured"
      className="ml-2 inline-flex items-center align-middle"
    >
      <span className="sr-only">edited</span>
      <span
        aria-hidden="true"
        className="size-1 rounded-full bg-muted-foreground/70"
      />
    </span>
  )
}


/**
 * One Search result: what the Note says, and the day it is filed under. The
 * whole row is the way in, because answering a result has exactly one meaning
 * — take History to that day in full. The Notes are not correctable here: a
 * result is a signpost to a day, and the day is where the list lives.
 */
function ResultLine({ note, onShow }: { note: Note; onShow: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onShow}
        className="flex w-full gap-3 rounded-md px-2 py-1 text-left type-body outline-none hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/30"
      >
        <ProjectChip project={note.project} />
        <span className="flex-1">{note.body}</span>
        <span className="shrink-0 pt-px type-meta text-muted-foreground">
          {formatJournalDay(note.journalDay)}
        </span>
      </button>
    </li>
  )
}

/**
 * A Body being reworded. Enter commits and Escape abandons — the same bargain
 * a Capture makes, so correcting a Note is the interaction that wrote it.
 */
function EditBody({
  note,
  onCommit,
  onAbandon,
}: {
  note: Note
  onCommit: (body: string) => void
  onAbandon: () => void
}) {
  const [body, setBody] = useState(note.body)

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    const decision = decideKeystroke(event.key, body)
    if (decision === 'ignore') return

    // Escape here abandons the edit; the window stays open.
    event.stopPropagation()
    if (decision === 'commit') {
      onCommit(body)
    } else {
      onAbandon()
    }
  }

  return (
    <input
      autoFocus
      value={body}
      onChange={(event) => setBody(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onAbandon}
      aria-label="Body"
      className="flex-1 rounded-md border border-border bg-transparent px-1.5 py-0.5 type-body text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
    />
  )
}

/**
 * The guard on the one irreversible operation. There is no trash and no undo,
 * so the confirmation says plainly that this is permanent.
 */
function ConfirmDelete({
  note,
  onConfirm,
  onCancel,
}: {
  note: Note | null
  onConfirm: (note: Note) => void
  onCancel: () => void
}) {
  return (
    <AlertDialog
      open={note !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this Note?</AlertDialogTitle>
          <AlertDialogDescription>
            “{note?.body}” will be gone for good. There is no trash and no undo.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => note !== null && onConfirm(note)}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * One whole Project into another. A confirmation rather than a text field on
 * the row — the move is journal-wide, and saying which stream is being moved
 * is the point of the surface.
 *
 * The question exists only while there is one: closed, nothing of it is kept —
 * not what was typed, not which stream it was about — so a cancelled rename
 * and a dismissed one leave exactly what they found.
 */
function RenameProject({
  source,
  projects,
  onConfirm,
  onCancel,
}: {
  /** The Project being renamed, or null while none is. */
  source: string | null
  projects: string[]
  onConfirm: (from: string, to: string) => void
  onCancel: () => void
}) {
  return (
    <AlertDialog
      open={source !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      {source !== null && (
        <RenameProjectDialog
          source={source}
          projects={projects}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      )}
    </AlertDialog>
  )
}

/**
 * The body of the rename question. The button names what will happen: `Rename`
 * while the target is a new stream, `Merge` once it is one the journal already
 * has, because the two read very differently after the fact.
 */
function RenameProjectDialog({
  source,
  projects,
  onConfirm,
  onCancel,
}: {
  source: string
  projects: string[]
  onConfirm: (from: string, to: string) => void
  onCancel: () => void
}) {
  const [typed, setTyped] = useState('')

  // The one valid spelling of the target, or nothing to confirm. What the
  // record refuses comes back in the record's own words — nothing typed is
  // not a refusal, only nothing to confirm yet.
  let target: string | null = null
  let problem: string | null = null
  if (typed.trim() !== '') {
    try {
      target = projectName(typed)
    } catch (error) {
      problem = (error as Error).message
    }
  }

  // The source is in `projects` too — it has Notes, which is why it is being
  // renamed — so spelling it back is not a merge but the same name, however
  // it is cased. Confirming it would close the question and do nothing at
  // all: the button says Rename, says it cannot be pressed, and the dialog
  // says why, rather than claiming two streams are about to become one.
  const same = target !== null && target === source
  const merging = target !== null && !same && projects.includes(target)

  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Rename {formatProject(source)}?</AlertDialogTitle>
        <AlertDialogDescription>
          Every Note filed under it moves, in this window and out of it.
          {merging && target !== null
            ? ` Notes already under ${formatProject(target)} stay where they are: the two streams become one.`
            : ''}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <label className="grid gap-1.5">
        <span className="type-meta text-muted-foreground">New Project name</span>
        <Input
          autoFocus
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          aria-label="New Project name"
          aria-invalid={problem !== null}
          placeholder={formatProject(source)}
        />
      </label>
      {(problem !== null || same) && (
        <p role="alert" className="type-meta text-destructive">
          {problem ?? 'That is already its name.'}
        </p>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
        <AlertDialogAction
          disabled={target === null || same}
          onClick={() => {
            if (target !== null) onConfirm(source, target)
          }}
        >
          {merging ? 'Merge' : 'Rename'}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  )
}

/**
 * The Filter's other axis: every Project, none of them, or one. Sticky, unlike
 * a Preset — it is the narrow the reader is reading under, so it stays until
 * they say otherwise and no Note arriving can move it.
 *
 * The Project on screen is offered even when the list does not hold it, which
 * happens the moment its last Note is deleted or refiled: a picker that
 * silently stopped showing what it is narrowed to would be lying about the
 * empty list underneath it.
 *
 * While narrowed to a named Project, the one place the whole stream can be
 * renamed from sits beside it — filing is per-Note here and the constraint is
 * the one thing on screen that names the stream, so it is where renaming
 * belongs. Any and Unfiled rename nothing: there is no stream to move.
 */
function ProjectConstraintField({
  constraint,
  projects,
  onNarrow,
  onRename,
}: {
  constraint: ProjectConstraint
  projects: string[]
  onNarrow: (constraint: ProjectConstraint) => void
  onRename: (name: string) => void
}) {
  const labelId = useId()
  const valueId = useId()
  // Open is held here only so the list can be closed when this view leaves the
  // screen: it is portalled to the end of the document, where hiding the
  // header does not reach it.
  const [open, setOpen] = useState(false)
  useOffScreen(() => setOpen(false))
  const chosen = projectChoice(constraint)
  const named =
    constraint.kind === 'named' && !projects.includes(constraint.name)
      ? [constraint.name, ...projects]
      : projects
  const options = [
    { value: 'any', label: 'Any Project' },
    { value: 'unfiled', label: 'Unfiled' },
    ...named.map((name) => ({ value: `#${name}`, label: `#${name}` })),
  ]

  return (
    <span className="flex items-center gap-1">
      <Select
        items={options}
        open={open}
        onOpenChange={setOpen}
        value={chosen}
        onValueChange={(value) => onNarrow(projectConstraintFor(String(value)))}
      >
        {/* Same bargain as the days: the name of the control, then what it
            currently narrows to. */}
        <span id={labelId} className="sr-only">
          Project
        </span>
        <SelectTrigger
          size="sm"
          aria-labelledby={`${labelId} ${valueId}`}
          className="max-w-40"
        >
          <SelectValue id={valueId} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {constraint.kind === 'named' && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => onRename(constraint.name)}
                aria-label="Rename Project"
                className="text-muted-foreground"
              >
                <PencilIcon />
              </Button>
            }
          />
          <TooltipContent>Rename Project</TooltipContent>
        </Tooltip>
      )}
    </span>
  )
}

/**
 * The header's one copy control: a split button whose primary copies the
 * Filter's Notes and whose chevron menu holds the variant that adds the work
 * completed in the Filter's days. One visible button rather than a
 * side-by-side pair, so copying is a default with an escape hatch rather than
 * a decision every time. Each copy's confirmation names which one landed,
 * through the toast and the one live region below.
 *
 * The count previews the held Digest itself — what a copy would write — so
 * it stays honest whatever the list underneath is doing. Null while no read
 * has landed yet, when the button reads plainly.
 *
 * Completed work has no Project, so under a
 * named Project or Unfiled its menu row is present but disabled, carrying the
 * rule as visible text rather than a tooltip no hover can reach.
 */
function Copies({
  filter,
  confirmation,
  noteCount,
  onCopyDigest,
  onCopyReviewMaterial,
}: {
  filter: Filter
  confirmation: string | null
  noteCount: number | null
  onCopyDigest: () => void
  onCopyReviewMaterial: () => void
}) {
  // A Task is never filed under a Project: the Project axis cannot narrow
  // what was never filed under it.
  const reviewAllowed = constraintOf(filter).kind === 'any'
  const reviewRuleId = useId()
  // The menu is portalled out of the header, so it leaves the screen with
  // this view rather than being hidden with it. Nothing is copied by closing
  // it.
  const [open, setOpen] = useState(false)
  useOffScreen(() => setOpen(false))

  return (
    <div className="ml-auto flex shrink-0 items-center gap-3">
      {/* Empty until something has been copied, and announced when it is. */}
      <span role="status" aria-live="polite" className="sr-only">
        {confirmation}
      </span>
      <div className="flex shrink-0 items-center">
        <Button
          size="sm"
          onClick={onCopyDigest}
          className="rounded-r-none border-r-0"
        >
          <ClipboardCopyIcon data-icon="inline-start" />
          {noteCount === null ? 'Copy notes' : `Copy notes (${noteCount})`}
        </Button>
        {/*
          A real menu rather than a popover with buttons: arrow keys,
          typeahead and focus management come with it. The disabled row
          carries the rule as a group hint beneath the item, so the item's
          own name stays exactly what the action does.
        */}
        <Menu open={open} onOpenChange={(next) => setOpen(next)}>
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
          <MenuContent align="end" className="w-80">
            <MenuGroup className="flex flex-col gap-1">
              <MenuItem
                onClick={() => onCopyReviewMaterial()}
                disabled={!reviewAllowed}
                aria-describedby={reviewAllowed ? undefined : reviewRuleId}
              >
                <ClipboardCopyIcon data-icon="inline-start" />
                Copy notes + completed work
              </MenuItem>
              {!reviewAllowed && (
                <p
                  id={reviewRuleId}
                  className="px-2 pb-1 type-micro text-muted-foreground"
                >
                  {REVIEW_PROJECT_RULE}
                </p>
              )}
            </MenuGroup>
          </MenuContent>
        </Menu>
      </div>
    </div>
  )
}

/**
 * A Note being refiled onto another Journal Day. A calendar in a popup, so a
 * day is picked whole and in one click: the value that leaves here is always a
 * day the reader meant, which is why nothing holds a half-picked one.
 *
 * The core still refuses a nonsense day, and that guard is the one that
 * matters — but there is no longer a way for this control to offer it one.
 */
function DayField({
  value,
  onPick,
  label,
}: {
  value: string
  onPick: (journalDay: string) => void
  label: string
}) {
  const [open, setOpen] = useState(false)

  // Portalled away from the row, so it leaves the screen with this view rather
  // than being hidden with it. Nothing is refiled by closing it.
  useOffScreen(() => setOpen(false))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={label}
                  className="text-muted-foreground"
                >
                  <CalendarIcon />
                </Button>
              }
            />
          }
        />
        <TooltipContent>File under another day</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-auto p-2">
        <Calendar
          mode="single"
          autoFocus
          // Monday, as every Preset's week is — see ADR-0006.
          weekStartsOn={1}
          defaultMonth={dayAsDate(value)}
          selected={dayAsDate(value)}
          onSelect={(_selected, day) => {
            setOpen(false)
            onPick(journalDayFor(day))
          }}
          className="p-0"
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * A Note's Project being set, changed or cleared. Explicit — not the Body — so
 * wording and filing stay separate. The list is the Predictions the journal
 * already offers a Capture, asked for by what has been typed so far, and a
 * name nothing has been filed under yet is offered as itself: filing under a
 * new Project is how the first Note under it gets there.
 *
 * Nothing is filed on the way out. A Project is filed by choosing one, so
 * Escape leaves what was typed exactly where it was typed — abandoned.
 */
function ProjectField({
  value,
  journal,
  onPick,
  label,
}: {
  value: string | null
  journal: Promise<Journal>
  onPick: (project: string | null) => void
  label: string
}) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [predictions, setPredictions] = useState<string[]>([])
  // Portalled away from the row, like the day picker beside it. Nothing is
  // filed on the way out, here or anywhere else this list closes.
  useOffScreen(() => {
    setOpen(false)
    setTyped('')
  })
  // Which line the keyboard is on, if any. Only Return on none of them is a
  // decision this field makes for itself.
  const highlighted = useRef<ProjectOption | null>(null)

  useEffect(() => {
    if (!open) return

    let cancelled = false
    void (async () => {
      const names = await (await journal).projectPredictions(projectPrefix(typed))
      if (!cancelled) setPredictions(names)
    })()

    return () => {
      cancelled = true
    }
  }, [open, typed, journal])

  const options = projectOptions(projectPrefix(typed), predictions, value)

  return (
    <Combobox
      items={options}
      // The Predictions are the journal's, matched by prefix the way a Capture
      // matches them, so nothing is filtered again on the way to the list.
      filter={null}
      autoHighlight
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next)
        if (!next) setTyped('')
      }}
      inputValue={typed}
      onInputValueChange={setTyped}
      itemToStringLabel={(option: ProjectOption) => option.label}
      onItemHighlighted={(option: ProjectOption | undefined) => {
        highlighted.current = option ?? null
      }}
      onValueChange={(option: ProjectOption | null) => {
        if (option === null) return
        setOpen(false)
        onPick(option.kind === 'unfiled' ? null : option.name)
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ComboboxPrimitive.Trigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={label}
                  className="text-muted-foreground"
                >
                  <HashIcon />
                </Button>
              }
            />
          }
        />
        <TooltipContent>File under a Project</TooltipContent>
      </Tooltip>
      <ComboboxContent align="end" className="w-48">
        <ComboboxInput
          showTrigger={false}
          placeholder="Project"
          aria-label="Project name"
          onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
            // An emptied field is the reader saying the Note is under nothing
            // — the way clearing a Project has always been said here. With a
            // line picked out, Return takes that line instead.
            if (
              event.key !== 'Enter' ||
              projectPrefix(typed) !== '' ||
              highlighted.current !== null
            ) {
              return
            }

            setOpen(false)
            onPick(null)
          }}
        />
        <ComboboxEmpty>No Project by that name.</ComboboxEmpty>
        <ComboboxList>
          {options.map((option) => (
            <ComboboxItem key={option.key} value={option}>
              {option.label}
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

/**
 * One line of the Project list: a Project already on Notes, the name being
 * typed for the first time, or Unfiled — which is a value like any other and
 * so is chosen like one, rather than by emptying a field.
 */
type ProjectOption =
  | { kind: 'unfiled'; key: string; label: string }
  | { kind: 'project'; key: string; label: string; name: string }

/** What has been typed, as a Project name: the display `#` is not part of it. */
function projectPrefix(typed: string): string {
  return typed.trim().replace(/^#/, '')
}

/**
 * The list under the field. Unfiled is offered only while nothing has been
 * typed — once the reader is naming a Project they are not looking for the
 * absence of one — and a new name is offered only when no Prediction already
 * is it, so the same Project is never on screen twice.
 */
function projectOptions(
  prefix: string,
  predictions: string[],
  filed: string | null,
): ProjectOption[] {
  const options: ProjectOption[] = []

  if (prefix === '' && filed !== null) {
    options.push({ kind: 'unfiled', key: 'unfiled', label: formatProject(null) })
  }

  for (const name of predictions) {
    options.push({ kind: 'project', key: name, label: formatProject(name), name })
  }

  const known = predictions.some(
    (name) => name.toLowerCase() === prefix.toLowerCase(),
  )
  // Offered only if it is a name at all: the record refuses anything else, and
  // a list holding a choice that cannot be made is not a list of choices.
  if (!known && isProjectName(prefix)) {
    options.push({
      kind: 'project',
      key: `new:${prefix}`,
      label: formatProject(prefix),
      name: prefix,
    })
  }

  return options
}

/**
 * A day outside the Filter has gained a Note. An inline banner, lifted just
 * off the page by an accent hairline and a shadow so it reads as something
 * that arrived — and unobtrusive all the same: it says what happened and
 * waits, rather than moving what is being read.
 */
function Nudge({
  journalDay,
  onShow,
  onDismiss,
}: {
  journalDay: string
  onShow: () => void
  onDismiss: () => void
}) {
  return (
    <div
      role="status"
      className="mx-6 mb-5 flex shrink-0 items-center gap-3 rounded-md border border-border border-l-2 border-l-primary bg-card px-4 py-3 type-meta shadow-sm"
    >
      <span className="flex-1 text-muted-foreground">
        A new Note on {formatJournalDay(journalDay)}.
      </span>
      <Button variant="outline" size="sm" onClick={onShow}>
        Show
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        Dismiss
      </Button>
    </div>
  )
}

/**
 * No Notes at all is a beginning, not an empty day — and the one screen a new
 * user is guaranteed to read, so it teaches the Hotkey: the fastest Entry
 * Point, named as the combination actually bound rather than in the abstract.
 *
 * The Tray Menu is the fallback, and is all this says when the Hotkey is
 * unavailable or unknown: an empty state that taught a combination doing
 * nothing would be worse than the slow way in.
 */
function NoNotesYet({ hotkeys }: { hotkeys: HotkeyStatuses | null }) {
  const note = hotkeys?.note

  return (
    <EmptyState icon={NotebookPenIcon} heading="No Notes yet">
      {note?.state === 'registered' ? (
        <>
          {/* The same keycaps Settings reads the Hotkey back in, so what is
              taught here is what is read back there. */}
          Press{' '}
          <KbdGroup className="align-baseline">
            {keysOfHotkey(note.hotkey).map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </KbdGroup>
          , type one line about what you just did, and press Enter. New Note in
          the Work Journal menu does the same thing.
        </>
      ) : (
        <>
          Choose New Note from the Work Journal menu, type one line about what
          you just did, and press Enter.
        </>
      )}
    </EmptyState>
  )
}

/**
 * A list that is not there, and why. The icon and the heading are what make it
 * read as an answer rather than as a page still loading; the heading is the
 * whole of the answer, so each of the ways a list can be empty keeps its own
 * words, and naming the region with it is how a screen reader hears the answer
 * rather than an unlabelled block.
 */
function EmptyState({
  icon: Icon,
  heading,
  children,
}: {
  icon: LucideIcon
  heading: string
  children?: React.ReactNode
}) {
  const headingId = useId()

  return (
    <section
      aria-labelledby={headingId}
      className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center type-body"
    >
      <span
        aria-hidden
        className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <Icon className="size-5" />
      </span>
      <h2 id={headingId} className="type-section text-foreground">
        {heading}
      </h2>
      {children !== undefined && (
        <p className="max-w-sm text-muted-foreground">{children}</p>
      )}
    </section>
  )
}
