import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { formatAgo, repositoryName, type Journal } from '@/journal/journal'
import type { Desktop, PauseLength, PauseState, RepositoryUnreadable } from '@/platform/desktop'
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
 * Whether the user's commits are observed, from which repositories, and which
 * identities count as the user in each — and the pause, which is done in the
 * moment from the Tray Menu and is shown and resumed here too. Every change is
 * a rule from `@/settings/observing` applied to the file as it stands —
 * consent and pauses are kept as the instants they were given, so the file,
 * not this view, decides them — and the view shows what the file came to hold.
 */
export default function ObservingSettings({
  desktop,
  settings,
  journal,
  initialSettings,
}: {
  desktop: Desktop
  settings: AppSettings
  /** The journal the repository rows read their last Note from. */
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
  // sample and re-arm, which the effect does from one place.
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

  // What the row above reads is the clock, and a sleeping Mac runs no timer:
  // the wake is what says the clock moved on its own.
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
        Project, or delete it. Deleting one refuses that commit for good. The
        repositories are only ever read.
      </SettingsAside>
    </SettingsGroup>
  )
}

/** One repository on the list: who is the user there, and what to skip. */
function RepositoryEntry({
  desktop,
  journal,
  listed,
  onIdentities,
  onIgnoredPrefixes,
  onRemove,
}: {
  desktop: Desktop
  journal: Promise<Journal>
  listed: ObservedRepository
  onIdentities: (identities: string[]) => void
  onIgnoredPrefixes: (prefixes: string[]) => void
  onRemove: () => void
}) {
  const name = repositoryName(listed.repository)
  // Two repositories may share a folder name, so ids come from React.
  const idBase = useId()
  const [suggested, setSuggested] = useState<string[]>([])
  const [unreadable, setUnreadable] = useState<RepositoryUnreadable | null>(null)
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

  useEffect(() => {
    void desktop.repositoryIdentities(listed.path).then(
      (read) => {
        if (read.state === 'read') setSuggested(read.identities)
        // Both answers say why nothing can be read from this repository, when
        // that is so: the unreadable one has nothing else to say, and one with
        // suggestions carries the same reason beside them — a repository with
        // nothing on its branches yet is still worth asking who the user is.
        setUnreadable(read.reason)
      },
      (error: unknown) => {
        console.error('could not suggest identities', error)
      },
    )
  }, [desktop, listed.path])

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
          Last: {last.body} · {formatAgo(new Date(last.arrivedAt), new Date())}
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
