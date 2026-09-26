import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createJournal,
  rangeForJournalDay,
  type Clock,
  type Journal,
} from './journal'
import { fixedClock, openTestDatabase } from './testing/database'
import {
  fakeDesktop,
  type FakeCommit,
  type FakeRepository,
  type FakeUnreadablePath,
} from '../platform/testing/desktop'
import type { PauseLength } from '../platform/desktop'
import { createAppSettings, type AppSettings } from '../settings/app-settings'
import {
  addRepository,
  pauseObserving,
  removeRepository,
  resumeObserving,
  setIdentities,
  setIgnoredPrefixes,
  turnObserving,
} from '../settings/observing'
import { createObserveSession, OBSERVE_INTERVAL_MS } from './observe-session'

// The commit sweep, driven end to end: a real journal over real SQL, a fake
// desktop for the repositories and the settings file, and an injected clock.
// What is asserted is what ended up in the journal. Consent is given through
// the same settings the Settings window writes, at the instant the clock
// reads, so every test says when the user said yes.

const openJournals: Array<() => void> = []

afterEach(() => {
  for (const close of openJournals.splice(0)) close()
})

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

const ME = 'me@example.com'

/** One commit, authored at a wall-clock time in the machine's own zone. */
function commit(
  hash: string,
  subject: string,
  authoredAt: string,
  author = ME,
): FakeCommit {
  return { hash, subject, authoredAt: new Date(authoredAt).getTime(), author }
}

function repository(name: string, commits: FakeCommit[] = []): FakeRepository {
  return { repository: `/code/${name}/.git`, commits }
}

async function observeSessionAt(
  instant: string,
  repositories: Record<string, FakeRepository | FakeUnreadablePath> = {},
  /** The clock the whole stack reads; a test about arrival passes one that ticks. */
  clock: Clock & { set(next: Date): void } = fixedClock(instant),
) {
  const { driver, close } = await openTestDatabase()
  openJournals.push(close)
  const journal = createJournal({ clock, driver })
  const desktop = fakeDesktop({ driver, repositories })
  const settings = createAppSettings(desktop, clock)
  const session = createObserveSession({
    journal: Promise.resolve(journal),
    desktop,
    settings,
    clock,
  })
  return { journal, desktop, clock, settings, session, driver }
}

/** Lists a repository with the user's identity ticked, as Settings would. */
async function list(settings: AppSettings, name: string, identities = [ME]) {
  await settings.updateObserving((observing, now) =>
    setIdentities(
      addRepository(
        observing,
        {
          path: `/code/${name}`,
          repository: `/code/${name}/.git`,
          identities: [],
          ignoredPrefixes: [],
        },
        now,
      ),
      `/code/${name}/.git`,
      identities,
    ),
  )
}

/** The same, from one directory of a repository — one worktree of it. */
async function listFrom(settings: AppSettings, path: string, repository: string) {
  await settings.updateObserving((observing, now) =>
    setIdentities(
      addRepository(
        observing,
        { path, repository, identities: [], ignoredPrefixes: [] },
        now,
      ),
      repository,
      [ME],
    ),
  )
}

async function turn(settings: AppSettings, enabled: boolean) {
  await settings.updateObserving((observing, now) => turnObserving(observing, enabled, now))
}

async function pause(settings: AppSettings, length: PauseLength) {
  await settings.updateObserving((observing, now) => pauseObserving(observing, length, now))
}

async function resume(settings: AppSettings) {
  await settings.updateObserving((observing, now) => resumeObserving(observing, now))
}

/** The Bodies filed under one day, oldest first, as a Digest would read them. */
async function bodiesOn(journal: Journal, journalDay: string) {
  const notes = await journal.notesForFilter(rangeForJournalDay(journalDay))
  return notes.map((note) => note.body).reverse()
}

/** What one day's Notes arrived filed under, oldest first. */
async function filingOn(journal: Journal, journalDay: string) {
  const notes = await journal.notesForFilter(rangeForJournalDay(journalDay))
  return notes
    .map((note) => ({ body: note.body, project: note.project }))
    .reverse()
}

/** Lets a sweep the session started on its own finish before asserting. */
async function flushSweep(): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve()
}

describe('a day of commits', () => {
  it('becomes Observed Notes across two repositories, each on the day it was authored', async () => {
    const { journal, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b2', 'Fix the second scrollbar on Settings', '2026-03-09T22:10'),
          commit('b1', 'Observe: the third Note origin', '2026-03-09T21:30'),
        ]),
        '/code/site': repository('site', [
          commit('s1', 'Publish the changelog page', '2026-03-09T21:45'),
        ]),
      },
    )
    await turn(settings, true)
    await list(settings, 'work-journal-ai')
    await list(settings, 'site')

    clock.set(new Date('2026-03-09T23:00:00'))
    await session.start()

    expect(await bodiesOn(journal, '2026-03-09')).toEqual([
      'Observe: the third Note origin',
      'Publish the changelog page',
      'Fix the second scrollbar on Settings',
    ])
    const [note] = await journal.notesForFilter(rangeForJournalDay('2026-03-09'))
    expect(note).toMatchObject({
      origin: 'observe',
      project: null,
      source: 'commit',
      sourceKey: 'b2@/code/work-journal-ai/.git',
      capturedAt: new Date('2026-03-09T22:10').toISOString(),
    })
  })

  it('writes one sweep\'s commits oldest first, so the last Note to arrive is the newest produced', async () => {
    // A clock that ticks on every read, as the app's own does between one
    // Note and the next: what is written later arrives later, and one sweep
    // writes what it brought the other way round from the walk. The last Note
    // to arrive is then the newest produced of the sweep — the reader's own
    // order would leave it the oldest.
    let tick = new Date('2026-03-09T08:00:00').getTime()
    const ticking: Clock & { set(next: Date): void } = {
      now: () => new Date((tick += 1000)),
      set: (next) => {
        tick = next.getTime()
      },
    }
    const { journal, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b3', 'Newest of the sweep', '2026-03-09T09:30'),
          commit('b2', 'Middle of the sweep', '2026-03-09T09:00'),
          commit('b1', 'Oldest of the sweep', '2026-03-09T08:30'),
        ]),
      },
      ticking,
    )
    await turn(settings, true)
    await list(settings, 'work-journal-ai')

    await session.start()

    expect((await journal.lastCommitNote('/code/work-journal-ai/.git'))?.body).toBe(
      'Newest of the sweep',
    )
  })

  it('never brings in a commit by an identity the user has not named', async () => {
    const { journal, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b2', 'Theirs', '2026-03-09T10:00', 'maintainer@example.com'),
          commit('b1', 'Mine', '2026-03-09T09:00'),
        ]),
      },
    )
    await turn(settings, true)
    await list(settings, 'work-journal-ai')

    clock.set(new Date('2026-03-09T12:00:00'))
    await session.start()

    expect(await bodiesOn(journal, '2026-03-09')).toEqual(['Mine'])
  })

  it('lands silently: a sweep never Nudges, and only says the Notes changed', async () => {
    const { desktop, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b1', 'Mine', '2026-03-09T09:00'),
        ]),
      },
    )
    await turn(settings, true)
    await list(settings, 'work-journal-ai')
    const nudged: string[] = []
    await desktop.onNoteCaptured((journalDay) => nudged.push(journalDay))
    let changed = 0
    await desktop.onJournalChanged(() => (changed += 1))

    clock.set(new Date('2026-03-09T12:00:00'))
    await session.start()
    desktop.wake()
    await flushSweep()

    expect(nudged).toEqual([])
    // Once for the Note that arrived, and not again for a sweep that found
    // nothing new.
    expect(changed).toBe(1)
  })
})

describe('the Project Mapping', () => {
  it('files a day of commits across two mapped repositories under the right Project, on the right day', async () => {
    const { journal, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b2', 'Fix the second scrollbar on Settings', '2026-03-09T22:10'),
          commit('b1', 'Observe: the third Note origin', '2026-03-09T21:30'),
        ]),
        '/code/site': repository('site', [
          commit('s1', 'Publish the changelog page', '2026-03-09T21:45'),
        ]),
      },
    )
    await turn(settings, true)
    await list(settings, 'work-journal-ai')
    await list(settings, 'site')
    await journal.setProjectMapping('/code/work-journal-ai/.git', 'journal')
    await journal.setProjectMapping('/code/site/.git', 'site')

    clock.set(new Date('2026-03-09T23:00:00'))
    await session.start()

    expect(await filingOn(journal, '2026-03-09')).toEqual([
      { body: 'Observe: the third Note origin', project: 'journal' },
      { body: 'Publish the changelog page', project: 'site' },
      { body: 'Fix the second scrollbar on Settings', project: 'journal' },
    ])
  })

  it('files two worktrees of one repository under the same Project', async () => {
    const worktree = {
      repository: '/code/work-journal-ai/.git',
      commits: [] as FakeCommit[],
    }
    const { journal, desktop, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': {
          ...worktree,
          commits: [commit('b1', 'From the first worktree', '2026-03-09T09:00')],
        },
        '/code/work-journal-ai-262': {
          ...worktree,
          commits: [commit('b2', 'From the second worktree', '2026-03-09T10:00')],
        },
      },
    )
    await turn(settings, true)
    await listFrom(settings, '/code/work-journal-ai', '/code/work-journal-ai/.git')
    await journal.setProjectMapping('/code/work-journal-ai/.git', 'journal')

    clock.set(new Date('2026-03-09T11:00:00'))
    await session.start()

    expect(await filingOn(journal, '2026-03-09')).toEqual([
      { body: 'From the first worktree', project: 'journal' },
    ])

    // The repository taken off the list and added again from its other
    // worktree — a different directory, the same repository. The mapping keys
    // on the repository, so the second worktree's commit is filed under it
    // without anything being mapped again.
    await settings.updateObserving((observing, now) =>
      removeRepository(observing, '/code/work-journal-ai/.git', now),
    )
    await listFrom(
      settings,
      '/code/work-journal-ai-262',
      '/code/work-journal-ai/.git',
    )

    clock.set(new Date('2026-03-09T12:00:00'))
    desktop.wake()
    await flushSweep()

    expect(await filingOn(journal, '2026-03-09')).toEqual([
      { body: 'From the first worktree', project: 'journal' },
      { body: 'From the second worktree', project: 'journal' },
    ])
  })

  it('leaves a repository with no mapping Unfiled, inferring nothing from its path', async () => {
    const { journal, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b1', 'Nothing from a path', '2026-03-09T09:00'),
        ]),
      },
    )
    await turn(settings, true)
    await list(settings, 'work-journal-ai')

    clock.set(new Date('2026-03-09T12:00:00'))
    await session.start()

    // The directory is called work-journal-ai, and the repository with it —
    // and that names nothing here.
    expect(await filingOn(journal, '2026-03-09')).toEqual([
      { body: 'Nothing from a path', project: null },
    ])
  })

  it('never moves a Note the user has filed by hand, however often it sweeps', async () => {
    const { journal, desktop, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b1', 'Mine', '2026-03-09T09:00'),
        ]),
      },
    )
    await turn(settings, true)
    await list(settings, 'work-journal-ai')
    await journal.setProjectMapping('/code/work-journal-ai/.git', 'journal')

    clock.set(new Date('2026-03-09T12:00:00'))
    await session.start()
    const [observed] = await journal.notesForFilter(
      rangeForJournalDay('2026-03-09'),
    )
    await journal.editProject(observed!.id, 'by-hand')
    await journal.setProjectMapping('/code/work-journal-ai/.git', 'elsewhere')

    clock.set(new Date('2026-03-09T14:00:00'))
    desktop.wake()
    await flushSweep()

    // The Note is filed where the reader put it, there is still only one of
    // it, and the mapping says what new work will arrive as.
    expect(await filingOn(journal, '2026-03-09')).toEqual([
      { body: 'Mine', project: 'by-hand' },
    ])
    expect(await journal.projectMapping('/code/work-journal-ai/.git')).toBe(
      'elsewhere',
    )
  })
})

describe('what is swept at all', () => {
  it('is nothing while Observing is off', async () => {
    const { journal, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b1', 'Mine', '2026-03-09T09:00'),
        ]),
      },
    )
    await list(settings, 'work-journal-ai')

    clock.set(new Date('2026-03-09T12:00:00'))
    await session.start()

    expect(await bodiesOn(journal, '2026-03-09')).toEqual([])
  })

  it('is nothing while no repository is chosen: nothing is read', async () => {
    const { desktop, settings, session } = await observeSessionAt('2026-03-09T08:00:00')
    await turn(settings, true)
    const read = vi.spyOn(desktop, 'repositoryCommits')

    await session.start()

    expect(read).not.toHaveBeenCalled()
  })

  it('is nothing from a repository with no identity ticked, though it is still read', async () => {
    const { journal, desktop, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b1', 'Mine', '2026-03-09T09:00'),
        ]),
      },
    )
    await turn(settings, true)
    await list(settings, 'work-journal-ai', [])
    const read = vi.spyOn(desktop, 'repositoryCommits')

    clock.set(new Date('2026-03-09T12:00:00'))
    await session.start()

    // Read for what the repository says about itself and nothing more: one
    // that gains its first commit with nobody ticked moves on from "nothing
    // on its branches yet", and Settings has to hear that — while no commit
    // is read for anyone.
    expect(read).toHaveBeenCalledWith('/code/work-journal-ai', [], expect.any(Number))
    expect(await bodiesOn(journal, '2026-03-09')).toEqual([])
  })
})

describe('what a sweep says about the repositories', () => {
  it('says one reads differently, and repeats nothing', async () => {
    const { desktop, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b1', 'Mine', '2026-03-09T09:00'),
        ]),
      },
    )
    await turn(settings, true)
    await list(settings, 'work-journal-ai')
    let moved = 0
    await desktop.onRepositoryStateChanged(() => (moved += 1))

    clock.set(new Date('2026-03-09T12:00:00'))
    await session.start()

    // First sight is not a change: whoever is reading has just read.
    expect(moved).toBe(0)

    // The folder goes away. Nothing in the journal says so — the next sweep
    // is the only thing that sees it, and it is what speaks.
    desktop.repositories['/code/work-journal-ai'] = 'missing'
    desktop.wake()
    await flushSweep()
    expect(moved).toBe(1)

    // Still gone: nothing moved, nothing said.
    desktop.wake()
    await flushSweep()
    expect(moved).toBe(1)
  })

  it('says it again when a repository that could not be read starts working', async () => {
    const { desktop, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      { '/code/fresh': { repository: '/code/fresh/.git', commits: [], noHead: true } },
    )
    await turn(settings, true)
    // Nobody ticked: its commits are never anybody's, and still the
    // repository moves on and says so.
    await list(settings, 'fresh', [])
    let moved = 0
    await desktop.onRepositoryStateChanged(() => (moved += 1))

    clock.set(new Date('2026-03-09T12:00:00'))
    await session.start()
    expect(moved).toBe(0)

    // The first commit lands — and becomes no Note at all.
    desktop.repositories['/code/fresh'] = {
      repository: '/code/fresh/.git',
      commits: [commit('f1', 'First', '2026-03-09T11:00')],
    }
    desktop.wake()
    await flushSweep()

    expect(moved).toBe(1)
  })
})

describe('consent', () => {
  it('observes nothing from before the enablement instant', async () => {
    const { journal, clock, settings, session } = await observeSessionAt(
      '2026-03-09T18:40:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b2', 'After', '2026-03-09T18:41'),
          commit('b1', 'Before', '2026-03-09T09:30'),
        ]),
      },
    )
    await list(settings, 'work-journal-ai')
    await turn(settings, true)

    clock.set(new Date('2026-03-09T18:45:00'))
    await session.start()

    expect(await bodiesOn(journal, '2026-03-09')).toEqual(['After'])
  })

  it('observes nothing from the gap between a disable and a re-enable, across a restart', async () => {
    const { journal, desktop, clock, settings, driver } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b3', 'After', '2026-03-09T11:30'),
          commit('b2', 'In the gap', '2026-03-09T10:30'),
          commit('b1', 'Before', '2026-03-09T09:00'),
        ]),
      },
    )
    await list(settings, 'work-journal-ai')
    await turn(settings, true)
    clock.set(new Date('2026-03-09T10:00:00'))
    await turn(settings, false)
    clock.set(new Date('2026-03-09T11:00:00'))
    await turn(settings, true)

    // A restart: nothing survives but the settings file and the journal.
    clock.set(new Date('2026-03-09T12:00:00'))
    const restarted = createObserveSession({
      journal: Promise.resolve(createJournal({ clock, driver })),
      desktop,
      settings: createAppSettings(desktop, clock),
      clock,
    })
    await restarted.start()

    expect(await bodiesOn(journal, '2026-03-09')).toEqual(['Before', 'After'])
  })

  it('observes nothing from the gap a repository was off the list for, when the sweep meets it after the re-add', async () => {
    const { journal, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b3', 'After', '2026-03-09T11:30'),
          commit('b2', 'Off the list', '2026-03-09T10:30'),
          commit('b1', 'Before', '2026-03-09T09:30'),
        ]),
      },
    )
    await turn(settings, true)
    await list(settings, 'work-journal-ai')
    clock.set(new Date('2026-03-09T10:00:00'))
    await settings.updateObserving((observing, now) =>
      removeRepository(observing, '/code/work-journal-ai/.git', now),
    )
    clock.set(new Date('2026-03-09T11:00:00'))
    await list(settings, 'work-journal-ai')

    clock.set(new Date('2026-03-09T12:00:00'))
    await session.start()

    expect(await bodiesOn(journal, '2026-03-09')).toEqual(['Before', 'After'])
  })

  it('keeps one repository’s gap from excluding another repository’s work', async () => {
    const { journal, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b1', 'Off the list', '2026-03-09T10:30'),
        ]),
        '/code/site': repository('site', [
          commit('s1', 'Listed all along', '2026-03-09T10:30'),
        ]),
      },
    )
    await turn(settings, true)
    await list(settings, 'work-journal-ai')
    await list(settings, 'site')
    clock.set(new Date('2026-03-09T10:00:00'))
    await settings.updateObserving((observing, now) =>
      removeRepository(observing, '/code/work-journal-ai/.git', now),
    )
    clock.set(new Date('2026-03-09T11:00:00'))
    await list(settings, 'work-journal-ai')

    clock.set(new Date('2026-03-09T12:00:00'))
    await session.start()

    expect(await bodiesOn(journal, '2026-03-09')).toEqual(['Listed all along'])
  })
})

describe('a pause', () => {
  it('excludes the work done during it, whenever the sweep comes to meet it', async () => {
    const { journal, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b3', 'After the pause', '2026-03-09T11:30'),
          commit('b2', 'During the pause', '2026-03-09T10:30'),
          commit('b1', 'Before the pause', '2026-03-09T09:30'),
        ]),
      },
    )
    await list(settings, 'work-journal-ai')
    await turn(settings, true)
    clock.set(new Date('2026-03-09T10:00:00'))
    await pause(settings, 'an-hour')
    clock.set(new Date('2026-03-09T11:00:00'))
    await resume(settings)

    // Nothing is looked at until noon: the pause has been over for an hour
    // by the time the sweep meets any of it.
    clock.set(new Date('2026-03-09T12:00:00'))
    await session.start()

    expect(await bodiesOn(journal, '2026-03-09')).toEqual([
      'Before the pause',
      'After the pause',
    ])
  })

  it('is still in force across a restart', async () => {
    const { journal, desktop, clock, settings, driver } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b2', 'During the pause', '2026-03-09T10:30'),
          commit('b1', 'Before the pause', '2026-03-09T09:30'),
        ]),
      },
    )
    await list(settings, 'work-journal-ai')
    await turn(settings, true)
    clock.set(new Date('2026-03-09T10:00:00'))
    await pause(settings, 'until-resumed')

    // A restart: nothing survives but the settings file and the journal.
    clock.set(new Date('2026-03-09T12:00:00'))
    const restarted = createObserveSession({
      journal: Promise.resolve(createJournal({ clock, driver })),
      desktop,
      settings: createAppSettings(desktop, clock),
      clock,
    })
    await restarted.start()

    expect(await bodiesOn(journal, '2026-03-09')).toEqual(['Before the pause'])
  })

  it('accumulates: several pause/resume pairs each exclude their own interval', async () => {
    const { journal, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b5', 'End of the day', '2026-03-09T16:00'),
          commit('b4', 'In the second pause', '2026-03-09T14:30'),
          commit('b3', 'Between the pauses', '2026-03-09T13:00'),
          commit('b2', 'In the first pause', '2026-03-09T10:15'),
          commit('b1', 'Start of the day', '2026-03-09T09:00'),
        ]),
      },
    )
    await list(settings, 'work-journal-ai')
    await turn(settings, true)
    clock.set(new Date('2026-03-09T10:00:00'))
    await pause(settings, 'an-hour')
    clock.set(new Date('2026-03-09T10:30:00'))
    await resume(settings)
    clock.set(new Date('2026-03-09T14:00:00'))
    await pause(settings, 'until-resumed')
    clock.set(new Date('2026-03-09T15:00:00'))
    await resume(settings)

    clock.set(new Date('2026-03-09T17:00:00'))
    await session.start()

    expect(await bodiesOn(journal, '2026-03-09')).toEqual([
      'Start of the day',
      'Between the pauses',
      'End of the day',
    ])
  })

  it('excludes the work of a repository added while it is in force', async () => {
    const { journal, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b1', 'Before the pause', '2026-03-09T09:30'),
        ]),
        '/code/site': repository('site', [
          commit('s1', 'During the pause', '2026-03-09T10:30'),
        ]),
      },
    )
    await list(settings, 'work-journal-ai')
    await turn(settings, true)
    clock.set(new Date('2026-03-09T10:00:00'))
    await pause(settings, 'until-resumed')
    clock.set(new Date('2026-03-09T10:15:00'))
    await list(settings, 'site')

    clock.set(new Date('2026-03-09T12:00:00'))
    await session.start()

    expect(await bodiesOn(journal, '2026-03-09')).toEqual(['Before the pause'])
  })
})

describe('the lookback', () => {
  async function consentedSince(instant: string, commits: FakeCommit[]) {
    const setup = await observeSessionAt(instant, {
      '/code/work-journal-ai': repository('work-journal-ai', commits),
    })
    await turn(setup.settings, true)
    await list(setup.settings, 'work-journal-ai')
    return setup
  }

  it('files a commit authored at 23:40 and first swept after midnight on the day it was authored', async () => {
    const { journal, clock, session } = await consentedSince('2026-03-09T08:00:00', [
      commit('b1', 'Before closing the lid', '2026-03-09T23:40'),
    ])

    clock.set(new Date('2026-03-10T08:30:00'))
    await session.start()

    expect(await bodiesOn(journal, '2026-03-09')).toEqual(['Before closing the lid'])
    expect(await bodiesOn(journal, '2026-03-10')).toEqual([])
  })

  it('files one fetched three days later on the day it was authored', async () => {
    const { journal, clock, session } = await consentedSince('2026-03-09T08:00:00', [
      commit('b1', 'Merged on GitHub', '2026-03-09T16:00'),
    ])

    clock.set(new Date('2026-03-12T09:00:00'))
    await session.start()

    expect(await bodiesOn(journal, '2026-03-09')).toEqual(['Merged on GitHub'])
  })

  it('never brings in one authored more than seven days before the sweep', async () => {
    const { journal, clock, session } = await consentedSince('2026-03-01T08:00:00', [
      commit('b1', 'Too long ago', '2026-03-01T09:00'),
    ])

    clock.set(new Date('2026-03-08T09:30:00'))
    await session.start()

    expect(await bodiesOn(journal, '2026-03-01')).toEqual([])
  })
})

describe('ignored prefixes', () => {
  it('make nothing of a matching commit, and let it arrive once the prefix is removed', async () => {
    const { journal, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b2', 'Release 0.15.1 (#257)', '2026-03-09T10:00'),
          commit('b1', 'Fix the second scrollbar', '2026-03-09T09:00'),
        ]),
      },
    )
    await turn(settings, true)
    await list(settings, 'work-journal-ai')
    await settings.updateObserving((observing) =>
      setIgnoredPrefixes(observing, '/code/work-journal-ai/.git', ['Release ']),
    )

    clock.set(new Date('2026-03-09T12:00:00'))
    await session.start()
    expect(await bodiesOn(journal, '2026-03-09')).toEqual(['Fix the second scrollbar'])

    await settings.updateObserving((observing) =>
      setIgnoredPrefixes(observing, '/code/work-journal-ai/.git', []),
    )
    await flushSweep()

    expect(await bodiesOn(journal, '2026-03-09')).toEqual([
      'Fix the second scrollbar',
      'Release 0.15.1 (#257)',
    ])
  })
})

describe('a Note that has come into existence', () => {
  it('stands after its commit is amended or dropped', async () => {
    const { journal, desktop, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b1', 'Draft wording', '2026-03-09T09:00'),
        ]),
      },
    )
    await turn(settings, true)
    await list(settings, 'work-journal-ai')
    clock.set(new Date('2026-03-09T12:00:00'))
    await session.start()

    // Amended: a new hash, the old one gone.
    desktop.repositories['/code/work-journal-ai'] = repository('work-journal-ai', [])
    desktop.wake()
    await flushSweep()

    expect(await bodiesOn(journal, '2026-03-09')).toEqual(['Draft wording'])
  })

  it('stays gone once deleted: the next sweep does not bring its commit back', async () => {
    const { journal, desktop, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b1', 'Refused', '2026-03-09T09:00'),
        ]),
      },
    )
    await turn(settings, true)
    await list(settings, 'work-journal-ai')
    clock.set(new Date('2026-03-09T12:00:00'))
    await session.start()

    const [observed] = await journal.notesForFilter(rangeForJournalDay('2026-03-09'))
    await journal.delete(observed.id)
    desktop.wake()
    await vi.advanceTimersByTimeAsync(OBSERVE_INTERVAL_MS * 2)
    await flushSweep()

    expect(await bodiesOn(journal, '2026-03-09')).toEqual([])
  })
})

describe('sweeping again', () => {
  it('looks on wake, when a Capture begins, on the interval, and when Observing changes', async () => {
    const { journal, desktop, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      { '/code/work-journal-ai': repository('work-journal-ai') },
    )
    await turn(settings, true)
    await list(settings, 'work-journal-ai')
    clock.set(new Date('2026-03-09T12:00:00'))
    await session.start()

    const arrive = (hash: string, subject: string) => {
      const found = desktop.repositories['/code/work-journal-ai'] as FakeRepository
      found.commits.unshift(commit(hash, subject, '2026-03-09T11:00'))
    }

    arrive('w', 'On wake')
    desktop.wake()
    await flushSweep()
    arrive('c', 'On a Capture')
    desktop.beginCapture()
    await flushSweep()
    arrive('i', 'On the interval')
    await vi.advanceTimersByTimeAsync(OBSERVE_INTERVAL_MS)
    await flushSweep()
    arrive('o', 'On a change')
    await settings.updateObserving((observing) => observing)
    await flushSweep()

    expect(await bodiesOn(journal, '2026-03-09')).toHaveLength(4)
  })

  it('never overlaps itself: a Note is never written twice for one commit', async () => {
    const { journal, desktop, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b1', 'Once', '2026-03-09T09:00'),
        ]),
      },
    )
    await turn(settings, true)
    await list(settings, 'work-journal-ai')
    clock.set(new Date('2026-03-09T12:00:00'))

    const starting = session.start()
    desktop.wake()
    desktop.beginCapture()
    await starting
    await flushSweep()

    expect(await bodiesOn(journal, '2026-03-09')).toEqual(['Once'])
  })

  it('stops for good once it is stopped', async () => {
    const { journal, desktop, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      { '/code/work-journal-ai': repository('work-journal-ai') },
    )
    await turn(settings, true)
    await list(settings, 'work-journal-ai')
    clock.set(new Date('2026-03-09T12:00:00'))
    await session.start()
    session.stop()

    desktop.repositories['/code/work-journal-ai'] = repository('work-journal-ai', [
      commit('b1', 'Too late', '2026-03-09T11:00'),
    ])
    desktop.wake()
    await vi.advanceTimersByTimeAsync(OBSERVE_INTERVAL_MS * 2)
    await flushSweep()

    expect(await bodiesOn(journal, '2026-03-09')).toEqual([])
  })
})

describe('a subject with a line break in it', () => {
  it('becomes one line, and never stops the commits behind it', async () => {
    const { journal, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b2', 'Carriage\rreturn', '2026-03-09T10:00'),
          commit('b1', 'Older', '2026-03-09T09:00'),
        ]),
      },
    )
    await turn(settings, true)
    await list(settings, 'work-journal-ai')

    clock.set(new Date('2026-03-09T12:00:00'))
    await session.start()

    expect(await bodiesOn(journal, '2026-03-09')).toEqual(['Older', 'Carriage return'])
  })

  it('never stops the commits behind one the journal refuses', async () => {
    const { journal, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': repository('work-journal-ai', [
          commit('b2', 'Refused', '2026-03-09T10:00'),
          commit('b1', 'Older', '2026-03-09T09:00'),
        ]),
      },
    )
    await turn(settings, true)
    await list(settings, 'work-journal-ai')
    const observe = journal.observe
    journal.observe = (event) =>
      event.body === 'Refused' ? Promise.reject(new Error('no')) : observe(event)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    clock.set(new Date('2026-03-09T12:00:00'))
    await session.start()

    expect(await bodiesOn(journal, '2026-03-09')).toEqual(['Older'])
  })
})

describe('a repository that cannot be read', () => {
  it('is a gap: the others are still read, and nothing is asked', async () => {
    const { journal, desktop, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
      {
        '/code/work-journal-ai': 'denied',
        '/code/site': repository('site', [
          commit('s1', 'Still read', '2026-03-09T09:00'),
        ]),
      },
    )
    await turn(settings, true)
    await list(settings, 'work-journal-ai')
    await list(settings, 'site')
    // A reason is never a prompt, an alert or a Nudge: the sweep says only
    // that the Notes changed, and only when they did.
    const nudges: string[] = []
    await desktop.onNoteCaptured((journalDay) => nudges.push(journalDay))

    clock.set(new Date('2026-03-09T12:00:00'))
    await session.start()

    expect(await bodiesOn(journal, '2026-03-09')).toEqual(['Still read'])
    expect(nudges).toEqual([])
    expect(desktop.reconciliations).toEqual([])
    expect(desktop.prompted).toBe(false)
  })

  it('leaves the journal working when the reader itself fails', async () => {
    const { journal, desktop, clock, settings, session } = await observeSessionAt(
      '2026-03-09T08:00:00',
    )
    await turn(settings, true)
    await list(settings, 'work-journal-ai')
    desktop.repositoryCommits = () => Promise.reject(new Error('git crashed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    clock.set(new Date('2026-03-09T12:00:00'))
    await expect(session.start()).resolves.toBeUndefined()

    await journal.capture('the migration landed')
    expect(await bodiesOn(journal, '2026-03-09')).toEqual(['the migration landed'])
  })
})
