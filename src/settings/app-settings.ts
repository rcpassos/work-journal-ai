/**
 * The settings as a running window has them: the core's rules over the
 * desktop's store, and the announcements that keep the other windows honest.
 * Built from a Desktop and nothing else, so the suite drives the whole of it
 * without Tauri or a file on disk.
 *
 * It holds no rule of its own — what a valid value is, and what a store that
 * says nothing means, both stay in `settings.ts` and `theme.ts`.
 */

import type { Desktop, Unlisten } from '@/platform/desktop'
import {
  readSettings,
  writeImportCalendars,
  writeImportMeetings,
  writeModel,
  writeModelBaseUrl,
  writeObserving,
  writeWorkSummaryPrompt,
  writeStartAtLogin,
  type Settings,
  type SettingsStore,
} from './settings'
import { systemClock, type Clock } from '@/journal/journal'
import type { Observing } from './observing'
import { readTheme, writeTheme, type Theme } from './theme'

/**
 * One part of Model Access, as the save that changed it says. A save speaks
 * only the part it wrote: the two ordinary fields announce the value the save
 * landed — never a re-read of the file, which could carry an older answer
 * than the one the user is looking at — and a Key save announces whether the
 * Keychain now holds a Key, which it knows without asking the Keychain again.
 * A field save therefore never touches the Keychain, and a refused Keychain
 * can never take a field save's announcement down with it.
 */
export type ModelAccessChange =
  | { modelBaseUrl: string }
  | { model: string }
  | { keySet: boolean }

export interface AppSettings {
  /** Every setting at once, with a default wherever the store is silent. */
  load(): Promise<Settings>
  /** The Theme as it stands, or `system` until the user has chosen one. */
  loadTheme(): Promise<Theme>
  /**
   * A new Theme, remembered and announced. Every window repaints, including
   * the one the toggle was not pressed in.
   */
  saveTheme(theme: Theme): Promise<void>
  onThemeChanged(handle: (theme: Theme) => void): Promise<Unlisten>
  /**
   * The answer to start at login, acted on and then remembered. The login item
   * is changed first: an answer recorded but not honoured would leave Settings
   * claiming something the OS disagrees with. A save that lands is announced,
   * so every control reading the answer — the Settings row and the Onboarding
   * flow's step both do — reflects what the OS came to hold. Only the newest
   * save announces: the OS and the file take each wish as it is made, so an
   * older save that settles after a newer one has already been undone by it.
   */
  saveStartAtLogin(startAtLogin: boolean): Promise<void>
  /**
   * A Start at Login save landed, in this window — and is still the newest
   * one. Heard by the Settings row so a choice saved by the Onboarding flow
   * reaches the mounted section without its state being rebuilt — the answer
   * the OS holds is one fact, however many controls write it. Announced
   * after the save settles, so a departure before it settles still reaches
   * the control that stayed.
   */
  onStartAtLoginChanged(handle: (startAtLogin: boolean) => void): Unlisten
  /**
   * Whether meetings are swept and which calendars are read, remembered and
   * announced. Announced because the window that sweeps is not the window
   * this is changed in — and because the Settings group and the Onboarding
   * flow's step share this very instance: a choice saved by the flow must
   * reach the mounted section without its state being rebuilt. Every settled
   * save announces the file as it stands then, so overlapping saves resolve
   * to the last write to have landed rather than to whoever started last.
   */
  onImportChanged(
    handle: (imported: {
      importMeetings: boolean
      importCalendars: string[]
    }) => void,
  ): Unlisten
  /**
   * Whether meetings are swept, remembered and announced. Announced because
   * the window that sweeps is not the window this is changed in, and a change
   * the user just made should reach the journal now rather than at the next
   * sweep. Only the user reaches this: the sweep returns when the calendar
   * permission is gone rather than writing the wish off, so the reason
   * Settings owes the user survives.
   */
  saveImportMeetings(importMeetings: boolean): Promise<void>
  /** Which calendars an Import reads. Announced for the same reason. */
  saveImportCalendars(importCalendars: string[]): Promise<void>
  /**
   * Whether Model Access has its three parts, remembered and announced — the
   * two that are ordinary settings, and whether the Keychain holds the Key.
   * Announced because the Settings group and the Onboarding flow's step share
   * this very instance: a choice saved by the flow must reach the mounted
   * section without its state being rebuilt. A settled save announces only
   * the part it wrote — the two ordinary fields each announce the value the
   * save just landed, and a Key save knows the Keychain now holds (or no
   * longer holds) a Key without asking it again — so a Base URL keystroke
   * never touches the Keychain, and only the newest save of a part speaks, so
   * an older save settling late never puts an older value back. The Key
   * itself never travels on the announcement — only whether the Keychain
   * holds one.
   */
  onModelAccessChanged(handle: (change: ModelAccessChange) => void): Unlisten
  /** Where the model is. Stored, and announced for the reason above. */
  saveModelBaseUrl(modelBaseUrl: string): Promise<void>
  /** Which model to ask. Stored the same way, and for the same reason. */
  saveModel(model: string): Promise<void>
  /**
   * Hands the API Key to the Keychain — reached through Rust, and announced
   * as held or not once it settles, for the reason above. What the Keychain
   * holds is never read back into this window; only whether it holds one is.
   */
  saveApiKey(apiKey: string): Promise<void>
  /** Takes the API Key out of the Keychain. Announced the same way. */
  clearApiKey(): Promise<void>
  /**
   * The preferences a Work Summary is written under. Stored the same way, and
   * for the same reason: nothing but the window it was typed in is looking at
   * it, and whatever reads it next reads it when it needs it.
   */
  saveWorkSummaryPrompt(workSummaryPrompt: string): Promise<void>
  /**
   * One change to Observing — a rule from `./observing.ts`, applied to the
   * file as it stands and at the instant it is made, since consent is kept
   * as instants. Changes are applied one after another, never side by side:
   * two applied to the same read would each write the list without the
   * other's repository, and a consent interval lost that way is work the
   * user said yes to that never arrives. Resolves with what the file came to
   * hold, and announces it, because the window that sweeps is not this one.
   */
  updateObserving(
    change: (observing: Observing, now: number) => Observing,
  ): Promise<Observing>
}

/**
 * An announcement that keeps the other windows honest, sent beside the write
 * it speaks for rather than as part of it. It is best-effort: what the file
 * holds is what was saved, and a failed emit — a window gone while it was
 * sent, a bus that hiccuped — is logged rather than allowed to name a saved
 * setting as refused. The window it was meant for catches up at its next
 * read: later by moments, but agreeing with the file.
 */
function emitChange(announcing: Promise<void>): void {
  void announcing.catch((error: unknown) => {
    console.error('could not announce the change to the other windows', error)
  })
}

export function createAppSettings(
  desktop: Desktop,
  /** Only Observing reads it: consent is kept as the instants it was given. */
  clock: Clock = systemClock,
): AppSettings {
  // Opened once per window and shared: every setting is in the one file, and
  // the store is what makes a write reach the disk.
  let loading: Promise<SettingsStore> | null = null
  function store(): Promise<SettingsStore> {
    loading ??= desktop.openSettingsStore()
    return loading
  }

  // Who is listening for a Start at Login save, in this window. In-window
  // rather than a Desktop announcement: no other window reads the login item,
  // and the two controls that do — the Settings row and the Onboarding step —
  // share this very instance.
  const startAtLoginChanged = new Set<(startAtLogin: boolean) => void>()
  // How many Start at Login saves have been started in this window. The OS
  // and the file take each wish as it is made, so a save that started before
  // a newer one has been undone by it by the time it settles — announcing it
  // would put a superseded answer back over the newer save's. Only the save
  // that is still the newest when it settles speaks for the answer that came
  // to hold.
  let startAtLoginSaves = 0
  // Who is listening for an Import save, in this window. In-window rather
  // than a Desktop announcement, for the same reason as above: the two
  // controls that read the answer — the Settings group and the Onboarding
  // step — share this very instance.
  const importChanged = new Set<
    (imported: { importMeetings: boolean; importCalendars: string[] }) => void
  >()
  // Who is listening for a Model Access save, in this window. In-window
  // rather than a Desktop announcement, for the same reason as the Import
  // one above: the two controls that read the answer — the Settings group
  // and the Onboarding step — share this very instance.
  const modelAccessChanged = new Set<(change: ModelAccessChange) => void>()
  // How many saves of each part have been started in this window. A save
  // that started before a newer one of the same part has been undone by it by
  // the time it settles — announcing it would put the older value back over
  // the newer one's — so only the save that is still the newest of its part
  // when it settles speaks. One counter per part: a keystroke into one field
  // never silences a save of the other, and a Key save never silences a
  // field save.
  let modelBaseUrlSaves = 0
  let modelSaves = 0
  let apiKeySaves = 0
  // The Observing change last started, which the next one waits for — see
  // `updateObserving`. Settled either way, so one refusal never stalls the
  // changes queued behind it.
  let observingChanges: Promise<unknown> = Promise.resolve()

  /**
   * Announces a settled Model Access save, as the caller's own landed value
   * rather than a re-read of the file: a re-read resolves on its own, and an
   * older re-read arriving after a newer keystroke has rendered would put the
   * older text back under the cursor. Announced only while this is still the
   * newest save of its part, for the same reason — see
   * docs/adr/0028-the-initial-read-seeds-only-what-the-user-has-not-changed.md.
   * Best-effort, like every other announcement: it is a synchronous call to
   * the listeners in this window, so there is nothing to refuse with.
   */
  function announceModelAccess(
    newest: boolean,
    change: ModelAccessChange,
  ): void {
    if (!newest) return
    for (const handle of modelAccessChanged) handle(change)
  }

  /**
   * Announces a settled Import save, with both keys as the file holds them
   * now. Every settled save speaks — unlike the Start at Login announcement,
   * which carries the caller's value and must stay silent once superseded,
   * this one re-reads the file, so its payload can never be a superseded
   * answer: it is the file as it stands, and the last one to be heard is
   * always the last write to have landed. Best-effort, like every other
   * announcement: a refusal is logged rather than allowed to name a saved
   * setting as refused.
   */
  function announceImport(): void {
    void (async () => {
      try {
        const stored = await readSettings(await store())
        for (const handle of importChanged) {
          handle({
            importMeetings: stored.importMeetings,
            importCalendars: stored.importCalendars,
          })
        }
      } catch (error: unknown) {
        console.error(
          'could not announce the change to the other windows',
          error,
        )
      }
    })()
  }

  return {
    async load() {
      return readSettings(await store())
    },

    async loadTheme() {
      return readTheme(await store())
    },

    async saveTheme(theme) {
      await writeTheme(await store(), theme)
      emitChange(desktop.announceTheme(theme))
    },

    onThemeChanged: (handle) => desktop.onThemeChanged(handle),

    async saveStartAtLogin(startAtLogin) {
      const save = ++startAtLoginSaves
      await desktop.setStartAtLogin(startAtLogin)
      await writeStartAtLogin(await store(), startAtLogin)
      // After it took: a save still in flight when a window departs must
      // still reach the control that stayed mounted, and a control must never
      // be told a change was saved before the OS has it — nor told about a
      // change a newer save has already undone, which is what makes an older
      // save that settles later hold its tongue.
      if (save === startAtLoginSaves) {
        for (const handle of startAtLoginChanged) handle(startAtLogin)
      }
    },

    onStartAtLoginChanged(handle) {
      startAtLoginChanged.add(handle)
      return () => {
        startAtLoginChanged.delete(handle)
      }
    },
    /**
     * An Import save landed, in this window. Heard by the Settings group so
     * a choice saved by the Onboarding flow reaches the mounted section
     * without its state being rebuilt — the wish and the ticks are one fact
     * the file holds, however many controls write it, and rebuilding would
     * throw away what else the user has unsaved in Settings. Announced after
     * the save settles, so a departure before it settles still reaches the
     * control that stayed.
     */
    onImportChanged(handle) {
      importChanged.add(handle)
      return () => {
        importChanged.delete(handle)
      }
    },

    async saveImportMeetings(importMeetings) {
      await writeImportMeetings(await store(), importMeetings)
      emitChange(desktop.announceImportChanged())
      // After it took: a save still in flight when a window departs must
      // still reach the control that stayed mounted — and every settled save
      // speaks, because each speaks the file as it stands.
      announceImport()
    },

    async saveImportCalendars(importCalendars) {
      await writeImportCalendars(await store(), importCalendars)
      emitChange(desktop.announceImportChanged())
      announceImport()
    },

    /**
     * A Model Access save landed, in this window. Heard by the Settings
     * group so a choice saved by the Onboarding flow reaches the mounted
     * section without its state being rebuilt — the Base URL, the Model and
     * the Key are one fact, however many controls write it, and rebuilding
     * would throw away what else the user has unsaved in Settings. Announced
     * after the save settles, so a departure before it settles still reaches
     * the control that stayed.
     */
    onModelAccessChanged(handle) {
      modelAccessChanged.add(handle)
      return () => {
        modelAccessChanged.delete(handle)
      }
    },

    async saveModelBaseUrl(modelBaseUrl) {
      const save = ++modelBaseUrlSaves
      await writeModelBaseUrl(await store(), modelBaseUrl)
      // After it took, and only if no newer Base URL save has been started
      // since: a keystroke that settles after the next one has already been
      // typed must not put its older value back over it. The value announced
      // is this save's own, never a re-read of the file — the two could
      // disagree, and the re-read could arrive last.
      announceModelAccess(save === modelBaseUrlSaves, { modelBaseUrl })
    },

    async saveModel(model) {
      const save = ++modelSaves
      await writeModel(await store(), model)
      announceModelAccess(save === modelSaves, { model })
    },

    async saveApiKey(apiKey) {
      const save = ++apiKeySaves
      await desktop.saveApiKey(apiKey)
      // The Keychain took the Key, so this save knows the answer without
      // asking again — and a settled save that is no longer the newest Key
      // change holds its tongue, as the newest one has already said what
      // came to hold.
      announceModelAccess(save === apiKeySaves, { keySet: true })
    },

    async clearApiKey() {
      const save = ++apiKeySaves
      await desktop.clearApiKey()
      announceModelAccess(save === apiKeySaves, { keySet: false })
    },

    async saveWorkSummaryPrompt(workSummaryPrompt) {
      await writeWorkSummaryPrompt(await store(), workSummaryPrompt)
    },

    updateObserving(change) {
      const applying = observingChanges.then(async () => {
        const opened = await store()
        const { observing } = await readSettings(opened)
        const next = change(observing, clock.now().getTime())
        await writeObserving(opened, next)
        emitChange(desktop.announceObservingChanged())
        return next
      })
      observingChanges = applying.catch(() => {})
      return applying
    },
  }
}
