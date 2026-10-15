/**
 * Orders material reads and explicit generation for one Main Window. Range
 * controls live in React; this session keeps request snapshots, paid-for
 * results and the last readable freshness verdict together. Nothing persists.
 */

import type { Desktop, Unlisten, WorkSummaryFailure } from '@/platform/desktop'
import type { AppSettings } from '@/settings/app-settings'
import { workSummarySystemPrompt } from '@/settings/settings'
import {
  msUntilNextJournalDay,
  type Clock,
  type DayRange,
  type Journal,
} from './journal'
import {
  buildWorkSummaryMaterial,
  selectWorkSummary,
  workSummaryRefuses,
  type WorkSummarySelection,
} from './work-summary'

export type WorkSummaryState =
  | { state: 'loading' }
  | { state: 'ready'; selection: WorkSummarySelection }
  | { state: 'unreadable' }

/** Immutable provenance of the material sent by one explicit Generate. */
export interface GeneratedSummary extends DayRange {
  markdown: string
  model: string
  material: string
  generatedAt: Date
}

export interface WorkSummarySnapshot {
  material: WorkSummaryState
  summary: GeneratedSummary | null
  /** The model's name once preparation has succeeded. */
  pending: string | null
  failure: WorkSummaryFailure | null
  outdated: boolean
  /** A new range is chosen but its material has not arrived. */
  awaitingRange: boolean
  canCopyMaterial: boolean
  /** Also excludes overlapping requests while settings are loading. */
  canGenerate: boolean
}

export const openingWorkSummarySnapshot: WorkSummarySnapshot = {
  material: { state: 'loading' },
  summary: null,
  pending: null,
  failure: null,
  outdated: false,
  awaitingRange: false,
  canCopyMaterial: false,
  canGenerate: false,
}

export interface WorkSummarySession {
  snapshot(): WorkSummarySnapshot
  /** Captures ready material before preparation; only an explicit call spends. */
  generate(): Promise<void>
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
  settings,
  clock,
  range,
  onChange,
}: {
  journal: Promise<Journal>
  desktop: Desktop
  settings: AppSettings
  clock: Clock
  /** The range the opening read selects within — owned by the view. */
  range: DayRange
  onChange: (snapshot: WorkSummarySnapshot) => void
}): WorkSummarySession {
  let running = false
  let rollover: ReturnType<typeof setTimeout> | null = null
  let unlisten: Unlisten[] = []
  let latestRead = 0
  let generation = 0
  // Whichever range the view last chose. Refreshes re-read the data within
  // it; they never move it.
  let current = { ...range }
  let material: WorkSummaryState = { state: 'loading' }
  let summary: GeneratedSummary | null = null
  let pending: string | null = null
  let failure: WorkSummaryFailure | null = null
  let inFlight = false
  // A failed read has no verdict of its own. Keep the last readable material
  // even if generation finishes during an unreadable refresh.
  let lastMaterial: string | null = null

  function snapshot(): WorkSummarySnapshot {
    const awaitingRange =
      material.state === 'ready' &&
      (material.selection.from !== current.from ||
        material.selection.to !== current.to)
    const canCopyMaterial =
      material.state === 'ready' &&
      !awaitingRange &&
      !workSummaryRefuses(material.selection)
    return {
      material,
      summary,
      pending,
      failure,
      awaitingRange,
      canCopyMaterial,
      canGenerate: canCopyMaterial && !inFlight,
      outdated:
        summary !== null &&
        (summary.from !== current.from ||
          summary.to !== current.to ||
          (lastMaterial !== null && lastMaterial !== summary.material)),
    }
  }

  function publish(): void {
    if (running) onChange(snapshot())
  }

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
      material = { state: 'ready', selection }
      lastMaterial = buildWorkSummaryMaterial(selection)
      publish()
    } catch (error) {
      console.error('could not read the Work Summary material', error)
      if (running && latestRead === readTicket) {
        material = { state: 'unreadable' }
        publish()
      }
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
    snapshot,

    async generate() {
      if (!running || !snapshot().canGenerate || material.state !== 'ready') return
      // Freeze both range and exact rendered material before settings.load:
      // later reads may change either while preparation or the model waits.
      const requested = {
        from: material.selection.from,
        to: material.selection.to,
        material: buildWorkSummaryMaterial(material.selection),
      }
      const requestingGeneration = generation
      inFlight = true
      failure = null
      publish()
      try {
        const stored = await settings.load()
        if (!isCurrent(requestingGeneration)) return
        if (stored.modelBaseUrl.trim() === '' || stored.model.trim() === '') {
          failure = { kind: 'model-access' }
          return
        }
        pending = stored.model
        publish()
        const response = await desktop.generateWorkSummary({
          baseUrl: stored.modelBaseUrl,
          model: stored.model,
          systemPrompt: workSummarySystemPrompt(stored.workSummaryPrompt),
          userContent: requested.material,
        })
        if (!isCurrent(requestingGeneration)) return
        if (response.state === 'generated') {
          summary = {
            ...requested,
            markdown: response.markdown,
            model: stored.model,
            generatedAt: clock.now(),
          }
        } else {
          failure = response.failure
        }
      } catch (error) {
        console.error('could not ask for a Work Summary', error)
        if (isCurrent(requestingGeneration)) failure = { kind: 'local' }
      } finally {
        inFlight = false
        pending = null
        publish()
      }
    },

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
      current = { ...next }
      publish()
      if (running) void read()
    },
  }
}
