import { describe, expect, it } from 'vitest'
import {
  NO_OBSERVING,
  OBSERVE_LOOKBACK_MS,
  addRepository,
  consentedAt,
  ignoredSubject,
  readObserving,
  removeRepository,
  setIdentities,
  setIgnoredPrefixes,
  turnObserving,
  type ObservedRepository,
} from './observing'

// The consent Observing keeps, as a pure rule: which instants the user said
// yes to, per repository, and what each thing the user does to the list
// makes of them. Instants are milliseconds, as the commit reader speaks them.

const hour = 60 * 60 * 1000
const day = 24 * hour
const at = (time: string) => new Date(time).getTime()

function repository(overrides: Partial<ObservedRepository> = {}): ObservedRepository {
  return {
    path: '/code/work-journal-ai',
    repository: '/code/work-journal-ai/.git',
    identities: ['me@example.com'],
    ignoredPrefixes: [],
    ...overrides,
  }
}

const journal = repository()
const other = repository({ path: '/code/other', repository: '/code/other/.git' })

describe('consent', () => {
  it('covers nothing until Observing is turned on', () => {
    const listed = addRepository(NO_OBSERVING, journal, at('2026-03-09T08:00'))

    expect(listed.enabled).toBe(false)
    expect(consentedAt(listed, journal.repository, at('2026-03-09T09:00'))).toBe(false)
  })

  it('begins at the enablement instant, never before it', () => {
    const listed = addRepository(NO_OBSERVING, journal, at('2026-03-09T08:00'))
    const on = turnObserving(listed, true, at('2026-03-09T18:40'))

    expect(consentedAt(on, journal.repository, at('2026-03-09T09:30'))).toBe(false)
    expect(consentedAt(on, journal.repository, at('2026-03-09T18:40'))).toBe(true)
    expect(consentedAt(on, journal.repository, at('2026-03-10T09:00'))).toBe(true)
  })

  it('excludes the gap between a disable and a re-enable', () => {
    let observing = turnObserving(
      addRepository(NO_OBSERVING, journal, at('2026-03-09T08:00')),
      true,
      at('2026-03-09T08:00'),
    )
    observing = turnObserving(observing, false, at('2026-03-09T10:00'))
    observing = turnObserving(observing, true, at('2026-03-09T11:00'))

    expect(consentedAt(observing, journal.repository, at('2026-03-09T09:00'))).toBe(true)
    expect(consentedAt(observing, journal.repository, at('2026-03-09T10:30'))).toBe(false)
    expect(consentedAt(observing, journal.repository, at('2026-03-09T11:30'))).toBe(true)
  })

  it('excludes the gap a repository was off the list for, and keeps what came before it', () => {
    let observing = turnObserving(NO_OBSERVING, true, at('2026-03-09T08:00'))
    observing = addRepository(observing, journal, at('2026-03-09T09:00'))
    observing = removeRepository(observing, journal.repository, at('2026-03-09T10:00'))
    observing = addRepository(observing, journal, at('2026-03-09T11:00'))

    expect(consentedAt(observing, journal.repository, at('2026-03-09T08:30'))).toBe(false)
    expect(consentedAt(observing, journal.repository, at('2026-03-09T09:30'))).toBe(true)
    expect(consentedAt(observing, journal.repository, at('2026-03-09T10:30'))).toBe(false)
    expect(consentedAt(observing, journal.repository, at('2026-03-09T12:00'))).toBe(true)
  })

  it('keeps each repository to its own intervals', () => {
    let observing = turnObserving(NO_OBSERVING, true, at('2026-03-09T08:00'))
    observing = addRepository(observing, journal, at('2026-03-09T08:00'))
    observing = addRepository(observing, other, at('2026-03-09T08:00'))
    observing = removeRepository(observing, journal.repository, at('2026-03-09T10:00'))
    observing = addRepository(observing, journal, at('2026-03-09T11:00'))

    expect(consentedAt(observing, journal.repository, at('2026-03-09T10:30'))).toBe(false)
    expect(consentedAt(observing, other.repository, at('2026-03-09T10:30'))).toBe(true)
  })

  it('opens nothing for a repository that is already on the list', () => {
    const observing = turnObserving(
      addRepository(NO_OBSERVING, journal, at('2026-03-09T08:00')),
      true,
      at('2026-03-09T08:00'),
    )
    const again = addRepository(
      observing,
      repository({ path: '/code/work-journal-ai-worktree' }),
      at('2026-03-09T09:00'),
    )

    expect(again).toBe(observing)
  })

  it('treats turning on what is on, or off what is off, as nothing', () => {
    const on = turnObserving(NO_OBSERVING, true, at('2026-03-09T08:00'))

    expect(turnObserving(on, true, at('2026-03-09T09:00'))).toBe(on)
    expect(turnObserving(NO_OBSERVING, false, at('2026-03-09T09:00'))).toBe(NO_OBSERVING)
  })

  it('prunes an interval once it ends before the lookback', () => {
    let observing = turnObserving(
      addRepository(NO_OBSERVING, journal, at('2026-03-01T08:00')),
      true,
      at('2026-03-01T08:00'),
    )
    observing = turnObserving(observing, false, at('2026-03-01T10:00'))
    observing = turnObserving(observing, true, at('2026-03-01T10:00') + OBSERVE_LOOKBACK_MS + day)

    expect(observing.consent[journal.repository]).toEqual([
      { from: at('2026-03-01T10:00') + OBSERVE_LOOKBACK_MS + day, until: null },
    ])
  })

  it('forgets a removed repository once its last interval is past the lookback', () => {
    let observing = turnObserving(
      addRepository(NO_OBSERVING, journal, at('2026-03-01T08:00')),
      true,
      at('2026-03-01T08:00'),
    )
    observing = removeRepository(observing, journal.repository, at('2026-03-01T10:00'))
    observing = addRepository(observing, other, at('2026-03-01T10:00') + OBSERVE_LOOKBACK_MS + day)

    expect(Object.keys(observing.consent)).toEqual([other.repository])
  })
})

describe('a repository on the list', () => {
  it('takes the identities that count as the user, and the prefixes to skip', () => {
    let observing = addRepository(NO_OBSERVING, repository({ identities: [] }), 0)
    observing = setIdentities(observing, journal.repository, ['me@example.com'])
    observing = setIgnoredPrefixes(observing, journal.repository, ['Release ', '', 'chore:'])

    expect(observing.repositories).toEqual([
      repository({ identities: ['me@example.com'], ignoredPrefixes: ['Release ', 'chore:'] }),
    ])
  })
})

describe('ignoredSubject', () => {
  it('skips a subject that begins with one of the prefixes, as written', () => {
    expect(ignoredSubject(['Release '], 'Release 0.15.1 (#257)')).toBe(true)
    expect(ignoredSubject(['Release '], 'release 0.15.1')).toBe(false)
    expect(ignoredSubject([], 'Release 0.15.1')).toBe(false)
  })
})

describe('readObserving', () => {
  it('reads nothing at all as Observing off with nothing listed', () => {
    expect(readObserving(undefined)).toEqual(NO_OBSERVING)
    expect(readObserving('on')).toEqual(NO_OBSERVING)
  })

  it('reads back what was written', () => {
    const observing = turnObserving(addRepository(NO_OBSERVING, journal, 5), true, 10)

    expect(readObserving(JSON.parse(JSON.stringify(observing)))).toEqual(observing)
  })

  it('keeps only what it can read: a repository with no path, or an interval with no start, is dropped', () => {
    expect(
      readObserving({
        enabled: true,
        repositories: [
          { repository: '/x/.git', identities: [], ignoredPrefixes: [] },
          { ...journal, identities: ['me@example.com', 7] },
        ],
        consent: {
          [journal.repository]: [{ until: 5 }, { from: 1, until: null }, { from: 2, until: 3 }],
          '/y/.git': 'always',
        },
      }),
    ).toEqual({
      enabled: true,
      repositories: [journal],
      consent: { [journal.repository]: [{ from: 1, until: null }, { from: 2, until: 3 }] },
    })
  })
})
