/// <reference types="vite/client" />

/**
 * The desktop as Tauri provides it. This is the only file in the app that
 * imports `@tauri-apps/*`: everything else is handed a `Desktop` and cannot
 * tell what is underneath it.
 */

import { getVersion } from '@tauri-apps/api/app'
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { LogicalSize } from '@tauri-apps/api/dpi'
import { downloadDir, join } from '@tauri-apps/api/path'
import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  open,
  save,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from '@tauri-apps/plugin-dialog'
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { relaunch } from '@tauri-apps/plugin-process'
import Database from '@tauri-apps/plugin-sql'
import { load } from '@tauri-apps/plugin-store'
import { check, type Update } from '@tauri-apps/plugin-updater'
import type { CalendarEvent, TaskAlert } from '@/journal/journal'
import type { HotkeyAction, HotkeyStatuses } from '@/settings/hotkey'
import type { Theme } from '@/settings/theme'
import {
  CAPTURE_SHOWN_EVENT,
  CAPTURE_WIDTH,
  captureWindowHeight,
  COPY_YESTERDAY_DIGEST_EVENT,
  DATABASE_URL,
  IMPORT_CHANGED_EVENT,
  OBSERVING_CHANGED_EVENT,
  JOURNAL_CHANGED_EVENT,
  NOTE_CAPTURED_EVENT,
  PRACTICE_ENDED_EVENT,
  SETTINGS_FILE,
  SECTION_REQUESTED_EVENT,
  SYSTEM_WOKE_EVENT,
  TASK_ALERT_COMPLETED_EVENT,
  TASK_ALERT_OPENED_EVENT,
  TASK_ALERTS_RECONCILED_EVENT,
  TASK_CREATION_SHOWN_EVENT,
  taskCreationWindowHeight,
  TASKS_CHANGED_EVENT,
  THEME_CHANGED_EVENT,
  type AvailableUpdate,
  type AutomaticBackups,
  type BackupResult,
  type CalendarAccess,
  type CalendarInfo,
  type CommitsRead,
  type Desktop,
  type ExportedFile,
  type IdentitiesRead,
  type MainSection,
  type OnboardingState,
  type PracticeEnded,
  type WorkSummaryRequest,
  type WorkSummaryResponse,
  type TaskAlertCompletion,
  type TaskAlertPermission,
} from './desktop'
import { releaseNotes } from './release-notes'

export function createTauriDesktop(): Desktop {
  // What the last check found, kept until it is installed or a later check
  // replaces it. The plugin answers with the update itself rather than with a
  // version, and installing means installing that one — the release the user
  // was shown and pressed for, not whatever is newest by the time they press.
  let found: Update | null = null

  return {
    // Outside Tauri — a bare `vite dev` — there is no current window to ask.
    windowLabel() {
      try {
        return getCurrentWindow().label
      } catch {
        return ''
      }
    },

    async appIdentity() {
      return {
        version: await getVersion(),
        // `tauri dev` serves Vite's dev bundle; `tauri build` uses production.
        isDevelopment: import.meta.env.DEV,
      }
    },

    // The marker is the Rust side's to read and write: it is settled before
    // this window (or the journal it reads) exists, which is the whole point.
    onboardingState: () => invoke<OnboardingState>('onboarding_state'),
    dismissOnboarding: () => invoke<void>('dismiss_onboarding'),

    closeWindow: () => getCurrentWindow().close(),

    // Clicking away is a discard, not a Capture left floating over the screen.
    onWindowBlurred: (handle) =>
      getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (!focused) handle()
      }),

    onWindowFocused: (handle) =>
      getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (focused) handle()
      }),

    isWindowVisible: () => getCurrentWindow().isVisible(),

    async onCloseRequested(answer) {
      const window = getCurrentWindow()
      // Guards the close this makes on the user's behalf, so it cannot
      // re-enter and loop.
      let closing = false

      return window.onCloseRequested((event) => {
        if (closing) return
        closing = true
        // Held open until the answer is written down; a window closing takes
        // its webview, and with it any write still in flight.
        event.preventDefault()
        void answer().finally(() => {
          void window.close()
        })
      })
    },

    async openJournalDatabase() {
      const database = await Database.load(DATABASE_URL)
      return {
        execute: (sql, params) => database.execute(sql, params),
        select: (sql, params) => database.select(sql, params),
        // Not `BEGIN` and `COMMIT` from here: the plugin hands each call
        // whichever connection of its pool happens to be free, so the writes
        // would not be on the connection that opened the transaction. The
        // Rust side runs the whole list through one of its own instead — see
        // docs/adr/0020-recurring-task-transitions-are-transactional.md.
        transaction: (statements) => invoke('journal_transaction', { statements }),
      }
    },

    async openSettingsStore() {
      // Every write is flushed rather than debounced, because the Rust side
      // reads the same file at startup and a lost write is a setting that
      // silently did not take.
      const backing = await load(SETTINGS_FILE, { autoSave: false })
      return {
        get: (key) => backing.get(key),
        has: (key) => backing.has(key),
        set: async (key, value) => {
          await backing.set(key, value)
          await backing.save()
        },
      }
    },

    dismissCapture: () => invoke('dismiss_capture'),
    beginPracticeCapture: () => invoke('start_practice_capture'),
    dismissPracticeCapture: (ended) =>
      invoke('dismiss_practice_capture', { ended }),
    announcePracticeEnded: (ended) => emit(PRACTICE_ENDED_EVENT, ended),
    onPracticeEnded: (handle) =>
      listen<PracticeEnded>(PRACTICE_ENDED_EVENT, ({ payload }) =>
        handle(payload),
      ),

    // Built at the resting size in Rust; the height is worked out in one place
    // so the window and the panel drawn inside it cannot disagree.
    fitCapture: (fit) =>
      getCurrentWindow().setSize(
        new LogicalSize(CAPTURE_WIDTH, captureWindowHeight(fit)),
      ),

    onCaptureShown: (handle) =>
      listen<{ practice: boolean }>(CAPTURE_SHOWN_EVENT, ({ payload }) =>
        handle(payload.practice),
      ),

    beginTaskCreation: () => invoke('start_task_creation'),
    dismissTaskCreation: () => invoke('dismiss_task_creation'),
    onTaskCreationShown: (handle) =>
      listen(TASK_CREATION_SHOWN_EVENT, () => handle()),
    fitTaskCreation: (refused) =>
      getCurrentWindow().setSize(
        new LogicalSize(CAPTURE_WIDTH, taskCreationWindowHeight(refused)),
      ),

    announceTasksChanged: () => emit(TASKS_CHANGED_EVENT),
    onTasksChanged: (handle) => listen(TASKS_CHANGED_EVENT, () => handle()),

    taskAlertPermission: () =>
      invoke<TaskAlertPermission>('task_alert_permission'),
    requestTaskAlertPermission: () =>
      invoke<TaskAlertPermission>('request_task_alert_permission'),
    reconcileTaskAlerts: (alerts: TaskAlert[]) =>
      invoke('reconcile_task_alerts', { alerts }),
    onTaskAlertOpened: (handle) =>
      listen<{ taskId: string }>(TASK_ALERT_OPENED_EVENT, ({ payload }) =>
        handle(payload.taskId),
      ),
    onTaskAlertCompleted: (handle) =>
      listen<TaskAlertCompletion>(TASK_ALERT_COMPLETED_EVENT, ({ payload }) =>
        handle(payload),
      ),
    announceTaskAlertsReconciled: (held) =>
      emit(TASK_ALERTS_RECONCILED_EVENT, { held }),
    onTaskAlertsReconciled: (handle) =>
      listen<{ held: boolean }>(TASK_ALERTS_RECONCILED_EVENT, ({ payload }) =>
        handle(payload.held),
      ),
    requestedSection: async () =>
      (await invoke<MainSection | null>('requested_section')) ?? null,
    onSectionRequested: (handle) =>
      listen<{ section: MainSection }>(SECTION_REQUESTED_EVENT, ({ payload }) =>
        handle(payload.section),
      ),

    openedTaskAlert: async () =>
      (await invoke<string | null>('opened_task_alert')) ?? null,
    completedTaskAlert: () =>
      invoke<TaskAlertCompletion[]>('completed_task_alert'),
    focusTaskAlert: (alertId) =>
      invoke('focus_task_alert', { alertId }),
    openNotificationSettings: () => invoke('open_notification_settings'),

    onYesterdayDigestRequested: (handle) =>
      listen(COPY_YESTERDAY_DIGEST_EVENT, () => handle()),

    calendarAccess: () => invoke<CalendarAccess>('calendar_access'),
    requestCalendarAccess: () => invoke<CalendarAccess>('request_calendar_access'),
    calendars: () => invoke<CalendarInfo[]>('calendars'),
    todaysCalendarEvents: () => invoke<CalendarEvent[]>('todays_calendar_events'),

    repositoryCommits: (path, identities, since) =>
      invoke<CommitsRead>('repository_commits', { path, identities, since }),
    repositoryIdentities: (path) =>
      invoke<IdentitiesRead>('repository_identities', { path }),

    // Opened on this side, like the restore picker: a cancelled dialog is a
    // frontend outcome rather than an error.
    async chooseRepositoryFolder() {
      const chosen = await open({ directory: true, multiple: false })
      if (chosen === null) return null
      if (Array.isArray(chosen)) return chosen[0] ?? null
      return chosen
    },

    announceObservingChanged: () => emit(OBSERVING_CHANGED_EVENT),
    onObservingChanged: (handle) => listen(OBSERVING_CHANGED_EVENT, () => handle()),

    onSystemWoke: (handle) => listen(SYSTEM_WOKE_EVENT, () => handle()),

    announceImportChanged: () => emit(IMPORT_CHANGED_EVENT),
    onImportChanged: (handle) => listen(IMPORT_CHANGED_EVENT, () => handle()),

    announceCapturedNote: (journalDay) =>
      emit(NOTE_CAPTURED_EVENT, { journalDay }),
    onNoteCaptured: (handle) =>
      listen<{ journalDay: string }>(NOTE_CAPTURED_EVENT, ({ payload }) =>
        handle(payload.journalDay),
      ),

    announceJournalChanged: () => emit(JOURNAL_CHANGED_EVENT),
    onJournalChanged: (handle) => listen(JOURNAL_CHANGED_EVENT, () => handle()),

    announceTheme: (theme) => emit(THEME_CHANGED_EVENT, { theme }),
    onThemeChanged: (handle) =>
      listen<{ theme: Theme }>(THEME_CHANGED_EVENT, ({ payload }) =>
        handle(payload.theme),
      ),

    hotkeyStatus: () => invoke<HotkeyStatuses>('hotkey_status'),
    setHotkey: (action: HotkeyAction, hotkey) =>
      invoke<HotkeyStatuses>('set_hotkey', { action, hotkey }),

    startsAtLogin: () => isEnabled(),

    async setStartAtLogin(startAtLogin) {
      // Asked first, because removing a login item that was never added fails
      // on macOS — and declining on first run is exactly that case.
      if ((await isEnabled()) !== startAtLogin) {
        await (startAtLogin ? enable() : disable())
      }
    },

    // The OS writes it, not the webview: the Tray Menu copies with no window
    // focused, where the webview's own clipboard is not allowed to.
    copyToClipboard: (text) => writeText(text),

    // The key crosses to Rust and never comes back: these three say whether
    // there is one, replace it, and remove it.
    apiKeySet: () => invoke<boolean>('api_key_set'),
    saveApiKey: (apiKey) => invoke('save_api_key', { apiKey }),
    clearApiKey: () => invoke('clear_api_key'),

    exportJournal: (markdown, fileName) =>
      invoke<ExportedFile>('export_journal', { markdown, fileName }),

    automaticBackups: () => invoke<AutomaticBackups>('automatic_backups'),

    // The picker and the write are two invocations, sequenced by the caller:
    // a `null` here means the user cancelled, and no backup call follows.
    //
    // The dialog is opened here rather than by a Rust command, for the same
    // reason `exportJournal`'s filename is rendered by the journal core and
    // this side only carries it across: the name a backup suggests is the
    // name `backupJournal`'s own `snapshot_file_name` writes, so both ends
    // read it from `desktop.ts` and cannot drift. The defaultPath carries
    // the Downloads folder and the timestamped name together, so the common
    // case is one confirm.
    async chooseBackupLocation() {
      const options: SaveDialogOptions = {
        defaultPath: await join(await downloadDir(), backupFileName()),
      }
      return save(options)
    },

    backupJournal: (path) => invoke<BackupResult>('backup_journal', { path }),

    revealBackups: () => invoke('reveal_backups'),

    // The picker and the stage are two invocations, sequenced by the caller:
    // a `null` here means the user cancelled, and no stage call follows.
    //
    // The dialog is opened here rather than by a Rust command, for the same
    // reason `chooseBackupLocation` opens its own: the file the user is
    // offered is chosen on this side, and a cancelled dialog is a frontend
    // outcome rather than an error. Filtered to the backup extension, so the
    // common case is one confirm — and no path is ever hand-typed.
    async chooseRestoreCandidate() {
      const options: OpenDialogOptions = {
        filters: [{ name: 'Work Journal backup', extensions: ['db'] }],
        multiple: false,
        directory: false,
      }
      const chosen = await open(options)
      if (chosen === null) return null
      if (Array.isArray(chosen)) return chosen[0] ?? null
      return chosen
    },

    stageRestore: (path) => invoke('stage_restore', { path }),

    // The Key stays in the Keychain: only what the model needs to hear crosses
    // to Rust, and the answer comes back as one shape, success or failure.
    generateWorkSummary: (request: WorkSummaryRequest) =>
      invoke<WorkSummaryResponse>('generate_work_summary', { request }),

    async checkForUpdate(): Promise<AvailableUpdate | null> {
      found = await check()

      return found === null
        ? null
        : { version: found.version, notes: releaseNotes(found.body) }
    },

    async installUpdate(report) {
      if (found === null) {
        throw new Error('Nothing has been found to install.')
      }

      // The plugin reports a length once and then a chunk at a time; what the
      // user is waiting on is the running total, so it is kept here.
      let downloaded = 0
      let total: number | null = null

      await found.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? null
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength
        }
        report({ downloaded, total })
      })
    },

    // macOS leaves the old binary running: the installed version is only on
    // screen once the app has been restarted into it. Asked for separately,
    // and last — this takes the webview that asked.
    restart: () => relaunch(),

    showTrayCount: (title) => invoke('show_tray_count', { title }),
  }
}

/**
 * The filename the save dialog is offered, and the one the automatic
 * snapshots are written under: the same format both ways, so the manual and
 * the automatic backups read as one family in whatever folder they land in.
 * It lives beside `backupJournal` rather than inside it so the dialog's
 * suggestion and the command's validation read as one decision.
 */
export function backupFileName(instant: Date = new Date()): string {
  // UTC, second-precise: the same clock the automatic snapshot names itself
  // by, so a name sorts with its own instant wherever the file ends up.
  const pad = (part: number) => String(part).padStart(2, '0')
  const stamp =
    `${instant.getUTCFullYear()}${pad(instant.getUTCMonth() + 1)}` +
    `${pad(instant.getUTCDate())}T${pad(instant.getUTCHours())}` +
    `${pad(instant.getUTCMinutes())}${pad(instant.getUTCSeconds())}`
  return `work-journal-${stamp}.db`
}
