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
})
