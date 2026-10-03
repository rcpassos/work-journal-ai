//! The Hotkeys: the fastest Entry Points, and the only ones that can be
//! unavailable. There are two of them — one that begins a Capture and one that
//! begins a Task Creation — and they are independent in every respect except
//! that they may never be the same combination; see
//! docs/adr/0018-note-and-task-have-independent-accessible-hotkeys.md.
//!
//! Registration is a plain function over an injected registrar so every
//! outcome — including the failures — is decided here and testable without a
//! running app.

use serde::{Deserialize, Serialize};

/// Which of the two things a global combination does. Every Hotkey in the app
/// is qualified by this, because "the Hotkey" no longer names one thing.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HotkeyAction {
    Note,
    Task,
}

impl HotkeyAction {
    /// The other one. A collision is always against exactly this.
    fn other(self) -> Self {
        match self {
            Self::Note => Self::Task,
            Self::Task => Self::Note,
        }
    }

    /// What the action is called when a refusal has to be said out loud. Must
    /// match `label` in `HOTKEY_ACTIONS` (`src/settings/hotkey.ts`), which is
    /// where Settings reads the same two names from.
    fn label(self) -> &'static str {
        match self {
            Self::Note => "Note Hotkey",
            Self::Task => "Task Hotkey",
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

/// What the Note Hotkey used to default to, before Tasks existed. Preserved
/// for anyone who has been running the app and never chose a combination of
/// their own: changing the fallback under them would silently move a keystroke
/// they have in their fingers. Written down explicitly on the first launch
/// after the upgrade, so it stops being a fallback at all.
pub const LEGACY_NOTE_HOTKEY: &str = "Ctrl+Alt+Cmd+J";

/// What each Hotkey has to be written down as before either is claimed, given
/// what the settings file already says. `None` means the file already holds an
/// answer and nothing should be written over it.
///
/// Both are settled once, explicitly, so that neither is ever again decided by
/// a fallback that could move under the user. The Note Hotkey's default changed
/// when the Task Hotkey arrived — the old `Ctrl+Opt+Cmd` family collides with
/// documented VoiceOver commands — so an installation that predates Tasks and
/// never chose a combination keeps the one it has been using, persisted before
/// the fallback moves beneath it. A genuinely new installation starts on the
/// new pair.
pub fn settle(
    stored_note: Option<&str>,
    stored_task: Option<&str>,
    predates_tasks: bool,
) -> (Option<&'static str>, Option<&'static str>) {
    let note = match stored_note {
        Some(_) => None,
        None if predates_tasks => Some(LEGACY_NOTE_HOTKEY),
        None => Some(DEFAULT_NOTE_HOTKEY),
    };
    let task = match stored_task {
        Some(_) => None,
        None => Some(DEFAULT_TASK_HOTKEY),
    };

    (note, task)
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
    /// or — for the Task Hotkey alone — the stored combination may be the one
    /// the Note Hotkey already holds. Every feature stays reachable through the
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

/// Both Hotkeys as they stand. Held as one value because the rule that keeps
/// them apart is about the pair rather than about either one. Must match
/// `HotkeyStatuses` in `src/settings/hotkey.ts`, as
/// `src/platform/desktop-rust.test.ts` checks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hotkeys {
    pub note: HotkeyStatus,
    pub task: HotkeyStatus,
}

impl Hotkeys {
    pub fn of(&self, action: HotkeyAction) -> &HotkeyStatus {
        match action {
            HotkeyAction::Note => &self.note,
            HotkeyAction::Task => &self.task,
        }
    }

    fn with(&self, action: HotkeyAction, status: HotkeyStatus) -> Hotkeys {
        match action {
            HotkeyAction::Note => Hotkeys {
                note: status,
                task: self.task.clone(),
            },
            HotkeyAction::Task => Hotkeys {
                note: self.note.clone(),
                task: status,
            },
        }
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

/// Moves one of the two Hotkeys, or explains why it could not move.
///
/// A combination the other Hotkey already holds is refused outright: the two
/// may never be the same, and claiming it would mean one keypress doing two
/// things or the OS refusing on the app's own behalf. Nothing is given up in
/// that case, so both live registrations survive a rejected remap intact.
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

    let other = action.other();
    if hotkeys.of(other).hotkey() == next {
        return Err(format!("it is already the {}", other.label()));
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

/// Registers both Hotkeys and reports the outcome of each. Never fails: a
/// Hotkey that could not be registered leaves the app running with one Entry
/// Point fewer, and the Tray Menu still does everything.
///
/// The Note Hotkey is claimed first, so a settings file holding the same
/// combination twice — which nothing in the app can produce, but a hand-edited
/// file can — resolves in its favour rather than by whichever happened to be
/// read first. The Task Hotkey is then Unavailable, and says so.
pub fn register_both(note: &str, task: &str, registrar: &impl Registrar) -> Hotkeys {
    let note_status = register(HotkeyAction::Note, note, registrar);

    let task_status = if task.trim() == note.trim() {
        HotkeyStatus::Unavailable {
            hotkey: task.to_string(),
            reason: format!("it is already the {}", HotkeyAction::Note.label()),
        }
    } else {
        register(HotkeyAction::Task, task, registrar)
    };

    Hotkeys {
        note: note_status,
        task: task_status,
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

    fn both(note: &str, task: &str) -> Hotkeys {
        Hotkeys {
            note: registered(note),
            task: registered(task),
        }
    }

    #[test]
    fn both_hotkeys_are_registered_independently() {
        let registrar = FakeRegistrar::accepting_everything();

        let hotkeys = register_both(DEFAULT_NOTE_HOTKEY, DEFAULT_TASK_HOTKEY, &registrar);

        assert_eq!(hotkeys, both(DEFAULT_NOTE_HOTKEY, DEFAULT_TASK_HOTKEY));
        assert_eq!(
            registrar.calls(),
            vec![
                format!("register note {DEFAULT_NOTE_HOTKEY}"),
                format!("register task {DEFAULT_TASK_HOTKEY}"),
            ]
        );
    }

    #[test]
    fn one_hotkey_the_os_refuses_leaves_the_other_registered() {
        let registrar = FakeRegistrar::refusing(DEFAULT_TASK_HOTKEY);

        let hotkeys = register_both(DEFAULT_NOTE_HOTKEY, DEFAULT_TASK_HOTKEY, &registrar);

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

        let hotkeys = register_both("Ctrl+Shift+Cmd+J", "Ctrl+Shift+Cmd+J", &registrar);

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
            vec!["register note Ctrl+Shift+Cmd+J".to_string()]
        );
    }

    #[test]
    fn a_remap_gives_up_the_old_combination_before_claiming_the_new_one() {
        let registrar = FakeRegistrar::accepting_everything();

        let hotkeys = remap(
            &both("Ctrl+Shift+Cmd+J", "Ctrl+Shift+Cmd+T"),
            HotkeyAction::Note,
            "Ctrl+Alt+K",
            &registrar,
        );

        assert_eq!(hotkeys, Ok(both("Ctrl+Alt+K", "Ctrl+Shift+Cmd+T")));
        assert_eq!(
            registrar.calls(),
            vec!["unregister Ctrl+Shift+Cmd+J", "register note Ctrl+Alt+K"]
        );
    }

    #[test]
    fn remapping_one_hotkey_leaves_the_other_exactly_as_it_was() {
        let registrar = FakeRegistrar::accepting_everything();

        let hotkeys = remap(
            &both("Ctrl+Shift+Cmd+J", "Ctrl+Shift+Cmd+T"),
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
            &both("Ctrl+Shift+Cmd+J", "Ctrl+Shift+Cmd+T"),
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
        let hotkeys = both("Ctrl+Shift+Cmd+J", "Ctrl+Shift+Cmd+T");

        let refused = remap(
            &hotkeys,
            HotkeyAction::Task,
            "Ctrl+Shift+Cmd+J",
            &registrar,
        );

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
        };

        let refused = remap(
            &hotkeys,
            HotkeyAction::Task,
            "Ctrl+Shift+Cmd+J",
            &registrar,
        );

        assert_eq!(refused, Err("it is already the Note Hotkey".to_string()));
        assert!(registrar.calls().is_empty());
    }

    #[test]
    fn remapping_to_the_combination_already_in_force_touches_nothing() {
        let registrar = FakeRegistrar::accepting_everything();

        let hotkeys = remap(
            &both("Ctrl+Shift+Cmd+J", "Ctrl+Shift+Cmd+T"),
            HotkeyAction::Note,
            "Ctrl+Shift+Cmd+J",
            &registrar,
        );

        assert_eq!(hotkeys, Ok(both("Ctrl+Shift+Cmd+J", "Ctrl+Shift+Cmd+T")));
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
        };

        let next = remap(&hotkeys, HotkeyAction::Task, "Ctrl+Shift+Cmd+T", &registrar).unwrap();

        assert_eq!(next.task, registered("Ctrl+Shift+Cmd+T"));
    }

    #[test]
    fn an_empty_hotkey_is_refused_without_giving_up_the_working_one() {
        let registrar = FakeRegistrar::accepting_everything();

        let refused = remap(
            &both("Ctrl+Shift+Cmd+J", "Ctrl+Shift+Cmd+T"),
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
    fn a_first_run_settles_on_the_pair_the_app_ships_with() {
        assert_eq!(
            settle(None, None, false),
            (Some(DEFAULT_NOTE_HOTKEY), Some(DEFAULT_TASK_HOTKEY))
        );
    }

    #[test]
    fn an_installation_predating_tasks_keeps_the_note_hotkey_it_has_been_using() {
        assert_eq!(
            settle(None, None, true),
            (Some(LEGACY_NOTE_HOTKEY), Some(DEFAULT_TASK_HOTKEY))
        );
    }

    #[test]
    fn a_combination_the_user_chose_is_never_written_over() {
        assert_eq!(settle(Some("Ctrl+Alt+K"), None, true).0, None);
        assert_eq!(settle(Some("Ctrl+Alt+K"), None, false).0, None);
        assert_eq!(settle(None, Some("Ctrl+Alt+L"), true).1, None);
    }

    #[test]
    fn settling_twice_writes_nothing_the_second_time() {
        let (note, task) = settle(None, None, true);
        assert_eq!(settle(note, task, true), (None, None));
    }

    #[test]
    fn the_defaults_avoid_the_voiceover_family_and_differ_from_each_other() {
        assert_ne!(DEFAULT_NOTE_HOTKEY, DEFAULT_TASK_HOTKEY);
        assert!(!DEFAULT_NOTE_HOTKEY.contains("Alt"));
        assert!(!DEFAULT_TASK_HOTKEY.contains("Alt"));
        assert_eq!(LEGACY_NOTE_HOTKEY, "Ctrl+Alt+Cmd+J");
    }
}
