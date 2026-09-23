/**
 * The Tray Menu's Observing controls, answered from the capture window.
 *
 * Pausing is done in the moment — a screen share, a client's confidential
 * work — so it lives in the Tray Menu as well as in Settings. The menu is
 * Rust's and cannot reach the settings file: like yesterday's Digest, the
 * tray asks and this window answers. What it answers *with* is not its own
 * either — a pause is an interval under `@/settings/observing`'s rules — so
 * this only sequences the ask, the save and the read-back.
 *
 * The controls' own state travels the other way, rendered already said:
 * whenever Observing changes in any window, what the menu should read is
 * computed from the file and handed to the tray. A timed pause that later
 * runs out needs no telling — the menu reads its state against the clock as
 * it opens, so an end that has passed is read as passed.
 *
 * Headless, like the tray count, and built from settings, a Desktop and a
 * clock: the whole of it runs in a test with no menu bar. One of these runs
 * per app, in the capture window — the one window that lives as long as the
 * tray does; see
 * docs/adr/0002-capture-window-is-hidden-never-closed.md.
 */

import type { Clock } from './journal'
import type { Desktop, PauseLength, Unlisten } from '@/platform/desktop'
import type { AppSettings } from '@/settings/app-settings'
import {
  pauseObserving,
  pauseState,
  resumeObserving,
  type Observing,
} from '@/settings/observing'

export interface TrayObserving {
  /**
   * Answers the Tray Menu, and keeps it current: subscribes to its asks and
   * to every change to Observing. Resolves once the menu has been told what
   * to read.
   */
  start(): Promise<void>
  /** Gives all of it up, for good. */
  stop(): void
}

export function createTrayObserving({
  settings,
  desktop,
  clock,
}: {
  settings: AppSettings
  desktop: Desktop
  clock: Clock
}): TrayObserving {
  let running = false
  let unlisten: Unlisten[] = []

  /**
   * What the menu should read right now. The file is read rather than held:
   * a pause can end while this sits idle, and the state pushed then is the
   * one a reader of the menu should be given.
   */
  async function show(): Promise<void> {
    try {
      const { observing } = await settings.load()
      if (!running) return
      await desktop.showTrayObserving(pauseState(observing, clock.now().getTime()))
    } catch (error) {
      console.error('could not show the Tray Menu what Observing is doing', error)
    }
  }

  /** One press from the menu, applied as a rule to the file as it stands. */
  async function apply(
    change: (observing: Observing, now: number) => Observing,
  ): Promise<void> {
    try {
      await settings.updateObserving(change)
    } catch (error) {
      // The menu's press is not worth asking anybody about: a settings file
      // that would not take the pause is a gap, exactly as a repository that
      // cannot be read is.
      console.error('could not change the pause', error)
    }
  }

  return {
    async start() {
      running = true
      const stopListening = await Promise.all([
        desktop.onObservingPauseRequested((length: PauseLength) =>
          void apply((observing, now) => pauseObserving(observing, length, now)),
        ),
        desktop.onObservingResumeRequested(() =>
          void apply((observing, now) => resumeObserving(observing, now)),
        ),
        // The tray's own presses land here too, through the save's
        // announcement: one path for every change, wherever it was made.
        desktop.onObservingChanged(() => void show()),
      ])

      // Stopped while the subscriptions were still being made: give them up
      // now, rather than leaving listeners nothing will ever come back for.
      if (!running) {
        for (const stop of stopListening) stop()
        return
      }
      unlisten = stopListening
      await show()
    },

    stop() {
      running = false
      for (const stop of unlisten) stop()
      unlisten = []
    },
  }
}
