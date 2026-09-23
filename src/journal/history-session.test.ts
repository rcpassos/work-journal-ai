import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createHistorySession,
  type HistorySnapshot,
} from './history-session'
import { SEARCH_DEBOUNCE_MS } from './search'
import {
  ANY_PROJECT,
  createJournal,
  rangeForDays,
  rangeForJournalDay,
  UNFILED,
  type Filter,
  type Journal,
  type Note,
} from './journal'
import { fixedClock, openTestDatabase } from './testing/database'

// Every test drives a session over a real database through its verbs and
// asserts on the snapshot a view would render. Nothing here renders anything.

/** One day in view under no Project constraint: where History opens. */
function anyProjectOn(journalDay: string): Filter {
  return { ...rangeForJournalDay(journalDay), project: ANY_PROJECT }
}

const openDatabases: Array<() => void> = []

afterEach(() => {
  for (const close of openDatabases.splice(0)) {
    close()
  }
  vi.restoreAllMocks()
})

describe('opening', () => {
  it('opens on the most recent Occupied Day', async () => {
    const { session } = await sessionOver([
      { at: '2026-03-09T10:00:00', body: 'Monday' },
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])

    await session.open()

    expect(session.snapshot().filter).toEqual(anyProjectOn('2026-03-13'))
    expect(bodiesOf(session.snapshot())).toEqual(['Friday'])
  })

  it('is empty when there are no Notes at all', async () => {
    const { session } = await sessionOver([])

    await session.open()

    expect(session.snapshot().history).toEqual({ state: 'empty' })
    expect(session.snapshot().filter).toBeNull()
  })

  it('is unreadable rather than forever loading when the journal fails', async () => {
    silenceErrors()
    const { session } = await sessionOver([], {
      journal: (core) => ({
        ...core,
        defaultRange: () => Promise.reject(new Error('no database')),
      }),
    })

    await session.open()

    expect(session.snapshot().history).toEqual({ state: 'unreadable' })
  })

  it('tells the view every time the snapshot changes', async () => {
    const { session, seen } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])

    await session.open()

    expect(seen.length).toBeGreaterThan(0)
    expect(seen.at(-1)).toEqual(session.snapshot())
  })
})

describe('the empty journal', () => {
  it('names a Project that exists only as a mapping, and renames it', async () => {
    const { session, core } = await sessionOver([])
    // A repository mapped before anything has been captured: the journal has
    // no Notes at all, and still names this Project.
    await core.setProjectMapping('/code/work-journal-ai/.git', 'work-journal-ai')

    await session.open()

    expect(session.snapshot().history).toEqual({ state: 'empty' })
    expect(session.snapshot().filter).toBeNull()
    expect(session.snapshot().projects).toEqual(['work-journal-ai'])

    await session.renameProject('work-journal-ai', 'journal')

    expect(await core.projectMapping('/code/work-journal-ai/.git')).toBe(
      'journal',
    )
    expect(session.snapshot().projects).toEqual(['journal'])
  })

  it('names it again after the window is closed and reopened', async () => {
    const { session, core } = await sessionOver([])
    await core.setProjectMapping('/code/work-journal-ai/.git', 'work-journal-ai')
    await session.open()

    // The window is closed and a new one opens: a new session over the same
    // journal, taking the path that goes through History's empty state.
    const seen: HistorySnapshot[] = []
    const reopened = createHistorySession({
      journal: Promise.resolve(core),
      clipboard: async () => {},
      announceChange: () => {},
      onChange: (snapshot) => seen.push(snapshot),
    })

    await reopened.open()

    expect(reopened.snapshot().history).toEqual({ state: 'empty' })
    expect(reopened.snapshot().projects).toEqual(['work-journal-ai'])

    await reopened.renameProject('work-journal-ai', 'journal')

    expect(await core.projectMapping('/code/work-journal-ai/.git')).toBe(
      'journal',
    )
    expect(reopened.snapshot().projects).toEqual(['journal'])
  })

  it('holds no Projects at all until something names one', async () => {
    const { session } = await sessionOver([])

    await session.open()

    expect(session.snapshot().projects).toEqual([])
  })
})

describe('moving the Filter', () => {
  it('reads the Notes of the range it was moved to', async () => {
    const { session } = await sessionOver([
      { at: '2026-03-09T10:00:00', body: 'Monday' },
      { at: '2026-03-10T10:00:00', body: 'Tuesday' },
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])

    await session.open()
    await session.moveTo(rangeForDays('2026-03-09', '2026-03-10'))

    expect(bodiesOf(session.snapshot())).toEqual(['Tuesday', 'Monday'])
  })

  it('is unreadable rather than showing a stale list when a read fails', async () => {
    silenceErrors()
    const { session } = await sessionOver(
      [{ at: '2026-03-13T10:00:00', body: 'Friday' }],
      {
        journal: (core) => ({
          ...core,
          notesForFilter: (filter) =>
            filter.from === '2026-03-09'
              ? Promise.reject(new Error('no database'))
              : core.notesForFilter(filter),
        }),
      },
    )

    await session.open()
    await session.moveTo(rangeForJournalDay('2026-03-09'))

    expect(session.snapshot().history).toEqual({ state: 'unreadable' })
  })

  it('clears the Nudge and the copy confirmation', async () => {
    const { session } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])

    await session.open()
    session.copy()
    await settle()
    await session.noteArrived('2026-03-16')
    expect(session.snapshot().nudgedDay).toBe('2026-03-16')
    expect(session.snapshot().confirmation).not.toBeNull()

    await session.moveTo(rangeForJournalDay('2026-03-16'))

    expect(session.snapshot().nudgedDay).toBeNull()
    expect(session.snapshot().confirmation).toBeNull()
  })

  it('lets only the newest of two overlapping reads reach the view', async () => {
    const slow = gate()
    const { session } = await sessionOver(
      [
        { at: '2026-03-09T10:00:00', body: 'Monday' },
        { at: '2026-03-13T10:00:00', body: 'Friday' },
      ],
      {
        journal: (core) => ({
          ...core,
          async notesForFilter(filter) {
            const notes = await core.notesForFilter(filter)
            await slow.reached(filter.from)
            return notes
          },
        }),
      },
    )

    await session.open()
    slow.hold('2026-03-09')
    slow.hold('2026-03-13')

    // Monday is asked for first and answers last: the reader acted on a Nudge
    // back to Friday while it was still in flight.
    const stale = session.moveTo(rangeForJournalDay('2026-03-09'))
    const fresh = session.moveTo(rangeForJournalDay('2026-03-13'))
    slow.release('2026-03-13')
    await fresh
    slow.release('2026-03-09')
    await stale

    expect(bodiesOf(session.snapshot())).toEqual(['Friday'])
  })
})

describe('narrowing the Filter by Project', () => {
  /** One Friday under two Projects, plus something Unfiled. */
  function friday() {
    return sessionOver([
      { at: '2026-03-13T10:00:00', body: '#api rate limits' },
      { at: '2026-03-13T11:00:00', body: 'read the postmortem' },
      { at: '2026-03-13T12:00:00', body: '#billing invoices' },
    ])
  }

  it('opens on Any, showing the day exactly as it did before', async () => {
    const { session } = await friday()

    await session.open()

    expect(session.snapshot().filter?.project).toEqual(ANY_PROJECT)
    expect(bodiesOf(session.snapshot())).toEqual([
      'invoices',
      'read the postmortem',
      'rate limits',
    ])
  })

  it('offers every Project on a Note, whatever the Filter shows', async () => {
    const { session } = await friday()

    await session.open()

    expect(session.snapshot().projects).toEqual(['api', 'billing'])
  })

  it('offers a Project only a Project Mapping names, whatever the Filter shows', async () => {
    const { session, core } = await friday()
    // One repository mapped to a stream nothing has been said under yet.
    await core.setProjectMapping('/code/site/.git', 'site')

    await session.open()

    expect(session.snapshot().projects).toEqual(['api', 'billing', 'site'])
  })

  it('shows one Project without moving the days', async () => {
    const { session } = await friday()

    await session.open()
    await session.narrowTo({ kind: 'named', name: 'api' })

    expect(bodiesOf(session.snapshot())).toEqual(['rate limits'])
    expect(session.snapshot().filter).toEqual({
      from: '2026-03-13',
      to: '2026-03-13',
      project: { kind: 'named', name: 'api' },
    })
  })

  it('shows only Unfiled Notes under Unfiled', async () => {
    const { session } = await friday()

    await session.open()
    await session.narrowTo(UNFILED)

    expect(bodiesOf(session.snapshot())).toEqual(['read the postmortem'])
  })

  it('shows an empty day rather than falling back to Any', async () => {
    const { session } = await friday()

    await session.open()
    await session.narrowTo({ kind: 'named', name: 'infra' })

    expect(bodiesOf(session.snapshot())).toEqual([])
  })

  it('copies the Digest of the narrowed Filter, Bodies only', async () => {
    const { session, clipboard } = await friday()

    await session.open()
    await session.narrowTo({ kind: 'named', name: 'api' })
    session.copy()
    await settle()

    expect(clipboard.written).toEqual(['- rate limits'])
    expect(session.snapshot().confirmation).toBe('Copied 1 note.')
  })

  it('holds the constraint while the day axis moves', async () => {
    const { session } = await sessionOver([
      { at: '2026-03-09T10:00:00', body: '#api the retry storm' },
      { at: '2026-03-09T11:00:00', body: 'Monday, unfiled' },
      { at: '2026-03-13T10:00:00', body: '#api rate limits' },
    ])

    await session.open()
    await session.narrowTo({ kind: 'named', name: 'api' })
    await session.moveTo(rangeForDays('2026-03-09', '2026-03-13'))

    expect(session.snapshot().filter?.project).toEqual({
      kind: 'named',
      name: 'api',
    })
    expect(bodiesOf(session.snapshot())).toEqual([
      'rate limits',
      'the retry storm',
    ])
  })

  it('holds the constraint while a Note arrives', async () => {
    const { session, capture } = await friday()

    await session.open()
    await session.narrowTo({ kind: 'named', name: 'api' })
    await capture('2026-03-13T13:00:00', '#billing another invoice')
    await session.noteArrived('2026-03-13')

    expect(session.snapshot().filter?.project).toEqual({
      kind: 'named',
      name: 'api',
    })
    expect(bodiesOf(session.snapshot())).toEqual(['rate limits'])
  })

  it('does not nudge for a Note the constraint excludes but the days hold', async () => {
    const { session, capture } = await friday()

    await session.open()
    await session.narrowTo({ kind: 'named', name: 'api' })
    await capture('2026-03-13T13:00:00', '#billing another invoice')
    await session.noteArrived('2026-03-13')

    expect(session.snapshot().nudgedDay).toBeNull()
  })

  it('still nudges for a Note outside the day range, Project or not', async () => {
    const { session, capture } = await friday()

    await session.open()
    await session.narrowTo({ kind: 'named', name: 'api' })
    await capture('2026-03-16T10:00:00', '#api Monday')
    await session.noteArrived('2026-03-16')

    expect(session.snapshot().nudgedDay).toBe('2026-03-16')
  })

  it('searches the whole journal regardless of the constraint, and keeps it', async () => {
    const { session } = await friday()

    await session.open()
    await session.narrowTo({ kind: 'named', name: 'api' })
    await session.search('invoices')

    // A Search is Body-only over every Note: the narrow is not a filter on it.
    expect(resultsOf(session.snapshot())).toEqual(['invoices'])
    expect(session.snapshot().filter?.project).toEqual({
      kind: 'named',
      name: 'api',
    })
  })

  it('gives the narrowed list back when a Search ends', async () => {
    const { session } = await friday()

    await session.open()
    await session.narrowTo({ kind: 'named', name: 'api' })
    await session.search('invoices')
    await session.search('')

    expect(bodiesOf(session.snapshot())).toEqual(['rate limits'])
  })

  it('narrows a Search off the screen, back to the Filter', async () => {
    const { session } = await friday()

    await session.open()
    await session.search('invoices')
    await session.narrowTo({ kind: 'named', name: 'api' })

    expect(session.snapshot().searching).toBe(false)
    expect(bodiesOf(session.snapshot())).toEqual(['rate limits'])
  })
})

describe('revealing a practice Note', () => {
  it('shows its day with no Project constraint, whatever narrowed before', async () => {
    const { session } = await sessionOver([
      { at: '2026-03-09T10:00:00', body: '#alpha Monday' },
      { at: '2026-03-11T10:00:00', body: 'Wednesday practice' },
    ])

    await session.open()
    await session.narrowTo({ kind: 'named', name: 'alpha' })
    await session.moveTo(rangeForJournalDay('2026-03-09'))

    await session.reveal('2026-03-11')

    expect(session.snapshot().filter).toEqual(anyProjectOn('2026-03-11'))
    expect(bodiesOf(session.snapshot())).toEqual(['Wednesday practice'])
  })

  it('lets a day the reader picks mid-read win over the reveal', async () => {
    const slow = gate()
    const { session } = await sessionOver(
      [
        { at: '2026-03-09T10:00:00', body: 'Monday' },
        { at: '2026-03-11T10:00:00', body: 'Wednesday practice' },
        { at: '2026-03-13T10:00:00', body: 'Friday' },
      ],
      {
        journal: (core) => ({
          ...core,
          async notesForFilter(filter) {
            const notes = await core.notesForFilter(filter)
            await slow.reached(filter.from)
            return notes
          },
        }),
      },
    )

    await session.open()
    await session.narrowTo({ kind: 'named', name: 'alpha' })
    slow.hold('2026-03-11')
    slow.hold('2026-03-13')

    // The reveal's single read is in flight when the reader picks Friday:
    // the newer choice wins by the session's newest-read rule.
    const revealing = session.reveal('2026-03-11')
    const chosen = session.moveTo(rangeForJournalDay('2026-03-13'))
    slow.release('2026-03-13')
    await chosen
    slow.release('2026-03-11')
    await revealing

    expect(session.snapshot().filter?.from).toBe('2026-03-13')
    expect(session.snapshot().filter?.to).toBe('2026-03-13')
    expect(bodiesOf(session.snapshot())).toEqual(['Friday'])
  })
})

describe('a Note arriving while History is open', () => {
  it('shows a Note filed under a day in the Filter', async () => {
    const { session, capture } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])

    await session.open()
    await capture('2026-03-13T11:00:00', 'Later on Friday')
    await session.noteArrived('2026-03-13')

    expect(bodiesOf(session.snapshot())).toEqual(['Later on Friday', 'Friday'])
    expect(session.snapshot().nudgedDay).toBeNull()
  })

  it('nudges rather than moving the Filter under the reader', async () => {
    const { session, capture } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])

    await session.open()
    await capture('2026-03-16T10:00:00', 'Monday')
    await session.noteArrived('2026-03-16')

    expect(session.snapshot().filter).toEqual(anyProjectOn('2026-03-13'))
    expect(bodiesOf(session.snapshot())).toEqual(['Friday'])
    expect(session.snapshot().nudgedDay).toBe('2026-03-16')
  })

  it('opens on the first Note ever captured, having had no Filter to hold', async () => {
    const { session, capture } = await sessionOver([])

    await session.open()
    expect(session.snapshot().history).toEqual({ state: 'empty' })

    await capture('2026-03-13T10:00:00', 'The first one')
    await session.noteArrived('2026-03-13')

    expect(session.snapshot().filter).toEqual(anyProjectOn('2026-03-13'))
    expect(bodiesOf(session.snapshot())).toEqual(['The first one'])
  })

  it('drops the Nudge once the reader acts on it', async () => {
    const { session, capture } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])

    await session.open()
    await capture('2026-03-16T10:00:00', 'Monday')
    await session.noteArrived('2026-03-16')
    session.dismissNudge()

    expect(session.snapshot().nudgedDay).toBeNull()
  })
})

describe('correcting a Note', () => {
  it('shows the reworded Body', async () => {
    const { session, notes } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])

    await session.open()
    await session.editBody(notes[0].id, 'Friday, reworded')

    expect(bodiesOf(session.snapshot())).toEqual(['Friday, reworded'])
  })

  it('shows the Note under its new Project', async () => {
    const { session, notes } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])

    await session.open()
    await session.editProject(notes[0].id, 'habic')

    expect(projectsOf(session.snapshot())).toEqual(['habic'])
  })

  it('drops a Note refiled out of the Filter from the list', async () => {
    const { session, notes } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
      { at: '2026-03-13T11:00:00', body: 'Also Friday' },
    ])

    await session.open()
    await session.refile(notes[0].id, '2026-03-09')

    expect(bodiesOf(session.snapshot())).toEqual(['Also Friday'])
  })

  it('drops a deleted Note from the list', async () => {
    const { session, notes } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
      { at: '2026-03-13T11:00:00', body: 'Also Friday' },
    ])

    await session.open()
    await session.delete(notes[1].id)

    expect(bodiesOf(session.snapshot())).toEqual(['Friday'])
  })

  it('leaves the list as it reads when the correction fails', async () => {
    silenceErrors()
    const { session } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])

    await session.open()
    await session.delete('no-such-note')

    expect(bodiesOf(session.snapshot())).toEqual(['Friday'])
  })

  it('says what did not happen when a correction fails', async () => {
    silenceErrors()
    const { session, notes } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])

    await session.open()

    await session.delete('no-such-note')
    expect(session.snapshot().problem).toBe('That Note could not be deleted.')

    await session.refile(notes[0].id, 'not-a-day')
    expect(session.snapshot().problem).toBe('That Note could not be refiled.')

    await session.editBody(notes[0].id, '   ')
    expect(session.snapshot().problem).toBe('That Note could not be reworded.')

    await session.editProject(notes[0].id, 'not a project!')
    expect(session.snapshot().problem).toBe(
      "That Note's Project could not be changed.",
    )
  })

  it('stops saying so once a correction works', async () => {
    silenceErrors()
    const { session, notes } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])

    await session.open()
    await session.delete('no-such-note')
    await session.editBody(notes[0].id, 'Friday, reworded')

    expect(session.snapshot().problem).toBeNull()
  })

  it('stops saying so once the Filter moves', async () => {
    silenceErrors()
    const { session } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])

    await session.open()
    await session.delete('no-such-note')
    await session.moveTo(rangeForJournalDay('2026-03-09'))

    expect(session.snapshot().problem).toBeNull()
  })
})

describe('renaming a Project', () => {
  it('shows the whole stream under its new name, across every day in the Filter', async () => {
    const { session } = await sessionOver([
      { at: '2026-03-09T10:00:00', body: '#api the retry storm' },
      { at: '2026-03-13T10:00:00', body: '#api rate limits' },
      { at: '2026-03-13T11:00:00', body: '#billing invoices' },
    ])

    await session.open()
    await session.moveTo(rangeForDays('2026-03-09', '2026-03-13'))
    await session.renameProject('api', 'backend')

    expect(projectsOf(session.snapshot())).toEqual([
      'billing',
      'backend',
      'backend',
    ])
  })

  it('keeps a narrowed Filter on the same stream under its new name', async () => {
    const { session } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: '#api rate limits' },
      { at: '2026-03-13T11:00:00', body: '#billing invoices' },
    ])

    await session.open()
    await session.narrowTo({ kind: 'named', name: 'api' })
    await session.renameProject('api', 'backend')

    expect(session.snapshot().filter?.project).toEqual({
      kind: 'named',
      name: 'backend',
    })
    expect(bodiesOf(session.snapshot())).toEqual(['rate limits'])
  })

  it('shows both streams merged once the target already existed', async () => {
    const { session } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: '#api rate limits' },
      { at: '2026-03-13T11:00:00', body: '#backend the retry storm' },
    ])

    await session.open()
    await session.narrowTo({ kind: 'named', name: 'api' })
    await session.renameProject('api', 'backend')

    // One stream now, under one name — not two options for the same filing.
    expect(session.snapshot().projects).toEqual(['backend'])
    expect(session.snapshot().filter?.project).toEqual({
      kind: 'named',
      name: 'backend',
    })
    expect(bodiesOf(session.snapshot())).toEqual([
      'the retry storm',
      'rate limits',
    ])
  })

  it('leaves the constraint alone when it is not the source', async () => {
    const { session } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: '#api rate limits' },
      { at: '2026-03-13T11:00:00', body: '#billing invoices' },
    ])

    await session.open()
    await session.narrowTo({ kind: 'named', name: 'billing' })
    await session.renameProject('api', 'backend')

    expect(session.snapshot().filter?.project).toEqual({
      kind: 'named',
      name: 'billing',
    })
    expect(session.snapshot().projects).toEqual(['backend', 'billing'])
    expect(bodiesOf(session.snapshot())).toEqual(['invoices'])
  })

  it('leaves Any and Unfiled exactly where they were', async () => {
    const { session } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: '#api rate limits' },
      { at: '2026-03-13T11:00:00', body: 'read the postmortem' },
    ])

    await session.open()
    await session.renameProject('api', 'backend')

    expect(session.snapshot().filter?.project).toEqual(ANY_PROJECT)
    // Newest first: the later Note is Unfiled, the earlier one was renamed.
    expect(projectsOf(session.snapshot())).toEqual([null, 'backend'])

    await session.narrowTo(UNFILED)
    await session.renameProject('backend', 'api')
    expect(session.snapshot().filter?.project).toEqual(UNFILED)
  })

  it('says so when the rename was refused, and leaves the list and constraint as they were', async () => {
    silenceErrors()
    const { session } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: '#api rate limits' },
    ])

    await session.open()
    await session.narrowTo({ kind: 'named', name: 'api' })
    await session.renameProject('no-such-project', 'backend')

    expect(session.snapshot().problem).toBe(
      'That Project could not be renamed.',
    )
    expect(session.snapshot().filter?.project).toEqual({
      kind: 'named',
      name: 'api',
    })
    expect(session.snapshot().projects).toEqual(['api'])
    expect(bodiesOf(session.snapshot())).toEqual(['rate limits'])
  })

  it('stops saying so once a rename works', async () => {
    silenceErrors()
    const { session } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: '#api rate limits' },
    ])

    await session.open()
    await session.renameProject('no-such-project', 'backend')
    await session.renameProject('api', 'backend')

    expect(session.snapshot().problem).toBeNull()
  })

  it('announces the change, so the tray hears about it too', async () => {
    const { session, announced } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: '#api rate limits' },
    ])
    await session.open()
    expect(announced.times).toBe(0)

    await session.renameProject('api', 'backend')

    expect(announced.times).toBe(1)
  })

  it('ends a Search, as every other act on the Project axis does', async () => {
    const { session } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: '#api rate limits' },
    ])

    await session.open()
    await session.narrowTo({ kind: 'named', name: 'api' })
    await session.search('limits')
    await session.renameProject('api', 'backend')

    expect(session.snapshot().searching).toBe(false)
    expect(bodiesOf(session.snapshot())).toEqual(['rate limits'])
    expect(session.snapshot().filter?.project).toEqual({
      kind: 'named',
      name: 'backend',
    })
  })

  it('leaves a Search exactly as the reader asked it when the rename is refused', async () => {
    silenceErrors()
    const { session } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: '#api rate limits' },
    ])

    await session.open()
    await session.search('limits')
    await session.renameProject('no-such-project', 'backend')

    expect(session.snapshot().searching).toBe(true)
    expect(resultsOf(session.snapshot())).toEqual(['rate limits'])
    expect(session.snapshot().problem).toBe(
      'That Project could not be renamed.',
    )
  })

  it('marks nothing edited, and reads nothing back, for a rename to the same name', async () => {
    const { session, notes } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: '#api rate limits' },
    ])

    await session.open()
    await session.renameProject('api', 'API')

    expect(session.snapshot().problem).toBeNull()
    expect(projectsOf(session.snapshot())).toEqual(['api'])
    expect(notes[0].editedAt).toBeNull()
  })

  it('stays quiet about a rename the record refused', async () => {
    silenceErrors()
    const { session, announced } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: '#api rate limits' },
    ])
    await session.open()

    await session.renameProject('no-such-project', 'backend')

    expect(announced.times).toBe(0)
  })
})

describe('searching the journal', () => {
  it('shows every matching Note in the journal, newest first, whatever the Filter', async () => {
    const { session } = await sessionOver([
      { at: '2026-03-09T10:00:00', body: 'planned the migration' },
      { at: '2026-03-11T10:00:00', body: 'nothing to do with it' },
      { at: '2026-03-13T10:00:00', body: 'ran the MIGRATION' },
    ])

    await session.open()
    await session.search('migration')

    expect(resultsOf(session.snapshot())).toEqual([
      'ran the MIGRATION',
      'planned the migration',
    ])
    // The Filter is where it was: a Search is a way in, not a narrowing.
    expect(session.snapshot().filter).toEqual(anyProjectOn('2026-03-13'))
  })

  it('asks nothing of the journal for a term of one character', async () => {
    const asked: string[] = []
    const { session } = await sessionOver(
      [{ at: '2026-03-13T10:00:00', body: 'Friday' }],
      {
        journal: (core) => ({
          ...core,
          notesMatching(term) {
            asked.push(term)
            return core.notesMatching(term)
          },
        }),
      },
    )

    await session.open()
    await session.search('F')

    expect(asked).toEqual([])
    expect(bodiesOf(session.snapshot())).toEqual(['Friday'])
    expect(session.snapshot().searching).toBe(false)
  })

  it('is showing a Search even when nothing matched', async () => {
    const { session } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])

    await session.open()
    await session.search('migration')

    expect(session.snapshot().history).toEqual({
      state: 'results',
      term: 'migration',
      notes: [],
    })
    expect(session.snapshot().searching).toBe(true)
  })

  it('holds the list still while a search is in flight, rather than loading', async () => {
    const slow = gate()
    const { session } = await sessionOver(
      [{ at: '2026-03-13T10:00:00', body: 'Friday' }],
      {
        journal: (core) => ({
          ...core,
          async notesMatching(term) {
            const notes = await core.notesMatching(term)
            await slow.reached(term)
            return notes
          },
        }),
      },
    )

    await session.open()
    slow.hold('Fri')
    const searching = session.search('Fri')
    await afterDebounce()

    expect(bodiesOf(session.snapshot())).toEqual(['Friday'])

    slow.release('Fri')
    await searching

    expect(resultsOf(session.snapshot())).toEqual(['Friday'])
  })

  it('lets only the newest of two overlapping searches reach the view', async () => {
    const slow = gate()
    const { session } = await sessionOver(
      [
        { at: '2026-03-13T10:00:00', body: 'the migration' },
        { at: '2026-03-13T11:00:00', body: 'the tray menu' },
      ],
      {
        journal: (core) => ({
          ...core,
          async notesMatching(term) {
            const notes = await core.notesMatching(term)
            await slow.reached(term)
            return notes
          },
        }),
      },
    )

    await session.open()
    slow.hold('migration')
    slow.hold('tray')

    // The reader kept typing: the first term is asked for first and answers
    // last, and must not land on top of the term they settled on.
    const stale = session.search('migration')
    await afterDebounce()
    const fresh = session.search('tray')
    slow.release('tray')
    await fresh
    slow.release('migration')
    await stale

    expect(resultsOf(session.snapshot())).toEqual(['the tray menu'])
    expect(session.snapshot().term).toBe('tray')
  })

  it('goes back to the Filter when the term drops below two characters', async () => {
    const { session } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])

    await session.open()
    await session.search('Fri')
    await session.search('')

    expect(bodiesOf(session.snapshot())).toEqual(['Friday'])
    expect(session.snapshot().term).toBe('')
    expect(session.snapshot().searching).toBe(false)
  })

  it('moves the Filter to the day a result is filed under, keeping the term', async () => {
    const { session } = await sessionOver([
      { at: '2026-03-09T10:00:00', body: 'planned the migration' },
      { at: '2026-03-09T11:00:00', body: 'and the rest of Monday' },
      { at: '2026-03-13T10:00:00', body: 'ran the migration' },
    ])

    await session.open()
    await session.search('migration')
    await session.moveTo(rangeForJournalDay('2026-03-09'))

    expect(session.snapshot().filter).toEqual(anyProjectOn('2026-03-09'))
    expect(bodiesOf(session.snapshot())).toEqual([
      'and the rest of Monday',
      'planned the migration',
    ])
    expect(session.snapshot().searching).toBe(false)
    expect(session.snapshot().term).toBe('migration')
  })

  it('nudges for a Note captured while results are showing, matching or not', async () => {
    const { session, capture } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'ran the migration' },
    ])

    await session.open()
    await session.search('migration')
    // Filed under the day in view, and matching the term: it still nudges,
    // because there is no Filter on screen for it to belong to.
    await capture('2026-03-13T11:00:00', 'the migration again')
    await session.noteArrived('2026-03-13')

    expect(session.snapshot().nudgedDay).toBe('2026-03-13')
    expect(resultsOf(session.snapshot())).toEqual(['ran the migration'])
  })

  it('closes the results when the reader acts on that Nudge', async () => {
    const { session, capture } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'ran the migration' },
    ])

    await session.open()
    await session.search('migration')
    await capture('2026-03-16T10:00:00', 'Monday')
    await session.noteArrived('2026-03-16')
    await session.moveTo(rangeForJournalDay('2026-03-16'))

    expect(bodiesOf(session.snapshot())).toEqual(['Monday'])
    expect(session.snapshot().nudgedDay).toBeNull()
    expect(session.snapshot().searching).toBe(false)
  })

  it('leaves the Digest bound to the Filter while a Search is showing', async () => {
    const { session, clipboard } = await sessionOver([
      { at: '2026-03-09T10:00:00', body: 'planned the migration' },
      { at: '2026-03-13T10:00:00', body: 'ran the migration' },
    ])

    await session.open()
    await session.search('migration')
    session.copy()
    await settle()

    expect(clipboard.written).toEqual(['- ran the migration'])
  })
})

describe('copying the Digest', () => {
  it('writes the whole Filter and says how many Notes went', async () => {
    const { session, clipboard } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
      { at: '2026-03-13T11:00:00', body: 'Also Friday' },
    ])

    await session.open()
    session.copy()
    await settle()

    expect(clipboard.written).toEqual(['- Friday\n- Also Friday'])
    expect(session.snapshot().confirmation).toBe('Copied 2 notes.')
  })

  it('copies the Digest as it was read, not the list on screen', async () => {
    const { session, notes, clipboard } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])

    await session.open()
    await session.editBody(notes[0].id, 'Friday, reworded')
    session.copy()
    await settle()

    expect(clipboard.written).toEqual(['- Friday, reworded'])
  })

  it('says there was nothing to copy rather than writing an empty Digest', async () => {
    const { session, clipboard } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])

    await session.open()
    await session.moveTo(rangeForJournalDay('2026-03-09'))
    session.copy()
    await settle()

    expect(clipboard.written).toEqual([])
    expect(session.snapshot().confirmation).toBe('No notes to copy.')
  })

  it('says so when the clipboard write fails', async () => {
    silenceErrors()
    const { session, clipboard } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])
    clipboard.fail(new Error('not allowed'))

    await session.open()
    session.copy()
    await settle()

    expect(session.snapshot().confirmation).toBe('Could not copy notes.')
  })

  it('holds the held Digest count for the copy control to preview', async () => {
    const { session } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
      { at: '2026-03-13T11:00:00', body: 'Also Friday' },
    ])

    expect(session.snapshot().noteCount).toBeNull()

    await session.open()
    expect(session.snapshot().noteCount).toBe(2)

    await session.moveTo(rangeForJournalDay('2026-03-09'))
    expect(session.snapshot().noteCount).toBe(0)
  })

  it('keeps the held count when a read fails, as the held Digest does', async () => {
    silenceErrors()
    const { session } = await sessionOver(
      [{ at: '2026-03-13T10:00:00', body: 'Friday' }],
      {
        journal: (core) => ({
          ...core,
          notesForFilter: (filter) =>
            filter.from === '2026-03-09'
              ? Promise.reject(new Error('no database'))
              : core.notesForFilter(filter),
        }),
      },
    )

    await session.open()
    expect(session.snapshot().noteCount).toBe(1)

    await session.moveTo(rangeForJournalDay('2026-03-09'))
    expect(session.snapshot().history).toEqual({ state: 'unreadable' })
    // The copy still carries the stale Digest, so the preview says so too.
    expect(session.snapshot().noteCount).toBe(1)
  })
})

describe('copying Review Material', () => {
  it('writes the Filter’s Notes and its completed work, naming which copy landed', async () => {
    const { session, core, clock, clipboard } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])

    clock.set(new Date('2026-03-13T11:00:00'))
    const kept = await core.createTask('kept Friday')
    await core.completeTask(kept.id)

    await session.open()
    await session.copyReviewMaterial()

    expect(clipboard.written).toHaveLength(1)
    expect(clipboard.written[0]).toContain('- Friday')
    expect(clipboard.written[0]).toContain('## Completed')
    expect(clipboard.written[0]).toContain('- [x] kept Friday')
    expect(session.snapshot().confirmation).toContain('notes + completed work')
  })

  it('embeds the Digest as it was read, so the two copies cannot disagree', async () => {
    const { session, core, notes, clipboard } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])

    await session.open()
    // The journal moves behind the session's back — another window's
    // correction, with no refresh yet — so a fresh read would describe Notes
    // the reader is no longer looking at.
    await core.editBody(notes[0].id, 'Friday, reworded elsewhere')
    await session.copyReviewMaterial()

    expect(clipboard.written).toHaveLength(1)
    expect(clipboard.written[0]).toContain('- Friday')
    expect(clipboard.written[0]).not.toContain('reworded')
  })

  it('copies a range whose only content is completed work', async () => {
    const { session, core, clock, clipboard } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])

    clock.set(new Date('2026-03-13T11:00:00'))
    const kept = await core.createTask('kept Friday')
    await core.completeTask(kept.id)

    await session.open()
    await session.moveTo(rangeForJournalDay('2026-03-09'))
    clock.set(new Date('2026-03-09T11:00:00'))
    const earlier = await core.createTask('kept earlier')
    await core.completeTask(earlier.id)
    await session.moveTo(rangeForJournalDay('2026-03-09'))
    await session.copyReviewMaterial()

    expect(clipboard.written).toHaveLength(1)
    expect(clipboard.written[0]).toContain('- [x] kept earlier')
    expect(clipboard.written[0]).not.toContain('Friday')
  })

  it('refuses under a named Project without writing, stating the rule', async () => {
    const { session, clipboard } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: '#api rate limits' },
    ])

    await session.open()
    await session.narrowTo({ kind: 'named', name: 'api' })
    await session.copyReviewMaterial()

    expect(clipboard.written).toEqual([])
    expect(session.snapshot().confirmation).toBe(
      'Completed work has no Project, so this is only offered for Any Project.',
    )
  })

  it('refuses under Unfiled without writing, stating the rule', async () => {
    const { session, clipboard } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])

    await session.open()
    await session.narrowTo(UNFILED)
    await session.copyReviewMaterial()

    expect(clipboard.written).toEqual([])
    expect(session.snapshot().confirmation).toBe(
      'Completed work has no Project, so this is only offered for Any Project.',
    )
  })

  it('refuses an empty range without writing', async () => {
    const { session, clipboard } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])

    await session.open()
    await session.moveTo(rangeForJournalDay('2026-03-09'))
    await session.copyReviewMaterial()

    expect(clipboard.written).toEqual([])
    expect(session.snapshot().confirmation).toBe(
      'No notes or completed work to copy.',
    )
  })

  it('says so when the clipboard write fails', async () => {
    silenceErrors()
    const { session, clipboard } = await sessionOver([
      { at: '2026-03-13T10:00:00', body: 'Friday' },
    ])
    clipboard.fail(new Error('not allowed'))

    await session.open()
    await session.copyReviewMaterial()

    expect(clipboard.written).toEqual([])
    expect(session.snapshot().confirmation).toBe(
      'Could not copy notes + completed work.',
    )
  })

  it('writes nothing when the Filter moved while the copy was in flight', async () => {
    const slow = gate()
    const { session, clipboard } = await sessionOver(
      [
        { at: '2026-03-09T10:00:00', body: 'Monday' },
        { at: '2026-03-13T10:00:00', body: 'Friday' },
      ],
      {
        journal: (core) => ({
          ...core,
          async completedTasks() {
            const tasks = await core.completedTasks()
            await slow.reached('copy')
            return tasks
          },
        }),
      },
    )

    await session.open()
    await session.moveTo(rangeForJournalDay('2026-03-09'))
    slow.hold('copy')

    // The copy is asked for Monday, but Friday lands first.
    const copying = session.copyReviewMaterial()
    await session.moveTo(rangeForJournalDay('2026-03-13'))
    slow.release('copy')
    await copying

    expect(clipboard.written).toEqual([])
  })
})

describe('announcing a change to the journal', () => {
  it('says so when a Note is deleted', async () => {
    const { session, notes, announced } = await sessionOver([
      { at: '2026-03-09T09:00:00', body: 'the migration landed' },
    ])
    await session.open()
    expect(announced.times).toBe(0)

    await session.delete(notes[0].id)

    expect(announced.times).toBe(1)
  })

  it('says so when a Note is refiled onto another day', async () => {
    const { session, notes, announced } = await sessionOver([
      { at: '2026-03-09T09:00:00', body: 'the migration landed' },
    ])
    await session.open()

    await session.refile(notes[0].id, '2026-03-08')

    expect(announced.times).toBe(1)
  })

  it('stays quiet about a correction the record refused', async () => {
    const { session, notes, announced } = await sessionOver(
      [{ at: '2026-03-09T09:00:00', body: 'the migration landed' }],
      {
        journal: (core) => ({
          ...core,
          delete: () => Promise.reject(new Error('no database')),
        }),
      },
    )
    await session.open()

    await session.delete(notes[0].id)

    expect(session.snapshot().problem).not.toBeNull()
    expect(announced.times).toBe(0)
  })

  it('stays quiet about merely reading', async () => {
    const { session, announced } = await sessionOver([
      { at: '2026-03-09T09:00:00', body: 'the migration landed' },
    ])
    await session.open()

    await session.moveTo(rangeForJournalDay('2026-03-08'))
    await session.search('migration')
    await settle()

    expect(announced.times).toBe(0)
  })
})

describe('a sweep importing meetings while History is open', () => {
  it('shows them, without nudging: a sweep is not the user', async () => {
    const { session, core } = await sessionOver([
      { at: '2026-03-09T09:00:00', body: 'the migration landed' },
    ])
    await session.open()

    await core.importMeeting({
      id: 'event-1',
      calendarId: 'work',
      title: 'Weekly sync',
      startsAt: new Date('2026-03-09T11:00:00').getTime(),
      endsAt: new Date('2026-03-09T11:30:00').getTime(),
      isAllDay: false,
      isDeclined: false,
    })
    await session.refresh()

    expect(bodiesShown(session.snapshot())).toEqual([
      'Weekly sync',
      'the migration landed',
    ])
    expect(session.snapshot().nudgedDay).toBeNull()
  })

  it('leaves a Search exactly as the reader asked it', async () => {
    const { session, capture } = await sessionOver([
      { at: '2026-03-09T09:00:00', body: 'the migration landed' },
    ])
    await session.open()
    await session.search('migration')
    await settle()

    await capture('2026-03-09T11:00:00', 'another migration note')
    await session.refresh()

    expect(session.snapshot().searching).toBe(true)
    expect(session.snapshot().history).toMatchObject({ state: 'results' })
  })

  it('opens on the day when the journal had nothing in it at all', async () => {
    const { session, capture } = await sessionOver([])
    await session.open()
    expect(session.snapshot().history).toMatchObject({ state: 'empty' })

    await capture('2026-03-09T11:00:00', 'the migration landed')
    await session.refresh()

    expect(bodiesShown(session.snapshot())).toEqual(['the migration landed'])
  })
})

/** Every Body on screen, newest first, whatever day it is filed under. */
function bodiesShown(snapshot: HistorySnapshot): string[] {
  const history = snapshot.history
  if (history.state !== 'notes') return []
  return history.days.flatMap((day) => day.notes.map((note) => note.body))
}

/**
 * A session over a real database holding the given Notes, plus the collaborators
 * a test needs to drive it: the clipboard it writes to, a way to capture more
 * Notes behind its back, and every snapshot it has announced.
 */
async function sessionOver(
  captured: Array<{ at: string; body: string }>,
  { journal = (core: Journal) => core }: { journal?: (core: Journal) => Journal } = {},
) {
  const { driver, close } = await openTestDatabase()
  openDatabases.push(close)

  const clock = fixedClock(new Date('2026-03-09T10:00:00'))
  const core = createJournal({ clock, driver })

  const notes: Note[] = []
  async function capture(at: string, body: string) {
    clock.set(new Date(at))
    const note = await core.capture(body)
    if (note === null) throw new Error('nothing was captured')
    notes.push(note)
    return note
  }

  for (const note of captured) {
    await capture(note.at, note.body)
  }

  const clipboard = recordingClipboard()
  const seen: HistorySnapshot[] = []
  // Every time the session said the Notes are no longer what they were. Only
  // the count matters: the announcement carries nothing.
  const announced = { times: 0 }
  const session = createHistorySession({
    journal: Promise.resolve(journal(core)),
    clipboard: clipboard.write,
    announceChange: () => {
      announced.times += 1
    },
    onChange: (snapshot) => seen.push(snapshot),
  })

  return { session, core, clock, capture, notes, clipboard, seen, announced }
}

function recordingClipboard() {
  const written: string[] = []
  let failure: Error | null = null

  return {
    written,
    fail: (error: Error) => {
      failure = error
    },
    write: (text: string) => {
      if (failure !== null) return Promise.reject(failure)
      written.push(text)
      return Promise.resolve()
    },
  }
}

/** A read held open until a test lets it through, keyed by the day asked for. */
function gate() {
  const held = new Map<string, Array<() => void>>()

  return {
    /** From now on, a read of this day waits to be released. */
    hold(key: string) {
      held.set(key, [])
    },
    reached(key: string) {
      const queue = held.get(key)
      if (queue === undefined) return Promise.resolve()
      return new Promise<void>((resolve) => queue.push(resolve))
    },
    release(key: string) {
      for (const resolve of held.get(key) ?? []) resolve()
      held.delete(key)
    },
  }
}

/** The bodies on screen, in the order the list shows them. */
function bodiesOf(snapshot: HistorySnapshot): string[] {
  if (snapshot.history.state !== 'notes') {
    throw new Error(`History is ${snapshot.history.state}, not notes`)
  }
  return snapshot.history.days.flatMap((day) =>
    day.notes.map((note) => note.body),
  )
}

/** The Projects on screen, in the order the list shows them. */
function projectsOf(snapshot: HistorySnapshot): Array<string | null> {
  if (snapshot.history.state !== 'notes') {
    throw new Error(`History is ${snapshot.history.state}, not notes`)
  }
  return snapshot.history.days.flatMap((day) =>
    day.notes.map((note) => note.project),
  )
}

/** The bodies of a Search's results, in the order the list shows them. */
function resultsOf(snapshot: HistorySnapshot): string[] {
  if (snapshot.history.state !== 'results') {
    throw new Error(`History is ${snapshot.history.state}, not results`)
  }
  return snapshot.history.notes.map((note) => note.body)
}

/** Lets a `copy()` — deliberately not awaitable — finish before asserting. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Long enough for one debounced search to be asked for, and no longer. */
function afterDebounce() {
  return new Promise((resolve) => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 10))
}

function silenceErrors() {
  vi.spyOn(console, 'error').mockImplementation(() => {})
}
