import { describe, expect, it, vi } from 'vitest'
import { fixedClock } from './testing/database'
import { fakeDesktop } from '../platform/testing/desktop'
import { createAppSettings } from '../settings/app-settings'
import { readObserving, turnObserving } from '../settings/observing'
import { createTrayObserving } from './tray-observing'

// The Tray Menu's Observing controls, answered end to end: a fake desktop for
// the menu's presses and its display, a fake settings store, and an injected
// clock. What is asserted is what the menu was told to read, and what the
// settings file came to hold — the press and its answer, with no menu bar.

const listed = {
  enabled: true,
  repositories: [
    {
      path: '/code/work-journal-ai',
      repository: '/code/work-journal-ai/.git',
      identities: ['me@example.com'],
      ignoredPrefixes: [],
    },
  ],
  consent: {},
  pauses: {},
}

/** Lets everything a press set going finish before asserting. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve()
}

function trayAt(instant: string) {
  const clock = fixedClock(instant)
  const desktop = fakeDesktop({ stored: { observing: listed } })
  const settings = createAppSettings(desktop, clock)
  const session = createTrayObserving({ settings, desktop, clock })
  return { desktop, clock, settings, session }
}

describe('the Tray Menu', () => {
  it('is told what Observing is doing as this starts', async () => {
    const { desktop, session } = trayAt('2026-03-09T10:00:00')

    await session.start()

    expect(desktop.trayObserving).toEqual({ state: 'running' })
  })

  it('is answered with a pause held in the settings file, and says so', async () => {
    const { desktop, session } = trayAt('2026-03-09T10:00:00')
    await session.start()

    desktop.requestObservingPause('an-hour')
    await flush()

    const state = desktop.trayObserving
    expect(state?.state).toBe('paused')
    expect(state).toMatchObject({ until: new Date('2026-03-09T11:00:00').getTime() })
    expect((state as { label: string }).label).toMatch(/^Paused until /)
    expect(desktop.stored.observing).toMatchObject({
      pauses: {
        '/code/work-journal-ai/.git': [
          {
            from: new Date('2026-03-09T10:00:00').getTime(),
            until: new Date('2026-03-09T11:00:00').getTime(),
          },
        ],
      },
    })
  })

  it('is answered with a resume, and the pause it ended keeps what it excluded', async () => {
    const { desktop, session } = trayAt('2026-03-09T10:00:00')
    await session.start()
    desktop.requestObservingPause('until-resumed')
    await flush()

    desktop.requestObservingResume()
    await flush()

    expect(desktop.trayObserving).toEqual({ state: 'running' })
    expect(
      readObserving(desktop.stored.observing).pauses['/code/work-journal-ai/.git'],
    ).toEqual([
      {
        from: new Date('2026-03-09T10:00:00').getTime(),
        until: new Date('2026-03-09T10:00:00').getTime(),
      },
    ])
  })

  it('tells the menu again when the Mac wakes', async () => {
    const { desktop, clock, session } = trayAt('2026-03-09T10:00:00')
    await session.start()
    desktop.requestObservingPause('an-hour')
    await flush()
    expect(desktop.trayObserving?.state).toBe('paused')

    // The pause ended while the Mac slept, and the timer that would have
    // said so slept with it — nothing here runs it, so the wake is the only
    // thing that can tell the menu. Without a wake the state stays paused.
    clock.set(new Date('2026-03-09T11:00:00'))
    desktop.wake()
    await flush()

    expect(desktop.trayObserving).toEqual({ state: 'running' })
  })

  it('tells the menu again as a timed pause runs out on its own', async () => {
    vi.useFakeTimers()
    try {
      const { desktop, clock, session } = trayAt('2026-03-09T10:00:00')
      await session.start()
      desktop.requestObservingPause('an-hour')
      await flush()
      expect(desktop.trayObserving?.state).toBe('paused')

      // The end comes for a pause nobody pressed anything about — and what
      // the tray holds is what a reader who opens the menu without a click is
      // shown, so it is told as the pause ends rather than at the next press.
      clock.set(new Date('2026-03-09T11:00:00'))
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
      await flush()

      expect(desktop.trayObserving).toEqual({ state: 'running' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('says no more about a pause running out once this is stopped', async () => {
    vi.useFakeTimers()
    try {
      const { desktop, clock, session } = trayAt('2026-03-09T10:00:00')
      await session.start()
      desktop.requestObservingPause('an-hour')
      await flush()
      session.stop()
      desktop.trayObserving = null

      clock.set(new Date('2026-03-09T11:00:00'))
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
      await flush()

      expect(desktop.trayObserving).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('hears a change made in Settings as readily as its own press', async () => {
    const { desktop, settings, session } = trayAt('2026-03-09T10:00:00')
    await session.start()

    await settings.updateObserving((observing, now) =>
      turnObserving(observing, false, now),
    )
    await flush()

    expect(desktop.trayObserving).toEqual({ state: 'nothing' })
  })

  it('is answered no more once this is stopped', async () => {
    const { desktop, settings, session } = trayAt('2026-03-09T10:00:00')
    await session.start()
    session.stop()
    desktop.trayObserving = null

    desktop.requestObservingPause('an-hour')
    await settings.updateObserving((observing, now) =>
      turnObserving(observing, false, now),
    )
    await flush()

    expect(desktop.trayObserving).toBeNull()
    expect(readObserving(desktop.stored.observing).pauses).toEqual({})
  })
})
