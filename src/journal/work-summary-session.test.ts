import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppSettings } from '@/settings/app-settings'
import type { WorkSummaryResponse } from '@/platform/desktop'
import { createJournal, type DayRange, type Journal } from './journal'
import { fixedClock, openTestDatabase } from './testing/database'
import { fakeDesktop } from '../platform/testing/desktop'
import {
  createWorkSummarySession,
  type WorkSummarySnapshot,
  type WorkSummarySession,
} from './work-summary-session'

function stubJournal(seen: DayRange[], holdFirstDigest = false) {
  // selectWorkSummary reads the range through `digest` and
  // `occurrencesKeptIn`; recording it on `digest` is enough to say which
  // range a read selected within.
  let releaseFirst: (() => void) | null = null
  const firstHeld =
    holdFirstDigest
      ? new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
      : null
  let calls = 0
  return {
    journal: {
      digest: async (range: DayRange) => {
        calls += 1
        seen.push({ ...range })
        if (firstHeld !== null && calls === 1) await firstHeld
        return { markdown: '', noteCount: 0 }
      },
      completedTasks: async () => [],
      occurrencesKeptIn: async () => [],
      openTasks: async () => [],
    } as unknown as Journal,
    releaseFirst: () => releaseFirst?.(),
  }
}

describe('Work Summary session startup', () => {
  it('stops every subscription across a start-stop-start lifecycle', async () => {
    const desktop = fakeDesktop()
    const installed: Array<() => void> = []
    const pendingStops: Array<(stop: () => void) => void> = []
    let stopped = 0

    function subscribe(handle: () => void): Promise<() => void> {
      installed.push(handle)
      return new Promise((resolve) => pendingStops.push(resolve))
    }

    desktop.onJournalChanged = subscribe
    desktop.onTasksChanged = subscribe
    desktop.onWindowFocused = subscribe
    desktop.onSystemWoke = subscribe

    const session = createWorkSummarySession({
      journal: Promise.resolve({
        digest: async () => ({ markdown: '', noteCount: 0 }),
        completedTasks: async () => [],
        occurrencesKeptIn: async () => [],
        openTasks: async () => [],
      } as unknown as Journal),
      desktop,
      settings: createAppSettings(desktop),
      clock: fixedClock('2026-03-12T09:00:00'),
      range: { from: '2026-03-09', to: '2026-03-12' },
      onChange: vi.fn(),
    })

    const firstStart = session.start()
    expect(installed).toHaveLength(4)

    session.stop()
    const secondStart = session.start()
    expect(installed).toHaveLength(8)

    for (const resolve of pendingStops) {
      resolve(() => {
        stopped += 1
      })
    }

    await Promise.all([firstStart, secondStart])
    session.stop()

    expect(stopped).toBe(8)
  })
})

describe('Work Summary session range', () => {
  const WEEK = { from: '2026-03-09', to: '2026-03-12' }
  const MONDAY = { from: '2026-03-09', to: '2026-03-09' }

  function states(): {
    seen: WorkSummarySnapshot[]
    onChange: (state: WorkSummarySnapshot) => void
  } {
    const seen: WorkSummarySnapshot[] = []
    return { seen, onChange: (state) => seen.push(state) }
  }

  it('reads the opening range on start', async () => {
    const seenRanges: DayRange[] = []
    const { journal } = stubJournal(seenRanges)
    const { seen, onChange } = states()
    const session = createWorkSummarySession({
      journal: Promise.resolve(journal),
      desktop: fakeDesktop(),
      settings: createAppSettings(fakeDesktop()),
      clock: fixedClock('2026-03-12T09:00:00'),
      range: WEEK,
      onChange,
    })

    await session.start()
    session.stop()

    expect(seenRanges).toEqual([WEEK])
    expect(seen.at(-1)).toMatchObject({ material: { state: 'ready' } })
  })

  it('re-reads within the moved range when the view moves it', async () => {
    const seenRanges: DayRange[] = []
    const { journal } = stubJournal(seenRanges)
    const { seen, onChange } = states()
    const session = createWorkSummarySession({
      journal: Promise.resolve(journal),
      desktop: fakeDesktop(),
      settings: createAppSettings(fakeDesktop()),
      clock: fixedClock('2026-03-12T09:00:00'),
      range: WEEK,
      onChange,
    })

    await session.start()
    session.setRange(MONDAY)
    await vi.waitFor(() => {
      expect(seenRanges).toEqual([WEEK, MONDAY])
    })
    session.stop()

    const delivered = seen.filter((state) => state.material.state === 'ready')
    expect(delivered.at(-1)).toMatchObject({
      material: { state: 'ready', selection: { from: MONDAY.from, to: MONDAY.to } },
    })
  })

  it('never lands an older range’s material over a newer selection', async () => {
    const seenRanges: DayRange[] = []
    const { journal, releaseFirst } = stubJournal(seenRanges, true)
    const { seen, onChange } = states()
    const session = createWorkSummarySession({
      journal: Promise.resolve(journal),
      desktop: fakeDesktop(),
      settings: createAppSettings(fakeDesktop()),
      clock: fixedClock('2026-03-12T09:00:00'),
      range: WEEK,
      onChange,
    })

    // The opening read is held inside the journal; the move's read lands
    // first and must stand when the held one finally resolves.
    const starting = session.start()
    await vi.waitFor(() => {
      expect(seenRanges).toEqual([WEEK])
    })
    session.setRange(MONDAY)
    await vi.waitFor(() => {
      expect(seenRanges).toEqual([WEEK, MONDAY])
    })
    releaseFirst()
    await starting
    // Let the released older read resolve and attempt its delivery.
    await vi.waitFor(() => {
      expect(seen.some((state) => state.material.state === 'ready')).toBe(true)
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    session.stop()

    const delivered = seen.filter((state) => state.material.state === 'ready')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      material: { selection: { from: MONDAY.from, to: MONDAY.to } },
    })
  })

  it('re-reads a refresh within the moved range, not the opening one', async () => {
    const seenRanges: DayRange[] = []
    const { journal } = stubJournal(seenRanges)
    const desktop = fakeDesktop()
    const { onChange } = states()
    const session = createWorkSummarySession({
      journal: Promise.resolve(journal),
      desktop,
      settings: createAppSettings(desktop),
      clock: fixedClock('2026-03-12T09:00:00'),
      range: WEEK,
      onChange,
    })

    await session.start()
    session.setRange(MONDAY)
    await vi.waitFor(() => {
      expect(seenRanges).toEqual([WEEK, MONDAY])
    })
    desktop.focus()
    await vi.waitFor(() => {
      expect(seenRanges).toEqual([WEEK, MONDAY, MONDAY])
    })
    session.stop()
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const WEEK = { from: '2026-03-09', to: '2026-03-12' }
const MONDAY = { from: '2026-03-09', to: '2026-03-09' }
const dispose: Array<() => void> = []

afterEach(() => {
  for (const close of dispose.splice(0)) close()
})

async function coordinationAt({ empty = false } = {}) {
  const { driver, close } = await openTestDatabase()
  const clock = fixedClock('2026-03-12T09:00:00')
  const journal = createJournal({ driver, clock })
  if (!empty) await journal.capture('Original note')
  const desktop = fakeDesktop({
    driver,
    stored: { modelBaseUrl: 'https://example.com/v1', model: 'request-model' },
  })
  const settings = createAppSettings(desktop)
  const onChange = vi.fn<(snapshot: WorkSummarySnapshot) => void>()
  const session = createWorkSummarySession({
    journal: Promise.resolve(journal),
    desktop,
    settings,
    clock,
    range: WEEK,
    onChange,
  })
  dispose.push(() => {
    session.stop()
    close()
  })
  // Await a delivered read rather than a verdict that could still belong to
  // the previous selection. All refresh triggers use the production seam.
  async function refresh(announce: () => void = () => desktop.announceJournalChanged()) {
    const before = onChange.mock.calls.length
    announce()
    await vi.waitFor(() => {
      expect(onChange.mock.calls.length).toBeGreaterThan(before)
    })
  }
  return { session, journal, desktop, settings, clock, onChange, refresh }
}

async function selected(session: WorkSummarySession, range: DayRange) {
  await vi.waitFor(() => {
    expect(session.snapshot().material).toMatchObject({
      state: 'ready', selection: range,
    })
    expect(session.snapshot().awaitingRange).toBe(false)
  })
}

describe('Work Summary generation coordination', () => {
  it('captures the request before settings load and excludes overlapping Generate attempts', async () => {
    const { session, settings, journal, desktop, clock, refresh } = await coordinationAt()
    const stored = await settings.load()
    const preparation = deferred<typeof stored>()
    settings.load = () => preparation.promise

    await session.start()
    const generating = session.generate()
    await session.generate()
    expect(session.snapshot().canGenerate).toBe(false)
    expect(desktop.workSummaryRequests).toHaveLength(0)

    session.setRange({ from: '2026-03-12', to: '2026-03-12' })
    await journal.capture('Changed note')
    await refresh()
    expect(session.snapshot().material).toMatchObject({
      state: 'ready', selection: { digest: { noteCount: 2 } },
    })
    clock.set(new Date('2026-03-12T10:00:00'))
    preparation.resolve(stored)
    await generating
    session.stop()

    expect(desktop.workSummaryRequests).toHaveLength(1)
    expect(desktop.workSummaryRequests[0].userContent).toContain('- Original note')
    expect(desktop.workSummaryRequests[0].userContent).not.toContain('Changed note')
    expect(session.snapshot()).toMatchObject({
      summary: {
        from: '2026-03-09',
        to: '2026-03-12',
        model: 'request-model',
        markdown: 'The work summary the model wrote.',
        generatedAt: new Date('2026-03-12T10:00:00'),
        material: desktop.workSummaryRequests[0].userContent,
      },
      outdated: true,
    })
  })
})

describe('Work Summary material readiness', () => {
  it.each(['loading', 'unreadable', 'empty', 'mismatched range'])(
    'refuses generation and copying for %s material before reading settings',
    async (condition) => {
      const { session, journal, desktop, settings } = await coordinationAt({ empty: condition === 'empty' })
      const load = vi.spyOn(settings, 'load')
      const digest = deferred<Awaited<ReturnType<Journal['digest']>>>()
      const read = journal.digest.bind(journal)
      if (condition === 'loading') journal.digest = () => digest.promise
      if (condition === 'unreadable') {
        journal.digest = async () => { throw new Error('unreadable') }
      }
      const starting = session.start()
      if (condition !== 'loading') await starting
      if (condition === 'mismatched range') {
        journal.digest = () => digest.promise
        session.setRange(MONDAY)
      }

      expect(session.snapshot().canGenerate).toBe(false)
      expect(session.snapshot().canCopyMaterial).toBe(false)
      await session.generate()
      expect(load).not.toHaveBeenCalled()
      expect(desktop.workSummaryRequests).toHaveLength(0)
      if (condition === 'loading' || condition === 'mismatched range') {
        digest.resolve(await read(condition === 'loading' ? WEEK : MONDAY))
        await starting
        await selected(session, condition === 'loading' ? WEEK : MONDAY)
      }
    },
  )
})

describe('Work Summary retained results and freshness', () => {
  it('names the pending model and keeps the exact request when records change during the call', async () => {
    const { session, journal, desktop, clock, refresh } = await coordinationAt()
    const answer = deferred<WorkSummaryResponse>()
    const generate = desktop.generateWorkSummary.bind(desktop)
    desktop.generateWorkSummary = async (request) => {
      await generate(request)
      return answer.promise
    }
    await session.start()
    const generating = session.generate()
    await vi.waitFor(() => {
      expect(session.snapshot().pending).toBe('request-model')
    })
    await session.generate()
    expect(session.snapshot().canCopyMaterial).toBe(true)
    await journal.capture('A later note')
    await refresh()
    clock.set(new Date('2026-03-12T11:00:00'))
    answer.resolve({ state: 'generated', markdown: 'The original work.' })
    await generating

    expect(desktop.workSummaryRequests).toHaveLength(1)
    expect(session.snapshot()).toMatchObject({
      pending: null,
      canGenerate: true,
      outdated: true,
      summary: {
        markdown: 'The original work.',
        generatedAt: clock.now(),
        material: desktop.workSummaryRequests[0].userContent,
      },
    })
    expect(session.snapshot().summary!.material).not.toContain('A later note')
  })

  it('compares rendered inputs across unchanged refreshes, range returns, and unreadable refreshes', async () => {
    const { session, journal, desktop, refresh } = await coordinationAt()
    await session.start()
    await session.generate()
    const original = session.snapshot().summary
    await refresh(() => desktop.focus())
    expect(session.snapshot().outdated).toBe(false)
    session.setRange(MONDAY)
    expect(session.snapshot().outdated).toBe(true)
    await selected(session, MONDAY)
    session.setRange(WEEK)
    await selected(session, WEEK)
    expect(session.snapshot().outdated).toBe(false)

    const digest = journal.digest.bind(journal)
    journal.digest = async () => {
      throw new Error('unreadable')
    }
    await refresh()
    expect(session.snapshot()).toMatchObject({ material: { state: 'unreadable' }, outdated: false })
    journal.digest = digest
    await journal.capture('A later note')
    await refresh()
    expect(session.snapshot().outdated).toBe(true)
    journal.digest = async () => {
      throw new Error('unreadable')
    }
    await refresh()
    expect(session.snapshot()).toMatchObject({ material: { state: 'unreadable' }, outdated: true })
    expect(session.snapshot().summary).toBe(original)
    expect(desktop.workSummaryRequests).toHaveLength(1)
  })

  it('retains prose and provenance after failed preparation and regeneration, and replaces them only on success', async () => {
    const { session, journal, desktop, settings, clock, refresh } = await coordinationAt()
    await session.start()
    await session.generate()
    const original = session.snapshot().summary
    await journal.capture('A later note')
    await refresh()
    const stored = await settings.load()
    const preparation = deferred<typeof stored>()
    settings.load = () => preparation.promise
    const failedPreparation = session.generate()
    preparation.reject(new Error('settings unreadable'))
    await failedPreparation
    expect(session.snapshot()).toMatchObject({ failure: { kind: 'local' }, outdated: true })
    expect(session.snapshot().summary).toBe(original)
    expect(session.snapshot().canCopyMaterial).toBe(true)
    expect(desktop.workSummaryRequests).toHaveLength(1)

    settings.load = async () => stored
    desktop.workSummaryResponse = { state: 'failed', failure: { kind: 'timeout' } }
    await session.generate()
    expect(session.snapshot()).toMatchObject({ failure: { kind: 'timeout' }, pending: null, outdated: true })
    expect(session.snapshot().summary).toBe(original)
    expect(session.snapshot().canCopyMaterial).toBe(true)

    clock.set(new Date('2026-03-12T12:00:00'))
    desktop.workSummaryResponse = { state: 'generated', markdown: 'The new work.' }
    await session.generate()
    expect(session.snapshot()).toMatchObject({
      failure: null,
      outdated: false,
      summary: { markdown: 'The new work.', generatedAt: clock.now() },
    })
    expect(session.snapshot().summary).not.toBe(original)
    expect(desktop.workSummaryRequests).toHaveLength(3)
  })

  it('keeps material copyable without Model Access and never generates on reads, range changes or restarts', async () => {
    const { session, settings, desktop, refresh } = await coordinationAt()
    await settings.saveModel('')
    await session.start()
    await refresh(() => desktop.wake())
    session.setRange(MONDAY)
    await selected(session, MONDAY)
    session.setRange(WEEK)
    await selected(session, WEEK)
    session.stop()
    await session.start()
    expect(desktop.workSummaryRequests).toHaveLength(0)
    expect(session.snapshot().canCopyMaterial).toBe(true)
    await session.generate()
    expect(session.snapshot()).toMatchObject({ failure: { kind: 'model-access' }, canCopyMaterial: true })
    expect(desktop.workSummaryRequests).toHaveLength(0)
  })
})

describe('Work Summary source changes', () => {
  it('outdates reworded Notes and completed Tasks', async () => {
    const { session, journal, refresh, desktop } = await coordinationAt({ empty: true })
    const note = await journal.capture('Original wording')
    const task = await journal.createTask('A commitment')
    await session.start()
    await session.generate()
    await journal.editBody(note!.id, 'Reworded note')
    await refresh()
    expect(session.snapshot().outdated).toBe(true)
    await session.generate()
    expect(session.snapshot().outdated).toBe(false)
    await journal.completeTask(task.id)
    await refresh(() => desktop.announceTasksChanged())
    expect(session.snapshot().outdated).toBe(true)
    expect(desktop.workSummaryRequests).toHaveLength(2)
  })

  it('compares selected Task Details while ignoring unchanged or unselected details', async () => {
    const { session, journal, clock, desktop, refresh } = await coordinationAt()
    clock.set(new Date('2026-03-02T09:00:00'))
    const old = await journal.createTask('Outside selected period', null, null, 'Old context')
    await journal.completeTask(old.id)
    clock.set(new Date('2026-03-12T09:00:00'))
    const current = await journal.createTask('Current commitment', null, null, 'Current context')
    await session.start()
    await session.generate()
    await journal.editTask(old.id, { description: old.description, details: 'Outside edit', schedule: null })
    await refresh(() => desktop.announceTasksChanged())
    expect(session.snapshot().outdated).toBe(false)
    await journal.editTask(current.id, { description: current.description, details: current.details, schedule: null })
    await refresh(() => desktop.announceTasksChanged())
    expect(session.snapshot().outdated).toBe(false)
    await journal.editTask(current.id, { description: current.description, details: 'New context', schedule: null })
    await refresh(() => desktop.announceTasksChanged())
    expect(session.snapshot().outdated).toBe(true)
    expect(desktop.workSummaryRequests).toHaveLength(1)
  })

  it('does not deliver a read from an earlier start over a restarted selection', async () => {
    const { session, journal, onChange } = await coordinationAt()
    const held = deferred<Awaited<ReturnType<Journal['digest']>>>()
    const digest = journal.digest.bind(journal)
    let reads = 0
    journal.digest = (range) => ++reads === 1 ? held.promise : digest(range)
    const firstStart = session.start()
    await vi.waitFor(() => expect(reads).toBe(1))
    session.stop()
    session.setRange(MONDAY)
    await session.start()
    const restarted = session.snapshot()
    const deliveries = onChange.mock.calls.length
    held.resolve({ markdown: '- Obsolete material', noteCount: 1 })
    await firstStart
    expect(session.snapshot()).toEqual(restarted)
    expect(onChange).toHaveBeenCalledTimes(deliveries)
    expect(session.snapshot().material).toMatchObject({ state: 'ready', selection: MONDAY })
  })
})
