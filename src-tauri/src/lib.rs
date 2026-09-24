mod alerts;
mod backup;
mod calendar;
mod commits;
mod dock;
mod export;
mod frontmost;
mod hotkey;
mod keychain;
mod onboarding;
mod work_summary;

use alerts::{Permission, TaskAlert, TaskAlertCompletion};
use calendar::{Access, CalendarEvent, CalendarInfo};
use dock::{Dock, Presence};
use export::ExportedFile;
use frontmost::PreviousApplication;
use hotkey::{HotkeyAction, Hotkeys};
use std::path::Path;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    webview::Color,
    Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_sql::{DbInstances, DbPool, Migration, MigrationKind};
use tauri_plugin_store::StoreExt;

/// The menu bar glyph, compiled in so the tray never depends on a file on disk.
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray-icon.png");

/// The one tray icon, named so the count can find it again after it is built.
const TRAY_ID: &str = "tray";

const NEW_NOTE_MENU_ITEM: &str = "new-note";
const NEW_TASK_MENU_ITEM: &str = "new-task";

const VIEW_NOTES_MENU_ITEM: &str = "view-notes";
const VIEW_TASKS_MENU_ITEM: &str = "view-tasks";
const VIEW_WORK_SUMMARY_MENU_ITEM: &str = "view-work-summary";
const COPY_YESTERDAY_DIGEST_MENU_ITEM: &str = "copy-yesterday-digest";

/// The pause controls of the Tray Menu. The submenu is the pause offered,
/// its items name the three lengths, and while a pause is in force the pair
/// is replaced by the status line and the way out of it. Purely this side's
/// own names: what a press means is `PauseLength`, below.
const PAUSE_OBSERVING_MENU_ITEM: &str = "pause-observing";
const PAUSE_AN_HOUR_MENU_ITEM: &str = "pause-an-hour";
const PAUSE_UNTIL_TOMORROW_MENU_ITEM: &str = "pause-until-tomorrow";
const PAUSE_UNTIL_RESUMED_MENU_ITEM: &str = "pause-until-resumed";
const PAUSED_MENU_ITEM: &str = "paused";
const RESUME_OBSERVING_MENU_ITEM: &str = "resume-observing";

const SETTINGS_MENU_ITEM: &str = "settings";
const CHECK_FOR_UPDATES_MENU_ITEM: &str = "check-for-updates";
const MAIN_SETTINGS_MENU_ITEM: &str = "main-settings";
const CLOSE_WINDOW_MENU_ITEM: &str = "close-window";
const QUIT_MENU_ITEM: &str = "quit";

const APP_MENU_ID: &str = "app-menu";
const EDIT_MENU_ID: &str = "edit-menu";
const APP_NAME: &str = "Work Journal";

// A name below that drifts from its copy in `src/platform/desktop.ts` is
// otherwise silent — no error, no failed build, and no symptom except a window
// that never hears something. Each "must match" comment names the test that
// holds the pair together; the geometry constants further down are the one
// deliberate exception, and say why.

/// The window labels the frontend routes on — see `src/views/route.ts`. Must
/// match `CAPTURE_WINDOW`, `TASK_CREATION_WINDOW` and `MAIN_WINDOW` in
/// `src/platform/desktop.ts`, as `src/platform/desktop-rust.test.ts` checks.
const CAPTURE_WINDOW: &str = "capture";
const TASK_CREATION_WINDOW: &str = "task-creation";
const MAIN_WINDOW: &str = "main";

/// The sections of the Main Window an Entry Point here can name. Must match
/// the members of `MainSection` in `src/platform/desktop.ts` — `HISTORY_SECTION`,
/// `TASKS_SECTION`, `WORK_SUMMARY_SECTION` and `SETTINGS_SECTION` — as
/// `src/platform/desktop-rust.test.ts` checks.
const HISTORY_SECTION: &str = "history";
const TASKS_SECTION: &str = "tasks";
const WORK_SUMMARY_SECTION: &str = "work-summary";
const SETTINGS_SECTION: &str = "settings";

/// Where the settings live. Must match `SETTINGS_FILE` in
/// `src/platform/desktop.ts`, as `src/platform/desktop-rust.test.ts` checks. Written from both sides — see
/// `src/settings/tauri-settings.ts` — which is acceptable only because v1 has
/// no secrets in it; see docs/adr/0001-defer-voice-capture-to-v2.md.
const SETTINGS_FILE: &str = "settings.json";

/// The Note Hotkey. Claimed from the OS rather than merely stored, so this
/// side owns both registering it and remembering it. Named without
/// qualification because it predates the Task Hotkey and an existing user's
/// chosen combination has to survive the upgrade untouched.
const HOTKEY_KEY: &str = "hotkey";

/// The Task Hotkey, stored beside it and independent in every other respect.
const TASK_HOTKEY_KEY: &str = "taskHotkey";

/// Where automatic Onboarding stands — `unfinished` while it is still due,
/// `suppressed` once it has been dismissed or was never due — written by the
/// startup classification before plugin-sql creates the journal or defaults
/// are saved, and read again when a window asks. Must match `ONBOARDING_KEY`
/// in `src/platform/desktop.ts`, as `src/platform/desktop-rust.test.ts` checks.
const ONBOARDING_KEY: &str = "onboarding";

/// The Theme the user settled on. Must match `THEME_KEY` in
/// `src/platform/desktop.ts`, as `src/platform/desktop-rust.test.ts` checks.
const THEME_KEY: &str = "theme";

/// Told to the capture window every time it is shown. It is long-lived, so it
/// clears its field and takes focus on this rather than on being built — see
/// docs/adr/0002-capture-window-is-hidden-never-closed.md. Carries whether
/// the showing was raised for Onboarding practice, so the view can route its
/// dismissal. Must match
/// `CAPTURE_SHOWN_EVENT` in `src/platform/desktop.ts`, as `src/platform/desktop-rust.test.ts` checks.
const CAPTURE_SHOWN_EVENT: &str = "capture://shown";

/// A practice Capture ended, submitted or cancelled. Reported by the Capture
/// view through its dismissal — or announced on its own when a showing raised
/// for practice is displaced by an ordinary one — and heard by the Main Window
/// holding the practice attempt, which closes it on this alone. Must match
/// `PRACTICE_ENDED_EVENT` in `src/platform/desktop.ts`, as
/// `src/platform/desktop-rust.test.ts` checks.
const PRACTICE_ENDED_EVENT: &str = "practice://ended";

/// Told to the Task Creation window every time it is shown, for the same
/// reason: it is resident and hidden between uses rather than rebuilt — see
/// docs/adr/0019-task-creation-has-its-own-resident-window.md. Must match
/// `TASK_CREATION_SHOWN_EVENT` in `src/platform/desktop.ts`, as
/// `src/platform/desktop-rust.test.ts` checks.
const TASK_CREATION_SHOWN_EVENT: &str = "task-creation://shown";

/// Asked of the capture window when the Tray Menu wants yesterday's Digest.
/// This side owns the menu but not the Notes — they are only reachable through
/// plugin-sql from a webview — so the tray asks and the window answers. The
/// capture window is the one that is always there to hear it; see
/// docs/adr/0002-capture-window-is-hidden-never-closed.md. Must match
/// `COPY_YESTERDAY_DIGEST_EVENT` in `src/platform/desktop.ts`, as
/// `src/platform/desktop-rust.test.ts` checks.
const COPY_YESTERDAY_DIGEST_EVENT: &str = "digest://yesterday";

/// Asked of the capture window when the Tray Menu wants Observing paused, for
/// one of the offered lengths — and when it wants it resumed. The same shape
/// of ask as the Digest above, for the same reason: a pause is an interval in
/// the settings file and every rule over it belongs to `@/settings/observing`,
/// so the menu asks and the window that owns the file applies it. Must match
/// `OBSERVING_PAUSE_EVENT` in `src/platform/desktop.ts`, as
/// `src/platform/desktop-rust.test.ts` checks.
const OBSERVING_PAUSE_EVENT: &str = "observing://pause";

/// The other half of the same ask. Must match `OBSERVING_RESUME_EVENT` in
/// `src/platform/desktop.ts`, as `src/platform/desktop-rust.test.ts` checks.
const OBSERVING_RESUME_EVENT: &str = "observing://resume";

/// The machine woke from sleep, so anything that looks at the world afresh has
/// to look again — Import above all, since a lid closed before a meeting ended
/// would otherwise lose that meeting for good. Must match `SYSTEM_WOKE_EVENT`
/// in `src/platform/desktop.ts`, as `src/platform/desktop-rust.test.ts` checks.
const SYSTEM_WOKE_EVENT: &str = "system://woke";

/// An Entry Point named a section of the Main Window. Told to a window already
/// open; one this request is about to build asks for `requested_section`
/// instead. Must match `SECTION_REQUESTED_EVENT` in `src/platform/desktop.ts`,
/// as `src/platform/desktop-rust.test.ts` checks.
const SECTION_REQUESTED_EVENT: &str = "main://section";

/// The user clicked a Task Alert. macOS hands the click to this side, which is
/// the only part of the app it talks to; the Main Window opens on Tasks View,
/// focused on the Task. Must match `TASK_ALERT_OPENED_EVENT` in
/// `src/platform/desktop.ts`, as `src/platform/desktop-rust.test.ts` checks.
const TASK_ALERT_OPENED_EVENT: &str = "task-alert://opened";

/// The user chose Complete on a Task Alert. Carried to the Capture window,
/// where the Task Alerts session processes it — never to the Main Window,
/// which is what the default click is for. Must match
/// `TASK_ALERT_COMPLETED_EVENT` in `src/platform/desktop.ts`, as
/// `src/platform/desktop-rust.test.ts` checks.
const TASK_ALERT_COMPLETED_EVENT: &str = "task-alert://completed";

/// The resting height of each resident window: the panel its view draws, plus
/// the transparent gutter the view's own drop shadow needs on every side. They
/// differ because a Task may say when it is meant to be done and how often it
/// repeats, and a Note may say neither, so the Task Creation panel has two more
/// rows under its field. Must match `CAPTURE_HEIGHT` and
/// `TASK_CREATION_HEIGHT` in `src/platform/desktop.ts`.
const CAPTURE_HEIGHT: f64 = 130.0;
const TASK_CREATION_HEIGHT: f64 = 219.0;

/// Both resident windows are this wide. Must match `CAPTURE_WIDTH` in
/// `src/platform/desktop.ts`.
const RESIDENT_WINDOW_WIDTH: f64 = 626.0;

/// Relative, so plugin-sql resolves it inside the app's data directory and the
/// journal survives a restart of the app and of the machine. The file name
/// after `sqlite:` must stay `backup::DATABASE_FILE_NAME` — the
/// live/staged/rollback paths resolve from that one constant, and this URL
/// and the preload entry below name the same file by hand (`concat!` takes
/// only literals, so the URL cannot be built from it). Must match
/// `DATABASE_URL` in `src/platform/desktop.ts`, as
/// `src/platform/desktop-rust.test.ts` checks — and must match the one entry
/// of `plugins.sql.preload` in `tauri.conf.json` and `tauri.dev.conf.json`,
/// which is what opens the pool (and runs the migrations) before `setup`
/// spawns the automatic snapshot. The two configs are JSON, which no test
/// reads, so the preload entry says the same thing in words beside it.
const DATABASE_URL: &str = "sqlite:work-journal.db";

/// The section of the Main Window the last Entry Point named, waiting for a
/// window to claim it.
///
/// The event alone is not enough, for the same reason the Alert below keeps
/// one of these: a Main Window built by this very request has no webview yet,
/// so nothing is listening. It is kept here instead, and the window asks for it
/// as it opens. Taken rather than read: a request opens the window once.
#[derive(Default)]
struct RequestedSection(Mutex<Option<String>>);

/// The Task Alert the user clicked, waiting for a window to claim it.
///
/// The event alone is not enough: a click on an Alert delivered while Work
/// Journal was not running arrives before Tasks View has a webview, so nothing
/// is listening and the focus would be dropped — which is precisely the case
/// the Alert exists for. It is kept here instead, and the window asks for it as
/// it opens. Taken rather than read: an Alert opens the window once.
#[derive(Default)]
struct OpenedTaskAlert(Mutex<Option<String>>);

/// The Complete actions the user chose, waiting for the Capture window to
/// claim them.
///
/// The event alone is not enough, for the same reason the click above keeps
/// one of these: a choice made while Work Journal was not running arrives
/// before the Capture window is listening. It is kept here instead, and the
/// window asks for it as it starts. A list rather than a single slot: one
/// Complete per banner the user acted on is kept, so a second choice never
/// destroys the first. Drained rather than read: each Complete processes once,
/// however it arrived.
#[derive(Default)]
struct CompletedTaskAlert(Mutex<Vec<TaskAlertCompletion>>);

/// Whether this launch opened the Main Window because automatic Onboarding is
/// due. Read when the user quits, so that quitting during the introduction
/// records the dismissal — and so that an instance which exits before it
/// could ever have shown it (a second launch handed off to the first) never
/// dismisses it for the instance that is actually showing it.
#[derive(Default)]
struct OpenedForOnboarding(std::sync::atomic::AtomicBool);

/// How long one pause is offered for, as a press in the Tray Menu carries it
/// to the capture window. The three the menu and Settings both offer: a timed
/// pause ends by itself, so it cannot be forgotten, and `until-resumed` holds
/// until the user says otherwise. Must match `PauseLength` in
/// `src/platform/desktop.ts`, as `src/platform/desktop-rust.test.ts` checks.
#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PauseLength {
    AnHour,
    UntilTomorrow,
    UntilResumed,
}

/// What the pause controls read, as the capture window carries it here —
/// decided there and already said there, because the rules and the words are
/// `@/settings/observing`'s and this side only puts them in a menu. Must
/// match `PauseState` in `src/platform/desktop.ts`, as
/// `src/platform/desktop-rust.test.ts` checks.
#[derive(Clone, Debug, Default, serde::Deserialize, serde::Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum PauseState {
    /// Nothing is being observed, so the controls stay out of the menu.
    #[default]
    Nothing,
    /// Observing, with no pause in force: the menu offers one.
    Running,
    /// Paused until `until` — null while it has no end — with that end
    /// already said as `label`.
    Paused {
        until: Option<f64>,
        label: String,
    },
}

/// What the capture window is asked for when the Tray Menu wants a pause: the
/// length, and only that. The `{ length }` the `onObservingPauseRequested`
/// listener reads on the other side.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PauseRequested {
    length: PauseLength,
}

/// What the Tray Menu's Observing controls were last told to read, waiting
/// for the menu to open and show it. The only state the tray keeps: the
/// settings file it all comes from is the webview's.
#[derive(Default)]
struct TrayMenuState(Mutex<PauseState>);

/// The pause to show at `now_ms` — its already-said line, and only while it
/// is still in force. A pause with an end runs out on its own, and the moment
/// the menu is built is where that has to be true: a "Paused" line shown after
/// the pause is over is exactly the forgetting the interval exists to prevent.
fn pause_in_force(state: &PauseState, now_ms: f64) -> Option<&str> {
    match state {
        PauseState::Paused { until: None, label } => Some(label.as_str()),
        PauseState::Paused {
            until: Some(end),
            label,
        } if *end > now_ms => Some(label.as_str()),
        _ => None,
    }
}

/// What the pause group of the Tray Menu holds at one instant: the pause
/// offered, a pause in force — the status line with its end, and the way out
/// under it — or nothing at all. Which items appear is decided here and
/// nowhere else, a pure reading of the state against the clock, so the choice
/// is tested without a menu bar.
#[derive(Debug, PartialEq)]
enum PauseControls {
    /// Observing off, or nothing on the list: the controls would mean nothing.
    Hidden,
    /// Observing, with no pause in force: the pause is offered.
    Offered,
    /// In force: the status line's own words, then the way out of it.
    Paused(String),
}

fn pause_controls(state: &PauseState, now_ms: f64) -> PauseControls {
    match pause_in_force(state, now_ms) {
        Some(label) => PauseControls::Paused(label.to_string()),
        // A pause that has ended reads as ended: Observing is running again,
        // so the pause is offered again.
        None if !matches!(state, PauseState::Nothing) => PauseControls::Offered,
        None => PauseControls::Hidden,
    }
}

/// This instant, in the milliseconds the webview counts in — what a pause's
/// end is compared against.
fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as f64)
        .unwrap_or(0.0)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Tauri's macOS defaults include Services, Hide, View, Window and
        // other framework-owned items. The app installs its own Edit menu at
        // startup and adds its app menu while the Main Window exists.
        .enable_macos_default_menu(false)
        // Registered first, deliberately: a second launch must exit here,
        // before it can build a second tray icon or fail to register the
        // Hotkey. It is an Entry Point rather than a no-op, so launching the
        // app while it is running starts a Capture in the surviving instance
        // instead of appearing to fail silently.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            start_capture(app);
        }))
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        // The app's own way forward: Settings asks these two for the newer
        // release and for the restart into it — see
        // docs/adr/0030-the-app-updates-itself-from-its-own-releases.md.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // The save dialog behind the manual backup — the destination goes
        // wherever the user says, which is the whole point of the manual one;
        // see docs/adr/0032-a-backup-is-a-sqlite-snapshot-taken-with-vacuum-into.md.
        // The open dialog behind the restore needs no new dependency, only
        // `dialog:allow-open` beside `dialog:allow-save`.
        .plugin(tauri_plugin_dialog::init())
        // The staged restore, before plugin-sql opens: the only moment
        // nothing holds the live journal. Registered ahead of the sql plugin
        // so its setup runs first — see
        // docs/adr/0033-a-restore-replaces-the-journal-at-startup-and-keeps-a-rollback.md.
        .plugin(
            tauri::plugin::Builder::new("restore")
                .setup(
                    |app: &tauri::AppHandle<tauri::Wry>,
                     _api: tauri::plugin::PluginApi<tauri::Wry, ()>| {
                    let config_dir = match app.path().app_config_dir() {
                        Ok(directory) => directory,
                        Err(error) => {
                            log::error!("no restore this launch: {error}");
                            return Ok(());
                        }
                    };
                    match backup::apply_staged_restore(
                        &config_dir,
                        std::time::SystemTime::now(),
                    ) {
                        Ok(backup::ApplyOutcome::Absent) => {}
                        Ok(backup::ApplyOutcome::Restored { rollback }) => match rollback {
                            Some(path) => log::info!(
                                "restored the journal from a staged backup, previous journal kept as {}",
                                path.display()
                            ),
                            None => log::info!("restored the journal from a staged backup"),
                        },
                        Err(error) => {
                            log::error!("the staged restore could not be applied: {error}")
                        }
                    }
                    Ok(())
                })
                .build(),
        )
        // Automatic Onboarding's one classification, before plugin-sql creates
        // the journal: a genuinely fresh installation has nothing on disk
        // yet, and the very first launch must not manufacture the evidence of
        // an older one. Registered after the restore (which may rename a
        // journal in) and before the sql plugin (whose preload creates the
        // journal) — the same ordering seam the restore uses — and it writes
        // the unfinished state down before the sql plugin or the Hotkey
        // settlement below can make this launch look established.
        .plugin(
            tauri::plugin::Builder::new("onboarding")
                .setup(
                    |app: &tauri::AppHandle<tauri::Wry>,
                     _api: tauri::plugin::PluginApi<tauri::Wry, ()>| {
                    settle_onboarding(app);
                    Ok(())
                })
                .build(),
        )
        .plugin(
            tauri_plugin_sql::Builder::new()
                .add_migrations(DATABASE_URL, migrations())
                .build(),
        )
        // The Main Window is genuinely closed rather than hidden, so its
        // destruction is what takes the app back out of the Dock. Every other
        // window passes through here and the Dock ignores it.
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::Destroyed) {
                let app = window.app_handle();
                let presence = app.state::<Dock>().window_closed(window.label());
                // The app stops drawing a menu bar first, so the moment
                // between the two menus is never a menu bar of one.
                show_presence(app, presence);
                if presence == Some(Presence::MenuBarOnly) {
                    remove_app_menu(app);
                }
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            MAIN_SETTINGS_MENU_ITEM => open_settings(app),
            CLOSE_WINDOW_MENU_ITEM => close_main_window(app),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            dismiss_capture,
            dismiss_practice_capture,
            start_practice_capture,
            start_task_creation,
            dismiss_task_creation,
            hotkey_status,
            set_hotkey,
            export_journal,
            show_tray_count,
            show_tray_observing,
            calendar_access,
            request_calendar_access,
            calendars,
            todays_calendar_events,
            repository_commits,
            repository_identities,
            requested_section,
            opened_task_alert,
            focus_task_alert,
            completed_task_alert,
            task_alert_permission,
            request_task_alert_permission,
            reconcile_task_alerts,
            open_notification_settings,
            journal_transaction,
            api_key_set,
            save_api_key,
            clear_api_key,
            generate_work_summary,
            automatic_backups,
            backup_journal,
            reveal_backups,
            stage_restore,
            onboarding_state,
            dismiss_onboarding
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Menu bar only: no Dock icon and no Cmd+Tab entry. The Main
            // Window puts the app in the Dock for as long as it is open, and
            // nothing else does — see docs/adr/0023-the-app-enters-the-dock-only-while-the-main-window-is-open.md.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            // Before any window is built, so the window event handler above
            // always has something to ask.
            app.manage(Dock::default());

            // Before the resident windows, so that neither webview can ask for
            // a Hotkey's status before there is one to hand it.
            register_hotkeys(app.handle());

            // Before the resident windows too: their fields route Cmd+C, Cmd+X,
            // Cmd+V and Cmd+Z through the Edit menu, which is the
            // application's for as long as any window can hold a text field.
            install_edit_menu(app.handle())?;

            // Built once, here, and thereafter only shown and hidden. Booting a
            // webview costs a few hundred milliseconds a Capture cannot afford,
            // and the two windows are separate so that unfinished text in one
            // survives the other being used — see
            // docs/adr/0019-task-creation-has-its-own-resident-window.md.
            build_resident_window(app.handle(), CAPTURE_WINDOW, "New Note", CAPTURE_HEIGHT)?;
            build_resident_window(
                app.handle(),
                TASK_CREATION_WINDOW,
                "New Task",
                TASK_CREATION_HEIGHT,
            )?;
            build_tray(app.handle())?;

            // Nothing has been clicked yet, but a click can arrive before any
            // window exists — so somewhere to keep it has to.
            app.manage(OpenedTaskAlert::default());
            app.manage(CompletedTaskAlert::default());
            app.manage(RequestedSection::default());

            // Whoever is in front when a Capture begins, kept so that putting
            // the Capture away can hand focus back to them.
            app.manage(PreviousApplication::default());
            // Whether this launch opened the Main Window because automatic
            // Onboarding is due — set below, read when the user quits, so an
            // instance that exits before it could have shown the introduction
            // never dismisses it on another instance's behalf.
            app.manage(OpenedForOnboarding::default());

            // Told to whichever window is sweeping the calendar. Set up after
            // the capture window, because that is the window that hears it.
            #[cfg(target_os = "macos")]
            watch_for_wake(app.handle());

            // Before launching finishes: a click on a Task Alert that macOS
            // delivered while Work Journal was not running arrives as the app
            // starts, and a delegate set any later would never hear it.
            watch_for_task_alerts(app.handle());

            // The automatic snapshot, off the main thread and off the critical
            // path: see take_automatic_snapshot.
            take_automatic_snapshot(app.handle().clone());

            // A genuinely new installation meets the introduction automatically;
            // so does one whose unfinished Onboarding a crash interrupted — the
            // state written by the startup classification before the journal or
            // the defaults existed takes precedence over them on every later
            // launch. An existing installation, or one that has dismissed
            // Onboarding, opens nothing on its own, exactly as it always has.
            if onboarding::is_unfinished(onboarding_marker(app.handle()).as_deref()) {
                app.state::<OpenedForOnboarding>()
                    .0
                    .store(true, std::sync::atomic::Ordering::Relaxed);
                open_main_window(app.handle(), None);
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app, event| {
            // An explicit Quit while automatic Onboarding is still due counts
            // as dismissing it — the same deliberate departure as Skip,
            // Finish, Close and navigation away. Recorded here, at the one
            // moment every Quit passes through, so the next launch opens
            // normally rather than offering the introduction again.
            if matches!(&event, tauri::RunEvent::ExitRequested { .. }) {
                dismiss_onboarding_on_quit(app);
            }

            // A click on the Dock icon. It names no section, so it raises a
            // Main Window that is already open on whatever it is showing, and
            // opens a new one on the section it opens on by default — History.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = &event {
                open_main_window(app, None);
            }
        });
}

/// The schema lives in `.sql` files rather than Rust string literals so the
/// test suite can build its database from the very same files.
fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create notes",
            sql: include_str!("../migrations/0001_create_notes.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "notes project",
            sql: include_str!("../migrations/0002_notes_project.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "note origin and imported meetings",
            sql: include_str!("../migrations/0003_note_origin_and_imported_meetings.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "create tasks",
            sql: include_str!("../migrations/0004_create_tasks.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 5,
            description: "task schedule",
            sql: include_str!("../migrations/0005_task_schedule.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 6,
            description: "task recurrence",
            sql: include_str!("../migrations/0006_task_recurrence.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 7,
            description: "task occurrences one kept per slot",
            sql: include_str!("../migrations/0007_task_occurrences_one_kept_per_slot.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 8,
            description: "observe origin and handled events",
            sql: include_str!("../migrations/0008_note_origin_observe_and_handled_events.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

/// The two resident windows: built once at startup, thereafter only shown and
/// hidden — see docs/adr/0002-capture-window-is-hidden-never-closed.md. They
/// are two windows rather than two modes of one so that an unfinished Capture
/// and an unfinished Task Creation can both be waiting at once; see
/// docs/adr/0019-task-creation-has-its-own-resident-window.md.
///
/// Both are nearly the same shape, so they are built by the same function: the
/// panel the user sees is smaller than the window on every side, because the
/// view draws the panel's own drop shadow and a window sized to the panel would
/// clip it. They differ only in how tall they rest, which is why the height is
/// passed in. Must match `CAPTURE_WIDTH` and the resting heights in
/// `src/platform/desktop.ts`.
fn build_resident_window(
    app: &tauri::AppHandle,
    label: &str,
    title: &str,
    height: f64,
) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, label, WebviewUrl::default())
        .title(title)
        .inner_size(RESIDENT_WINDOW_WIDTH, height)
        .resizable(false)
        .decorations(false)
        // The rounded corners and the shadow are drawn by the view, so the
        // window itself has to let the desktop through outside them — and must
        // not draw a second shadow of its own around the whole frame.
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .visible(false)
        .build()?;

    Ok(())
}

/// What every Note Entry Point does. Each of them reaches the same single
/// place, and none can fail loudly enough to be worth more than a log: the user
/// asked for a Capture, not for an error.
fn start_capture(app: &tauri::AppHandle) {
    show_resident_window(app, CAPTURE_WINDOW, CAPTURE_SHOWN_EVENT, false)
}

/// What every Task Entry Point does — the Task Hotkey, New Task in the Tray
/// Menu, and the New Task control in Tasks View all arrive here.
fn start_task_creation_window(app: &tauri::AppHandle) {
    show_resident_window(
        app,
        TASK_CREATION_WINDOW,
        TASK_CREATION_SHOWN_EVENT,
        false,
    )
}

fn show_resident_window(
    app: &tauri::AppHandle,
    label: &str,
    shown_event: &str,
    practice: bool,
) {
    if let Err(error) = raise_resident_window(app, label, shown_event, practice) {
        log::error!("could not show the {label} window: {error}");
    }
}

/// The window is already alive, so showing it is all that is left. Focus is
/// requested explicitly because a Dock-less app does not reliably receive it
/// when a window becomes visible.
///
/// The other resident window is put away first, and put away by this side
/// rather than by asking it to dismiss itself: the two panels float over
/// everything, so both on screen at once is one too many — but whatever is
/// half-typed in the one going away has to survive, which a dismiss would
/// discard.
fn raise_resident_window(
    app: &tauri::AppHandle,
    label: &str,
    shown_event: &str,
    practice: bool,
) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(label) else {
        log::error!("the {label} window is missing");
        return Ok(());
    };

    // An Entry Point reached while its own window is already up focuses it and
    // changes nothing else: showing again would clear a line the user is
    // halfway through typing.
    if window.is_visible()? {
        return window.set_focus();
    }

    // Whoever the panel is about to float over, remembered before anything
    // moves: dismissing it hands focus straight back to them, and hiding the
    // other panel first would let macOS promote somebody else in the meantime.
    remember_frontmost_application(app);

    if let Some(other) = app.get_webview_window(other_resident_window(label)) {
        other.hide()?;
    }

    window.show()?;
    window.set_focus()?;
    window.emit(shown_event, CaptureShown { practice })?;

    Ok(())
}

/// What a resident window is told every time it is shown: whether this
/// showing was raised for Onboarding practice. The Capture view routes its
/// dismissal on it — a practice ending returns focus to the Main Window and
/// reports its outcome, an ordinary one hands focus back as before — so the
/// return destination is carried by the showing itself rather than by any
/// flag that could outlive it. The Task Creation view ignores the payload.
#[derive(Clone, serde::Serialize)]
struct CaptureShown {
    practice: bool,
}

/// The resident window that is not this one. There are exactly two.
fn other_resident_window(label: &str) -> &'static str {
    if label == CAPTURE_WINDOW {
        TASK_CREATION_WINDOW
    } else {
        CAPTURE_WINDOW
    }
}

/// The Edit menu, which belongs to the application rather than to any one
/// window. macOS routes Cmd+Z, Cmd+X, Cmd+C and Cmd+V through menu items, so
/// the resident Capture and Task Creation panels need this menu installed
/// whether or not the Main Window exists — see
/// docs/adr/0023-the-app-enters-the-dock-only-while-the-main-window-is-open.md.
fn build_edit_menu(app: &tauri::AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    let undo = PredefinedMenuItem::undo(app, Some("Undo"))?;
    let redo = PredefinedMenuItem::redo(app, Some("Redo"))?;
    let edit_separator = PredefinedMenuItem::separator(app)?;
    let cut = PredefinedMenuItem::cut(app, Some("Cut"))?;
    let copy = PredefinedMenuItem::copy(app, Some("Copy"))?;
    let paste = PredefinedMenuItem::paste(app, Some("Paste"))?;
    let select_all = PredefinedMenuItem::select_all(app, Some("Select All"))?;

    Submenu::with_id_and_items(
        app,
        EDIT_MENU_ID,
        "Edit",
        true,
        &[
            &undo,
            &redo,
            &edit_separator,
            &cut,
            &copy,
            &paste,
            &select_all,
        ],
    )
}

/// The app menu, which arrives with the Main Window and leaves with it: About,
/// Settings, Close Window and Quit are what a Regular application owns and an
/// Accessory one does not.
///
/// Close Window lives here because AppKit only matches visible menu key
/// equivalents. It is a normal item rather than the predefined responder-chain
/// command: Cmd+W must close this app's Main Window even when a resident
/// Capture or Task Creation panel is temporarily in front of it.
fn build_app_menu(app: &tauri::AppHandle) -> tauri::Result<Submenu<tauri::Wry>> {
    let about = PredefinedMenuItem::about(app, Some("About"), None)?;
    let settings = MenuItem::with_id(app, MAIN_SETTINGS_MENU_ITEM, "Settings", true, None::<&str>)?;
    let close_window = MenuItem::with_id(
        app,
        CLOSE_WINDOW_MENU_ITEM,
        "Close Window",
        true,
        Some("CmdOrCtrl+W"),
    )?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit"))?;
    let about_separator = PredefinedMenuItem::separator(app)?;
    let settings_separator = PredefinedMenuItem::separator(app)?;
    let close_separator = PredefinedMenuItem::separator(app)?;

    Submenu::with_id_and_items(
        app,
        APP_MENU_ID,
        APP_NAME,
        true,
        &[
            &about,
            &about_separator,
            &settings,
            &settings_separator,
            &close_window,
            &close_separator,
            &quit,
        ],
    )
}

/// Installs the application's standing menu: Edit alone, which is every menu a
/// menu-bar-only app needs and every menu it may show. Called once at startup,
/// before the resident panels exist, and again whenever the Main Window takes
/// its own menu away with it.
///
/// The menu is deliberately built by hand rather than from `Menu::default`:
/// Tauri's defaults add framework-owned View, Window, Help and macOS
/// application commands that are not part of Work Journal's navigation model.
/// The Tray Menu is attached to its icon and is unaffected by this app-wide
/// menu.
fn install_edit_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    let edit = build_edit_menu(app)?;
    app.set_menu(Menu::with_items(app, &[&edit])?)?;
    Ok(())
}

/// Adds the app menu beside Edit as the Main Window is about to exist, so the
/// menu bar a Regular application shows is complete from the first frame.
fn install_main_window_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    let app_menu = build_app_menu(app)?;
    let edit = build_edit_menu(app)?;
    app.set_menu(Menu::with_items(app, &[&app_menu, &edit])?)?;
    Ok(())
}

/// Takes the app menu away as the Main Window is destroyed, leaving the Edit
/// menu the resident panels keep their clipboard and undo shortcuts through.
fn remove_app_menu(app: &tauri::AppHandle) {
    if let Err(error) = install_edit_menu(app) {
        log::error!("could not restore the Edit menu on its own: {error}");
    }
}

/// Restores the menu-bar-only state if creating the Main Window did not
/// complete. Both the app menu and the Dock state are transactions around the
/// window build, so neither may be left claiming an absent window.
fn rollback_main_window_open(app: &tauri::AppHandle, menu_was_attempted: bool) {
    show_presence(app, app.state::<Dock>().window_closed(MAIN_WINDOW));
    if menu_was_attempted {
        remove_app_menu(app);
    }
}

/// Opens the Main Window, building it if it is not already open. Unlike the
/// capture window this one is created on demand and genuinely closed on
/// dismiss — see docs/adr/0002-capture-window-is-hidden-never-closed.md and
/// docs/adr/0022-one-main-window-for-reading-and-settings.md.
///
/// The section is what the Entry Point asked for, and `None` where it asked
/// for nothing — a click on the Dock icon, which raises whatever the window is
/// already showing and opens a new one on History.
///
/// Which section is said twice, exactly as a Task Alert is: written down for a
/// window that has yet to ask — one this call is about to build, or one built
/// a moment ago whose webview is still coming up — and announced for one that
/// is already open and has long since asked.
///
/// Said both ways every time, rather than one or the other depending on
/// whether a window exists yet. A window that exists is not necessarily
/// listening, and deciding between them left a request arriving while the
/// window was still starting up written down nowhere and announced to nothing.
/// The window takes whichever of the two arrives last.
fn open_main_window(app: &tauri::AppHandle, section: Option<&str>) {
    // An Entry Point that names no section — a click on the Dock icon — takes
    // away what an earlier request left waiting, so the window it opens starts
    // on History rather than inheriting that request.
    remember_requested_section(app, section);

    if let Err(error) = show_main_window(app) {
        log::error!("could not open the Main Window: {error}");
        if app.get_webview_window(MAIN_WINDOW).is_none() {
            // Nothing was built, so nothing is going to come and ask.
            remember_requested_section(app, None);
            return;
        }
        // The window is there and will come and ask — building it succeeded
        // and only taking focus failed — so what was written down stands.
    }

    let Some(section) = section else {
        return;
    };

    // Addressed rather than broadcast: only the Main Window has sections.
    if let Err(error) = app.emit_to(
        MAIN_WINDOW,
        SECTION_REQUESTED_EVENT,
        SectionRequested {
            section: section.to_string(),
        },
    ) {
        log::warn!("could not pass on the section: {error}");
    }
}

/// Puts the section a window has yet to claim down, or takes it away again.
fn remember_requested_section(app: &tauri::AppHandle, section: Option<&str>) {
    if let Some(pending) = app.try_state::<RequestedSection>() {
        if let Ok(mut waiting) = pending.0.lock() {
            *waiting = section.map(str::to_string);
        }
    }
}

/// Which section of the Main Window an Entry Point named. Must match the
/// payload `onSectionRequested` reads in `src/platform/tauri-desktop.ts`.
#[derive(Clone, serde::Serialize)]
struct SectionRequested {
    section: String,
}

/// The section the Entry Point that opened this window named, if it named one
/// — asked for by the Main Window as it opens. Taken rather than read, like the
/// Alert: a window opened for any other reason must not inherit the last
/// request.
#[tauri::command]
fn requested_section(pending: tauri::State<'_, RequestedSection>) -> Option<String> {
    pending.0.lock().ok()?.take()
}

/// Opens the Main Window at one size, whichever section is showing: the
/// sidebar's width on top of the room History had when it was a window of its
/// own — see `SectionSidebar` in `src/views/main/SectionSidebar.tsx`. A window
/// that resized itself when the user clicked a sidebar item would be
/// disorienting, and would have nothing to say about a window already resized
/// by hand.
///
/// The window is built the first time it is asked for and raised every time
/// after, until it is dismissed and genuinely closed. The Main Window is the
/// only on-demand window; the Capture and Task Creation panels are resident.
fn show_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    // Whatever is half-typed in a resident panel survives the window that is
    // about to take focus from it.
    put_the_resident_panels_away(app);

    // Reaching the Tray Menu again with the window already open raises it
    // rather than building a second one.
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        window.show()?;
        return window.set_focus();
    }

    // Both before the window exists, so it is born into an application that
    // already owns a Dock icon and a Cmd+Tab entry rather than acquiring them
    // under the user. Only the Main Window moves this; the Dock ignores the
    // rest.
    let presence = app.state::<Dock>().window_opened(MAIN_WINDOW);

    // The app menu goes up before the app starts drawing a menu bar, so the
    // first bar the user sees is already the two menus and never Edit alone.
    let menu_was_attempted = presence == Some(Presence::InTheDock);
    if menu_was_attempted {
        if let Err(error) = install_main_window_menu(app) {
            rollback_main_window_open(app, menu_was_attempted);
            return Err(error);
        }
    }

    show_presence(app, presence);

    // A window opens on whatever it was built with and keeps it until its
    // webview has something of its own to show — a fifth of a second later. Both
    // of these are about that gap: the window is painted the palette it is
    // going to end up in, and the webview is told which one that is before it
    // parses a line of the document, so its first frame is already right.
    let theme = resolved_theme(app);

    let builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::default())
        .title("Work Journal")
        .inner_size(696.0, 620.0)
        .min_inner_size(556.0, 320.0)
        .center()
        .background_color(theme.background())
        .initialization_script(theme.announcement());

    // The window is handed its own title bar: the traffic lights are inset over
    // the view rather than sitting in a bar of their own, and the title is left
    // unsaid, because every one of these windows already says what it is. The
    // view leaves the buttons a strip to sit in — see
    // `src/components/WindowTitleBar.tsx`. The Capture window is not built here
    // and keeps its own chrome, which is none at all.
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    let window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
            // Nothing was built, so nothing should be left in the Dock or
            // claiming a window in the menu bar either.
            rollback_main_window_open(app, menu_was_attempted);
            return Err(error);
        }
    };

    // A Dock-less app does not reliably receive focus when a window appears.
    window.set_focus()?;

    Ok(())
}

/// Puts an on-screen resident panel away before another Work Journal window
/// takes focus from it. Losing focus to another application is the user walking
/// away from what they were typing, and both panels discard on it; losing it
/// to this app's own window is a handoff, and the panel going away first is how
/// it is told which one this is — the same exemption `raise_resident_window`
/// already gives each panel when the other is invoked.
///
/// Hidden by this side rather than by asking the window to dismiss itself,
/// which would throw the half-typed line away. Nothing is cleared, so the next
/// Capture or Task Creation opens on the words that were already there — which
/// is also why a Main Window that then fails to open needs nothing put back:
/// the panel is away rather than gone, and the next Entry Point brings it back
/// with every word in it.
fn put_the_resident_panels_away(app: &tauri::AppHandle) {
    for label in [CAPTURE_WINDOW, TASK_CREATION_WINDOW] {
        let Some(panel) = app.get_webview_window(label) else {
            continue;
        };

        if let Err(error) = panel.hide() {
            log::error!("could not put the {label} window away: {error}");
        }
    }
}

/// Tells macOS how the app shows itself now, when that has changed at all.
/// `None` is the ordinary case — most windows opening and closing say nothing
/// about the Dock.
fn show_presence(app: &tauri::AppHandle, presence: Option<Presence>) {
    let Some(presence) = presence else {
        return;
    };

    #[cfg(target_os = "macos")]
    {
        let policy = match presence {
            Presence::InTheDock => tauri::ActivationPolicy::Regular,
            Presence::MenuBarOnly => tauri::ActivationPolicy::Accessory,
        };

        if let Err(error) = app.set_activation_policy(policy) {
            log::error!("could not change how the app shows itself: {error}");
        }
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (app, presence);
}

/// Opens the Main Window on Settings, building it if it is not already open.
/// The Tray Menu reaches it here; a Work Summary showing a Model Access
/// failure links there from inside the window, where the section switch is its
/// own host's — no command crosses the boundary for a trip the sidebar already
/// makes.
fn open_settings(app: &tauri::AppHandle) {
    open_main_window(app, Some(SETTINGS_SECTION));
}

/// Closes the Main Window without quitting the app. The resident Capture and
/// Task Creation windows are intentionally not touched, so their background
/// sessions keep running and any unfinished resident work remains available.
fn close_main_window(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };

    if let Err(error) = window.close() {
        log::error!("could not close the Main Window: {error}");
    }
}

/// The Resolved Theme — the palette actually painted, never `system`; see
/// [CONTEXT.md](../../CONTEXT.md). Worked out here as well as in
/// `src/settings/theme.ts` because a window needs its palette *before* it has a
/// webview, which is the one question the frontend cannot answer in time.
#[derive(Clone, Copy)]
enum ResolvedTheme {
    Light,
    Dark,
}

impl ResolvedTheme {
    /// What the window itself is painted while its webview has nothing to show
    /// — `--background` from `src/index.css`, in sRGB. Tauri's default is
    /// white, which in a dark app is a flash of the wrong colour on every open.
    fn background(self) -> Color {
        match self {
            Self::Dark => Color(10, 10, 10, 255),
            Self::Light => Color(255, 255, 255, 255),
        }
    }

    /// Handed to the webview before its document is parsed, so the very first
    /// frame is painted in the right palette rather than repainted into it.
    /// Must match `__THEME__` in `src/platform/desktop.ts`.
    fn announcement(self) -> String {
        let name = match self {
            Self::Dark => "dark",
            Self::Light => "light",
        };
        format!("window.__THEME__ = '{name}'")
    }
}

/// The palette the app is about to paint in: the stored preference, or the OS
/// where there is none. The capture window is asked about the OS because it is
/// built before any of this and outlives every other window.
fn resolved_theme(app: &tauri::AppHandle) -> ResolvedTheme {
    let stored = app
        .store(SETTINGS_FILE)
        .ok()
        .and_then(|store| store.get(THEME_KEY))
        .and_then(|value| value.as_str().map(str::to_string));

    match stored.as_deref() {
        Some("dark") => ResolvedTheme::Dark,
        Some("light") => ResolvedTheme::Light,
        // `system`, or nothing said yet: whatever the OS is painting.
        _ => {
            let dark = app
                .get_webview_window(CAPTURE_WINDOW)
                .and_then(|window| window.theme().ok())
                .is_some_and(|theme| theme == tauri::Theme::Dark);

            if dark {
                ResolvedTheme::Dark
            } else {
                ResolvedTheme::Light
            }
        }
    }
}

/// Classifies this installation and writes the Onboarding marker down — the
/// one startup operation that has to happen before plugin-sql's preload can
/// create the journal and before the Hotkey settlement writes the defaults,
/// because either side effect would make a genuinely fresh installation look
/// like an established one on its very first launch.
///
/// The marker written here is what the Hotkey settlement later reads: it is
/// the durable record of this launch's classification, so a launch interrupted
/// after the marker but before the Hotkeys keeps its fresh identity on the
/// next one. When the settings cannot be read, nothing is written and the
/// marker stays away (which reads as suppressed, and falls back to the
/// evidence as it stands).
fn settle_onboarding(app: &tauri::AppHandle) {
    let Ok(store) = app.store(SETTINGS_FILE) else {
        // Unreadable settings must not become an introduction asked about
        // on every launch, nor an app that opens a window uninvited.
        log::error!("could not read the settings; automatic Onboarding stays suppressed");
        return;
    };

    // The evidence first — before the marker below makes the settings file
    // hold something, and before plugin-sql (which has yet to run) can create
    // the journal: a settings file with anything in it, or a journal already
    // on disk, is an installation that was running before this launch.
    let existing = onboarding::installation_existed(
        !store.is_empty(),
        journal_database_exists(app),
    );

    let stored = store
        .get(ONBOARDING_KEY)
        .and_then(|value| value.as_str().map(str::to_string));

    if let Some(next) = onboarding::settle(stored.as_deref(), existing) {
        store.set(ONBOARDING_KEY, next);
        if let Err(error) = store.save() {
            log::error!("could not record the Onboarding state: {error}");
        }
    }
}

/// The stored Onboarding marker, when the settings say anything at all.
fn onboarding_marker(app: &tauri::AppHandle) -> Option<String> {
    app.store(SETTINGS_FILE)
        .ok()
        .and_then(|store| store.get(ONBOARDING_KEY))
        .and_then(|value| value.as_str().map(str::to_string))
}

/// What automatic Onboarding's state is, for whichever window asks: the Main
/// Window presents the introduction when it is still due.
#[tauri::command]
fn onboarding_state(app: tauri::AppHandle) -> String {
    if onboarding::is_unfinished(onboarding_marker(&app).as_deref()) {
        onboarding::UNFINISHED.to_string()
    } else {
        // A marker that says nothing — including a settings store that would
        // not answer — reads as suppressed: an introduction nobody asked for
        // is worse than one asked for a launch late.
        onboarding::SUPPRESSED.to_string()
    }
}

/// Records that automatic Onboarding will not be offered again on its own —
/// what Finish, Skip onboarding, Close, explicit Quit and navigation away all
/// settle on. Writing it again when it already says so is harmless: replaying
/// the introduction from Settings must never re-enable automatic
/// presentation, so the write is one-way.
#[tauri::command]
fn dismiss_onboarding(app: tauri::AppHandle) -> Result<(), String> {
    let store = app.store(SETTINGS_FILE).map_err(|error| error.to_string())?;
    store.set(ONBOARDING_KEY, onboarding::SUPPRESSED);
    store.save().map_err(|error| error.to_string())
}

/// Records the dismissal an explicit Quit is, but only when this launch was
/// the one actually offering the introduction: a second instance handed off to
/// the first exits before it could show anything, and must not dismiss
/// Onboarding for the instance that is showing it.
fn dismiss_onboarding_on_quit(app: &tauri::AppHandle) {
    if !app
        .state::<OpenedForOnboarding>()
        .0
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        return;
    }
    if !onboarding::is_unfinished(onboarding_marker(app).as_deref()) {
        return;
    }

    let store = match app.store(SETTINGS_FILE) {
        Ok(store) => store,
        Err(error) => {
            log::error!("could not record the Onboarding dismissal on quit: {error}");
            return;
        }
    };
    store.set(ONBOARDING_KEY, onboarding::SUPPRESSED);
    if let Err(error) = store.save() {
        log::error!("could not record the Onboarding dismissal on quit: {error}");
    }
}

/// The OS's global shortcut table, plus what pressing each Hotkey does.
struct GlobalShortcuts {
    app: tauri::AppHandle,
}

impl hotkey::Registrar for GlobalShortcuts {
    fn register(&self, action: HotkeyAction, hotkey: &str) -> Result<(), String> {
        let handle = self.app.clone();
        self.app
            .global_shortcut()
            .on_shortcut(hotkey, move |_app, _shortcut, event| {
                // Press and release both arrive; one action per press, and only
                // ever the one this combination was registered for.
                if event.state() != ShortcutState::Pressed {
                    return;
                }
                match action {
                    HotkeyAction::Note => start_capture(&handle),
                    HotkeyAction::Task => start_task_creation_window(&handle),
                }
            })
            .map_err(|error| error.to_string())
    }

    fn unregister(&self, hotkey: &str) {
        if let Err(error) = self.app.global_shortcut().unregister(hotkey) {
            log::warn!("could not give up the Hotkey {hotkey}: {error}");
        }
    }
}

/// Registers the two Hotkeys the user last settled on and records the outcomes
/// where the rest of the app can read them. A registration macOS withholds must
/// not take the app down with it: the Tray Menu still reaches both Entry
/// Points, and Settings reports each failure against its own action.
fn register_hotkeys(app: &tauri::AppHandle) {
    settle_stored_hotkeys(app);

    let registrar = GlobalShortcuts { app: app.clone() };
    let hotkeys = hotkey::register_both(
        &stored_hotkey(app, HotkeyAction::Note),
        &stored_hotkey(app, HotkeyAction::Task),
        &registrar,
    );

    for status in [&hotkeys.note, &hotkeys.task] {
        if let hotkey::HotkeyStatus::Unavailable { hotkey, reason } = status {
            log::error!("the Hotkey {hotkey} is unavailable: {reason}");
        }
    }

    app.manage(Mutex::new(hotkeys));
}

/// Writes both combinations down explicitly, once. What each should be is
/// `hotkey::settle`'s decision; all that happens here is reading the settings
/// file, telling it whether this installation predates Tasks, and saving.
///
/// Whether it predates Tasks is the Onboarding marker's to say — the durable
/// record of the first launch's classification, written before this launch
/// could create the journal or the defaults. A launch that was classified
/// brand new and then interrupted keeps its fresh identity on the next one,
/// rather than reading the journal and settings it created as evidence of an
/// older installation. A marker that is absent or unknown — classification
/// never ran, or a settings file edited by hand — reads the evidence as it
/// stands, exactly as the Hotkey migration always has.
fn settle_stored_hotkeys(app: &tauri::AppHandle) {
    let Ok(store) = app.store(SETTINGS_FILE) else {
        log::error!("could not read the settings; the Hotkeys keep their defaults");
        return;
    };

    let stored_note = store.get(HOTKEY_KEY);
    let stored_task = store.get(TASK_HOTKEY_KEY);
    let marker = store
        .get(ONBOARDING_KEY)
        .and_then(|value| value.as_str().map(str::to_string));
    let (note, task) = hotkey::settle(
        stored_note.as_ref().and_then(|value| value.as_str()),
        stored_task.as_ref().and_then(|value| value.as_str()),
        onboarding::predates_tasks(
            marker.as_deref(),
            onboarding::installation_existed(
                !store.is_empty(),
                journal_database_exists(app),
            ),
        ),
    );

    if let Some(note) = note {
        store.set(HOTKEY_KEY, note);
    }
    if let Some(task) = task {
        store.set(TASK_HOTKEY_KEY, task);
    }

    if note.is_some() || task.is_some() {
        if let Err(error) = store.save() {
            log::error!("could not settle the Hotkeys: {error}");
        }
    }
}

/// Whether this machine already holds a journal — the evidence that the app has
/// been run before, and the one that survives a settings file that never got
/// written. Both directories are looked in because that is where plugin-sql
/// resolves a relative database URL to.
fn journal_database_exists(app: &tauri::AppHandle) -> bool {
    let file = DATABASE_URL.trim_start_matches("sqlite:");

    [app.path().app_config_dir(), app.path().app_data_dir()]
        .into_iter()
        .flatten()
        .any(|directory| directory.join(file).exists())
}

/// The Hotkey as its own Tray Menu item should show it: the combination if it
/// is registered, and nothing at all if it is not.
fn live_hotkey(app: &tauri::AppHandle, action: HotkeyAction) -> Option<String> {
    match app.state::<Mutex<Hotkeys>>().lock().ok()?.of(action) {
        hotkey::HotkeyStatus::Registered { hotkey } => Some(hotkey.clone()),
        hotkey::HotkeyStatus::Unavailable { .. } => None,
    }
}

/// Which key one of the two Hotkeys is remembered under.
fn hotkey_key(action: HotkeyAction) -> &'static str {
    match action {
        HotkeyAction::Note => HOTKEY_KEY,
        HotkeyAction::Task => TASK_HOTKEY_KEY,
    }
}

/// The Hotkey remembered from a previous run, or the one the app ships with.
/// After `settle_stored_hotkeys` the stored value is always there; the fallback
/// remains for a settings file that could not be written.
fn stored_hotkey(app: &tauri::AppHandle, action: HotkeyAction) -> String {
    app.store(SETTINGS_FILE)
        .ok()
        .and_then(|store| store.get(hotkey_key(action)))
        .and_then(|value| value.as_str().map(str::to_string))
        .filter(|hotkey| !hotkey.trim().is_empty())
        .unwrap_or_else(|| {
            match action {
                HotkeyAction::Note => hotkey::DEFAULT_NOTE_HOTKEY,
                HotkeyAction::Task => hotkey::DEFAULT_TASK_HOTKEY,
            }
            .to_string()
        })
}

/// Both Hotkeys' availability, for whichever window asks — Settings reports a
/// failed registration to the user, and points them at the Tray Menu item that
/// does the same thing.
#[tauri::command]
fn hotkey_status(hotkeys: tauri::State<'_, Mutex<Hotkeys>>) -> Result<Hotkeys, String> {
    Ok(hotkeys.lock().map_err(|_| lost_hotkey())?.clone())
}

/// Moves one Hotkey to another combination. A combination the OS refuses — or
/// one the other Hotkey already holds — is reported as an error and is not
/// remembered: restoring it on the next run would leave the app with a Hotkey
/// that does nothing and no explanation.
#[tauri::command]
fn set_hotkey(
    app: tauri::AppHandle,
    hotkeys: tauri::State<'_, Mutex<Hotkeys>>,
    action: HotkeyAction,
    hotkey: String,
) -> Result<Hotkeys, String> {
    let registrar = GlobalShortcuts { app: app.clone() };
    let mut current = hotkeys.lock().map_err(|_| lost_hotkey())?;
    let next = hotkey::remap(&current, action, &hotkey, &registrar)?;

    let store = app.store(SETTINGS_FILE).map_err(|error| error.to_string())?;
    store.set(hotkey_key(action), next.of(action).hotkey());
    store.save().map_err(|error| error.to_string())?;

    *current = next.clone();
    // The Tray Menu spells each Hotkey out beside its Entry Point, so it is
    // rebuilt here: what is attached is what a reader who opens the menu
    // without a click is shown, and a changed Hotkey is one of the things it
    // must never read wrong.
    refresh_tray_menu_of(&app);
    Ok(next)
}

fn lost_hotkey() -> String {
    "the Hotkey could not be read".to_string()
}

/// Writes the whole journal — Notes and Tasks — to a Markdown file, the way out
/// of the SQLite file. The Markdown is rendered by the journal core; all that
/// is left here is putting it somewhere the user can find it, and saying where
/// that was.
#[tauri::command]
fn export_journal(
    app: tauri::AppHandle,
    markdown: String,
    file_name: String,
) -> Result<ExportedFile, String> {
    let directory = app
        .path()
        .download_dir()
        .map_err(|error| format!("there is nowhere to export to: {error}"))?;

    export::write(&directory, &file_name, &markdown).map_err(|error| error.to_string())
}

/// The plugin's already-open pool, for the one statement a backup runs. The
/// same access `journal_transaction` has: there is no second connection to the
/// file and no second copy of the migrations. The plugin keeps its pools
/// behind an enum whose accessors are not published, so the variant is matched
/// directly.
async fn journal_pool(
    databases: tauri::State<'_, DbInstances>,
) -> Result<sqlx::SqlitePool, String> {
    let databases = databases.0.read().await;
    #[allow(unreachable_patterns)]
    match databases
        .get(DATABASE_URL)
        .ok_or_else(|| "the journal database is not open".to_string())?
    {
        DbPool::Sqlite(pool) => Ok(pool.clone()),
        _ => Err("the journal database is not SQLite".to_string()),
    }
}

/// Where the automatic snapshots sit: beside the journal, in the directory
/// plugin-sql resolves every relative `sqlite:` URL into — see
/// docs/adr/0032-a-backup-is-a-sqlite-snapshot-taken-with-vacuum-into.md for
/// why beside is still chosen, and what it buys and does not.
fn backups_directory(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join("backups"))
        .map_err(|error| format!("there is nowhere to back up to: {error}"))
}

/// The automatic snapshot: at most one per interval, on the app's own launch.
/// Spawned off the main thread against the pool the plugin already holds open,
/// so there is no second connection and no ordering hazard with migrations —
/// and so a slow disk never delays a window or a Tray Menu.
///
/// A failed snapshot is a log line and nothing else. The journal works
/// exactly as before without one, and an error in front of the user on launch
/// would teach them to dismiss the one dialog that must never be dismissed —
/// see docs/adr/0032-a-backup-is-a-sqlite-snapshot-taken-with-vacuum-into.md.
fn take_automatic_snapshot(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let pool = match journal_pool(app.state::<DbInstances>()).await {
            Ok(pool) => pool,
            // The config's sql `preload` opens the pool before setup runs, so
            // an empty DbInstances here means the preload did not happen at
            // all — worth a log line that names the cause, since a silent
            // one would leave the journal running for years with no backup
            // and nothing said about it.
            Err(error) => {
                log::error!("no automatic snapshot this launch: {error}");
                return;
            }
        };

        let directory = match backups_directory(&app) {
            Ok(directory) => directory,
            Err(error) => {
                log::error!("no automatic snapshot this launch: {error}");
                return;
            }
        };

        let now = std::time::SystemTime::now();
        let decision = backup::automatic(&directory, now);
        if !decision.due {
            return;
        }

        // Made before the snapshot is attempted, so the file is never asked
        // to appear out of nowhere: VACUUM INTO refuses to create a directory
        // on the way, and a snapshot refused for want of one is a launch that
        // never backs up again.
        if let Err(error) = std::fs::create_dir_all(&directory) {
            log::error!("could not make the backups directory: {error}");
            return;
        }

        let destination = directory.join(backup::snapshot_file_name(now));
        if let Err(error) = backup::take_snapshot(&destination, &pool).await {
            log::error!("could not take the automatic snapshot: {error}");
            return;
        }
        log::info!("automatic snapshot written to {}", destination.display());

        // Only after a snapshot is safely on disk: pruning first could take
        // the newest copy there is.
        for path in backup::prunable(&directory) {
            if let Err(error) = std::fs::remove_file(&path) {
                log::warn!("could not prune {}: {error}", path.display());
            } else {
                log::info!("pruned old snapshot {}", path.display());
            }
        }
    });
}

/// What Settings says about the automatic backups: how many there are, and
/// when the newest was taken — asked of the live directory rather than
/// remembered, since the user can empty it.
#[tauri::command(async)]
fn automatic_backups(app: tauri::AppHandle) -> Result<backup::AutomaticBackups, String> {
    let directory = backups_directory(&app)?;
    Ok(backup::automatic_backups(&directory))
}

/// Writes the snapshot to the destination the save dialog just answered with —
/// the second moment of the one gesture: the webview opened the dialog, this
/// writes what it came back with.
///
/// The overwrite question belongs to the save dialog alone: it is the one
/// that shows "Replace?" and the user answers it there. A name that is
/// nevertheless taken by the time the write runs is not refused — refusing
/// would turn the dialog's own confirmation into "Could not back up the
/// journal." — but settled beside it, `-2.db`, `-3.db`, and so on, exactly
/// as export does. Nothing on disk is ever replaced, renamed or deleted to
/// make room for a backup, and `VACUUM INTO` could not overwrite a file
/// even if asked to.
///
/// The destination arrives over IPC, so it is validated here rather than
/// trusted: reined back to a plain, absolute file name, and settled inside a
/// directory this side chose or the dialog confirmed. The parameter is named
/// for what the webview sends — `path`, as `backupJournal` in
/// `src/platform/desktop.ts` invokes it — because a mismatched argument name
/// is refused before this body runs, and says nothing. `desktop-rust.test.ts`
/// holds the pair together.
#[tauri::command(async)]
async fn backup_journal(
    _app: tauri::AppHandle,
    databases: tauri::State<'_, DbInstances>,
    path: String,
) -> Result<BackupResult, String> {
    let chosen = std::path::Path::new(&path);
    if !chosen.is_absolute() {
        return Err("the destination is not a path this dialog could have given".to_string());
    }
    // The file name alone is what carries the name; the directory it sits in
    // must be a directory the OS dialog, not the webview, chose.
    let file_name = chosen
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();

    let pool = journal_pool(databases).await?;

    // Settle after the pool, before the write: the first free sibling of the
    // chosen name in the chosen directory. In the common case the name is
    // free and this is a no-op.
    let directory = chosen
        .parent()
        .ok_or_else(|| "the destination has no directory".to_string())?;
    let destination = backup::settle_destination(directory, &file_name)
        .map_err(|error| error.to_string())?;
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    backup::take_snapshot(&destination, &pool).await?;

    Ok(BackupResult {
        path: destination.to_string_lossy().into_owned(),
        file_name: destination
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
    })
}

/// Where a manual backup ended up, so the app can say so rather than leaving
/// the user to guess whether anything happened. Must match `BackupResult` in
/// `src/platform/desktop.ts`.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupResult {
    path: String,
    file_name: String,
}

/// Shows the automatic backups folder in the Finder — the one place the
/// snapshots the app takes on its own can be seen and copied by hand. A
/// folder that does not exist yet is made rather than missed: the user asked
/// to see it, and the first snapshot may still be a launch away.
#[tauri::command(async)]
fn reveal_backups(app: tauri::AppHandle) -> Result<(), String> {
    let directory = backups_directory(&app)?;
    if !directory.exists() {
        std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    }

    reveal_in_finder(&directory)
}

/// Asks macOS to show one folder in the Finder, selecting it — `NSWorkspace
/// activateFileViewerSelectingURLs`, through the same shared workspace the
/// rest of this file already talks to.
#[cfg(target_os = "macos")]
fn reveal_in_finder(directory: &std::path::Path) -> Result<(), String> {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::class;
    use objc2_foundation::{NSArray, NSString, NSURL};

    let path = NSString::from_str(&directory.to_string_lossy());
    let url = NSURL::fileURLWithPath_isDirectory(&path, true);
    let urls = NSArray::from_retained_slice(&[url]);

    let workspace: Retained<AnyObject> = unsafe { msg_send![class!(NSWorkspace), sharedWorkspace] };
    let _: () = unsafe { msg_send![&*workspace, activateFileViewerSelectingURLs: &*urls] };
    Ok(())
}

/// Nowhere to reveal a Finder folder to, off macOS — the command answers
/// without doing anything, as every other macOS-shaped ask in this file does.
#[cfg(not(target_os = "macos"))]
fn reveal_in_finder(directory: &std::path::Path) -> Result<(), String> {
    let _ = directory;
    Ok(())
}

/// Validates a restore candidate and stages it for the next launch — the
/// second moment of the one gesture: the webview opened the open dialog,
/// this validates and stages what it came back with.
///
/// The path arrives over IPC, so it is trusted for nothing: it must be an
/// absolute path the dialog could have given, and Step 2's validation already
/// refuses anything that is not a readable journal snapshot at a supported
/// version. A refusal names which check failed and stages nothing. The
/// parameter is named for what the webview sends — `path`, as `stageRestore`
/// in `src/platform/desktop.ts` invokes it — because a mismatched argument
/// name is refused before this body runs, and says nothing.
/// `desktop-rust.test.ts` holds the pair together.
#[tauri::command(async)]
async fn stage_restore(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let candidate = std::path::Path::new(&path);
    if !candidate.is_absolute() {
        return Err("the candidate is not a path this dialog could have given".to_string());
    }
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("there is nowhere to stage a restore to: {error}"))?;
    backup::stage_restore(candidate, &config_dir).await?;
    Ok(())
}

/// Whether an API Key is saved. The key itself never crosses back to the
/// webview — see `src-tauri/src/keychain.rs`.
///
/// Off the main thread, like every other command that can end up behind a
/// system dialog: macOS puts an authorization prompt in front of the keychain
/// whenever the binary asking is not the one that saved the item, and the app
/// must not sit frozen behind it while the user reads it. Reading is prompted
/// for exactly as writing is, so all three of these are async.
#[tauri::command(async)]
fn api_key_set() -> Result<bool, String> {
    keychain::is_set()
}

/// Saves the API Key in the keychain, over whatever was there before. Off the
/// main thread, for the reason above.
#[tauri::command(async)]
fn save_api_key(api_key: String) -> Result<(), String> {
    keychain::save(&api_key)
}

/// Removes the API Key from the keychain. A keychain entry outlives an
/// uninstall, so this is the only way out of one. Off the main thread, for the
/// reason above.
#[tauri::command(async)]
fn clear_api_key() -> Result<(), String> {
    keychain::clear()
}

/// Asks the model to write a Work Summary. The webview sent only where the
/// model is, which one, and what it should hear; the Key is read here, from
/// the Keychain, and never travels back — see `work_summary.rs` and
/// docs/adr/0026-the-api-key-lives-in-the-keychain-and-rust-makes-the-call.md.
///
/// Only the Keychain is this side's business: whether the Base URL and the
/// Model are there at all is settings validation, which lives in TypeScript
/// — see ADR 0026 — with one deliberate exception: the transport the Key is
/// allowed to travel on is refused here, in `work_summary::generate`, because a
/// settings file edited by hand bypasses a view-layer check. Off the main
/// thread twice over: the Keychain can put an
/// authorization prompt in front of the read, and the call itself is allowed
/// 60 seconds. A failure is an answer like any other — one of the few kinds
/// `WorkSummaryFailure` names — so the section can say it back as a line. No
/// retry is attempted: a model call is billable, and a silent retry spends
/// the user's money twice for one click.
#[tauri::command(async)]
async fn generate_work_summary(
    request: work_summary::WorkSummaryRequest,
) -> work_summary::WorkSummaryResponse {
    let api_key = match keychain::get() {
        Ok(key) if !key.trim().is_empty() => key,
        // No key is the same refusal as a missing half of Model Access: the
        // call is refused before it can spend anything.
        Ok(_) => {
            return work_summary::WorkSummaryResponse::Failed {
                failure: work_summary::WorkSummaryFailure::ModelAccess,
            };
        }
        // The Keychain itself refused — locked, or a prompt denied.
        Err(_) => {
            return work_summary::WorkSummaryResponse::Failed {
                failure: work_summary::WorkSummaryFailure::Keychain,
            };
        }
    };

    work_summary::generate(request, &api_key).await
}

/// Puts today's Captured Note count beside the menu bar glyph. What it says is
/// decided in `src/journal/tray-count.ts` and rendered by the journal core —
/// this only carries the text across, because the count lives in the database
/// and the tray lives here.
///
/// A missing tray is not worth failing over: the count is a reminder, and the
/// window that asked for it is in the middle of a Capture.
#[tauri::command]
fn show_tray_count(app: tauri::AppHandle, title: String) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        log::warn!("there is no tray to count on");
        return;
    };

    if let Err(error) = tray.set_title(Some(title)) {
        log::warn!("the tray kept the old count: {error}");
    }
}

/// What the Tray Menu's Observing controls should read — decided and already
/// said by the capture window, which owns the settings file and the rules
/// over it. Kept for the menu to show, and the menu rebuilt as it is told:
/// what is attached is what a reader who opens the menu without a click —
/// VoiceOver, the keyboard — is shown, so a change reaches the menu itself
/// rather than waiting for the next one to be clicked open.
#[tauri::command]
fn show_tray_observing(app: tauri::AppHandle, pause_state: PauseState) -> Result<(), String> {
    let held = app.state::<TrayMenuState>();
    *held
        .0
        .lock()
        .map_err(|_| "the Tray Menu's state could not be read".to_string())? = pause_state;
    refresh_tray_menu_of(&app);
    Ok(())
}

/// What the OS allows the app to read of the user's calendars. Asked rather
/// than remembered: a grant can be revoked in System Settings, and a rebuilt
/// binary is one macOS has never seen. Never prompts.
#[tauri::command(async)]
fn calendar_access() -> Access {
    calendar::access()
}

/// Asks the user, through the OS, and answers with what it came to. Off the
/// main thread: the dialog is the system's, and the app must not sit frozen
/// behind it while the user reads it.
#[tauri::command(async)]
fn request_calendar_access() -> Access {
    calendar::request_access()
}

/// Every calendar the user has, for Settings to offer as a tick-list.
#[tauri::command(async)]
fn calendars() -> Vec<CalendarInfo> {
    calendar::calendars()
}

/// Today's events, from every calendar. Which of them are meetings worth
/// keeping is the journal's question, not this side's.
#[tauri::command(async)]
fn todays_calendar_events() -> Vec<CalendarEvent> {
    calendar::todays_events()
}

/// The commits the user's identities authored in one repository at or after
/// `since`, milliseconds since the epoch — or why that repository could not be
/// read, which is an answer about it and not a failure. Off the main thread:
/// it waits on `git`.
#[tauri::command(async)]
fn repository_commits(path: String, identities: Vec<String>, since: f64) -> commits::CommitsRead {
    commits::read(Path::new(&path), &identities, since)
}

/// Who might be the user in one repository, for Settings to offer as
/// suggestions: the configured address and the last ninety days' first-parent
/// authors. None of them counts until the user ticks it.
#[tauri::command(async)]
fn repository_identities(path: String) -> commits::IdentitiesRead {
    commits::identities(Path::new(&path))
}

/// What the OS allows the app to deliver as Task Alerts. Asked rather than
/// remembered: a grant is revoked in System Settings without the app hearing of
/// it. Never prompts.
#[tauri::command(async)]
fn task_alert_permission() -> Permission {
    alerts::permission()
}

/// Asks the user, through the OS, and answers with what it came to. Off the
/// main thread: the dialog is the system's, and the app must not sit frozen
/// behind it while the user reads it.
#[tauri::command(async)]
fn request_task_alert_permission() -> Permission {
    alerts::request_permission()
}

/// Makes the OS's pending requests say exactly what the journal says. A failure
/// is reported back and goes no further: the Task it was about is already
/// stored, and a Task Alert is derived from it — see
/// docs/adr/0017-the-os-schedules-task-alerts.md.
#[tauri::command(async)]
fn reconcile_task_alerts(alerts: Vec<TaskAlert>) -> Result<(), String> {
    alerts::reconcile(&alerts)
}

/// Opens System Settings at Notifications. The only way back after a denial,
/// because macOS never shows its own prompt a second time.
#[tauri::command(async)]
fn open_notification_settings() -> Result<(), String> {
    alerts::open_settings()
}

/// Listens for Task Alert responses. A default click turns into a Main Window
/// showing Tasks View focused on that Task. The identifier is passed through
/// untouched: which Task it names is the journal's to say, in `taskIdOfAlert`.
/// A Complete choice is instead written down and announced to the Capture
/// window, where the Task Alerts session processes it — no window is opened
/// for it here.
///
/// The click is split in two: the section is the Main Window's to switch to,
/// and the Task is Tasks View's to single out.
fn watch_for_task_alerts(app: &tauri::AppHandle) {
    let opened_handle = app.clone();
    let completed_handle = app.clone();

    alerts::watch_for_clicks(alerts::Clicks {
        opened: Box::new(move |identifier| {
            show_task_alert(&opened_handle, identifier);
        }),
        completed: Box::new(move |completion| {
            let handle = &completed_handle;
            // Written down first, and always: a choice made while Work Journal
            // was not running arrives before the Capture window is listening,
            // so it asks for these as it starts instead. Kept alongside any
            // choice that is already waiting — a second must not destroy the
            // first.
            if let Some(pending) = handle.try_state::<CompletedTaskAlert>() {
                if let Ok(mut waiting) = pending.0.lock() {
                    waiting.push(completion.clone());
                }
            }

            // And announced too, for the window already listening. Addressed
            // rather than broadcast: only the Capture window processes these.
            // No window is opened: the action is foreground-free, and the
            // session decides whether anything needs showing.
            if let Err(error) = handle.emit_to(
                CAPTURE_WINDOW,
                TASK_ALERT_COMPLETED_EVENT,
                completion,
            ) {
                log::warn!("could not pass on the Task Alert completion: {error}");
            }
        }),
    });
}

/// Turns an Alert naming a Task into a Main Window showing Tasks View focused
/// on it. The identifier passes through untouched: which Task it names is the
/// journal's to say, in `taskIdOfAlert`.
///
/// Said both ways every time, exactly as a section is: written down for a
/// window that has yet to ask — one this call is about to build, or one still
/// starting up — and announced for one already open and listening.
///
/// The click is split in two: the section is the Main Window's to switch to,
/// and the Task is Tasks View's to single out.
fn show_task_alert(app: &tauri::AppHandle, identifier: String) {
    // Written down first, and always: a Tasks View built by this very click
    // has no webview yet and would never hear the event, so it asks for this
    // as it opens instead.
    if let Some(pending) = app.try_state::<OpenedTaskAlert>() {
        if let Ok(mut waiting) = pending.0.lock() {
            *waiting = Some(identifier.clone());
        }
    }

    open_main_window(app, Some(TASKS_SECTION));

    // And announced too, for the window that was already open and has long
    // since asked. Addressed rather than broadcast: only Tasks View has
    // anything to do with it.
    if let Err(error) = app.emit_to(
        MAIN_WINDOW,
        TASK_ALERT_OPENED_EVENT,
        TaskAlertOpened {
            task_id: identifier,
        },
    ) {
        log::warn!("could not pass on the Task Alert: {error}");
    }
}

/// The Task Alert that opened this window, if one did — asked for by Tasks View
/// as it opens. Taken rather than read: an Alert singles a Task out once, and a
/// window opened for any other reason must not inherit the last click.
#[tauri::command]
fn opened_task_alert(pending: tauri::State<'_, OpenedTaskAlert>) -> Option<String> {
    pending.0.lock().ok()?.take()
}

/// Opens Tasks View focused on the Task a stale Complete action was about —
/// the Capture window's doing, which is how a background choice opens a window
/// at all. The identifier passes through untouched, exactly as a click does.
///
/// The parameter is named for what the webview sends — `alertId`, as
/// `focusTaskAlert` in `src/platform/desktop.ts` invokes it — because a
/// mismatched argument name is refused before this body runs, and says
/// nothing. `desktop-rust.test.ts` holds the pair together.
#[tauri::command]
fn focus_task_alert(app: tauri::AppHandle, alert_id: String) {
    show_task_alert(&app, alert_id);
}

/// The Complete actions waiting to be claimed, if any were chosen — asked for
/// by the Capture window as it starts. Drained rather than read: each Complete
/// processes once, however it arrived.
#[tauri::command]
fn completed_task_alert(
    pending: tauri::State<'_, CompletedTaskAlert>,
) -> Vec<TaskAlertCompletion> {
    match pending.0.lock() {
        Ok(mut waiting) => std::mem::take(&mut waiting),
        Err(_) => Vec::new(),
    }
}

/// Which Task an Alert the user clicked was about. Must match the payload
/// `onTaskAlertOpened` reads in `src/platform/tauri-desktop.ts`.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskAlertOpened {
    task_id: String,
}

/// Passes on the one thing the OS says that the webviews cannot hear for
/// themselves: the machine is awake again. A sleeping Mac runs no timers, so
/// without this a sweep that was due at 11:00 simply never happens.
#[cfg(target_os = "macos")]
fn watch_for_wake(app: &tauri::AppHandle) {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    let handle = app.clone();
    let observed = block2::RcBlock::new(move |_notification: *mut AnyObject| {
        if let Err(error) = handle.emit(SYSTEM_WOKE_EVENT, ()) {
            log::warn!("could not pass on the wake: {error}");
        }
    });

    unsafe {
        let workspace: Retained<AnyObject> = msg_send![class!(NSWorkspace), sharedWorkspace];
        let center: Retained<AnyObject> = msg_send![&*workspace, notificationCenter];
        let name = NSString::from_str("NSWorkspaceDidWakeNotification");

        let observer: Retained<AnyObject> = msg_send![
            &*center,
            addObserverForName: &*name,
            object: std::ptr::null::<AnyObject>(),
            queue: std::ptr::null::<AnyObject>(),
            usingBlock: block2::RcBlock::as_ptr(&observed),
        ];

        // Both live as long as the app does, and the app only stops when the
        // process does — so they are deliberately never given up.
        std::mem::forget(observer);
        std::mem::forget(observed);
    }
}

/// One statement of a transaction, exactly as the journal's storage seam hands
/// it over. Must match `SqlStatement` in `src/journal/journal.ts`.
#[derive(serde::Deserialize)]
struct Statement {
    sql: String,
    params: Vec<serde_json::Value>,
}

/// Every statement, or none — the journal's transaction seam; see
/// docs/adr/0020-recurring-task-transitions-are-transactional.md.
///
/// It is here rather than in the webview because `tauri-plugin-sql` hands each
/// call whichever connection of its pool happens to be free, so a `BEGIN` sent
/// from JavaScript would not be on the same connection as the writes that
/// follow it. This runs the whole list through one `sqlx` transaction on one
/// connection, which is the only way the one-Open-occurrence invariant can
/// survive an interruption.
///
/// The pool is the plugin's own, so these statements see exactly the database
/// the ordinary reads and writes do — there is no second connection to the file
/// and no second copy of the migrations.
#[tauri::command]
async fn journal_transaction(
    databases: tauri::State<'_, DbInstances>,
    statements: Vec<Statement>,
) -> Result<(), String> {
    let databases = databases.0.read().await;
    // The plugin keeps its pools behind an enum whose accessors are not
    // published, so the variant is matched directly.
    #[allow(unreachable_patterns)]
    let pool = match databases
        .get(DATABASE_URL)
        .ok_or_else(|| "the journal database is not open".to_string())?
    {
        DbPool::Sqlite(pool) => pool,
        _ => return Err("the journal database is not SQLite".to_string()),
    };

    let mut transaction = pool.begin().await.map_err(|error| error.to_string())?;

    for statement in statements {
        let mut query = sqlx::query(&statement.sql);
        for value in statement.params {
            // The only three shapes the journal ever stores. Anything else is
            // a statement built wrong, and refusing it loudly is better than
            // stringifying it into a column that will read back as nonsense.
            query = match value {
                serde_json::Value::Null => query.bind(None::<String>),
                serde_json::Value::String(text) => query.bind(text),
                serde_json::Value::Number(number) => query.bind(
                    number
                        .as_i64()
                        .ok_or_else(|| format!("not a whole number: {number}"))?,
                ),
                other => return Err(format!("the journal does not store {other}")),
            };
        }

        // The first refusal ends the transaction: dropping it without a commit
        // rolls back everything before it.
        query
            .execute(&mut *transaction)
            .await
            .map_err(|error| error.to_string())?;
    }

    transaction.commit().await.map_err(|error| error.to_string())
}

/// Ends a Capture, whether it committed a Note or discarded one. The window is
/// only ever hidden — see docs/adr/0002-capture-window-is-hidden-never-closed.md.
#[tauri::command]
fn dismiss_capture(app: tauri::AppHandle) -> Result<(), String> {
    hide_resident_window(&app, CAPTURE_WINDOW).map_err(|error| error.to_string())
}

/// Ends a Capture raised for Onboarding practice, whether it committed a Note
/// or discarded one. Hidden rather than closed, like any Capture — but focus
/// returns to the Main Window showing Onboarding instead of to whoever was in
/// front, and the outcome is reported for the Main Window holding the practice
/// attempt. Which dismiss command the Capture view calls is what scopes the
/// return destination to practice: there is no flag to go stale, so a Capture
/// put away for something else and dismissed later still hands focus back as
/// before.
#[tauri::command]
fn dismiss_practice_capture(app: tauri::AppHandle, ended: PracticeEnded) -> Result<(), String> {
    hide_capture_for_practice(&app).map_err(|error| error.to_string())?;
    if let Err(error) = app.emit(PRACTICE_ENDED_EVENT, ended) {
        log::warn!("could not report the practice outcome: {error}");
    }
    Ok(())
}

/// How a practice Capture ended: submitted with the Note's Journal Day, or
/// cancelled with nothing created. Must match `PracticeEnded` in
/// `src/platform/desktop.ts`, as `src/platform/desktop-rust.test.ts` checks.
/// Both attributes matter: `rename_all` spells the variants, while
/// `rename_all_fields` spells the fields inside them — without the latter a
/// `submitted` outcome arrives as `journal_day` and never deserializes.
#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "outcome"
)]
pub enum PracticeEnded {
    Submitted { journal_day: String },
    Cancelled,
}

/// Raises the real resident Capture window for optional Onboarding practice.
/// The Note it commits is an ordinary Captured Note; cancelling creates
/// nothing. The showing carries that it is practice, so the Capture view can
/// route its dismissal back to the Main Window — ordinary Capture behavior
/// elsewhere is unchanged.
#[tauri::command]
fn start_practice_capture(app: tauri::AppHandle) {
    show_resident_window(&app, CAPTURE_WINDOW, CAPTURE_SHOWN_EVENT, true);
}

/// A Task Entry Point reached from a webview — the New Task control in Tasks
/// View. The Hotkey and the Tray Menu reach the same place without this.
#[tauri::command]
fn start_task_creation(app: tauri::AppHandle) {
    start_task_creation_window(&app);
}

/// Ends a Task Creation, whether it committed a Task or abandoned one. Hidden
/// rather than closed, for the same reason the capture window is.
#[tauri::command]
fn dismiss_task_creation(app: tauri::AppHandle) -> Result<(), String> {
    hide_resident_window(&app, TASK_CREATION_WINDOW).map_err(|error| error.to_string())
}

/// Puts a resident window away, whether it committed anything or not. Only
/// ever hidden — see docs/adr/0002-capture-window-is-hidden-never-closed.md.
fn hide_resident_window(app: &tauri::AppHandle, label: &str) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(label) {
        window.hide()?;
    }

    // Hiding the window leaves this app active, so the user would be left
    // typing into nothing. Focus goes back to whatever was in front when the
    // Capture or Task Creation began — the panel interrupted them, and putting
    // it away is what gives that back. Every other Work Journal window is left
    // exactly as it was, on screen and unfocused.
    hand_focus_back(app);

    Ok(())
}

/// Puts the practice Capture away and returns focus to the Main Window
/// showing Onboarding. The Main Window is already open — practice begins
/// there — so focusing it is the whole return. With no Main Window to return
/// to, focus goes back to whoever was in front, exactly as an ordinary
/// Capture would.
fn hide_capture_for_practice(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(CAPTURE_WINDOW) {
        window.hide()?;
    }

    if let Some(main) = app.get_webview_window(MAIN_WINDOW) {
        main.set_focus()?;
    } else {
        hand_focus_back(app);
    }

    Ok(())
}

/// Takes note of the application a resident panel is about to cover, so that
/// dismissing the panel can hand focus back to it.
fn remember_frontmost_application(app: &tauri::AppHandle) {
    app.state::<PreviousApplication>().note(
        frontmost::frontmost_process_id(),
        frontmost::own_process_id(),
    );
}

/// Hands focus back to the application a resident panel covered. Nothing to
/// hand it to — nothing was ever in front — leaves focus where it is.
fn hand_focus_back(app: &tauri::AppHandle) {
    if let Some(previous) = app.state::<PreviousApplication>().remembered_id() {
        frontmost::activate(previous);
    }
}

/// Become active without unhiding windows. Needed before the Tray Menu opens:
/// an Accessory app that has never been active loses the menu to the activation
/// that the click itself triggers.
#[cfg(target_os = "macos")]
fn activate_for_tray_menu(app: &tauri::AppHandle) {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};

    // The click is about to make this app frontmost, so whoever is in front now
    // is the one a Capture started from the menu will be covering.
    remember_frontmost_application(app);

    unsafe {
        let shared: Retained<AnyObject> = msg_send![class!(NSApplication), sharedApplication];
        let active: bool = msg_send![&*shared, isActive];
        if !active {
            let _: bool = msg_send![&*shared, activateIgnoringOtherApps: true];
        }
    }
}

/// Asks the capture window for yesterday's Digest. Nothing more happens here:
/// the day, the Notes and the Markdown are all the journal's, and the window
/// puts the result on the clipboard itself.
///
/// A failure is not worth taking the app down for — the clipboard simply keeps
/// what it had, which is the same thing an empty yesterday does.
fn copy_yesterday_digest(app: &tauri::AppHandle) {
    ask_the_capture_window(app, COPY_YESTERDAY_DIGEST_EVENT, ());
}

/// Asks the capture window to pause Observing for one of the offered lengths.
/// The pause is an interval in the settings file, written under
/// `@/settings/observing`'s rules — and this side keeps neither, so the tray
/// asks exactly as it does for a Digest.
fn pause_observing(app: &tauri::AppHandle, length: PauseLength) {
    ask_the_capture_window(app, OBSERVING_PAUSE_EVENT, PauseRequested { length });
}

/// Asks the capture window to resume Observing: whatever pause is in force
/// ends now, and what it already excluded stays excluded.
fn resume_observing(app: &tauri::AppHandle) {
    ask_the_capture_window(app, OBSERVING_RESUME_EVENT, ());
}

/// Hands one Tray Menu ask to the capture window — the window that owns the
/// settings file and the journal, and the one that lives exactly as long as
/// the tray does, so it is always there to hear it; see
/// docs/adr/0002-capture-window-is-hidden-never-closed.md. Addressed rather
/// than broadcast, so no second window acts on one ask. An ask with nowhere
/// to go is logged and dropped: nothing the menu says is worth prompting
/// over.
fn ask_the_capture_window<T: serde::Serialize + Clone>(
    app: &tauri::AppHandle,
    event: &str,
    payload: T,
) {
    if app.get_webview_window(CAPTURE_WINDOW).is_none() {
        log::warn!("there is no capture window to hear {event}");
        return;
    }
    if let Err(error) = app.emit_to(CAPTURE_WINDOW, event, payload) {
        log::warn!("could not send {event} to the capture window: {error}");
    }
}

/// The Tray Menu, as it should read at this moment. Rebuilt whenever what it
/// says changes and whenever it opens, so the pause controls are the ones the
/// state calls for at that very instant — a pause that ran out while the menu
/// was shut reads as ended — and the Hotkeys beside the Entry Points are the
/// live ones.
///
/// The pause controls sit in their own group, and are absent rather than
/// greyed when there is nothing to pause: Observing off, or nothing on the
/// list, is a user who has no business with them. Otherwise the group is the
/// pause offered, or — while one is in force — the status line with its end
/// and the way out of it: the three shapes `pause_controls` decides between.
fn tray_menu(app: &tauri::AppHandle, state: &PauseState) -> tauri::Result<Menu<tauri::Wry>> {
    // The Hotkey is spelled out next to New Note so the Tray Menu teaches the
    // faster Entry Point. Only when it is actually live: an accelerator beside
    // a combination the OS refused would promise a keystroke that does nothing.
    let new_note = MenuItem::with_id(
        app,
        NEW_NOTE_MENU_ITEM,
        "New Note",
        true,
        live_hotkey(app, HotkeyAction::Note).as_deref(),
    )?;
    // The other Entry Point, and the fallback Settings points at when the Task
    // Hotkey is the one macOS withheld.
    let new_task = MenuItem::with_id(
        app,
        NEW_TASK_MENU_ITEM,
        "New Task",
        true,
        live_hotkey(app, HotkeyAction::Task).as_deref(),
    )?;
    let view_notes =
        MenuItem::with_id(app, VIEW_NOTES_MENU_ITEM, "View Notes", true, None::<&str>)?;
    let view_tasks =
        MenuItem::with_id(app, VIEW_TASKS_MENU_ITEM, "View Tasks", true, None::<&str>)?;
    let view_work_summary = MenuItem::with_id(
        app,
        VIEW_WORK_SUMMARY_MENU_ITEM,
        "Work Summary",
        true,
        None::<&str>,
    )?;
    let settings = MenuItem::with_id(app, SETTINGS_MENU_ITEM, "Settings", true, None::<&str>)?;
    // The update check lives inside Settings, so the Tray Menu takes the user
    // there rather than running a check with nowhere to show the answer.
    let check_for_updates = MenuItem::with_id(
        app,
        CHECK_FOR_UPDATES_MENU_ITEM,
        "Check for Updates…",
        true,
        None::<&str>,
    )?;
    let readback_separator = PredefinedMenuItem::separator(app)?;
    // The other half of the loop: what was captured yesterday, ready to paste
    // into the work log the user owes their chat group every morning.
    let copy_yesterday = MenuItem::with_id(
        app,
        COPY_YESTERDAY_DIGEST_MENU_ITEM,
        "Copy Yesterday's Notes",
        true,
        None::<&str>,
    )?;

    // The pause controls, whichever shape they take below. Built either way,
    // because the menu takes its items whole.
    let pause_separator = PredefinedMenuItem::separator(app)?;
    let an_hour =
        MenuItem::with_id(app, PAUSE_AN_HOUR_MENU_ITEM, "For an Hour", true, None::<&str>)?;
    let until_tomorrow = MenuItem::with_id(
        app,
        PAUSE_UNTIL_TOMORROW_MENU_ITEM,
        "Until Tomorrow",
        true,
        None::<&str>,
    )?;
    let until_resumed = MenuItem::with_id(
        app,
        PAUSE_UNTIL_RESUMED_MENU_ITEM,
        "Until Resumed",
        true,
        None::<&str>,
    )?;
    let offer_pause = Submenu::with_id_and_items(
        app,
        PAUSE_OBSERVING_MENU_ITEM,
        "Pause Observing",
        true,
        &[&an_hour, &until_tomorrow, &until_resumed],
    )?;
    // The status line takes the pause's own words when there is a pause.
    let paused_line = MenuItem::with_id(app, PAUSED_MENU_ITEM, "Paused", false, None::<&str>)?;
    let resume_observing = MenuItem::with_id(
        app,
        RESUME_OBSERVING_MENU_ITEM,
        "Resume Observing",
        true,
        None::<&str>,
    )?;

    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, QUIT_MENU_ITEM, "Quit", true, None::<&str>)?;

    // Entry Points first, then everything that opens the Main Window on a
    // section, then the actions that change or read the journal without
    // opening a window — copy alone in its group, the pause controls in
    // theirs — then out.
    let mut items: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = vec![
        &new_note,
        &new_task,
        &view_notes,
        &view_tasks,
        &view_work_summary,
        &settings,
        &check_for_updates,
        &readback_separator,
        &copy_yesterday,
    ];

    match pause_controls(state, now_ms()) {
        PauseControls::Paused(label) => {
            paused_line.set_text(&label)?;
            items.push(&pause_separator);
            items.push(&paused_line);
            items.push(&resume_observing);
        }
        PauseControls::Offered => {
            items.push(&pause_separator);
            items.push(&offer_pause);
        }
        PauseControls::Hidden => {}
    }

    items.push(&separator);
    items.push(&quit);
    Menu::with_items(app, &items)
}

/// Replaces the tray's menu with one built for the state as it stands. Called
/// as the menu opens and whenever what it says changes: whatever is said is
/// true at that instant — and what is attached is also what a reader who opens
/// the menu without a click (VoiceOver, the keyboard) is shown, so a change
/// cannot wait for the next one.
fn refresh_tray_menu(tray: &TrayIcon<tauri::Wry>) -> Result<(), String> {
    let app = tray.app_handle();
    let held = app.state::<TrayMenuState>();
    let state = held
        .0
        .lock()
        .map_err(|_| "the Tray Menu's state could not be read".to_string())?;
    let menu = tray_menu(app, &state).map_err(|error| error.to_string())?;
    drop(state);
    tray.set_menu(Some(menu)).map_err(|error| error.to_string())
}

/// The same rebuild, from the app rather than from the tray — what a change
/// behind the menu uses. A missing tray or a menu that would not build is a
/// logged gap: the menu then keeps the state it had, and the next open
/// rebuilds it.
fn refresh_tray_menu_of(app: &tauri::AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        log::warn!("there is no tray to refresh the menu of");
        return;
    };
    if let Err(error) = refresh_tray_menu(&tray) {
        log::warn!("the Tray Menu kept the state it had: {error}");
    }
}

/// The Tray Menu — the Entry Point that always works, and the one Settings
/// points at when the Hotkey cannot be registered. Quit is here because without
/// a Dock icon it is the only way out.
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    // The state the menu reads as it opens, written by `show_tray_observing`.
    app.manage(TrayMenuState::default());
    let menu = tray_menu(app, &PauseState::default())?;

    // tray-icon opens the menu from `mouseDown` via `performClick`. On an
    // Accessory app that has never been active, that same click also activates
    // the app, and the activation cancels the menu ~250ms later — first click
    // after launch flashes open and shut. Open from `mouseUp` after becoming
    // active, so the menu is only shown once activation has finished.
    let mut tray = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            let TrayIconEvent::Click {
                button: MouseButton::Left | MouseButton::Right,
                button_state: MouseButtonState::Up,
                ..
            } = event
            else {
                return;
            };
            #[cfg(target_os = "macos")]
            activate_for_tray_menu(tray.app_handle());
            // Rebuilt first: the menu is read at the moment it is opened.
            if let Err(error) = refresh_tray_menu(tray) {
                log::warn!("the Tray Menu kept the state it had: {error}");
            }
            let _ = tray.with_inner_tray_icon(|inner| inner.show_menu());
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            NEW_NOTE_MENU_ITEM => start_capture(app),
            NEW_TASK_MENU_ITEM => start_task_creation_window(app),
            VIEW_NOTES_MENU_ITEM => open_main_window(app, Some(HISTORY_SECTION)),
            VIEW_TASKS_MENU_ITEM => open_main_window(app, Some(TASKS_SECTION)),
            VIEW_WORK_SUMMARY_MENU_ITEM => open_main_window(app, Some(WORK_SUMMARY_SECTION)),
            COPY_YESTERDAY_DIGEST_MENU_ITEM => copy_yesterday_digest(app),
            PAUSE_AN_HOUR_MENU_ITEM => pause_observing(app, PauseLength::AnHour),
            PAUSE_UNTIL_TOMORROW_MENU_ITEM => {
                pause_observing(app, PauseLength::UntilTomorrow)
            }
            PAUSE_UNTIL_RESUMED_MENU_ITEM => pause_observing(app, PauseLength::UntilResumed),
            RESUME_OBSERVING_MENU_ITEM => resume_observing(app),
            SETTINGS_MENU_ITEM | CHECK_FOR_UPDATES_MENU_ITEM => open_settings(app),
            QUIT_MENU_ITEM => app.exit(0),
            _ => {}
        });

    // The menu bar wants a flat monochrome glyph, not the app icon: macOS
    // recolours a template image for the light and the dark bar itself, while
    // the rounded app tile would sit up there as a coloured sticker. Falling
    // back to the app icon keeps the tray — the Entry Point that always works —
    // from being lost if the glyph ever fails to decode.
    match tauri::image::Image::from_bytes(TRAY_ICON) {
        Ok(icon) => {
            tray = tray.icon(icon);
            #[cfg(target_os = "macos")]
            {
                tray = tray.icon_as_template(true);
            }
        }
        Err(error) => {
            log::error!("tray glyph failed to decode, using the app icon: {error}");
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
        }
    }

    let tray = tray.build(app)?;
    // tray-icon defaults to opening on right-mouseDown too; same race. Both
    // buttons go through the mouseUp handler above instead.
    let _ = tray.with_inner_tray_icon(|inner| inner.set_show_menu_on_right_click(false));

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The database path is named once: the URL plugin-sql opens must stay
    /// the `sqlite:` scheme plus `backup::DATABASE_FILE_NAME`, which the
    /// live/staged/rollback paths resolve from. If they drift, a restore
    /// renames into a file plugin-sql never opens — silently doing nothing.
    #[test]
    fn the_database_url_names_the_database_file() {
        assert_eq!(
            DATABASE_URL,
            format!("sqlite:{}", backup::DATABASE_FILE_NAME)
        );
    }

    /// The practice outcome crosses the webview boundary as JSON, and a field
    /// spelled wrong on either side refuses the call before any command body
    /// runs — a Capture window left standing with no way to dismiss it. These
    /// are the literals the TypeScript side sends and reads, so a drift in
    /// either direction fails here instead of on a user's screen.
    #[test]
    fn the_practice_outcome_matches_the_literals_the_webview_sends() {
        let submitted: PracticeEnded =
            serde_json::from_str(r#"{"outcome":"submitted","journalDay":"2026-03-12"}"#)
                .expect("a submitted practice outcome must deserialize");
        assert!(matches!(submitted, PracticeEnded::Submitted { .. }));

        let cancelled: PracticeEnded = serde_json::from_str(r#"{"outcome":"cancelled"}"#)
            .expect("a cancelled practice outcome must deserialize");
        assert!(matches!(cancelled, PracticeEnded::Cancelled));

        // And the way back: what this side emits for the Main Window to read
        // carries the day under the same spelling.
        let rendered = serde_json::to_value(&submitted).expect("must serialize");
        assert_eq!(
            rendered,
            serde_json::json!({"outcome": "submitted", "journalDay": "2026-03-12"})
        );
    }

    /// A pause with an end is over once that end has passed — decided as the
    /// menu opens, which is the only moment it has to be true. A drift here
    /// is a "Paused" line shown after the pause is over: exactly the
    /// forgetting the interval exists to prevent.
    #[test]
    fn the_menu_reads_a_pause_only_while_it_is_in_force() {
        let timed = PauseState::Paused {
            until: Some(1_000.0),
            label: "Paused until 11:00 AM".into(),
        };
        assert_eq!(pause_in_force(&timed, 999.0), Some("Paused until 11:00 AM"));
        assert_eq!(pause_in_force(&timed, 1_000.0), None);

        let open = PauseState::Paused {
            until: None,
            label: "Paused".into(),
        };
        assert_eq!(pause_in_force(&open, 1_000_000.0), Some("Paused"));

        assert_eq!(pause_in_force(&PauseState::Running, 0.0), None);
        assert_eq!(pause_in_force(&PauseState::Nothing, 0.0), None);
    }

    /// Which items the pause group holds at one instant — the choice itself,
    /// tested without a menu bar: nothing to pause, the pause offered, a pause
    /// in force with its end already said and the way out under it, and a
    /// pause that has ended reading as ended rather than showing a "Paused"
    /// line over an end that has passed.
    #[test]
    fn the_pause_items_follow_the_state_against_the_clock() {
        let timed = PauseState::Paused {
            until: Some(1_000.0),
            label: "Paused until 11:00 AM".into(),
        };
        let open = PauseState::Paused {
            until: None,
            label: "Paused".into(),
        };

        assert_eq!(
            pause_controls(&PauseState::Nothing, 0.0),
            PauseControls::Hidden
        );
        assert_eq!(
            pause_controls(&PauseState::Running, 0.0),
            PauseControls::Offered
        );
        assert_eq!(
            pause_controls(&timed, 999.0),
            PauseControls::Paused("Paused until 11:00 AM".into())
        );
        assert_eq!(
            pause_controls(&open, 999.0),
            PauseControls::Paused("Paused".into())
        );
        // The end has passed: Observing is running again, and the pause is
        // offered again.
        assert_eq!(pause_controls(&timed, 1_000.0), PauseControls::Offered);
    }

    /// The pause wire shapes, pinned as serde reads and writes them — the
    /// states the webview sends under `pauseState`, and the lengths a press
    /// travels back under as `{ length }`.
    #[test]
    fn the_pause_states_spell_themselves_the_way_the_webview_does() {
        let paused: PauseState =
            serde_json::from_str(r#"{"state":"paused","until":1000.0,"label":"Paused"}"#)
                .expect("a paused state must deserialize");
        let PauseState::Paused { until, label } = paused else {
            panic!("a paused state must read back as paused");
        };
        assert_eq!(until, Some(1000.0));
        assert_eq!(label, "Paused");

        let nothing: PauseState =
            serde_json::from_str(r#"{"state":"nothing"}"#).expect("must deserialize");
        let running: PauseState =
            serde_json::from_str(r#"{"state":"running"}"#).expect("must deserialize");
        assert!(matches!(nothing, PauseState::Nothing));
        assert!(matches!(running, PauseState::Running));

        assert_eq!(
            serde_json::to_value(&PauseState::Paused {
                until: None,
                label: "Paused".into()
            })
            .expect("must serialize"),
            serde_json::json!({"state": "paused", "until": null, "label": "Paused"})
        );

        for (length, name) in [
            (PauseLength::AnHour, "an-hour"),
            (PauseLength::UntilTomorrow, "until-tomorrow"),
            (PauseLength::UntilResumed, "until-resumed"),
        ] {
            assert_eq!(
                serde_json::to_value(PauseRequested { length }).expect("must serialize"),
                serde_json::json!({"length": name})
            );
        }
    }
}
