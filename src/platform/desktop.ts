/**
 * The desktop the app runs on, as the app sees it: every window, command,
 * store and cross-window announcement it needs, and nothing else. One
 * implementation talks to Tauri (`tauri-desktop.ts`, the only file in the app
 * that imports `@tauri-apps/*`); the suite drives a fake.
 *
 * Every name shared with the Rust side lives here too, so the two ends of a
 * "must match" pair are one screen apart rather than four files apart.
 */

import type { CalendarEvent, SqlDriver, TaskAlert } from '@/journal/journal'
import type { HotkeyAction, HotkeyStatuses } from '@/settings/hotkey'
import type { SettingsStore } from '@/settings/settings'
import type { Theme } from '@/settings/theme'

/** Stops a subscription. Everything subscribed to here can be unsubscribed. */
export type Unlisten = () => void

/**
 * The window labels. One Vite build serves every window and the label is the
 * only thing that says which — must match `CAPTURE_WINDOW`,
 * `TASK_CREATION_WINDOW` and `MAIN_WINDOW` in `src-tauri/src/lib.rs`, as
 * `src/platform/desktop-rust.test.ts` checks.
 *
 * `MAIN_WINDOW` is the window the journal is read in, a section at a time —
 * see docs/adr/0022-one-main-window-for-reading-and-settings.md.
 */
export const CAPTURE_WINDOW = 'capture'
export const TASK_CREATION_WINDOW = 'task-creation'
export const MAIN_WINDOW = 'main'

/**
 * The sections of the Main Window, named by whatever asked for one: the Tray
 * Menu and a clicked Task Alert both say which they mean. Constants rather than
 * four bare members of the union below, so that a section has a name of its
 * own on this side too and a drift is reported against it — must match
 * `HISTORY_SECTION`, `TASKS_SECTION`, `WORK_SUMMARY_SECTION` and
 * `SETTINGS_SECTION` in
 * `src-tauri/src/lib.rs`, as `src/platform/desktop-rust.test.ts` checks, and
 * the sidebar's own list in `src/views/main/sections.ts`.
 */
export const HISTORY_SECTION = 'history'
export const TASKS_SECTION = 'tasks'
export const WORK_SUMMARY_SECTION = 'work-summary'
export const SETTINGS_SECTION = 'settings'

/** A section of the Main Window: one of the four above and nothing else. */
export type MainSection =
  | typeof HISTORY_SECTION
  | typeof TASKS_SECTION
  | typeof WORK_SUMMARY_SECTION
  | typeof SETTINGS_SECTION

/**
 * An Entry Point named a section of the Main Window. Addressed to a window
 * already open — one this very request is about to build hears nothing and
 * asks for `requestedSection` instead. Must match `SECTION_REQUESTED_EVENT` in
 * `src-tauri/src/lib.rs`, as `src/platform/desktop-rust.test.ts` checks.
 */
export const SECTION_REQUESTED_EVENT = 'main://section'

/**
 * Must match `SETTINGS_FILE` in `src-tauri/src/lib.rs`, as
 * `src/platform/desktop-rust.test.ts` checks.
 */
export const SETTINGS_FILE = 'settings.json'

/**
 * Must match `THEME_KEY` in `src-tauri/src/lib.rs`, as
 * `src/platform/desktop-rust.test.ts` checks.
 */
export const THEME_KEY = 'theme'

/**
 * Whether the app starts at login. Declared here rather than in
 * `src/settings/settings.ts` with the rest because it used to be shared with
 * the Rust side — it answered the standalone first-run question — and a name
 * that stops being shared is safest left where it was. Nothing on the Rust
 * side reads it any more: the question it answered was replaced by the
 * Onboarding flow, whose state the Rust side keeps under `ONBOARDING_KEY`.
 */
export const START_AT_LOGIN_KEY = 'startAtLogin'

/**
 * Where automatic Onboarding stands. Written by the Rust side at startup —
 * before the journal or the default settings exist, so a genuinely fresh
 * installation is classified while it still has nothing on disk — and read by
 * the Main Window as it opens. Must match `ONBOARDING_KEY` in
 * `src-tauri/src/lib.rs`, as `src/platform/desktop-rust.test.ts` checks.
 */
export const ONBOARDING_KEY = 'onboarding'

/**
 * The durable Onboarding state, as the Rust side keeps it: whether automatic
 * presentation is still due (`unfinished`) or will not be offered again on its
 * own (`suppressed`). The two names must match `UNFINISHED` and `SUPPRESSED`
 * in `src-tauri/src/onboarding.rs`, as
 * `src/platform/desktop-rust.test.ts` checks.
 */
export type OnboardingState =
  | 'unfinished'
  | 'suppressed'

/**
 * Where a window is told its Resolved Theme, before its document is parsed and
 * so before anything is painted — the Rust side works the palette out and sets
 * this, because the store cannot be read in time to get the first frame right.
 * Must match `ResolvedTheme::announcement` in `src-tauri/src/lib.rs`.
 *
 * Absent outside Tauri — a bare `vite dev` — where the OS is asked instead.
 */
declare global {
  interface Window {
    __THEME__?: 'light' | 'dark'
  }
}

/**
 * Must match `DATABASE_URL` in `src-tauri/src/lib.rs`, as
 * `src/platform/desktop-rust.test.ts` checks.
 */
export const DATABASE_URL = 'sqlite:work-journal.db'

/**
 * Must match `CAPTURE_SHOWN_EVENT` in `src-tauri/src/lib.rs`, as
 * `src/platform/desktop-rust.test.ts` checks.
 */
export const CAPTURE_SHOWN_EVENT = 'capture://shown'

/**
 * A Task Creation is beginning. Like the capture window, the Task Creation
 * window is built at startup and only ever shown and hidden — see
 * docs/adr/0019-task-creation-has-its-own-resident-window.md — so it is told
 * on being shown rather than on being built. Must match
 * `TASK_CREATION_SHOWN_EVENT` in `src-tauri/src/lib.rs`, as
 * `src/platform/desktop-rust.test.ts` checks.
 */
export const TASK_CREATION_SHOWN_EVENT = 'task-creation://shown'

/**
 * The Tray Menu asked for yesterday's Digest. Spoken by the Rust side, which
 * owns the menu but not the journal — the Notes are only reachable from a
 * webview, so the tray asks and a window answers. Must match
 * `COPY_YESTERDAY_DIGEST_EVENT` in `src-tauri/src/lib.rs`, as
 * `src/platform/desktop-rust.test.ts` checks.
 */
export const COPY_YESTERDAY_DIGEST_EVENT = 'digest://yesterday'

/**
 * What sits under the Capture field right now, and so how tall the window has
 * to be. Both parts grow the window rather than sharing the field's room: the
 * Body being predicted for, or refused, has to stay in sight and stay editable.
 */
export interface CaptureFit {
  /** How many Prediction rows are open under the field. */
  predictions: number
  /** Whether the refusal line is showing under those. */
  refused: boolean
}

/**
 * Capture panel geometry, in the panel's own terms: the field, a Prediction
 * row, the hairline above the first one, and the refusal line. `CaptureView`
 * sizes those elements from these very numbers rather than restating them in
 * classes, so the window and the panel inside it cannot drift apart.
 */
export const CAPTURE_PANEL_WIDTH = 560
export const CAPTURE_FIELD_HEIGHT = 64
export const CAPTURE_PREDICTION_ROW = 36
export const CAPTURE_HAIRLINE = 1
export const CAPTURE_REFUSAL_HEIGHT = 32
/** The panel's own outline, on every side, and outside the widths above. */
export const CAPTURE_PANEL_BORDER = 1

/**
 * The transparent margin the window keeps around the panel. The panel's drop
 * shadow is drawn by the view, and a window sized to the panel would clip it —
 * so the window is bigger than what the user sees, on every side.
 */
export const CAPTURE_SHADOW_GUTTER = 32

/**
 * Window width and resting height — the panel plus its gutter. Must match
 * `.inner_size` in `build_capture_window` (`src-tauri/src/lib.rs`).
 */
const CAPTURE_PANEL_MARGIN = 2 * (CAPTURE_PANEL_BORDER + CAPTURE_SHADOW_GUTTER)
export const CAPTURE_WIDTH = CAPTURE_PANEL_WIDTH + CAPTURE_PANEL_MARGIN
const CAPTURE_HEIGHT = CAPTURE_FIELD_HEIGHT + CAPTURE_PANEL_MARGIN

/**
 * The row under the Task Creation field holding Scheduled For: the date, the
 * time, and the way to clear both. Always there rather than revealed, because
 * a control nobody can see is a feature nobody knows the window has — and its
 * height is fixed, so the window's resting size is a constant rather than
 * something measured.
 */
export const TASK_CREATION_SCHEDULE_ROW = 44

/**
 * The row under that one holding the cadence: whether the Task repeats, how
 * often, and — for a weekly one — on which days. Also always there and also a
 * fixed height, for the same reason: a window whose resting size depended on
 * which cadence was chosen would jump under the user as they chose one.
 */
export const TASK_CREATION_RECURRENCE_ROW = 44

/**
 * The Task Creation panel is the Capture panel's shape — the same width and
 * the same gutter — because they are the same gesture over a different record.
 * It differs in what sits under the field: a Note has only a Body, while a Task
 * may also say when it is meant to be done, so the schedule row is part of the
 * resting height rather than something that grows it.
 *
 * The refusal grows the window on top of that, exactly as it does for a
 * Capture: the description being refused has to stay in sight and stay
 * editable.
 */
export function taskCreationWindowHeight(refused: boolean): number {
  return (
    CAPTURE_HEIGHT +
    CAPTURE_HAIRLINE +
    TASK_CREATION_SCHEDULE_ROW +
    TASK_CREATION_RECURRENCE_ROW +
    (refused ? CAPTURE_REFUSAL_HEIGHT : 0)
  )
}

/**
 * What the Task Creation window is built at, before its view has asked for
 * anything. Must match `.inner_size` in `build_task_creation_window`
 * (`src-tauri/src/lib.rs`).
 */
export const TASK_CREATION_HEIGHT = taskCreationWindowHeight(false)

/** How tall the window has to be to show the field and everything under it. */
export function captureWindowHeight(fit: CaptureFit): number {
  const predictions =
    fit.predictions > 0
      ? CAPTURE_HAIRLINE + fit.predictions * CAPTURE_PREDICTION_ROW
      : 0
  const refusal = fit.refused ? CAPTURE_REFUSAL_HEIGHT : 0

  return CAPTURE_HEIGHT + predictions + refusal
}

/**
 * The announcements the windows make to each other. These two are spoken only
 * in TypeScript, but they sit with the rest so that every event name in the app
 * is in one place.
 *
 * Each exists because the windows are separate: one already on screen learns
 * of a Note or a Theme only by being told — it never polls, and the capture
 * window is never rebuilt, so it would otherwise spend the rest of the run on
 * whatever was true when it started.
 */
export const NOTE_CAPTURED_EVENT = 'note://captured'
export const THEME_CHANGED_EVENT = 'settings://theme'

/**
 * A practice Capture ended, submitted or cancelled. Reported by the Capture
 * window through its dismissal — or announced on its own when a showing
 * raised for practice is displaced by an ordinary one — and heard by the Main
 * Window holding the practice attempt, which closes it on this alone. Must
 * match `PRACTICE_ENDED_EVENT` in `src-tauri/src/lib.rs`, as
 * `src/platform/desktop-rust.test.ts` checks.
 */
export const PRACTICE_ENDED_EVENT = 'practice://ended'

/**
 * How a practice Capture ended: submitted with the Note's Journal Day, or
 * cancelled with nothing created. One event closes one attempt, so there is
 * no race between a submission and the focus that follows it. Must match
 * `PracticeEnded` in `src-tauri/src/lib.rs`, as
 * `src/platform/desktop-rust.test.ts` checks.
 */
export type PracticeEnded =
  | { outcome: 'submitted'; journalDay: string }
  | { outcome: 'cancelled' }

/**
 * Import was turned on or off, or the ticked calendars changed. Spoken by
 * Settings and heard by the window that sweeps, which is a different one: a
 * change the user just made should show up in the journal now rather than at
 * the next sweep.
 */
export const IMPORT_CHANGED_EVENT = 'settings://import'

/**
 * Observing was turned on or off, or its repositories changed. Spoken by
 * Settings and heard by the window that sweeps, for the same reason as
 * `IMPORT_CHANGED_EVENT`.
 */
export const OBSERVING_CHANGED_EVENT = 'settings://observing'

/**
 * The machine woke up. Spoken by the Rust side, which is the only part of the
 * app the OS tells. Must match `SYSTEM_WOKE_EVENT` in `src-tauri/src/lib.rs`,
 * as `src/platform/desktop-rust.test.ts` checks.
 *
 * Import needs it: a lid closed before a meeting ended would otherwise lose
 * that meeting for good, since nothing ever looks back for it — see
 * docs/adr/0011-imported-meetings-are-today-only.md.
 */
export const SYSTEM_WOKE_EVENT = 'system://woke'

/**
 * The Notes are no longer what they were: one was captured, deleted, refiled or
 * reworded. Distinct from `NOTE_CAPTURED_EVENT`, which says a Note arrived on a
 * particular day and is about the reader's Filter; this one says only that a
 * count taken before it is now out of date.
 */
export const JOURNAL_CHANGED_EVENT = 'journal://changed'

/**
 * The Tasks are no longer what they were: one was created, reworded, completed,
 * reopened or deleted. Separate from `JOURNAL_CHANGED_EVENT` because the two
 * records are separate: a window listing Tasks has nothing to re-read when a
 * Note is corrected, and vice versa.
 */
export const TASKS_CHANGED_EVENT = 'tasks://changed'

/**
 * The user clicked a Task Alert. Spoken by the Rust side, which is the only
 * part of the app macOS hands the click to, and carried to Tasks View so it can
 * open focused on that Task. Must match `TASK_ALERT_OPENED_EVENT` in
 * `src-tauri/src/lib.rs`, as `src/platform/desktop-rust.test.ts` checks.
 */
export const TASK_ALERT_OPENED_EVENT = 'task-alert://opened'

/**
 * What choosing Complete on a Task Alert carries: which Task, and the exact
 * Scheduled For the delivered banner represented. The slot is what makes a
 * stale banner harmless — completion proceeds only if the journal still holds
 * this Task Open at this slot; see `completeTaskAt` in
 * `src/journal/journal.ts`. Must match `TaskAlertCompletion` in
 * `src-tauri/src/alerts.rs`.
 */
export interface TaskAlertCompletion {
  /**
   * The pending request's identifier the Alert was registered under, verbatim
   * — which Task it names is the journal's to say, in `taskIdOfAlert`.
   */
  alertId: string
  /** The delivered slot's date, exactly as `TaskSchedule` spells it. */
  date: string
  /** The delivered slot's time, exactly as `TaskSchedule` spells it. */
  time: string
}

/**
 * The user chose Complete on a Task Alert. Spoken by the Rust side, which is
 * the only part of the app macOS hands the response to, and carried to the
 * Capture window, where the Task Alerts session processes it — never to the
 * Main Window, which is what the default click is for. Must match
 * `TASK_ALERT_COMPLETED_EVENT` in `src-tauri/src/lib.rs`, as
 * `src/platform/desktop-rust.test.ts` checks.
 */
export const TASK_ALERT_COMPLETED_EVENT = 'task-alert://completed'

/**
 * How a reconciliation went: whether the OS is now holding what the journal
 * says it should. Spoken by the reconciliation, which runs in the capture
 * window and has no screen of its own, and heard by Tasks View, which does. A
 * failure never rolls a Task back — this is only how it stops being silent; see
 * docs/adr/0017-the-os-schedules-task-alerts.md. Spoken and heard entirely on
 * this side, so the Rust side keeps no copy of it.
 */
export const TASK_ALERTS_RECONCILED_EVENT = 'task-alert://reconciled'

/**
 * A release newer than the running build, as the updater found it. What
 * Settings has to say out loud: the version it would move to, and what that
 * version changed — the release's own notes, which the release workflow fills
 * with the version's CHANGELOG.md section and nothing else, one sentence per
 * line. Empty when the manifest carried no notes at all, which is every
 * release published before the workflow started writing them. These lines are
 * shown as they arrive, so a manifest whose notes were something other than a
 * changelog would be read out as one: the workflow refusing to release a tag
 * without a section is what makes that impossible, not anything here.
 */
export interface AvailableUpdate {
  version: string
  notes: string[]
}

/**
 * How far the download has got. `total` is what the server said it would be,
 * and null when it said nothing — a length nobody promised is not a percentage
 * anyone should be shown.
 */
export interface UpdateProgress {
  downloaded: number
  total: number | null
}

/** Where an export ended up — the Rust side's `ExportedFile`. */
export interface ExportedFile {
  path: string
  fileName: string
}

/** Where a manual backup ended up — the Rust side's `BackupResult`. */
export interface BackupResult {
  path: string
  fileName: string
}

/** What the automatic backups look like right now, as the Rust side counts it. */
export interface AutomaticBackups {
  count: number
  /** Epoch seconds of the newest snapshot, or null when there is none. */
  newestTakenAt: number | null
}

/**
 * What a Work Summary call asks for: where the model is, which one, and the
 * two turns. The API Key is deliberately not among them — the Rust side
 * supplies it, so it never crosses into the webview. Must match
 * `WorkSummaryRequest` in `src-tauri/src/work_summary.rs`, as
 * `src/platform/desktop-rust.test.ts` checks.
 */
export interface WorkSummaryRequest {
  baseUrl: string
  model: string
  systemPrompt: string
  userContent: string
}

/**
 * The model's answer, or why there is none — one shape, so a failure is an
 * answer like any other rather than a rejection the caller has to guess at.
 * Must match `WorkSummaryResponse` in `src-tauri/src/work_summary.rs`, as
 * `src/platform/desktop-rust.test.ts` checks.
 */
export type WorkSummaryResponse =
  | { state: 'generated'; markdown: string }
  | { state: 'failed'; failure: WorkSummaryFailure }

/**
 * Why there is no post, as one of the few lines the section can say. The
 * first is this side's own — a call that could not even be prepared is not
 * the model's answer; the rest must match `WorkSummaryFailure` in
 * `src-tauri/src/work_summary.rs`, as `src/platform/desktop-rust.test.ts` checks.
 */
export type WorkSummaryFailure =
  | { kind: 'local' }
  | { kind: 'model-access' }
  | { kind: 'https-required' }
  | { kind: 'keychain' }
  | { kind: 'offline' }
  | { kind: 'unauthorized' }
  | { kind: 'rate-limited' }
  | { kind: 'timeout' }
  | { kind: 'other'; status: number }
  | { kind: 'empty-response' }

export interface AppIdentity {
  version: string
  isDevelopment: boolean
}

/**
 * What the OS is currently allowing the app to read of the user's calendars.
 * `undetermined` is the state before anyone has been asked, and it is also
 * where macOS leaves a build it has no record of — every rebuilt release is a
 * new binary as far as the grant is concerned, so being asked again is routine
 * rather than exceptional.
 */
export type CalendarAccess = 'granted' | 'denied' | 'undetermined'

/**
 * What the OS is currently allowing the app to deliver as Task Alerts.
 * `undetermined` is the state before the user has been asked — which is where
 * every install starts, because the app asks in context when the first timed
 * Task is saved rather than at first launch.
 *
 * After a denial macOS will not prompt again, whatever the app does, which is
 * why Settings shows the status and the way back rather than a button that
 * would silently do nothing.
 */
export type TaskAlertPermission = 'granted' | 'denied' | 'undetermined'

/** One of the user's calendars, as Settings lists it to be ticked. */
export interface CalendarInfo {
  /** Stable enough to remember a tick against; opaque to the journal. */
  id: string
  title: string
  /** The account it belongs to — two calendars can share a title. */
  source: string
}

/**
 * One commit a repository on this machine holds, as the reader answers with
 * it. Must match `Commit` in `src-tauri/src/commits.rs`, as
 * `src/platform/desktop-rust.test.ts` checks.
 */
export interface Commit {
  hash: string
  /** The subject, verbatim. */
  subject: string
  /**
   * The author date, in milliseconds since the epoch — when the work was done,
   * which a rebase or a squash-merge on a server does not move.
   */
  authoredAt: number
  /**
   * The repository's identity: its common directory, which every worktree of
   * it reports alike.
   */
  repository: string
}

/**
 * Why one repository could not be read — an ordinary answer about it, never
 * a failure of the reader. Must match `RepositoryUnreadable` in
 * `src-tauri/src/commits.rs`, as `src/platform/desktop-rust.test.ts` checks.
 */
export type RepositoryUnreadable =
  | 'missing'
  | 'not-a-repository'
  | 'no-head'
  | 'denied'
  | 'git-unavailable'

/**
 * The commits, newest first along first-parent, or why there are none to read.
 * Must match `CommitsRead` in `src-tauri/src/commits.rs`, as
 * `src/platform/desktop-rust.test.ts` checks.
 */
export type CommitsRead =
  | { state: 'read'; commits: Commit[] }
  | { state: 'unreadable'; reason: RepositoryUnreadable }

/**
 * Who might be the user in one repository, or why it could not be asked. Must
 * match `IdentitiesRead` in `src-tauri/src/commits.rs`, as
 * `src/platform/desktop-rust.test.ts` checks.
 */
export type IdentitiesRead =
  | { state: 'read'; repository: string; identities: string[] }
  | { state: 'unreadable'; reason: RepositoryUnreadable }

export interface Desktop {
  /** Which window this bundle is running in; empty outside the desktop app. */
  windowLabel(): string
  /** The configured app version and whether this bundle is a development build. */
  appIdentity(): Promise<AppIdentity>
  /**
   * Where automatic Onboarding stands. Asked by the Main Window as it opens,
   * so it can present the introduction on its own when the installation is
   * still due — and never when it has been dismissed.
   */
  onboardingState(): Promise<OnboardingState>
  /**
   * Records that automatic Onboarding will not be offered again on its own:
   * what Finish, Skip onboarding, Close, explicit Quit and navigation away
   * all settle on. Replaying the introduction from Settings never calls this,
   * so a dismissed installation stays dismissed.
   */
  dismissOnboarding(): Promise<void>
  /** Closes the window the caller is in. */
  closeWindow(): Promise<void>
  /** The window lost focus — for a Capture, a discard. */
  onWindowBlurred(handle: () => void): Promise<Unlisten>
  /**
   * The window regained focus. A list grouped as Overdue, Today and Upcoming
   * stops being true while nobody is looking at it, so the window that is
   * looked at again asks the question afresh.
   */
  onWindowFocused(handle: () => void): Promise<Unlisten>
  /**
   * Whether the caller's own window is on screen. Asked by the two resident
   * windows when they lose focus: losing it to another application is the user
   * walking away from what they were typing, but losing it to a window the
   * Rust side put this one away for is a handoff, and not a word of it has
   * been discarded. The other resident panel does that to either of them; the
   * Main Window opening does it to both.
   */
  isWindowVisible(): Promise<boolean>
  /**
   * The user is closing the window, and something has to happen first. The
   * close is held until `answer` settles, because a window closing takes its
   * webview and with it any write still in flight.
   */
  onCloseRequested(answer: () => Promise<void>): Promise<Unlisten>

  /** The journal's storage, migrated and ready. */
  openJournalDatabase(): Promise<SqlDriver>
  /** The settings file, with every write flushed rather than debounced. */
  openSettingsStore(): Promise<SettingsStore>

  /**
   * Ends a Capture. Hiding the window is the Rust side's job: it also has to
   * hand focus back to the application the Capture interrupted.
   */
  dismissCapture(): Promise<void>
  /**
   * Ends a Capture raised for Onboarding practice, submitted or abandoned.
   * Hiding the window is the Rust side's job, as with an ordinary Capture —
   * except focus returns to the Main Window showing Onboarding, and the
   * outcome is reported for the Main Window holding the practice attempt.
   * Which dismiss command the Capture view calls is what scopes the return
   * to practice, so ordinary Capture behavior elsewhere is unchanged.
   */
  dismissPracticeCapture(ended: PracticeEnded): Promise<void>
  /**
   * Says how a practice Capture ended without putting it away: what a showing
   * raised for practice reports when an ordinary showing displaces it. Heard
   * by the Main Window holding the practice attempt, like the dismissal's own
   * report.
   */
  announcePracticeEnded(ended: PracticeEnded): Promise<void>
  /** A practice Capture ended, submitted or cancelled. */
  onPracticeEnded(handle: (ended: PracticeEnded) => void): Promise<Unlisten>
  /**
   * Raises the real resident Capture window for optional Onboarding practice.
   * The Note it commits is an ordinary Captured Note; cancelling creates
   * nothing. The showing carries that it is practice, so the Capture view can
   * route its dismissal and report its outcome.
   */
  beginPracticeCapture(): Promise<void>
  /**
   * Fits the Capture window to the field plus whatever sits under it. Nothing
   * under it is the resting height — must match the size built in
   * `build_capture_window` on the Rust side.
   */
  fitCapture(fit: CaptureFit): Promise<void>
  /**
   * A Capture is beginning: the window has just been shown, and whether this
   * showing was raised for Onboarding practice. The Capture view routes its
   * dismissal and its outcome report on it.
   */
  onCaptureShown(handle: (practice: boolean) => void): Promise<Unlisten>

  /**
   * Every Task Entry Point — the Task Hotkey, New Task in the Tray Menu, and
   * the New Task control in Tasks View — reaches the same resident window. It
   * is focused rather than reset, so unfinished text survives being asked for
   * again, and an unfinished Capture is untouched either way.
   */
  beginTaskCreation(): Promise<void>
  /**
   * Ends a Task Creation, committed or abandoned. Hiding the window is the Rust
   * side's job: it also has to hand focus back to whatever was in front.
   */
  dismissTaskCreation(): Promise<void>
  /** A Task Creation is beginning: the window has just been shown. */
  onTaskCreationShown(handle: () => void): Promise<Unlisten>
  /**
   * Fits the Task Creation window to the field plus the refusal under it, if
   * there is one. Nothing under it is the resting height — must match the size
   * built in `build_task_creation_window` on the Rust side.
   */
  fitTaskCreation(refused: boolean): Promise<void>

  announceTasksChanged(): Promise<void>
  onTasksChanged(handle: () => void): Promise<Unlisten>

  /**
   * What macOS allows the app to deliver right now, asked rather than
   * remembered: a grant is revoked in System Settings without the app hearing
   * of it. Never prompts.
   */
  taskAlertPermission(): Promise<TaskAlertPermission>
  /**
   * Asks for alert and sound authorization, through the OS, and answers with
   * what it came to. Asked in context when the first timed Task is saved and
   * never at first launch; asking again after a refusal does not re-prompt,
   * because macOS answers for the user.
   */
  requestTaskAlertPermission(): Promise<TaskAlertPermission>
  /**
   * Makes the OS's pending requests say exactly this and nothing else: whatever
   * is here is registered, and every other Task Alert the app owns is
   * cancelled. One call rather than a schedule and a cancel, because the
   * journal is authoritative and the pending requests are a copy of its answer
   * — reconciling is the only operation that can be repeated safely on launch,
   * on wake and after every change.
   *
   * Rejects when the OS refuses. That never rolls back a Task: the schedule is
   * already stored, and the Alert is derived from it.
   */
  reconcileTaskAlerts(alerts: TaskAlert[]): Promise<void>
  /**
   * The user clicked a Task Alert. Carries the Task it was about, so a Tasks
   * View already on screen can single it out. The section the click asks for
   * travels separately, through `onSectionRequested`: the Main Window switches
   * sections, and Tasks View singles the Task out.
   */
  onTaskAlertOpened(handle: (taskId: string) => void): Promise<Unlisten>
  /**
   * The user chose Complete on a Task Alert. Carries the Task and the exact
   * delivered slot, so the session can complete it only if it still stands
   * there. Heard in the Capture window, where the session lives — the default
   * click keeps its own announcement to the Main Window.
   */
  onTaskAlertCompleted(
    handle: (completion: TaskAlertCompletion) => void,
  ): Promise<Unlisten>
  /**
   * Whether the OS took what the journal asked it to hold. Said by the window
   * that reconciles, which is headless, so that the window with a screen can
   * say it to the user — and said either way, so a failure that has since been
   * put right stops being on screen.
   */
  announceTaskAlertsReconciled(held: boolean): Promise<void>
  onTaskAlertsReconciled(handle: (held: boolean) => void): Promise<Unlisten>
  /**
   * Which section the Entry Point that opened this window named, if it named
   * one — asked for by the Main Window as it opens, and null when nothing was
   * named, which resolves to History.
   *
   * Written down rather than only announced, for the same reason the Task
   * Alert is: a window built by the very request that names a section has no
   * webview yet. Handed over exactly once.
   */
  requestedSection(): Promise<MainSection | null>
  /**
   * An Entry Point named a section while the Main Window was already open, so
   * the window switches to it.
   */
  onSectionRequested(handle: (section: MainSection) => void): Promise<Unlisten>

  /**
   * The Task Alert that opened this window, if one did — asked for by Tasks
   * View as it opens, and null when it was opened any other way.
   *
   * The announcement above is not enough on its own: an Alert delivered while
   * Work Journal was not running builds the window with its click, and no
   * webview is listening yet. The Rust side keeps it until it is asked for, and
   * hands it over exactly once.
   */
  openedTaskAlert(): Promise<string | null>
  /**
   * The Complete actions waiting to be claimed, if any were chosen — asked for
   * by the Capture window as it starts, and empty when the app was opened any
   * other way.
   *
   * The announcement above is not enough on its own: a Complete chosen while
   * Work Journal was not running arrives before the Capture window is
   * listening. The Rust side keeps them until it is asked for — one per banner
   * acted on, so a second choice never destroys the first — and hands them
   * over exactly once, as a set.
   */
  completedTaskAlert(): Promise<TaskAlertCompletion[]>
  /**
   * Opens the Main Window on Tasks View focused on the Task an Alert names —
   * what a stale Complete does instead of completing, so the banner's Task is
   * reviewed rather than acted on. Takes the pending request's identifier, as
   * `completedTaskAlert` carries it.
   */
  focusTaskAlert(alertId: string): Promise<void>
  /**
   * Opens System Settings at Notifications — the only way back after a denial,
   * since macOS will not show its prompt a second time. The pane is opened by
   * its documented identifier; the app never guesses a per-app deep link.
   */
  openNotificationSettings(): Promise<void>
  /** The Tray Menu wants yesterday's Digest on the clipboard. */
  onYesterdayDigestRequested(handle: () => void): Promise<Unlisten>

  /**
   * What the OS allows right now, asked rather than remembered: a grant can be
   * revoked in System Settings, and a rebuilt binary is one macOS has never
   * seen. Never prompts.
   */
  calendarAccess(): Promise<CalendarAccess>
  /**
   * Asks the user, through the OS. Resolves once they have answered, with what
   * the answer came to. Asking again after a refusal does not re-prompt: macOS
   * answers for the user, which is why the app never nags.
   */
  requestCalendarAccess(): Promise<CalendarAccess>
  /** Every calendar the user has, for Settings to offer. Empty without access. */
  calendars(): Promise<CalendarInfo[]>
  /**
   * Today's events, from every calendar — which ones matter is the journal's
   * decision, not the machine's. Empty without access.
   */
  todaysCalendarEvents(): Promise<CalendarEvent[]>
  /**
   * The commits `identities` authored at or after `since` in the repository
   * at `path`, read and never written: no hook, no ref, no config, no fetch.
   * Read along first-parent of `origin/HEAD` as this machine has it, then the
   * current branch's upstream, then `HEAD`. A squash-merged pull request is
   * one commit and the branch behind it none; a branch merged by fast-forward
   * or rebase is each of its own commits; a merge authored by somebody else
   * is theirs, and hides the user's work behind it. No identities is nobody's
   * commits. See `src-tauri/src/commits.rs`.
   */
  repositoryCommits(
    path: string,
    identities: string[],
    since: number,
  ): Promise<CommitsRead>
  /**
   * The addresses that might be the user in the repository at `path`, for
   * Settings to offer: `git config user.email`, then the last ninety days'
   * first-parent authors, most recent first. Suggestions only — none of them
   * counts until the user ticks it.
   */
  repositoryIdentities(path: string): Promise<IdentitiesRead>
  /**
   * The folder picker a repository is added through — a path is never typed.
   * Null when the user cancelled.
   */
  chooseRepositoryFolder(): Promise<string | null>
  announceObservingChanged(): Promise<void>
  onObservingChanged(handle: () => void): Promise<Unlisten>
  /** The machine woke from sleep: whatever was missed is worth looking for. */
  onSystemWoke(handle: () => void): Promise<Unlisten>
  announceImportChanged(): Promise<void>
  onImportChanged(handle: () => void): Promise<Unlisten>

  announceCapturedNote(journalDay: string): Promise<void>
  onNoteCaptured(handle: (journalDay: string) => void): Promise<Unlisten>
  announceJournalChanged(): Promise<void>
  onJournalChanged(handle: () => void): Promise<Unlisten>
  announceTheme(theme: Theme): Promise<void>
  onThemeChanged(handle: (theme: Theme) => void): Promise<Unlisten>

  /** Both Hotkeys as they stand, each registered or not. */
  hotkeyStatus(): Promise<HotkeyStatuses>
  /**
   * Moves one of the two Hotkeys. Rejects with the reason the OS gave — or with
   * the collision, since the two may never share a combination — in which case
   * both combinations in force are unchanged: the Rust side puts the old one
   * back rather than leaving the user with none.
   */
  setHotkey(action: HotkeyAction, hotkey: string): Promise<HotkeyStatuses>

  /**
   * Whether the app actually starts at login, asked of the OS rather than of
   * the store: a login item can be removed from System Settings, and a
   * checkbox that disagreed with the system would be a lie.
   */
  startsAtLogin(): Promise<boolean>
  /** Adds or removes the login item. */
  setStartAtLogin(startAtLogin: boolean): Promise<void>

  /**
   * Puts text on the system clipboard. Written by the OS rather than by the
   * webview: a Digest is also copied from the Tray Menu, where no window is
   * focused and no click is granting the page user activation.
   */
  copyToClipboard(text: string): Promise<void>

  /**
   * Whether an API Key is in the Keychain. Never the key itself: the webview
   * is where a Body the user typed and a model's answer already meet, and a
   * billable credential does not belong in it — see
   * docs/adr/0026-the-api-key-lives-in-the-keychain-and-rust-makes-the-call.md.
   *
   * Rejects with what the Keychain said when it will not answer — locked, or a
   * refused prompt. That is an ordinary state Settings has a line for, not a
   * failure that should take the rest of the window with it.
   */
  apiKeySet(): Promise<boolean>
  /** Puts the API Key in the Keychain, over whatever was there before. */
  saveApiKey(apiKey: string): Promise<void>
  /**
   * Takes the API Key out of the Keychain. A Keychain entry outlives an
   * uninstall, so this is the only way out — and clearing one that is already
   * gone is not an error.
   */
  clearApiKey(): Promise<void>

  /** Writes a rendered export to a file, and says where it went. */
  exportJournal(markdown: string, fileName: string): Promise<ExportedFile>

  /**
   * What the automatic backups look like: how many, and when the newest was
   * taken. Asked of the live directory rather than remembered — the folder
   * sits beside the journal and the user can empty it.
   */
  automaticBackups(): Promise<AutomaticBackups>
  /**
   * Opens the save dialog and resolves to the path the user chose, or null
   * for a cancelled one. One moment of the one gesture — see
   * `backupJournal`, and the split `installUpdate` and `restart` already
   * make. Deliberately not the write: the button that started this stays
   * honest about which of the two moments it is waiting on, and a cancelled
   * dialog is a frontend outcome rather than an error.
   */
  chooseBackupLocation(): Promise<string | null>
  /**
   * Writes the snapshot to the path `chooseBackupLocation` answered with, and
   * says where it went. Every read and write happens on the Rust side — the
   * webview only carries a path, exactly as `exportJournal` already does.
   */
  backupJournal(path: string): Promise<BackupResult>
  /**
   * Shows the automatic backups folder in the Finder — the one place the
   * snapshots the app takes on its own can be seen and copied by hand.
   */
  revealBackups(): Promise<void>
  /**
   * Opens the open dialog and resolves to the path the user chose, or null
   * for a cancelled one. One moment of the one gesture — see
   * `stageRestore`, and the split `installUpdate` and `restart` already
   * make. Deliberately not the stage: the button that started this stays
   * honest about which of the two moments it is waiting on, and a cancelled
   * dialog is a frontend outcome rather than an error.
   */
  chooseRestoreCandidate(): Promise<string | null>
  /**
   * Validates the candidate `chooseRestoreCandidate` answered with and stages
   * it for the next launch. Refuses anything that is not a readable journal
   * snapshot at a supported version, naming which check failed — and stages
   * nothing on a refusal. Every read happens on the Rust side; the webview
   * only carries a path, exactly as `backupJournal` already does.
   */
  stageRestore(path: string): Promise<void>

  /**
   * The release newer than this build, or null when this build is already the
   * latest. Asked for, never on a timer: an app that reaches out on its own
   * schedule is one the user did not ask to be reached out for — see
   * docs/adr/0030-the-app-updates-itself-from-its-own-releases.md.
   */
  checkForUpdate(): Promise<AvailableUpdate | null>
  /**
   * Installs the update the last check found, and stops there. The update
   * installed is the one that was found rather than whatever is latest at this
   * moment, so what the user pressed for is what they get; a check has to have
   * found one, and rejects when none has.
   *
   * `report` is called as the download moves, so a wait of twenty megabytes is
   * a wait the user can see.
   *
   * Deliberately not the restart: the two are one gesture to the user but two
   * moments to the app, and everything the app wants to say about the install
   * has to be on screen before the restart takes the webview away.
   */
  installUpdate(report: (progress: UpdateProgress) => void): Promise<void>
  /**
   * Quits and comes back in the version just installed — the running process
   * is still the old one until it does. Normally does not resolve, because it
   * ends the process it was called from.
   */
  restart(): Promise<void>

  /**
   * Asks the model to write a Work Summary. The command takes only what the
   * model needs to hear — the API Key is read from the Keychain by the Rust
   * side and never enters this window; see
   * docs/adr/0026-the-api-key-lives-in-the-keychain-and-rust-makes-the-call.md.
   * The answer is one shape, success or failure, so a failure reads as one of
   * the few lines the section can say rather than as a rejection the caller
   * has to guess at.
   */
  generateWorkSummary(request: WorkSummaryRequest): Promise<WorkSummaryResponse>

  /**
   * Puts a short piece of text beside the menu bar glyph. Rendered by the
   * journal core, never here: this only carries it across to the tray. macOS
   * only — elsewhere the glyph stands alone and this does nothing.
   */
  showTrayCount(title: string): Promise<void>
}
