//! The Hotkeys: the fastest Entry Points, and the only ones that can be
//! unavailable. They begin a Capture, begin a Task Creation, or open Tasks View,
//! and they are independent in every respect except
//! that they may never be the same combination; see
//! docs/adr/0018-note-and-task-have-independent-accessible-hotkeys.md.
//!
//! Registration is a plain function over an injected registrar so every
//! outcome — including the failures — is decided here and testable without a
//! running app.

use serde::{Deserialize, Serialize};

/// What a global combination does. Every Hotkey in the app
/// is qualified by this, because "the Hotkey" no longer names one thing. Must
/// match `HotkeyAction` in `src/settings/hotkey.ts`, as
/// `src/platform/desktop-rust.test.ts` checks.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HotkeyAction {
    Note,
    Task,
    ViewTasks,
}

impl HotkeyAction {
    pub const ALL: [Self; 3] = [Self::Note, Self::Task, Self::ViewTasks];

    /// What the action is called when a refusal has to be said out loud. Must
    /// match `label` in `HOTKEY_ACTIONS` (`src/settings/hotkey.ts`), which is
    /// where Settings reads the same names from.
    fn label(self) -> &'static str {
        match self {
            Self::Note => "Note Hotkey",
            Self::Task => "Task Hotkey",
            Self::ViewTasks => "View Tasks Hotkey",
        }
    }
}

/// Three modifiers, because a global registration intercepts the keystroke
/// before the focused application sees it and this combination is unclaimed
/// territory. `Shift` rather than `Alt`: the `Ctrl+Opt+Cmd` family collides
/// with documented VoiceOver commands, and an Entry Point that fights a screen
/// reader is not an accessible one. Remappable in Settings; this is only where
/// each starts.
pub const DEFAULT_NOTE_HOTKEY: &str = "Ctrl+Shift+Cmd+J";
pub const DEFAULT_TASK_HOTKEY: &str = "Ctrl+Shift+Cmd+T";
pub const DEFAULT_VIEW_TASKS_HOTKEY: &str = "Ctrl+Shift+Cmd+L";

/// What the Note Hotkey used to default to, before Tasks existed. Preserved
/// for anyone who has been running the app and never chose a combination of
/// their own: changing the fallback under them would silently move a keystroke
/// they have in their fingers. Written down explicitly on the first launch
/// after the upgrade, so it stops being a fallback at all.
pub const LEGACY_NOTE_HOTKEY: &str = "Ctrl+Alt+Cmd+J";

/// What each Hotkey has to be written down as before they are claimed, given
/// what the settings file already says. `None` means the file already holds an
/// answer and nothing should be written over it.
///
/// All are settled once, explicitly, so that none is ever again decided by
/// a fallback that could move under the user. The Note Hotkey's default changed
/// when the Task Hotkey arrived — the old `Ctrl+Opt+Cmd` family collides with
/// documented VoiceOver commands — so an installation that predates Tasks and
/// never chose a combination keeps the one it has been using, persisted before
/// the fallback moves beneath it. A genuinely new installation starts on the
/// current defaults.
pub fn settle(
    stored_note: Option<&str>,
    stored_task: Option<&str>,
    stored_view_tasks: Option<&str>,
    predates_tasks: bool,
) -> (
    Option<&'static str>,
    Option<&'static str>,
    Option<&'static str>,
) {
    let note = match stored_note {
        Some(_) => None,
        None if predates_tasks => Some(LEGACY_NOTE_HOTKEY),
        None => Some(DEFAULT_NOTE_HOTKEY),
    };
    let task = match stored_task {
        Some(_) => None,
        None => Some(DEFAULT_TASK_HOTKEY),
    };

    let view_tasks = match stored_view_tasks {
        Some(_) => None,
        None => Some(DEFAULT_VIEW_TASKS_HOTKEY),
    };

    (note, task, view_tasks)
}

/// Whether a Hotkey is available, and if not, why. Recorded at startup and
/// readable from anywhere afterwards — Settings reports on it later. Must match
/// `HotkeyStatus` in `src/settings/hotkey.ts`, as
/// `src/platform/desktop-rust.test.ts` checks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum HotkeyStatus {
    Registered {
        hotkey: String,
    },
    /// macOS may withhold the permission registration needs, the combination
    /// may already belong to another application, the machine may be managed,
    /// or the stored combination may be one another Hotkey already holds.
    /// Every feature stays reachable through the
    /// Tray Menu, so this is recorded rather than fatal.
    Unavailable {
        hotkey: String,
        reason: String,
    },
}

impl HotkeyStatus {
    /// The combination this status is about, registered or not.
    pub fn hotkey(&self) -> &str {
        match self {
            HotkeyStatus::Registered { hotkey } => hotkey,
            HotkeyStatus::Unavailable { hotkey, .. } => hotkey,
        }
    }

    /// Whether the combination is actually live, and so whether it has to be
    /// given up before another one can take its place.
    fn is_registered(&self) -> bool {
        matches!(self, HotkeyStatus::Registered { .. })
    }
}

/// All Hotkeys as they stand. Held as one value because their combinations
/// must stay distinct. Must match
/// `HotkeyStatuses` in `src/settings/hotkey.ts`, as
/// `src/platform/desktop-rust.test.ts` checks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hotkeys {
    pub note: HotkeyStatus,
    pub task: HotkeyStatus,
    pub view_tasks: HotkeyStatus,
}

impl Hotkeys {
    pub fn of(&self, action: HotkeyAction) -> &HotkeyStatus {
        match action {
            HotkeyAction::Note => &self.note,
            HotkeyAction::Task => &self.task,
            HotkeyAction::ViewTasks => &self.view_tasks,
        }
    }

    fn with(&self, action: HotkeyAction, status: HotkeyStatus) -> Hotkeys {
        let mut next = self.clone();
        *match action {
            HotkeyAction::Note => &mut next.note,
            HotkeyAction::Task => &mut next.task,
            HotkeyAction::ViewTasks => &mut next.view_tasks,
        } = status;
        next
    }
}

/// The OS's global shortcut table, as registration needs to see it. Injected
/// so every decision below is testable without a running app. The action comes
/// with the combination because what a keypress does depends on which Hotkey
/// it was.
pub trait Registrar {
    fn register(&self, action: HotkeyAction, hotkey: &str) -> Result<(), String>;
    fn unregister(&self, hotkey: &str);
}

/// Moves one of the Hotkeys, or explains why it could not move.
///
/// A combination another Hotkey already holds is refused outright: they
/// may never be the same, and claiming it would mean one keypress doing two
/// things or the OS refusing on the app's own behalf. Nothing is given up in
/// that case, so all live registrations survive a rejected remap intact.
///
/// Otherwise the old binding is given up first, because the OS will not hand
/// out a combination twice and remapping onto an overlapping one would fail
/// against the app itself. If the new combination is refused, the old one is
/// put back: a rejected remap must leave the user with the Hotkey they had,
/// not with none at all.
///
/// The error is the reason the OS gave, or the collision, for the caller to
/// say plainly.
pub fn remap(
    hotkeys: &Hotkeys,
    action: HotkeyAction,
    next: &str,
    registrar: &impl Registrar,
) -> Result<Hotkeys, String> {
    let next = next.trim();

    if next.is_empty() {
        return Err("a Hotkey cannot be empty".to_string());
    }

    for other in HotkeyAction::ALL {
        if other != action && hotkeys.of(other).hotkey() == next {
            return Err(format!("it is already the {}", other.label()));
        }
    }

    let current = hotkeys.of(action);

    // Already live and unchanged: nothing to give up and nothing to claim.
    if current.is_registered() && current.hotkey() == next {
        return Ok(hotkeys.clone());
    }

    if current.is_registered() {
        registrar.unregister(current.hotkey());
    }

    match registrar.register(action, next) {
        Ok(()) => Ok(hotkeys.with(
            action,
            HotkeyStatus::Registered {
                hotkey: next.to_string(),
            },
        )),
        Err(reason) => {
            if current.is_registered() {
                // Best effort: if even the old combination will not come back,
                // there is nothing further to try, and the Tray Menu is
                // unaffected either way.
                let _ = registrar.register(action, current.hotkey());
            }
            Err(reason)
        }
    }
}

/// Registers all Hotkeys and reports the outcome of each. Never fails: a
/// Hotkey that could not be registered leaves the app running with one Entry
/// Point fewer, and the Tray Menu still does everything.
///
/// Duplicate stored values resolve in Note, Task, View Tasks order, preserving
/// the existing capture bindings when the View Tasks Hotkey is added.
pub fn register_all(
    note: &str,
    task: &str,
    view_tasks: &str,
    registrar: &impl Registrar,
) -> Hotkeys {
    let combinations = [
        (HotkeyAction::Note, note),
        (HotkeyAction::Task, task),
        (HotkeyAction::ViewTasks, view_tasks),
    ];
    let statuses: [HotkeyStatus; 3] = std::array::from_fn(|index| {
        let (action, hotkey) = combinations[index];
        if let Some((other, _)) = combinations[..index]
            .iter()
            .find(|(_, previous)| previous.trim() == hotkey.trim())
        {
            HotkeyStatus::Unavailable {
                hotkey: hotkey.to_string(),
                reason: format!("it is already the {}", other.label()),
            }
        } else {
            register(action, hotkey, registrar)
        }
    });
    let [note, task, view_tasks] = statuses;
    Hotkeys {
        note,
        task,
        view_tasks,
    }
}

/// One Hotkey, claimed from the OS, with the outcome recorded either way.
pub fn register(action: HotkeyAction, hotkey: &str, registrar: &impl Registrar) -> HotkeyStatus {
    match registrar.register(action, hotkey) {
        Ok(()) => HotkeyStatus::Registered {
            hotkey: hotkey.to_string(),
        },
        Err(reason) => HotkeyStatus::Unavailable {
            hotkey: hotkey.to_string(),
            reason,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Every call made to the OS, in order, plus which combinations it refuses.
    struct FakeRegistrar {
        refuses: Vec<String>,
        calls: RefCell<Vec<String>>,
    }

    impl FakeRegistrar {
        fn accepting_everything() -> Self {
            FakeRegistrar {
                refuses: Vec::new(),
                calls: RefCell::new(Vec::new()),
            }
        }

        fn refusing(hotkey: &str) -> Self {
            FakeRegistrar {
                refuses: vec![hotkey.to_string()],
                calls: RefCell::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.borrow().clone()
        }
    }

    impl Registrar for FakeRegistrar {
        fn register(&self, action: HotkeyAction, hotkey: &str) -> Result<(), String> {
            let name = match action {
                HotkeyAction::Note => "note",
                HotkeyAction::Task => "task",
                HotkeyAction::ViewTasks => "viewTasks",
            };
            self.calls
                .borrow_mut()
                .push(format!("register {name} {hotkey}"));
            if self.refuses.iter().any(|refused| refused == hotkey) {
                return Err("the combination belongs to another application".to_string());
            }
            Ok(())
        }

        fn unregister(&self, hotkey: &str) {
            self.calls.borrow_mut().push(format!("unregister {hotkey}"));
        }
    }

    fn registered(hotkey: &str) -> HotkeyStatus {
        HotkeyStatus::Registered {
            hotkey: hotkey.to_string(),
        }
    }

    fn capture_hotkeys(note: &str, task: &str) -> Hotkeys {
        Hotkeys {
            note: registered(note),
            task: registered(task),
            view_tasks: registered(DEFAULT_VIEW_TASKS_HOTKEY),
        }
    }

    #[test]
    fn all_hotkeys_are_registered_independently() {
        let registrar = FakeRegistrar::accepting_everything();

        let hotkeys = register_all(
            DEFAULT_NOTE_HOTKEY,
            DEFAULT_TASK_HOTKEY,
            DEFAULT_VIEW_TASKS_HOTKEY,
            &registrar,
        );

        assert_eq!(
            hotkeys,
            capture_hotkeys(DEFAULT_NOTE_HOTKEY, DEFAULT_TASK_HOTKEY)
        );
        assert_eq!(
            registrar.calls(),
            vec![
                format!("register note {DEFAULT_NOTE_HOTKEY}"),
                format!("register task {DEFAULT_TASK_HOTKEY}"),
                format!("register viewTasks {DEFAULT_VIEW_TASKS_HOTKEY}"),
            ]
        );
    }

    #[test]
    fn one_hotkey_the_os_refuses_leaves_the_other_registered() {
        let registrar = FakeRegistrar::refusing(DEFAULT_TASK_HOTKEY);

        let hotkeys = register_all(
            DEFAULT_NOTE_HOTKEY,
            DEFAULT_TASK_HOTKEY,
            DEFAULT_VIEW_TASKS_HOTKEY,
            &registrar,
        );

        assert_eq!(hotkeys.note, registered(DEFAULT_NOTE_HOTKEY));
        assert_eq!(
            hotkeys.task,
            HotkeyStatus::Unavailable {
                hotkey: DEFAULT_TASK_HOTKEY.to_string(),
                reason: "the combination belongs to another application".to_string(),
            }
        );
    }

    #[test]
    fn duplicate_stored_combinations_resolve_in_the_note_hotkeys_favour() {
        let registrar = FakeRegistrar::accepting_everything();

        let hotkeys = register_all(
            "Ctrl+Shift+Cmd+J",
            "Ctrl+Shift+Cmd+J",
            DEFAULT_VIEW_TASKS_HOTKEY,
            &registrar,
        );

        assert_eq!(hotkeys.note, registered("Ctrl+Shift+Cmd+J"));
        assert_eq!(
            hotkeys.task,
            HotkeyStatus::Unavailable {
                hotkey: "Ctrl+Shift+Cmd+J".to_string(),
                reason: "it is already the Note Hotkey".to_string(),
            }
        );
        // The Task Hotkey was never asked for: claiming it would either fail
        // against the app itself or bind one keypress to two actions.
        assert_eq!(
            registrar.calls(),
            vec![
                "register note Ctrl+Shift+Cmd+J".to_string(),
                format!("register viewTasks {DEFAULT_VIEW_TASKS_HOTKEY}")
            ]
        );
    }

    #[test]
    fn a_remap_gives_up_the_old_combination_before_claiming_the_new_one() {
        let registrar = FakeRegistrar::accepting_everything();

        let hotkeys = remap(
            &capture_hotkeys("Ctrl+Shift+Cmd+J", "Ctrl+Shift+Cmd+T"),
            HotkeyAction::Note,
            "Ctrl+Alt+K",
            &registrar,
        );

        assert_eq!(
            hotkeys,
            Ok(capture_hotkeys("Ctrl+Alt+K", "Ctrl+Shift+Cmd+T"))
        );
        assert_eq!(
            registrar.calls(),
            vec!["unregister Ctrl+Shift+Cmd+J", "register note Ctrl+Alt+K"]
        );
    }

    #[test]
    fn remapping_one_hotkey_leaves_the_other_exactly_as_it_was() {
        let registrar = FakeRegistrar::accepting_everything();

        let hotkeys = remap(
            &capture_hotkeys("Ctrl+Shift+Cmd+J", "Ctrl+Shift+Cmd+T"),
            HotkeyAction::Task,
            "Ctrl+Alt+K",
            &registrar,
        )
        .unwrap();

        assert_eq!(hotkeys.note, registered("Ctrl+Shift+Cmd+J"));
        assert_eq!(hotkeys.task, registered("Ctrl+Alt+K"));
    }

    #[test]
    fn a_refused_remap_reports_the_reason_and_puts_the_old_combination_back() {
        let registrar = FakeRegistrar::refusing("Ctrl+Alt+K");

        let hotkeys = remap(
            &capture_hotkeys("Ctrl+Shift+Cmd+J", "Ctrl+Shift+Cmd+T"),
            HotkeyAction::Note,
            "Ctrl+Alt+K",
            &registrar,
        );

        assert_eq!(
            hotkeys,
            Err("the combination belongs to another application".to_string())
        );
        assert_eq!(
            registrar.calls(),
            vec![
                "unregister Ctrl+Shift+Cmd+J",
                "register note Ctrl+Alt+K",
                "register note Ctrl+Shift+Cmd+J"
            ]
        );
    }

    #[test]
    fn a_collision_is_refused_without_touching_either_registration() {
        let registrar = FakeRegistrar::accepting_everything();
        let hotkeys = capture_hotkeys("Ctrl+Shift+Cmd+J", "Ctrl+Shift+Cmd+T");

        let refused = remap(&hotkeys, HotkeyAction::Task, "Ctrl+Shift+Cmd+J", &registrar);

        assert_eq!(refused, Err("it is already the Note Hotkey".to_string()));
        assert!(registrar.calls().is_empty());
    }

    #[test]
    fn a_collision_against_an_unavailable_hotkey_is_refused_too() {
        let registrar = FakeRegistrar::accepting_everything();
        let hotkeys = Hotkeys {
            note: HotkeyStatus::Unavailable {
                hotkey: "Ctrl+Shift+Cmd+J".to_string(),
                reason: "macOS withheld the permission".to_string(),
            },
            task: registered("Ctrl+Shift+Cmd+T"),
            view_tasks: registered(DEFAULT_VIEW_TASKS_HOTKEY),
        };

        let refused = remap(&hotkeys, HotkeyAction::Task, "Ctrl+Shift+Cmd+J", &registrar);

        assert_eq!(refused, Err("it is already the Note Hotkey".to_string()));
        assert!(registrar.calls().is_empty());
    }

    #[test]
    fn remapping_to_the_combination_already_in_force_touches_nothing() {
        let registrar = FakeRegistrar::accepting_everything();

        let hotkeys = remap(
            &capture_hotkeys("Ctrl+Shift+Cmd+J", "Ctrl+Shift+Cmd+T"),
            HotkeyAction::Note,
            "Ctrl+Shift+Cmd+J",
            &registrar,
        );

        assert_eq!(
            hotkeys,
            Ok(capture_hotkeys("Ctrl+Shift+Cmd+J", "Ctrl+Shift+Cmd+T"))
        );
        assert!(registrar.calls().is_empty());
    }

    #[test]
    fn an_unavailable_hotkey_has_nothing_to_give_up() {
        let registrar = FakeRegistrar::accepting_everything();
        let hotkeys = Hotkeys {
            note: HotkeyStatus::Unavailable {
                hotkey: "Ctrl+Shift+Cmd+J".to_string(),
                reason: "macOS withheld the permission".to_string(),
            },
            task: registered("Ctrl+Shift+Cmd+T"),
            view_tasks: registered(DEFAULT_VIEW_TASKS_HOTKEY),
        };

        let next = remap(&hotkeys, HotkeyAction::Note, "Ctrl+Alt+K", &registrar).unwrap();

        assert_eq!(next.note, registered("Ctrl+Alt+K"));
        assert_eq!(registrar.calls(), vec!["register note Ctrl+Alt+K"]);
    }

    #[test]
    fn a_hotkey_that_failed_to_register_can_be_retried_as_it_is() {
        let registrar = FakeRegistrar::accepting_everything();
        let hotkeys = Hotkeys {
            note: registered("Ctrl+Shift+Cmd+J"),
            task: HotkeyStatus::Unavailable {
                hotkey: "Ctrl+Shift+Cmd+T".to_string(),
                reason: "macOS withheld the permission".to_string(),
            },
            view_tasks: registered(DEFAULT_VIEW_TASKS_HOTKEY),
        };

        let next = remap(&hotkeys, HotkeyAction::Task, "Ctrl+Shift+Cmd+T", &registrar).unwrap();

        assert_eq!(next.task, registered("Ctrl+Shift+Cmd+T"));
    }

    #[test]
    fn an_empty_hotkey_is_refused_without_giving_up_the_working_one() {
        let registrar = FakeRegistrar::accepting_everything();

        let refused = remap(
            &capture_hotkeys("Ctrl+Shift+Cmd+J", "Ctrl+Shift+Cmd+T"),
            HotkeyAction::Note,
            "   ",
            &registrar,
        );

        assert!(refused.is_err());
        assert!(registrar.calls().is_empty());
    }

    #[test]
    fn a_failed_registration_records_the_reason_rather_than_panicking() {
        let registrar = FakeRegistrar::refusing(DEFAULT_NOTE_HOTKEY);

        let status = register(HotkeyAction::Note, DEFAULT_NOTE_HOTKEY, &registrar);

        assert_eq!(
            status,
            HotkeyStatus::Unavailable {
                hotkey: DEFAULT_NOTE_HOTKEY.to_string(),
                reason: "the combination belongs to another application".to_string(),
            }
        );
    }

    #[test]
    fn the_hotkey_asked_for_is_the_one_registered() {
        let registrar = FakeRegistrar::accepting_everything();

        register(HotkeyAction::Task, "Ctrl+K", &registrar);

        assert_eq!(registrar.calls(), vec!["register task Ctrl+K"]);
    }

    #[test]
    fn view_tasks_registration_failure_leaves_capture_hotkeys_working() {
        let registrar = FakeRegistrar::refusing(DEFAULT_VIEW_TASKS_HOTKEY);
        let hotkeys = register_all(
            DEFAULT_NOTE_HOTKEY,
            DEFAULT_TASK_HOTKEY,
            DEFAULT_VIEW_TASKS_HOTKEY,
            &registrar,
        );
        assert!(hotkeys.note.is_registered());
        assert!(hotkeys.task.is_registered());
        assert!(!hotkeys.view_tasks.is_registered());
    }

    #[test]
    fn view_tasks_cannot_claim_either_capture_combination_at_startup() {
        for (combination, label) in [
            (DEFAULT_NOTE_HOTKEY, "Note Hotkey"),
            (DEFAULT_TASK_HOTKEY, "Task Hotkey"),
        ] {
            let registrar = FakeRegistrar::accepting_everything();
            let hotkeys = register_all(
                DEFAULT_NOTE_HOTKEY,
                DEFAULT_TASK_HOTKEY,
                combination,
                &registrar,
            );
            assert_eq!(
                hotkeys.view_tasks,
                HotkeyStatus::Unavailable {
                    hotkey: combination.to_string(),
                    reason: format!("it is already the {label}"),
                }
            );
            assert_eq!(registrar.calls().len(), 2);
        }
    }

    #[test]
    fn every_action_refuses_combinations_reserved_for_other_actions() {
        let hotkeys = capture_hotkeys(DEFAULT_NOTE_HOTKEY, DEFAULT_TASK_HOTKEY);
        for action in HotkeyAction::ALL {
            for other in HotkeyAction::ALL {
                if action == other {
                    continue;
                }
                let registrar = FakeRegistrar::accepting_everything();
                assert_eq!(
                    remap(&hotkeys, action, hotkeys.of(other).hotkey(), &registrar),
                    Err(format!("it is already the {}", other.label()))
                );
                assert!(registrar.calls().is_empty());
            }
        }
    }

    #[test]
    fn view_tasks_remap_preserves_capture_bindings_and_rolls_back_on_refusal() {
        let hotkeys = capture_hotkeys(DEFAULT_NOTE_HOTKEY, DEFAULT_TASK_HOTKEY);
        let accepting = FakeRegistrar::accepting_everything();
        let next = remap(&hotkeys, HotkeyAction::ViewTasks, "Ctrl+Cmd+K", &accepting).unwrap();
        assert_eq!(next.note, hotkeys.note);
        assert_eq!(next.task, hotkeys.task);
        assert_eq!(next.view_tasks, registered("Ctrl+Cmd+K"));
        let refusing = FakeRegistrar::refusing("Ctrl+Cmd+K");
        assert!(remap(&hotkeys, HotkeyAction::ViewTasks, "Ctrl+Cmd+K", &refusing).is_err());
        assert_eq!(
            refusing.calls(),
            vec![
                format!("unregister {DEFAULT_VIEW_TASKS_HOTKEY}"),
                "register viewTasks Ctrl+Cmd+K".to_string(),
                format!("register viewTasks {DEFAULT_VIEW_TASKS_HOTKEY}"),
            ]
        );
    }

    #[test]
    fn an_upgrade_adds_view_tasks_without_overwriting_existing_bindings() {
        assert_eq!(
            settle(Some("Ctrl+K"), Some("Ctrl+T"), None, true),
            (None, None, Some(DEFAULT_VIEW_TASKS_HOTKEY))
        );
        assert_eq!(
            settle(Some("Ctrl+K"), Some("Ctrl+T"), Some("Ctrl+L"), true),
            (None, None, None)
        );
    }

    #[test]
    fn a_first_run_settles_on_the_hotkeys_the_app_ships_with() {
        assert_eq!(
            settle(None, None, None, false),
            (
                Some(DEFAULT_NOTE_HOTKEY),
                Some(DEFAULT_TASK_HOTKEY),
                Some(DEFAULT_VIEW_TASKS_HOTKEY)
            )
        );
    }

    #[test]
    fn an_installation_predating_tasks_keeps_the_note_hotkey_it_has_been_using() {
        assert_eq!(
            settle(None, None, None, true),
            (
                Some(LEGACY_NOTE_HOTKEY),
                Some(DEFAULT_TASK_HOTKEY),
                Some(DEFAULT_VIEW_TASKS_HOTKEY)
            )
        );
    }

    #[test]
    fn a_combination_the_user_chose_is_never_written_over() {
        assert_eq!(settle(Some("Ctrl+Alt+K"), None, None, true).0, None);
        assert_eq!(settle(Some("Ctrl+Alt+K"), None, None, false).0, None);
        assert_eq!(settle(None, Some("Ctrl+Alt+L"), None, true).1, None);
    }

    #[test]
    fn settling_twice_writes_nothing_the_second_time() {
        let (note, task, view_tasks) = settle(None, None, None, true);
        assert_eq!(settle(note, task, view_tasks, true), (None, None, None));
    }

    #[test]
    fn the_defaults_avoid_the_voiceover_family_and_differ_from_each_other() {
        assert_ne!(DEFAULT_NOTE_HOTKEY, DEFAULT_TASK_HOTKEY);
        assert_ne!(DEFAULT_VIEW_TASKS_HOTKEY, DEFAULT_NOTE_HOTKEY);
        assert_ne!(DEFAULT_VIEW_TASKS_HOTKEY, DEFAULT_TASK_HOTKEY);
        assert!(!DEFAULT_NOTE_HOTKEY.contains("Alt"));
        assert!(!DEFAULT_TASK_HOTKEY.contains("Alt"));
        assert!(!DEFAULT_VIEW_TASKS_HOTKEY.contains("Alt"));
        assert_eq!(LEGACY_NOTE_HOTKEY, "Ctrl+Alt+Cmd+J");
    }
}
