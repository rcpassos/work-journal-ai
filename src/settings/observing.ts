/**
 * Observing as the settings file holds it: whether the user wants commits
 * observed, which repositories and which identities, and — the part Meeting
 * Import never needed — the instants the user said yes, per repository.
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
 * Configuration, not journal content: it lives in the settings store and is
 * pruned once an interval ends before the lookback, since nothing that old is
 * ever read again. Every rule here is pure, and each takes the instant it is
 * applied at, so the whole of it is driven from a test with no clock.
 */

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
 * One stretch of consent, in milliseconds since the epoch: `from` inclusive,
 * `until` exclusive, and `until` null while it is still open.
 */
export interface ConsentInterval {
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
  consent: Record<string, ConsentInterval[]>
}

/** What a store that says nothing means: off, nothing listed, nothing consented. */
export const NO_OBSERVING: Observing = {
  enabled: false,
  repositories: [],
  consent: {},
}

/** Whether the work done at `instant` in this repository was consented to. */
export function consentedAt(
  observing: Observing,
  repository: string,
  instant: number,
): boolean {
  return (observing.consent[repository] ?? []).some(
    ({ from, until }) => from <= instant && (until === null || instant < until),
  )
}

/** Whether a subject is one the user asked to skip. Matched as written. */
export function ignoredSubject(prefixes: string[], subject: string): boolean {
  return prefixes.some((prefix) => subject.startsWith(prefix))
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
 * already listed, such as a second worktree of it, adds nothing.
 */
export function addRepository(
  observing: Observing,
  added: ObservedRepository,
  now: number,
): Observing {
  if (observing.repositories.some(({ repository }) => repository === added.repository)) {
    return observing
  }

  return prune(
    {
      ...observing,
      repositories: [...observing.repositories, added],
      consent: observing.enabled
        ? open(observing.consent, added.repository, now)
        : observing.consent,
    },
    now,
  )
}

/**
 * A repository taken off the list. Its open interval closes now, and what it
 * consented to before stays — so adding it again excludes only the gap.
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
  return change(observing, repository, { identities })
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
  return change(observing, repository, {
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

  const consent: Record<string, ConsentInterval[]> = {}
  if (isRecord(stored.consent)) {
    for (const [repository, intervals] of Object.entries(stored.consent)) {
      if (!Array.isArray(intervals)) continue
      const read = intervals.flatMap((each): ConsentInterval[] =>
        isRecord(each) &&
        typeof each.from === 'number' &&
        (each.until === null || typeof each.until === 'number')
          ? [{ from: each.from, until: each.until }]
          : [],
      )
      if (read.length > 0) consent[repository] = read
    }
  }

  return {
    enabled: typeof stored.enabled === 'boolean' ? stored.enabled : false,
    repositories,
    consent,
  }
}

function open(
  consent: Record<string, ConsentInterval[]>,
  repository: string,
  now: number,
): Record<string, ConsentInterval[]> {
  const intervals = consent[repository] ?? []
  if (intervals.some(({ until }) => until === null)) return consent
  return { ...consent, [repository]: [...intervals, { from: now, until: null }] }
}

function close(
  consent: Record<string, ConsentInterval[]>,
  repository: string,
  now: number,
): Record<string, ConsentInterval[]> {
  const intervals = consent[repository]
  if (intervals === undefined) return consent
  return {
    ...consent,
    [repository]: intervals.map((each) =>
      each.until === null ? { ...each, until: now } : each,
    ),
  }
}

/** Drops every interval that ended before the lookback, and any repository left with none. */
function prune(observing: Observing, now: number): Observing {
  const horizon = now - OBSERVE_LOOKBACK_MS
  const consent: Record<string, ConsentInterval[]> = {}
  for (const [repository, intervals] of Object.entries(observing.consent)) {
    const kept = intervals.filter(({ until }) => until === null || until >= horizon)
    if (kept.length > 0) consent[repository] = kept
  }
  return { ...observing, consent }
}

function change(
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
