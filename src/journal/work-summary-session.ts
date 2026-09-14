/**
 * Sequencing for the Work Summary section: one read on open, refreshes when
 * Notes or Tasks change, and a rollover when the calendar day moves. The
 * range starts as the view's This-week preset and moves whenever the view's
 * own date-range control says so; every read selects within whichever range
 * is current when it is asked, and only the newest read may reach the view —
 * so a slower read for an older range can never land over a newer selection.
 * The view renders what this session delivers, and does not own the
 * coordination.
 */

import type { Desktop, Unlisten } from '@/platform/desktop'
import {
  msUntilNextJournalDay,
  type Clock,
  type DayRange,
  type Journal,
} from './journal'
import {
  selectWorkSummary,
  type WorkSummarySelection,
} from './work-summary'

export type WorkSummaryState =
  | { state: 'loading' }
  | { state: 'ready'; selection: WorkSummarySelection }
  | { state: 'unreadable' }

export interface WorkSummarySession {
  /** Starts listening and reads the material for the first time. */
  start(): Promise<void>
  /** Gives up all listeners and the calendar rollover. */
  stop(): void
  /**
   * Moves the selected range and re-reads within it. The view owns the
   * control; this only sequences the read, newest-read-wins as everywhere
   * else. Never generates: reading is not asking the model.
   */
  setRange(next: DayRange): void
}

export function createWorkSummarySession({
  journal,
  desktop,
  clock,
  range,
  onChange,
}: {
  journal: Promise<Journal>
  desktop: Desktop
  clock: Clock
  /** The range the opening read selects within — owned by the view. */
  range: DayRange
  onChange: (state: WorkSummaryState) => void
}): WorkSummarySession {
  let running = false
  let rollover: ReturnType<typeof setTimeout> | null = null
  let unlisten: Unlisten[] = []
  let latestRead = 0
  let generation = 0
  // Whichever range the view last chose. Refreshes re-read the data within
  // it; they never move it.
  let current = range

  function isCurrent(startGeneration: number): boolean {
    return running && generation === startGeneration
  }

  async function read(): Promise<void> {
    const readTicket = ++latestRead
    // The range this read selects within, fixed while it is in flight: a
    // newer move starts a newer read rather than rewriting this one.
    const selecting = current

    try {
      const resolvedJournal = await journal
      const selection = await selectWorkSummary({
        journal: resolvedJournal,
        range: selecting,
      })
      if (!running || latestRead !== readTicket) return
      onChange({ state: 'ready', selection })
    } catch (error) {
      console.error('could not read the Work Summary material', error)
      if (running && latestRead === readTicket) onChange({ state: 'unreadable' })
    }
  }

  function armRollover(startGeneration: number): void {
    if (!isCurrent(startGeneration)) return

    rollover = setTimeout(() => {
      if (!isCurrent(startGeneration)) return
      void read().then(() => armRollover(startGeneration))
    }, msUntilNextJournalDay(clock.now()))
  }

  return {
    async start() {
      const startGeneration = ++generation
      running = true
      const refresh = () => {
        if (isCurrent(startGeneration)) void read()
      }
      const stopListening = await Promise.all([
        desktop.onJournalChanged(refresh),
        desktop.onTasksChanged(refresh),
        desktop.onWindowFocused(refresh),
        desktop.onSystemWoke(refresh),
      ])

      if (!isCurrent(startGeneration)) {
        for (const stop of stopListening) stop()
        return
      }

      unlisten = stopListening
      await read()
      armRollover(startGeneration)
    },

    stop() {
      running = false
      generation += 1
      latestRead += 1
      if (rollover !== null) clearTimeout(rollover)
      rollover = null
      for (const stop of unlisten) stop()
      unlisten = []
    },

    setRange(next: DayRange) {
      current = next
      if (running) void read()
    },
  }
}
