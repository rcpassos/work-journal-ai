import { useEffect, useId, useRef, useState } from 'react'
import ProjectChip from '@/components/ProjectChip'
import {
  projectOptions,
  projectPrefix,
  useProjectPredictions,
  type ProjectOption,
} from '@/components/project-options'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
} from '@/components/ui/menu'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useOnScreenToast } from '@/components/on-screen-toast'
import { useOnScreen } from '@/components/on-screen-context'
import {
  formatAgo,
  formatProject,
  isProjectName,
  projectName,
  repositoryName,
  type Journal,
} from '@/journal/journal'
import type {
  Desktop,
  PauseLength,
  PauseState,
  RepositoryUnreadable,
} from '@/platform/desktop'
import type { AppSettings } from '@/settings/app-settings'
import {
  addRepository,
  pauseState,
  pauseObserving,
  removeRepository,
  resumeObserving,
  setIdentities,
  setIgnoredPrefixes,
  turnObserving,
  type ObservedRepository,
  type Observing,
} from '@/settings/observing'
import { DEFAULT_SETTINGS } from '@/settings/settings'
import type { SettingsInitialState } from './SettingsInitialState'
import { saySettled } from './saySettled'
import { SettingsAside, SettingsGroup, SettingsProblem, SettingsRow } from './SettingsGroup'
import { useSeededState } from './useSeededState'

/**
 * Whether the user's commits are observed, from which repositories, which
 * identities count as the user in each, which Project each repository's
 * Notes arrive filed under, and the pause — which is done in the moment from
 * the Tray Menu and is shown and resumed here too. Every change to the list
 * is a rule from `@/settings/observing` applied to the file as it stands —
 * consent and pauses are kept as the instants they were given, so the file,
 * not this view, decides them — and the view shows what the file came to
 * hold. A Project Mapping is journal content rather than configuration, so
 * it is written to the journal and shown as it reads there.
 */
export default function ObservingSettings({
  desktop,
  settings,
  journal,
  initialSettings,
}: {
  desktop: Desktop
  settings: AppSettings
  /** The journal the repository rows read their last Note from, and hold their Project Mapping in. */
  journal: Promise<Journal>
  initialSettings: Promise<SettingsInitialState | null> | null
}) {
  const [observing, setObserving] = useSeededState(
    initialSettings,
    (initial) => initial.stored.observing,
    DEFAULT_SETTINGS.observing,
  )
  const says = useOnScreenToast()

  // How many changes have been started here. What the file came to hold is
  // shown only for the newest one: an older save settling after a newer
  // press would otherwise put the older list back for a moment.
  const changes = useRef(0)
  // How many are still in flight — which is when a change from another
  // window is not taken from the announcement: the save already running
  // answers with the file as it stands, and it holds everything written
  // before it, this window's press included.
  const saving = useRef(0)

  /**
   * One change, shown at once and then as the file came to hold it. The view
   * applies the rule itself so the control moves under the press, and then
   * takes the file's answer: consent is kept as the instant the file applied
   * the change at, and the file is what a save is.
   */
  function update(
    change: (observing: Observing, now: number) => Observing,
    messages: { id: string; saved: string; couldNot: string },
  ) {
    const started = ++changes.current
    saving.current += 1
    const rollback = setObserving((current) => change(current, Date.now()))
    saySettled(says, settings.updateObserving(change), {
      ...messages,
      what: 'could not change what is observed',
      onSaved: (saved) => {
        saving.current -= 1
        if (changes.current === started) setObserving(saved)
      },
      // Back to what the file holds now, for the same reason the calendar
      // ticks roll back that way.
      onRefused: () => {
        saving.current -= 1
        void settings.load().then(
          (stored) => rollback(stored.observing),
          () => rollback(observing),
        )
      },
    })
  }

  // A pause is taken from the Tray Menu as often as from here, and turning
  // Observing on or off changes what this section shows. The file is the one
  // fact either way.
  useEffect(() => {
    let listening = true
    let stop: (() => void) | null = null
    void desktop
      .onObservingChanged(() => {
        if (saving.current > 0) return
        void settings.load().then(
          (stored) => {
            if (listening) setObserving(stored.observing)
          },
          (error: unknown) => {
            console.error('could not read what Observing came to hold', error)
          },
        )
      })
      .then((unlisten) => {
        if (listening) stop = unlisten
        else unlisten()
      })
    return () => {
      listening = false
      stop?.()
    }
  }, [desktop, settings, setObserving])

  function toggle(enabled: boolean) {
    update((current, now) => turnObserving(current, enabled, now), {
      id: 'observing',
      saved: enabled
        ? 'Your commits will be added to the journal.'
        : 'Commits will no longer be added to the journal.',
      couldNot: 'Could not change whether commits are added.',
    })
  }

  /**
   * A repository, added through a folder picker — a path is never typed. Its
   * identity is asked of the reader, so a second worktree of a repository on
   * the list is recognised as the entry it already is and adds nothing.
   */
  async function add() {
    try {
      const path = await desktop.chooseRepositoryFolder()
      if (path === null) return

      const read = await desktop.repositoryIdentities(path)
      if (read.state === 'unreadable') {
        says.failure(`Could not add that folder: ${describeUnreadable(read.reason)}`, 'observing-repositories')
        return
      }

      // No identity ticked: the suggestions are offered, and count only once
      // the user ticks them.
      const added: ObservedRepository = {
        path,
        repository: read.repository,
        identities: [],
        ignoredPrefixes: [],
      }
      // Whether it is already listed is the file's answer, not this view's:
      // the view may not have read the file yet.
      let listed: ObservedRepository | undefined
      const started = ++changes.current
      saving.current += 1
      let saved: Observing
      try {
        saved = await settings.updateObserving((current, now) => {
          listed = current.repositories.find(
            ({ repository }) => repository === added.repository,
          )
          return listed === undefined ? addRepository(current, added, now) : current
        })
      } finally {
        saving.current -= 1
      }
      if (changes.current === started) setObserving(saved)
      if (listed !== undefined) {
        says.say(`Already added as ${repositoryName(listed.repository)}.`, 'observing-repositories')
        return
      }
      says.success(
        `${repositoryName(added.repository)} added. Tick the addresses that are you.`,
        'observing-repositories',
      )
    } catch (error) {
      console.error('could not add a repository', error)
      says.failure('Could not add that repository.', 'observing-repositories')
    }
  }

  // What the pause controls say, from the same rule the Tray Menu's are
  // given — read against the clock when the state changes, and again the
  // moment a timed pause runs out, so the row says "Paused" only while one
  // is in force. And read again whenever the clock has moved while the timer
  // could not: a Mac that slept through a pause's end stops it part-way, and
  // a section that sat off screen keeps its row the while — so waking and
  // coming back on screen are both a moment to read the clock again.
  const onScreen = useOnScreen()
  // Ticked by the wake below, and nothing else: waking is one more reason to
  // read the clock again. One listener for the whole section — the pause row
  // here and every repository's Last line both hear it through this.
  const [woke, setWoke] = useState(0)
  const [pause, setPause] = useState<PauseState>({ state: 'nothing' })
  useEffect(() => {
    const active = pauseState(observing, Date.now())
    // Sampled here rather than in the render: the clock is not a render's to
    // read — the same reason the coordinated initial read sets its state from
    // an effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPause(active)
    if (active.state !== 'paused' || active.until === null) return
    const timer = setTimeout(() => {
      setPause(pauseState(observing, Date.now()))
    }, Math.max(0, active.until - Date.now()))
    return () => clearTimeout(timer)
  }, [observing, onScreen, woke])

  // What the pause row and the Last lines read is the clock, and a sleeping
  // Mac runs no timer: the wake is what says the clock moved on its own.
  useEffect(() => {
    let listening = true
    let stop: (() => void) | null = null
    void desktop
      .onSystemWoke(() => {
        if (listening) setWoke((count) => count + 1)
      })
      .then((unlisten) => {
        if (listening) stop = unlisten
        else unlisten()
      })
    return () => {
      listening = false
      stop?.()
    }
  }, [desktop])

  function pauseFor(length: PauseLength) {
    update((current, now) => pauseObserving(current, length, now), {
      id: 'observing-pause',
      saved: {
        'an-hour': 'Nothing done in the next hour will be added to the journal.',
        'until-tomorrow': 'Nothing done before tomorrow will be added to the journal.',
        'until-resumed': 'Nothing done before you resume will be added to the journal.',
      }[length],
      couldNot: 'Could not pause observing.',
    })
  }

  function resume() {
    update((current, now) => resumeObserving(current, now), {
      id: 'observing-pause',
      saved: 'Your commits will be added to the journal again.',
      couldNot: 'Could not resume observing.',
    })
  }

  return (
    <SettingsGroup>
      <SettingsRow
        label="Add your commits to the journal"
        explanation="Commits you made in the repositories you choose, added as Notes on the day they were authored. Nothing from before you turn this on."
        controls="observing"
      >
        <Switch id="observing" checked={observing.enabled} onCheckedChange={toggle} />
      </SettingsRow>

      {observing.enabled && (
        <>
          {observing.repositories.length === 0 && (
            <p className="type-meta text-muted-foreground">
              No repositories chosen, so nothing is observed.
            </p>
          )}

          {observing.repositories.map((listed) => (
            <RepositoryEntry
              key={listed.repository}
              desktop={desktop}
              journal={journal}
              listed={listed}
              woke={woke}
              onIdentities={(identities) =>
                update((current) => setIdentities(current, listed.repository, identities), {
                  id: `observing-identities-${listed.repository}`,
                  saved: 'Addresses saved.',
                  couldNot: 'Could not save which addresses are you.',
                })
              }
              onIgnoredPrefixes={(prefixes) =>
                update((current) => setIgnoredPrefixes(current, listed.repository, prefixes), {
                  id: `observing-prefixes-${listed.repository}`,
                  saved: 'Skipped prefixes saved.',
                  couldNot: 'Could not save which commits to skip.',
                })
              }
              onRemove={() =>
                update((current, now) => removeRepository(current, listed.repository, now), {
                  id: 'observing-repositories',
                  saved: `${repositoryName(listed.repository)} removed.`,
                  couldNot: 'Could not remove that repository.',
                })
              }
            />
          ))}

          <div>
            <Button variant="outline" size="sm" onClick={() => void add()}>
              Add Repository…
            </Button>
          </div>
        </>
      )}

      {pause.state === 'running' && (
        <SettingsRow
          label="Pause observing"
          explanation="Work done during a pause never enters the journal — for a screen share, or a client's confidential work. A pause for an hour or until tomorrow ends by itself."
        >
          <Menu>
            <MenuTrigger
              render={<Button variant="outline" size="sm" />}
            >
              Pause observing
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem onClick={() => pauseFor('an-hour')}>For an hour</MenuItem>
              <MenuItem onClick={() => pauseFor('until-tomorrow')}>Until tomorrow</MenuItem>
              <MenuItem onClick={() => pauseFor('until-resumed')}>Until resumed</MenuItem>
            </MenuContent>
          </Menu>
        </SettingsRow>
      )}

      {pause.state === 'paused' && (
        <SettingsRow
          label={pause.label}
          explanation="Observing is paused. Nothing done during the pause enters the journal — the pause is kept as when the work happened, so a commit from inside it never arrives, however late a sweep meets it."
        >
          <Button variant="outline" size="sm" onClick={resume}>
            Resume
          </Button>
        </SettingsRow>
      )}

      <SettingsAside>
        Each commit becomes an ordinary Note: reword it, file it under a
        Project, or delete it. Deleting one refuses that commit for good, and
        one filed by hand stays filed that way. The repositories are only ever
        read.
      </SettingsAside>
    </SettingsGroup>
  )
}

/** One repository on the list: what its Notes are filed under, who is the user there, and what to skip. */
function RepositoryEntry({
  desktop,
  journal,
  listed,
  woke,
  onIdentities,
  onIgnoredPrefixes,
  onRemove,
}: {
  desktop: Desktop
  journal: Promise<Journal>
  listed: ObservedRepository
  woke: number
  onIdentities: (identities: string[]) => void
  onIgnoredPrefixes: (prefixes: string[]) => void
  onRemove: () => void
}) {
  const says = useOnScreenToast()
  const name = repositoryName(listed.repository)
  // Two repositories may share a folder name, so ids come from React.
  const idBase = useId()
  const [suggested, setSuggested] = useState<string[]>([])
  const [unreadable, setUnreadable] = useState<RepositoryUnreadable | null>(null)
  // The Project Mapping as the journal holds it: what this repository's Notes
  // arrive filed under. Null is Unfiled.
  const [mapping, setMapping] = useState<string | null>(null)
  // The text as typed, blank lines and all: the list saved from it drops the
  // blanks, and reading that back into the field would eat the line being
  // started.
  const [prefixes, setPrefixes] = useState(() => listed.ignoredPrefixes.join('\n'))
  // The last Note this repository produced, and when it arrived — read from
  // the Notes' own source columns, so one the user deleted does not count —
  // or null once it is known there is none. Nothing is said until the journal
  // has answered.
  const [last, setLast] = useState<{ body: string; arrivedAt: string } | null>(
    null,
  )
  const [asked, setAsked] = useState(false)

  // Read again when something says this repository moved. The journal is not
  // that signal: a folder that goes away, or a first commit that becomes no
  // Note, changes nothing in it — only the sweep sees either happen, and it
  // says so when what a repository reads as changes. Nothing is read while
  // the section is off screen, because it is not being looked at: coming back
  // on screen reads it then. And only the newest read is ever applied — two
  // of them overlap, and an older one landing late would put a reason back
  // that a newer one cleared.
  const onScreen = useOnScreen()
  const reads = useRef(0)
  // The mapping's own reads and writes, in order with each other: a read
  // queues behind the saves, so one of them never shows a write that has not
  // landed yet, and only the newest read is ever applied. A read that began
  // before a press is discarded — an arriving read may only seed state that
  // has not been touched since the snapshot was taken (ADR 0028) — and so is
  // a rollback: a save refused once a newer change has landed puts nothing
  // back over it.
  const writes = useRef<Promise<void>>(Promise.resolve())
  const touches = useRef(0)
  const mappingReads = useRef(0)

  // Read when the row opens and again whenever the journal changes: a rename
  // or a merge in History moves what this row is showing, and the field says
  // the name it moved to.
  useEffect(() => {
    let listening = true
    let stop: (() => void) | null = null
    async function readMapping(): Promise<void> {
      const mine = (mappingReads.current += 1)
      const touch = touches.current
      await writes.current
      try {
        const core = await journal
        const project = await core.projectMapping(listed.repository)
        if (
          !listening ||
          mine !== mappingReads.current ||
          touch !== touches.current
        ) {
          return
        }
        setMapping(project)
      } catch (error) {
        console.error('could not read the Project Mapping', error)
      }
    }
    void readMapping()
    void desktop
      .onJournalChanged(() => {
        void readMapping()
      })
      .then((unlisten) => {
        if (listening) stop = unlisten
        else unlisten()
      })
    return () => {
      listening = false
      stop?.()
    }
  }, [desktop, journal, listed.repository])

  /**
   * One repository's Project Mapping — which Project its Notes arrive filed
   * under. Journal content rather than a setting, so the journal is what is
   * written. The field moves under the press, and a write the journal refuses
   * is rolled back before the toast raises, so what the user is told and what
   * they can see never disagree (ADR 0029). Two presses close together are
   * written one behind the other, so the older cannot settle last and hold
   * the journal where the field no longer is.
   *
   * The journal moving is announced beside the write that moved it, never as
   * part of it: an announcement that fails is logged, not raised as a save
   * refused that in truth took.
   */
  function pick(project: string | null) {
    const before = mapping
    const mine = (touches.current += 1)
    setMapping(project)
    const write = writes.current.then(async () => {
      const core = await journal
      await core.setProjectMapping(listed.repository, project)
      await desktop.announceJournalChanged().catch((error: unknown) => {
        console.error('could not announce the Project Mapping', error)
      })
    })
    writes.current = write.catch(() => undefined)
    saySettled(
      says,
      write,
      {
        id: `observing-project-${listed.repository}`,
        saved:
          project === null
            ? 'Commits will be Unfiled.'
            : `Commits will be filed under ${formatProject(project)}.`,
        couldNot: 'Could not save the Project.',
        what: 'could not change the Project Mapping',
        // A rollback belongs to the change that started it, and is discarded
        // once a newer change has landed (ADR 0028).
        onRefused: () => {
          if (mine === touches.current) setMapping(before)
        },
      },
    )
  }

  useEffect(() => {
    if (!onScreen) return
    let listening = true
    let stop: (() => void) | null = null
    async function readIdentities(): Promise<void> {
      const mine = (reads.current += 1)
      const read = await desktop.repositoryIdentities(listed.path)
      if (!listening || mine !== reads.current) return
      if (read.state === 'read') setSuggested(read.identities)
      // Both answers say why nothing can be read from this repository, when
      // that is so: the unreadable one has nothing else to say, and one with
      // suggestions carries the same reason beside them — a repository with
      // nothing on its branches yet is still worth asking who the user is.
      setUnreadable(read.reason)
    }
    const failed = (error: unknown) =>
      console.error('could not suggest identities', error)
    void readIdentities().catch(failed)
    void desktop
      .onRepositoryStateChanged(() => {
        void readIdentities().catch(failed)
      })
      .then((unlisten) => {
        if (listening) stop = unlisten
        else unlisten()
      })
    return () => {
      listening = false
      stop?.()
    }
  }, [desktop, listed.path, onScreen])

  // A sweep lands while this is open, and "is this on?" is exactly the
  // question the line answers — so it is read again when the journal changes.
  useEffect(() => {
    let listening = true
    let stop: (() => void) | null = null
    async function readLast(): Promise<void> {
      const core = await journal
      const note = await core.lastCommitNote(listed.repository)
      if (listening) {
        setLast(note)
        setAsked(true)
      }
    }
    const failed = (error: unknown) =>
      console.error('could not read the last Note of a repository', error)
    void readLast().catch(failed)
    void desktop
      .onJournalChanged(() => {
        void readLast().catch(failed)
      })
      .then((unlisten) => {
        if (listening) stop = unlisten
        else unlisten()
      })
    return () => {
      listening = false
      stop?.()
    }
  }, [desktop, journal, listed.repository])

  // The clock the Last line reads its "ago" against: fixed at render, it
  // would say "just now" all afternoon while the section sits open. It moves
  // about once a minute — the words go no finer than "5 min ago" — and only
  // while the section is on screen. Coming back on screen and waking are both
  // read at once rather than left to the next tick: a line looked at after
  // either would otherwise keep the time it was left with, saying "5 min ago"
  // of a Note hours old. The wake is the parent's to hear — one listener for
  // the whole section — and arrives here as `woke`.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    // Sampled here rather than in the render: the clock is not a render's to
    // read — the same reason the pause row above sets its own state from an
    // effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(new Date())
    if (!onScreen) return
    const timer = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(timer)
  }, [onScreen, woke])

  // What is ticked, then what is suggested, one address in any case.
  const offered = [...listed.identities]
  for (const identity of suggested) {
    if (!offered.some((each) => sameAddress(each, identity))) {
      offered.push(identity)
    }
  }

  function tick(identity: string, ticked: boolean) {
    onIdentities(
      ticked
        ? [...listed.identities, identity]
        : listed.identities.filter((each) => !sameAddress(each, identity)),
    )
  }

  const prefixesId = `${idBase}-prefixes`

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-col">
          <span className="type-body font-medium">{name}</span>
          <span className="truncate type-micro text-muted-foreground">{listed.path}</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onRemove} aria-label={`Remove ${name}`}>
          Remove
        </Button>
      </div>

      {last !== null ? (
        <span className="type-micro text-muted-foreground">
          Last: {last.body} · {formatAgo(new Date(last.arrivedAt), now)}
        </span>
      ) : (
        asked && (
          <span className="type-micro text-muted-foreground">
            Nothing yet since you turned this on
          </span>
        )
      )}

      {unreadable !== null && (
        <SettingsProblem>
          {describeUnreadable(unreadable)} Its commits are not being added.
        </SettingsProblem>
      )}

      <ProjectMappingField
        journal={journal}
        repository={listed.repository}
        value={mapping}
        onPick={pick}
      />

      <fieldset className="flex flex-col gap-2 pl-1">
        <legend className="type-meta text-muted-foreground">Addresses that are you</legend>
        {offered.length === 0 && (
          <p className="type-meta text-muted-foreground">No addresses to offer.</p>
        )}
        {offered.map((identity) => {
          const id = `${idBase}-identity-${identity}`
          return (
            <div key={identity} className="flex items-center gap-2">
              <Checkbox
                id={id}
                checked={listed.identities.some((each) => sameAddress(each, identity))}
                onCheckedChange={(next: boolean) => tick(identity, next)}
              />
              <label htmlFor={id} className="type-meta">
                {identity}
              </label>
            </div>
          )
        })}
      </fieldset>

      <label htmlFor={prefixesId} className="type-meta text-muted-foreground">
        Skip commits whose subject begins with, one per line
      </label>
      <Textarea
        id={prefixesId}
        value={prefixes}
        placeholder="Release "
        onChange={(event) => setPrefixes(event.target.value)}
        // Saved when the field is left, never per keystroke: a sweep between
        // two keystrokes of a retyped prefix would meet the field empty, and
        // a commit it lets through is handled for good.
        // Only a changed list is saved: leaving an untouched field would
        // otherwise confirm a save that did nothing and wake a sweep.
        onBlur={() => {
          const next = prefixes.split('\n').filter((prefix) => prefix !== '')
          if (next.join('\n') !== listed.ignoredPrefixes.join('\n')) {
            onIgnoredPrefixes(next)
          }
        }}
      />
    </div>
  )
}

/**
 * The Project Mapping for one repository: the Project its Observed Notes
 * arrive filed under. A field rather than a picker, because the mapping has
 * an empty state to say — nothing mapped is Unfiled, and the field says so by
 * holding nothing — and its completion is the one a Capture gets, with the
 * repository's own name offered first. That name becomes the Project only if
 * the user picks or types it: nothing is ever inferred from a path.
 *
 * A mapping is decided rather than typed at the journal, so what has been
 * typed lands only when it is picked or named with Enter — an emptied field
 * is the repository left Unfiled, which is how a mapping is removed — and
 * leaving the field abandons the rest.
 */
function ProjectMappingField({
  journal,
  repository,
  value,
  onPick,
}: {
  journal: Promise<Journal>
  /** The repository's identity: what the mapping keys on, every worktree included. */
  repository: string
  /** The mapping as the journal holds it. Null is Unfiled. */
  value: string | null
  onPick: (project: string | null) => void
}) {
  // What has been typed and not yet said, or null while the field shows the
  // mapping as it is. The buffer is not the value: until the user picks or
  // says a name, the field is only text.
  const [draft, setDraft] = useState<string | null>(null)
  // The completions show while the field is open, and the keyboard is on one
  // line of them only once the user has moved there — so a bare Enter is
  // always what was typed, never the first thing that happened to be listed.
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState<number | null>(null)
  const fieldId = useId()
  const listId = `${fieldId}-predictions`

  const typed = draft ?? ''
  // Untouched, the field offers everything: as much as a Capture with an
  // empty marker shows. The first line is the repository's own name.
  const predictions = useProjectPredictions(
    journal,
    open ? projectPrefix(typed) : null,
  )
  const options = projectOptions(
    projectPrefix(typed),
    predictions,
    value,
    repositoryName(repository),
  )

  /** What was typed and never said goes with the field. */
  function abandon() {
    setOpen(false)
    setHighlight(null)
    setDraft(null)
  }

  function choose(option: ProjectOption) {
    abandon()
    onPick(option.kind === 'unfiled' ? null : option.name)
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      // Escape is the field's while there is something of the user's in it:
      // what was typed is abandoned, and an open list is a popup, which
      // closes before the window ever sees the keystroke (History's Escape
      // order). Abandoned and closed, the keystroke is the window's again.
      const holding =
        draft !== null || highlight !== null || (open && options.length > 0)
      if (!holding) return
      event.stopPropagation()
      abandon()
      return
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setOpen(true)
      setHighlight((line) => {
        if (options.length === 0) return null
        if (line === null) return step > 0 ? 0 : options.length - 1
        return (line + step + options.length) % options.length
      })
      return
    }

    if (event.key !== 'Enter') return
    event.preventDefault()

    const pointed = highlight === null ? null : options[highlight]
    if (pointed != null) {
      choose(pointed)
      return
    }

    // Nothing pointed at, so what has been typed is the decision: an emptied
    // field is the repository left Unfiled — the way clearing a Project has
    // always been said — and a name is mapped as the record stores it. What
    // the record refuses is no decision at all, and stays in the field. A
    // field nothing was typed into is no decision either: only one the user
    // emptied takes the mapping away.
    if (draft === null) return
    const prefix = projectPrefix(typed)
    if (prefix === '') {
      abandon()
      if (value !== null) onPick(null)
      return
    }
    if (isProjectName(prefix)) {
      const name = projectName(prefix)
      abandon()
      if (name !== value) onPick(name)
    }
  }

  return (
    <>
      <label htmlFor={fieldId} className="type-meta text-muted-foreground">
        Project
      </label>
      <div className="relative">
        <Input
          id={fieldId}
          value={draft ?? value ?? ''}
          placeholder="Unfiled"
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={open && options.length > 0}
          aria-controls={options.length > 0 ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={
            highlight === null ? undefined : `${listId}-${highlight}`
          }
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            setDraft(event.target.value)
            setOpen(true)
            setHighlight(null)
          }}
          onKeyDown={onKeyDown}
          onBlur={abandon}
        />
        {open && options.length > 0 && (
          <ul
            id={listId}
            role="listbox"
            aria-label="Project Predictions"
            className="absolute z-20 mt-1 w-full rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          >
            {options.map((option, index) => (
              <li
                key={option.key}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === highlight}
              >
                <button
                  type="button"
                  // mousedown: a click would blur the field first, and blur
                  // abandons what is being chosen before it lands.
                  onMouseDown={(event) => {
                    event.preventDefault()
                    choose(option)
                  }}
                  className={`flex w-full items-center rounded-sm px-2 py-1 text-left type-body ${
                    index === highlight
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-accent/50'
                  }`}
                >
                  <ProjectChip
                    project={option.kind === 'unfiled' ? null : option.name}
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

/** One address in any case, as the reader matches them. */
function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Why a repository cannot be read, as a sentence. */
function describeUnreadable(reason: RepositoryUnreadable): string {
  switch (reason) {
    case 'missing':
      return 'That folder is gone.'
    case 'not-a-repository':
      return 'That folder is not a git repository.'
    case 'no-head':
      return 'The default branch of that repository cannot be resolved.'
    case 'denied':
      return 'macOS is not letting Work Journal read that folder.'
    case 'git-unavailable':
      return 'git is not installed on this Mac.'
  }
}
