/**
 * The commit sweep: the commits the user made in the repositories they listed,
 * turned into Observed Notes without anybody being asked.
 *
 * The meeting sweep's twin — built the same way, from a Journal, a Desktop,
 * the settings and a clock, and looking on the same occasions — and apart
 * from it because the two answer to different rules about time. Meetings are
 * today-only; commits are the last seven days, and only inside an interval
 * the user consented to, filtered by when the work happened and never by when
 * a sweep found it. See docs/adr/0011-imported-meetings-are-today-only.md.
 * Which commits count is `commitsToObserve`; what an Observe writes is
 * `Journal.observe`. What lives here is *when* to look.
 *
 * It never Nudges, for the reason the meeting sweep never does: a Nudge is a
 * fact about the user, and a sweep has nothing to say about them. The only
 * announcement is that the Notes are no longer what they were.
 *
 * Runs in the capture window, beside the meeting sweep and for the same
 * reason — see docs/adr/0002-capture-window-is-hidden-never-closed.md.
 */

import type { Commit, Desktop } from '@/platform/desktop'
import type { AppSettings } from '@/settings/app-settings'
import {
  OBSERVE_LOOKBACK_MS,
  consentedAt,
  ignoredSubject,
  type ObservedRepository,
  type Observing,
} from '@/settings/observing'
import { commitEventKey, type Clock, type Journal, type SourceEvent } from './journal'

/**
 * How often the repositories are looked at. As often as the calendar is: near
 * enough that the day's work is in the journal before it is read back, far
 * enough apart that nothing is woken to run `git` for nobody.
 */
export const OBSERVE_INTERVAL_MS = 5 * 60 * 1000

export interface ObserveSession {
  /**
   * Sweeps, and keeps sweeping: arms the interval and subscribes to the
   * moments worth looking again. Resolves once the first sweep is done.
   */
  start(): Promise<void>
  /** Gives all of it up, for good. */
  stop(): void
}

/**
 * The commits from one listed repository that become Notes: consented to at
 * the instant they were authored, not skipped by a prefix the user wrote, and
 * with a subject to say. A skipped commit becomes nothing at all — no Note and
 * no handled row — so removing its prefix lets it arrive within the lookback.
 * Always Unfiled: nothing is ever inferred from a path.
 */
export function commitsToObserve({
  observing,
  listed,
  commits,
}: {
  observing: Observing
  listed: ObservedRepository
  commits: Commit[]
}): SourceEvent[] {
  return commits
    .filter(
      ({ subject, authoredAt }) =>
        subject.trim() !== '' &&
        consentedAt(observing, listed.repository, authoredAt) &&
        !ignoredSubject(listed.ignoredPrefixes, subject),
    )
    .map(({ hash, subject, authoredAt }) => ({
      source: 'commit',
      eventKey: commitEventKey(hash, listed.repository),
      body: subject,
      happenedAt: new Date(authoredAt).toISOString(),
      project: null,
    }))
}

export function createObserveSession({
  journal,
  desktop,
  settings,
  clock,
}: {
  /** A promise, as the meeting sweep takes it: the database opens after the first paint. */
  journal: Promise<Journal>
  desktop: Desktop
  settings: AppSettings
  clock: Clock
}): ObserveSession {
  let running = false
  let interval: ReturnType<typeof setInterval> | null = null
  let unlisten: Array<() => void> = []
  // Sweeps never overlap, for the meeting sweep's reason: a commit is only
  // handled once it is written down, so two sweeps reading together would
  // each see it unhandled. The late one is dropped; the next trigger finds
  // whatever it would have.
  let sweeping = false

  /**
   * One look at every listed repository. A repository that cannot be read is
   * a gap in the journal, never an interruption: it is passed over, the rest
   * are still read, and nothing is ever asked.
   */
  async function sweep(): Promise<void> {
    if (!running || sweeping) return
    sweeping = true

    try {
      const { observing } = await settings.load()
      if (!observing.enabled) return

      const since = clock.now().getTime() - OBSERVE_LOOKBACK_MS
      let observed = 0
      for (const listed of observing.repositories) {
        // No identity ticked is nobody's commits: nothing to ask `git` for.
        if (listed.identities.length === 0) continue
        try {
          const read = await desktop.repositoryCommits(
            listed.path,
            listed.identities,
            since,
          )
          if (read.state !== 'read') continue

          const core = await journal
          for (const event of commitsToObserve({ observing, listed, commits: read.commits })) {
            if (!running) return
            if ((await core.observe(event)) !== null) observed += 1
          }
        } catch (error) {
          console.error('could not observe a repository', error)
        }
      }

      // Never `announceCapturedNote`: that one names a day for the reader's
      // Filter, and a sweep has nothing to say about the user.
      if (observed > 0) {
        await desktop.announceJournalChanged()
      }
    } catch (error) {
      console.error('could not observe commits', error)
    } finally {
      sweeping = false
    }
  }

  return {
    async start() {
      running = true
      const stopListening = await Promise.all([
        desktop.onSystemWoke(() => void sweep()),
        desktop.onCaptureShown(() => void sweep()),
        // Turning Observing on, or listing a repository, should show up in
        // the journal now rather than at the next interval.
        desktop.onObservingChanged(() => void sweep()),
      ])

      if (!running) {
        for (const stop of stopListening) stop()
        return
      }
      unlisten = stopListening

      await sweep()
      interval = setInterval(() => void sweep(), OBSERVE_INTERVAL_MS)
    },

    stop() {
      running = false
      if (interval !== null) clearInterval(interval)
      interval = null
      for (const stop of unlisten) stop()
      unlisten = []
    },
  }
}
