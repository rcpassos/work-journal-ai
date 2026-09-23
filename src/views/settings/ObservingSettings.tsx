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
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useOnScreenToast } from '@/components/on-screen-toast'
import {
  formatProject,
  isProjectName,
  projectName,
  repositoryName,
  type Journal,
} from '@/journal/journal'
import type { Desktop, RepositoryUnreadable } from '@/platform/desktop'
import type { AppSettings } from '@/settings/app-settings'
import {
  addRepository,
  removeRepository,
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
 * identities count as the user in each, and which Project each repository's
 * Notes arrive filed under. Every change to the list is a rule from
 * `@/settings/observing` applied to the file as it stands — consent is kept
 * as the instants it was given, so the file, not this view, decides them —
 * and the view shows what the file came to hold. A Project Mapping is journal
 * content rather than configuration, so it is written to the journal and
 * shown as it reads there.
 */
export default function ObservingSettings({
  desktop,
  settings,
  journal,
  initialSettings,
}: {
  desktop: Desktop
  settings: AppSettings
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
    const rollback = setObserving((current) => change(current, Date.now()))
    saySettled(says, settings.updateObserving(change), {
      ...messages,
      what: 'could not change what is observed',
      onSaved: (saved) => {
        if (changes.current === started) setObserving(saved)
      },
      // Back to what the file holds now, for the same reason the calendar
      // ticks roll back that way.
      onRefused: () => {
        void settings.load().then(
          (stored) => rollback(stored.observing),
          () => rollback(observing),
        )
      },
    })
  }

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
      const saved = await settings.updateObserving((current, now) => {
        listed = current.repositories.find(
          ({ repository }) => repository === added.repository,
        )
        return listed === undefined ? addRepository(current, added, now) : current
      })
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

  useEffect(() => {
    void (async () => {
      try {
        const core = await journal
        setMapping(await core.projectMapping(listed.repository))
      } catch (error) {
        console.error('could not read the Project Mapping', error)
      }
    })()
  }, [journal, listed.repository])

  /**
   * One repository's Project Mapping — which Project its Notes arrive filed
   * under. Journal content rather than a setting, so the journal is what is
   * written. The field moves under the press, and a write the journal refuses
   * is rolled back before the toast raises, so what the user is told and what
   * they can see never disagree (ADR 0029).
   */
  function pick(project: string | null) {
    const before = mapping
    setMapping(project)
    saySettled(
      says,
      (async () => {
        const core = await journal
        await core.setProjectMapping(listed.repository, project)
      })(),
      {
        id: `observing-project-${listed.repository}`,
        saved:
          project === null
            ? 'Commits will be Unfiled.'
            : `Commits will be filed under ${formatProject(project)}.`,
        couldNot: 'Could not save the Project.',
        what: 'could not change the Project Mapping',
        onRefused: () => setMapping(before),
      },
    )
  }

  useEffect(() => {
    void desktop.repositoryIdentities(listed.path).then(
      (read) => {
        if (read.state === 'read') {
          setSuggested(read.identities)
          setUnreadable(null)
        } else {
          setUnreadable(read.reason)
        }
      },
      (error: unknown) => {
        console.error('could not suggest identities', error)
      },
    )
  }, [desktop, listed.path])

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
      // Escape abandons what was typed, and is not the window's to close on
      // while this field holds the keystroke.
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
    // the record refuses is no decision at all, and stays in the field.
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
      return 'That repository has no commits yet.'
    case 'denied':
      return 'macOS is not letting Work Journal read that folder.'
    case 'git-unavailable':
      return 'git is not installed on this Mac.'
  }
}
