import { describe, expect, it } from 'vitest'
import {
  NO_OBSERVING,
  OBSERVE_LOOKBACK_MS,
  addRepository,
  consentedAt,
  describePause,
  ignoredSubject,
  observedAt,
  activePause,
  pausedAt,
  pauseObserving,
  pauseState,
  readObserving,
  removeRepository,
  resumeObserving,
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

describe('a pause', () => {
  /** Observing on with both repositories listed, from 08:00. */
  function observingOn() {
    let observing = turnObserving(NO_OBSERVING, true, at('2026-03-09T08:00'))
    observing = addRepository(observing, journal, at('2026-03-09T08:00'))
    observing = addRepository(observing, other, at('2026-03-09T08:00'))
    return observing
  }

  it('is an interval of when the work happened, not of when a sweep ran', () => {
    const paused = pauseObserving(observingOn(), 'an-hour', at('2026-03-09T10:00'))

    // The commit authored at 10:30 is refused however late it is met.
    expect(observedAt(paused, journal.repository, at('2026-03-09T10:30'))).toBe(false)
    expect(pausedAt(paused, journal.repository, at('2026-03-09T10:30'))).toBe(true)
    expect(observedAt(paused, journal.repository, at('2026-03-09T09:30'))).toBe(true)
    expect(observedAt(paused, journal.repository, at('2026-03-09T11:00'))).toBe(true)
  })

  it('covers every repository on the list, and one added while it is in force', () => {
    let paused = pauseObserving(observingOn(), 'until-resumed', at('2026-03-09T10:00'))
    paused = addRepository(
      paused,
      repository({ path: '/code/late', repository: '/code/late/.git' }),
      at('2026-03-09T10:30'),
    )

    expect(observedAt(paused, journal.repository, at('2026-03-09T10:40'))).toBe(false)
    expect(observedAt(paused, other.repository, at('2026-03-09T10:40'))).toBe(false)
    expect(observedAt(paused, '/code/late/.git', at('2026-03-09T10:40'))).toBe(false)
  })

  it('ends by itself when it has an end, with nothing done at the time', () => {
    const paused = pauseObserving(observingOn(), 'an-hour', at('2026-03-09T10:00'))

    expect(observedAt(paused, journal.repository, at('2026-03-09T11:30'))).toBe(true)
    expect(activePause(paused, at('2026-03-09T11:30'))).toBeNull()
  })

  it('ends with the day when it is taken until tomorrow', () => {
    const paused = pauseObserving(observingOn(), 'until-tomorrow', at('2026-03-09T17:00'))

    expect(pausedAt(paused, journal.repository, at('2026-03-09T23:40'))).toBe(true)
    expect(observedAt(paused, journal.repository, at('2026-03-10T00:00'))).toBe(true)
  })

  it('holds until resumed when it has no end', () => {
    let paused = pauseObserving(observingOn(), 'until-resumed', at('2026-03-09T10:00'))
    expect(pausedAt(paused, journal.repository, at('2026-03-11T09:00'))).toBe(true)

    paused = resumeObserving(paused, at('2026-03-11T09:30'))

    expect(pausedAt(paused, journal.repository, at('2026-03-11T09:00'))).toBe(true)
    expect(observedAt(paused, journal.repository, at('2026-03-11T10:00'))).toBe(true)
  })

  it('resumes early at the instant it is resumed, keeping what it excluded', () => {
    let paused = pauseObserving(observingOn(), 'an-hour', at('2026-03-09T10:00'))
    paused = resumeObserving(paused, at('2026-03-09T10:30'))

    expect(pausedAt(paused, journal.repository, at('2026-03-09T10:20'))).toBe(true)
    expect(observedAt(paused, journal.repository, at('2026-03-09T10:40'))).toBe(true)
  })

  it('accumulates: several pause/resume pairs each exclude their own interval', () => {
    let observing = observingOn()
    observing = pauseObserving(observing, 'an-hour', at('2026-03-09T10:00'))
    observing = resumeObserving(observing, at('2026-03-09T10:30'))
    observing = pauseObserving(observing, 'until-resumed', at('2026-03-09T14:00'))
    observing = resumeObserving(observing, at('2026-03-09T15:00'))

    for (const taken of ['2026-03-09T10:15', '2026-03-09T14:30']) {
      expect(pausedAt(observing, journal.repository, at(taken)), taken).toBe(true)
    }
    for (const working of ['2026-03-09T09:00', '2026-03-09T11:00', '2026-03-09T13:00', '2026-03-09T16:00']) {
      expect(observedAt(observing, journal.repository, at(working)), working).toBe(true)
    }
  })

  it('is the pause asked for when one is already in force', () => {
    let observing = pauseObserving(observingOn(), 'until-resumed', at('2026-03-09T10:00'))
    observing = pauseObserving(observing, 'an-hour', at('2026-03-09T10:15'))

    expect(activePause(observing, at('2026-03-09T10:20'))).toEqual({
      from: at('2026-03-09T10:15'),
      until: at('2026-03-09T11:15'),
    })
    // The pause it replaced kept everything it had already excluded.
    expect(pausedAt(observing, journal.repository, at('2026-03-09T10:10'))).toBe(true)
  })

  it('follows a repository off the list and back on, so its gap stays excluded', () => {
    let observing = pauseObserving(observingOn(), 'until-resumed', at('2026-03-09T10:00'))
    observing = removeRepository(observing, journal.repository, at('2026-03-09T10:10'))
    observing = addRepository(observing, journal, at('2026-03-09T10:20'))

    expect(pausedAt(observing, journal.repository, at('2026-03-09T10:15'))).toBe(true)
    expect(pausedAt(observing, journal.repository, at('2026-03-09T10:30'))).toBe(true)
  })

  it('excludes work done while the repository was off the list and paused at once', () => {
    let observing = observingOn()
    observing = removeRepository(observing, journal.repository, at('2026-03-09T09:50'))
    observing = pauseObserving(observing, 'until-resumed', at('2026-03-09T10:00'))
    observing = addRepository(observing, journal, at('2026-03-09T10:20'))

    // Both rules refuse it: off the list before it joined the pause, and
    // inside the pause after.
    expect(observedAt(observing, journal.repository, at('2026-03-09T10:10'))).toBe(false)
    expect(observedAt(observing, journal.repository, at('2026-03-09T10:30'))).toBe(false)
  })

  it('is pruned with consent once it ends before the lookback', () => {
    let observing = pauseObserving(observingOn(), 'an-hour', at('2026-03-09T10:00'))
    observing = resumeObserving(observing, at('2026-03-09T11:00'))
    observing = pauseObserving(
      observing,
      'an-hour',
      at('2026-03-09T11:00') + OBSERVE_LOOKBACK_MS + day,
    )

    expect(observing.pauses[journal.repository]).toEqual([
      {
        from: at('2026-03-09T11:00') + OBSERVE_LOOKBACK_MS + day,
        until: at('2026-03-09T11:00') + OBSERVE_LOOKBACK_MS + day + hour,
      },
    ])
  })

  it('is read back as it was written, and survives the file unchanged', () => {
    const paused = pauseObserving(observingOn(), 'until-resumed', at('2026-03-09T10:00'))

    const read = readObserving(JSON.parse(JSON.stringify(paused)))

    expect(read).toEqual(paused)
    expect(pausedAt(read, journal.repository, at('2026-03-09T22:00'))).toBe(true)
  })
})

describe('the pause controls', () => {
  /** Observing on with one repository listed. */
  const on = addRepository(
    turnObserving(NO_OBSERVING, true, at('2026-03-09T08:00')),
    journal,
    at('2026-03-09T08:00'),
  )

  it('have nothing to show while nothing is being observed', () => {
    expect(pauseState(NO_OBSERVING, at('2026-03-09T10:00'))).toEqual({ state: 'nothing' })
    expect(
      pauseState(turnObserving(NO_OBSERVING, true, at('2026-03-09T08:00')), at('2026-03-09T10:00')),
    ).toEqual({ state: 'nothing' })
  })

  it('offer a pause while Observing runs', () => {
    expect(pauseState(on, at('2026-03-09T10:00'))).toEqual({ state: 'running' })
  })

  it('say a pause is in force and until when', () => {
    const paused = pauseObserving(on, 'an-hour', at('2026-03-09T10:00'))

    // The whole shape, pinned: these three names are what the Tray Menu is
    // handed on the other side of the seam.
    expect(pauseState(paused, at('2026-03-09T10:15'))).toEqual({
      state: 'paused',
      until: at('2026-03-09T11:00'),
      label: expect.stringMatching(/^Paused until /),
    })
    expect(describePause(activePause(paused, at('2026-03-09T10:15'))!, at('2026-03-09T10:15')))
      .toMatch(/^Paused until \d{1,2}:\d{2}/)
  })

  it('say "tomorrow" for a pause that ends with the day, and "Paused" for one with no end', () => {
    const overnight = pauseObserving(on, 'until-tomorrow', at('2026-03-09T17:00'))
    const open = pauseObserving(on, 'until-resumed', at('2026-03-09T17:00'))

    expect(describePause(activePause(overnight, at('2026-03-09T17:30'))!, at('2026-03-09T17:30')))
      .toBe('Paused until tomorrow')
    expect(describePause(activePause(open, at('2026-03-09T17:30'))!, at('2026-03-09T17:30')))
      .toBe('Paused')
  })

  it('say the hour for a pause that merely crosses midnight', () => {
    const crossing = pauseObserving(on, 'an-hour', at('2026-03-09T23:30'))

    // It ends at half past midnight, not with the day: "tomorrow" names an
    // end, and this pause's end is its hour.
    expect(describePause(activePause(crossing, at('2026-03-09T23:40'))!, at('2026-03-09T23:40')))
      .toMatch(/^Paused until \d{1,2}:\d{2}/)
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
      pauses: {},
    })
  })
})
