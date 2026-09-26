/**
 * Observing as the settings file holds it: whether the user wants commits
 * observed, which repositories and which identities, and — the part Meeting
 * Import never needed — the instants the user said yes, per repository, and
 * the stretches a pause held over them.
 *
 * A commit authored before the user said yes is work they did not consent to
 * have recorded, so consent is kept as intervals of *when the work happened*
 * and never of when a sweep found it: a sweep that meets at noon a commit
 * authored at 10:30, while the repository was off the list, must refuse it.
 * An interval is open while Observing is on and the repository is listed, and
 * closes the moment either stops being true. One shape serves the three ways
 * that happens — turning Observing off, removing a repository, and the time
 * before either was first said — which is why removal lives here, beside the
 * list. See docs/adr/0011-imported-meetings-are-today-only.md.
 *
 * **A pause is an interval too** — the same shape of state, kept beside the
 * consent intervals and pruned with them. Pause at 10:00, resume at 11:00,
 * and a commit authored at 10:30 that a sweep meets at noon is still
 * excluded: the pause's interval covers the instant the work happened,
 * whenever it is looked at. A flag read at sweep time cannot do that. A pause
 * with an end expires by itself — the interval simply stops covering anything
 * — so it survives a restart and a sleep with nothing to remember to undo.
 *
 * Configuration, not journal content: it lives in the settings store and is
 * pruned once an interval ends before the lookback, since nothing that old is
 * ever read again. Every rule here is pure, and each takes the instant it is
 * applied at, so the whole of it is driven from a test with no clock.
 */

import { msUntilNextJournalDay } from '@/journal/journal'
import type { PauseLength, PauseState } from '@/platform/desktop'

/** How far back a sweep reads, and how long a closed interval is kept. */
export const OBSERVE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000

/** One repository on the list, as the user added it. */
export interface ObservedRepository {
  /** The folder the user picked — what the reader is asked about. */
  path: string
  /**
   * The repository's identity, as the reader answered when it was added: its
   * common directory, which every worktree of it shares. What consent, the
   * list and a commit's Note are all keyed on.
   */
  repository: string
  /** The addresses that count as the user here, as ticked. None is nobody. */
  identities: string[]
  /** Subject prefixes whose commits become nothing. Empty by default. */
  ignoredPrefixes: string[]
}

/**
 * One stretch of the state's own time in milliseconds since the epoch: `from`
 * inclusive, `until` exclusive, and `until` null while it is still open. One
 * shape for both kinds of stretch — consent given, and a pause held — because
 * both answer the same question of a commit: was this instant one of them?
 */
export interface ObservingInterval {
  from: number
  until: number | null
}

export interface Observing {
  /** The user's wish, and only theirs. Off until turned on. */
  enabled: boolean
  repositories: ObservedRepository[]
  /**
   * By repository identity, so one repository's gap never excludes another's
   * work — and kept after a repository is removed, so the time before the
   * removal still counts once it is added again.
   */
  consent: Record<string, ObservingInterval[]>
  /**
   * The pauses, per repository and beside the consent intervals for the same
   * reason: kept after a removal, pruned with consent, and covering the
   * instants the work happened. Written for every repository on the list at
   * the moment of the pause, and a repository added while one is in force
   * joins it — a pause is of Observing, not of one repository.
   */
  pauses: Record<string, ObservingInterval[]>
}

/** What a store that says nothing means: off, nothing listed, nothing consented. */
export const NO_OBSERVING: Observing = {
  enabled: false,
  repositories: [],
  consent: {},
  pauses: {},
}

/** Whether the work done at `instant` in this repository was consented to. */
export function consentedAt(
  observing: Observing,
  repository: string,
  instant: number,
): boolean {
  return covers(observing.consent[repository], instant)
}

/** Whether the work done at `instant` in this repository fell in a pause. */
export function pausedAt(
  observing: Observing,
  repository: string,
  instant: number,
): boolean {
  return covers(observing.pauses[repository], instant)
}

/**
 * The one filter the sweep reads a commit by: work done then, there, may
 * become a Note. Consent and the pause are the same rule applied to the same
 * axis — when the work happened — so a caller cannot honour one and forget
 * the other.
 */
export function observedAt(
  observing: Observing,
  repository: string,
  instant: number,
): boolean {
  return consentedAt(observing, repository, instant) && !pausedAt(observing, repository, instant)
}

/**
 * The pause in force at `instant`, or null when none is. A pause is of
 * Observing, so every repository's list is one pause's record: the one that
 * covers this instant and reaches furthest — an open pause reaches furthest
 * of all.
 */
export function activePause(
  observing: Observing,
  instant: number,
): ObservingInterval | null {
  let paused: ObservingInterval | null = null
  for (const intervals of Object.values(observing.pauses)) {
    for (const each of intervals) {
      if (!covers([each], instant)) continue
      if (
        paused === null ||
        (paused.until !== null && (each.until === null || each.until > paused.until))
      ) {
        paused = each
      }
    }
  }
  return paused
}

/** Whether a subject is one the user asked to skip. Matched as written. */
export function ignoredSubject(prefixes: string[], subject: string): boolean {
  return prefixes.some((prefix) => subject.startsWith(prefix))
}

/**
 * Observing paused for one of the offered lengths, over every repository on
 * the list. The pause is its own interval, opening now and closing at its
 * end — or staying open when there is no end — so a commit authored inside it
 * is refused by the instant it was authored at, on every sweep that ever
 * meets it. A pause while one is already in force is the pause asked for: the
 * one in force closes now, keeping what it excluded, and the new one runs
 * from here.
 */
export function pauseObserving(
  observing: Observing,
  length: PauseLength,
  now: number,
): Observing {
  const until =
    length === 'an-hour'
      ? now + 60 * 60 * 1000
      : length === 'until-tomorrow'
        ? now + msUntilNextJournalDay(new Date(now))
        : null

  let pauses = observing.pauses
  for (const { repository } of observing.repositories) {
    const intervals = pauses[repository] ?? []
    pauses = {
      ...pauses,
      [repository]: [...endAt(intervals, now), { from: now, until }],
    }
  }
  return prune({ ...observing, pauses }, now)
}

/**
 * Observing resumed: whatever pause covers now ends now, whatever end it was
 * meant to have. What each pause already excluded stays excluded — the work
 * inside it was never observed and never will be.
 */
export function resumeObserving(observing: Observing, now: number): Observing {
  const pauses: Record<string, ObservingInterval[]> = {}
  for (const [repository, intervals] of Object.entries(observing.pauses)) {
    pauses[repository] = endAt(intervals, now)
  }
  return prune({ ...observing, pauses }, now)
}

/**
 * What the pause controls say at `instant`: nothing to pause, a pause to
 * offer, or a pause in force with its end already said as a sentence.
 */
export function pauseState(observing: Observing, now: number): PauseState {
  if (!observing.enabled || observing.repositories.length === 0) {
    return { state: 'nothing' }
  }
  const pause = activePause(observing, now)
  return pause === null
    ? { state: 'running' }
    : { state: 'paused', until: pause.until, label: describePause(pause, now) }
}

/**
 * A pause in force, said as its own end: "Paused until 11:00 AM", "Paused
 * until tomorrow" for one that ends with the day — the length the Tray Menu
 * calls until tomorrow, read back the way it was chosen — and just "Paused"
 * for one with no end at all. An hour's pause that happens to cross midnight
 * still says its hour: "tomorrow" is the day's own end, not any later one.
 */
export function describePause(pause: ObservingInterval, now: number): string {
  if (pause.until === null) return 'Paused'
  const end = new Date(pause.until)
  if (pause.until === now + msUntilNextJournalDay(new Date(now))) {
    return 'Paused until tomorrow'
  }
  return `Paused until ${end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

/**
 * Observing turned on or off. On opens an interval for every repository on
 * the list; off closes every open one. Saying what is already so changes
 * nothing, so a second press never splits an interval.
 */
export function turnObserving(
  observing: Observing,
  enabled: boolean,
  now: number,
): Observing {
  if (observing.enabled === enabled) return observing

  let consent = observing.consent
  for (const { repository } of observing.repositories) {
    consent = enabled ? open(consent, repository, now) : close(consent, repository, now)
  }
  return prune({ ...observing, enabled, consent }, now)
}

/**
 * A repository added to the list — consented from now if Observing is on, and
 * from the moment it is turned on otherwise. A repository whose identity is
 * already listed, such as a second worktree of it, adds nothing. A pause in
 * force reaches it too: the pause is of Observing, so work it does from the
 * moment it joins is refused like every other repository's.
 */
export function addRepository(
  observing: Observing,
  added: ObservedRepository,
  now: number,
): Observing {
  if (observing.repositories.some(({ repository }) => repository === added.repository)) {
    return observing
  }

  const active = activePause(observing, now)
  const pauses =
    active !== null && !covers(observing.pauses[added.repository], now)
      ? {
          ...observing.pauses,
          [added.repository]: [
            ...(observing.pauses[added.repository] ?? []),
            { from: now, until: active.until },
          ],
        }
      : observing.pauses

  return prune(
    {
      ...observing,
      repositories: [...observing.repositories, added],
      consent: observing.enabled
        ? open(observing.consent, added.repository, now)
        : observing.consent,
      pauses,
    },
    now,
  )
}

/**
 * A repository taken off the list. Its open interval closes now, and what it
 * consented to before stays — so adding it again excludes only the gap. Its
 * pauses stay for the same reason and in the same way: the work inside one
 * was refused when it happened, whether or not the repository comes back.
 */
export function removeRepository(
  observing: Observing,
  repository: string,
  now: number,
): Observing {
  return prune(
    {
      ...observing,
      repositories: observing.repositories.filter((each) => each.repository !== repository),
      consent: close(observing.consent, repository, now),
    },
    now,
  )
}

/** The identities that count as the user in one repository, as ticked. */
export function setIdentities(
  observing: Observing,
  repository: string,
  identities: string[],
): Observing {
  return changeRepository(observing, repository, { identities })
}

/**
 * The prefixes one repository skips. An empty prefix would skip every commit,
 * and nobody types one on purpose, so it is dropped.
 */
export function setIgnoredPrefixes(
  observing: Observing,
  repository: string,
  prefixes: string[],
): Observing {
  return changeRepository(observing, repository, {
    ignoredPrefixes: prefixes.filter((prefix) => prefix !== ''),
  })
}

/**
 * Observing as the store holds it, with anything that cannot be read dropped
 * rather than guessed at: a settings file edited by hand must not stop the
 * app from starting, and must never widen what was consented to.
 */
export function readObserving(stored: unknown): Observing {
  if (!isRecord(stored)) return NO_OBSERVING

  const repositories = Array.isArray(stored.repositories)
    ? stored.repositories.flatMap((each): ObservedRepository[] =>
        isRecord(each) &&
        typeof each.path === 'string' &&
        typeof each.repository === 'string'
          ? [
              {
                path: each.path,
                repository: each.repository,
                identities: strings(each.identities),
                ignoredPrefixes: strings(each.ignoredPrefixes),
              },
            ]
          : [],
      )
    : []

  const consent = readIntervals(stored.consent)
  const pauses = readIntervals(stored.pauses)

  return {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : false,
    repositories,
    consent,
    pauses,
  }
}

/** The stretches one part of the state holds, dropping whatever is not one. */
function readIntervals(stored: unknown): Record<string, ObservingInterval[]> {
  const intervals: Record<string, ObservingInterval[]> = {}
  if (!isRecord(stored)) return intervals
  for (const [repository, each] of Object.entries(stored)) {
    if (!Array.isArray(each)) continue
    const read = each.flatMap((one): ObservingInterval[] =>
      isRecord(one) &&
      typeof one.from === 'number' &&
      (one.until === null || typeof one.until === 'number')
        ? [{ from: one.from, until: one.until }]
        : [],
    )
    if (read.length > 0) intervals[repository] = read
  }
  return intervals
}

/** Whether one of these stretches covers the instant. */
function covers(intervals: ObservingInterval[] | undefined, instant: number): boolean {
  return (intervals ?? []).some(
    ({ from, until }) => from <= instant && (until === null || instant < until),
  )
}

/** Whatever covers `now` ends now; the rest is left exactly as it was. */
function endAt(intervals: ObservingInterval[], now: number): ObservingInterval[] {
  return intervals.map((each) =>
    covers([each], now) ? { ...each, until: now } : each,
  )
}

function open(
  consent: Record<string, ObservingInterval[]>,
  repository: string,
  now: number,
): Record<string, ObservingInterval[]> {
  const intervals = consent[repository] ?? []
  if (intervals.some(({ until }) => until === null)) return consent
  return { ...consent, [repository]: [...intervals, { from: now, until: null }] }
}

function close(
  consent: Record<string, ObservingInterval[]>,
  repository: string,
  now: number,
): Record<string, ObservingInterval[]> {
  const intervals = consent[repository]
  if (intervals === undefined) return consent
  return {
    ...consent,
    [repository]: intervals.map((each) =>
      each.until === null ? { ...each, until: now } : each,
    ),
  }
}

/**
 * Drops every interval that ended before the lookback, and any repository
 * left with none — of consent and of pauses alike, since neither can matter
 * again: a sweep never reads work that old.
 */
function prune(observing: Observing, now: number): Observing {
  const horizon = now - OBSERVE_LOOKBACK_MS
  const kept = (stretches: Record<string, ObservingInterval[]>) => {
    const intervals: Record<string, ObservingInterval[]> = {}
    for (const [repository, each] of Object.entries(stretches)) {
      const alive = each.filter(({ until }) => until === null || until >= horizon)
      if (alive.length > 0) intervals[repository] = alive
    }
    return intervals
  }
  return { ...observing, consent: kept(observing.consent), pauses: kept(observing.pauses) }
}

function changeRepository(
  observing: Observing,
  repository: string,
  changes: Partial<Pick<ObservedRepository, 'identities' | 'ignoredPrefixes'>>,
): Observing {
  return {
    ...observing,
    repositories: observing.repositories.map((each) =>
      each.repository === repository ? { ...each, ...changes } : each,
    ),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((each): each is string => typeof each === 'string')
    : []
}
