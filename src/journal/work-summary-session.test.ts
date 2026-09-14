import { describe, expect, it, vi } from 'vitest'
import type { DayRange, Journal } from './journal'
import { fixedClock } from './testing/database'
import { fakeDesktop } from '../platform/testing/desktop'
import {
  createWorkSummarySession,
  type WorkSummaryState,
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
    seen: WorkSummaryState[]
    onChange: (state: WorkSummaryState) => void
  } {
    const seen: WorkSummaryState[] = []
    return { seen, onChange: (state) => seen.push(state) }
  }

  it('reads the opening range on start', async () => {
    const seenRanges: DayRange[] = []
    const { journal } = stubJournal(seenRanges)
    const { seen, onChange } = states()
    const session = createWorkSummarySession({
      journal: Promise.resolve(journal),
      desktop: fakeDesktop(),
      clock: fixedClock('2026-03-12T09:00:00'),
      range: WEEK,
      onChange,
    })

    await session.start()
    session.stop()

    expect(seenRanges).toEqual([WEEK])
    expect(seen.at(-1)).toMatchObject({ state: 'ready' })
  })

  it('re-reads within the moved range when the view moves it', async () => {
    const seenRanges: DayRange[] = []
    const { journal } = stubJournal(seenRanges)
    const { seen, onChange } = states()
    const session = createWorkSummarySession({
      journal: Promise.resolve(journal),
      desktop: fakeDesktop(),
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

    const delivered = seen.filter((state) => state.state === 'ready')
    expect(delivered.at(-1)).toMatchObject({
      state: 'ready',
      selection: { from: MONDAY.from, to: MONDAY.to },
    })
  })

  it('never lands an older range’s material over a newer selection', async () => {
    const seenRanges: DayRange[] = []
    const { journal, releaseFirst } = stubJournal(seenRanges, true)
    const { seen, onChange } = states()
    const session = createWorkSummarySession({
      journal: Promise.resolve(journal),
      desktop: fakeDesktop(),
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
      expect(seen.some((state) => state.state === 'ready')).toBe(true)
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    session.stop()

    const delivered = seen.filter((state) => state.state === 'ready')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      selection: { from: MONDAY.from, to: MONDAY.to },
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
