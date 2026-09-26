import { describe, expect, it } from 'vitest'
import { fakeDesktop } from './testing/desktop'
import {
  CAPTURE_FIELD_HEIGHT,
  CAPTURE_HAIRLINE,
  CAPTURE_PANEL_BORDER,
  CAPTURE_PREDICTION_ROW,
  CAPTURE_REFUSAL_HEIGHT,
  CAPTURE_SHADOW_GUTTER,
  captureWindowHeight,
} from './desktop'

describe('Desktop app identity', () => {
  for (const [build, appIdentity] of [
    ['release', { version: '0.4.1', isDevelopment: false }],
    ['development', { version: '0.4.1', isDevelopment: true }],
  ] as const) {
    it(`exposes the configured version for a ${build} build`, async () => {
      const desktop = fakeDesktop({ appIdentity })

      expect(await desktop.appIdentity()).toEqual(appIdentity)
    })
  }
})

describe('the Capture window height', () => {
  it('rests at the field, its outline and its shadow gutter', () => {
    expect(captureWindowHeight({ predictions: 0, refused: false })).toBe(
      CAPTURE_FIELD_HEIGHT + 2 * (CAPTURE_PANEL_BORDER + CAPTURE_SHADOW_GUTTER),
    )
  })

  it('carries a hairline above the first Prediction and none above no Predictions', () => {
    const resting = captureWindowHeight({ predictions: 0, refused: false })

    expect(captureWindowHeight({ predictions: 1, refused: false })).toBe(
      resting + CAPTURE_HAIRLINE + CAPTURE_PREDICTION_ROW,
    )
    expect(captureWindowHeight({ predictions: 3, refused: false })).toBe(
      resting + CAPTURE_HAIRLINE + 3 * CAPTURE_PREDICTION_ROW,
    )
  })

  it('grows for a refusal rather than taking the room from the field', () => {
    // The field is a fixed height in the panel, so the only way the Body stays
    // whole under a refusal is for the window itself to be taller.
    expect(captureWindowHeight({ predictions: 0, refused: true })).toBe(
      captureWindowHeight({ predictions: 0, refused: false }) +
        CAPTURE_REFUSAL_HEIGHT,
    )
    expect(captureWindowHeight({ predictions: 2, refused: true })).toBe(
      captureWindowHeight({ predictions: 2, refused: false }) +
        CAPTURE_REFUSAL_HEIGHT,
    )
  })
})

describe('the fake commit reader', () => {
  const now = Date.now()
  const hour = 60 * 60 * 1000
  const repository = {
    repository: '/code/work-journal-ai/.git',
    configuredEmail: 'r.passos@outlook.pt',
    commits: [
      { hash: 'c3', subject: 'Theirs', authoredAt: now - hour, author: 'maintainer@example.com' },
      { hash: 'c2', subject: 'From GitHub', authoredAt: now - 2 * hour, author: '81316043+rp-pipecodes@users.noreply.github.com' },
      { hash: 'c1', subject: 'Yesterday', authoredAt: now - 24 * hour, author: 'R.Passos@outlook.pt' },
      { hash: 'c0', subject: 'Long ago', authoredAt: now - 100 * 24 * hour, author: 'old@example.com' },
    ],
  }

  it('answers with the named identities\' commits at or after the instant', async () => {
    const desktop = fakeDesktop({ repositories: { '/code/work-journal-ai': repository } })

    expect(
      await desktop.repositoryCommits(
        '/code/work-journal-ai',
        ['r.passos@outlook.pt', '81316043+rp-pipecodes@users.noreply.github.com'],
        now - 24 * hour,
      ),
    ).toEqual({
      state: 'read',
      commits: [
        { hash: 'c2', subject: 'From GitHub', authoredAt: now - 2 * hour, repository: '/code/work-journal-ai/.git' },
        { hash: 'c1', subject: 'Yesterday', authoredAt: now - 24 * hour, repository: '/code/work-journal-ai/.git' },
      ],
    })
    expect(
      await desktop.repositoryCommits('/code/work-journal-ai', [], 0),
    ).toEqual({ state: 'read', commits: [] })
  })

  it('suggests the configured address, then the last ninety days\' authors', async () => {
    const desktop = fakeDesktop({ repositories: { '/code/work-journal-ai': repository } })

    expect(await desktop.repositoryIdentities('/code/work-journal-ai')).toEqual({
      state: 'read',
      repository: '/code/work-journal-ai/.git',
      identities: [
        'r.passos@outlook.pt',
        'maintainer@example.com',
        '81316043+rp-pipecodes@users.noreply.github.com',
      ],
      reason: null,
    })
  })

  it('suggests the most recent author by author date, not by walk order', async () => {
    // On top in the walk, as a rebase leaves it, but written first.
    const desktop = fakeDesktop({
      repositories: {
        '/code/rebased': {
          repository: '/code/rebased/.git',
          commits: [
            { hash: 'b', subject: 'Written first', authoredAt: now - 5 * hour, author: 'rebased@example.com' },
            { hash: 'a', subject: 'Written last', authoredAt: now - hour, author: 'earlier@example.com' },
          ],
        },
      },
    })

    expect(await desktop.repositoryIdentities('/code/rebased')).toMatchObject({
      identities: ['earlier@example.com', 'rebased@example.com'],
    })
  })

  it('says why a repository cannot be read, and a path it has never heard of is missing', async () => {
    const desktop = fakeDesktop({ repositories: { '/tmp': 'not-a-repository' } })

    expect(await desktop.repositoryCommits('/tmp', ['me@example.com'], 0)).toEqual({
      state: 'unreadable',
      reason: 'not-a-repository',
    })
    expect(await desktop.repositoryIdentities('/gone')).toEqual({
      state: 'unreadable',
      reason: 'missing',
    })
  })

  it('reads a repository with nothing resolvable the way the reader does', async () => {
    // The real reader cannot fail an identities read with `no-head`: it
    // answers with the suggestions and the reason beside them, and only the
    // commits read cannot go on. The fake says it the same way, so no test
    // can put the reason on the wrong call.
    const desktop = fakeDesktop({
      repositories: {
        '/code/fresh': {
          repository: '/code/fresh/.git',
          configuredEmail: 'me@example.com',
          commits: [],
          noHead: true,
        },
      },
    })

    expect(await desktop.repositoryIdentities('/code/fresh')).toEqual({
      state: 'read',
      repository: '/code/fresh/.git',
      identities: ['me@example.com'],
      reason: 'no-head',
    })
    expect(
      await desktop.repositoryCommits('/code/fresh', ['me@example.com'], 0),
    ).toEqual({
      state: 'unreadable',
      reason: 'no-head',
    })
  })
})
