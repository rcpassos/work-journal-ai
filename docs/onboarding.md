# Onboarding

Confirmed design for [issue #174](https://github.com/rcpassos/work-journal-ai/issues/174). All identified design questions are settled, and the user confirmed shared understanding on 2026-09-05. The design interview is complete; implementation is a separate task.

## Purpose and audience

Introduce capturing a Note and finding it again, then offer optional setup. Notes and Tasks already work without integrations. Skipping integrations counts as successful onboarding.

Show onboarding automatically for new installations only. Existing users retain their normal startup experience. Everyone can open onboarding manually from Settings.

A pre-existing journal or saved settings counts as an existing installation, including after reinstalling. A surviving API Key alone does not suppress onboarding. Determine this before startup creates a database or writes defaults. Persist unfinished onboarding separately so a crash does not cause the next launch to misclassify it as an existing installation.

## Experience

Use a temporary guided flow inside the Main Window. Finishing lands in History.

Explain the Note Hotkey, the Tray Menu fallback, and History. Show current shortcuts without requiring customization. Offer an optional “Try it” action; do not require a Note or insert sample data.

“Try it” opens the real Capture window. A saved Note becomes part of the journal. Saving or cancelling returns focus to onboarding; cancellation returns to the introduction. After saving, offer “View your note” and “Continue setup.” Viewing the Note opens History on its Journal Day with Project = Any and dismisses onboarding under the navigation-away rule.

Offer Start at Login, Meeting Import, and Model Access, each skippable. This replaces the existing first-run Start at Login question. Theme customization stays in Settings. Task Alert permission remains tied to saving the first timed Task.

The step order is Introduction and optional practice → Start at Login → Meeting Import → Model Access → Finish in History. Include Back, per-step Skip, and a clearly separate “Skip onboarding” action. The final action is “Open History”; there is no extra completion screen.

## Saving and leaving

Save each successful configuration immediately. Explicitly skipping or closing dismisses automatic onboarding permanently; the user can reopen it from Settings. A crash before dismissal or completion causes onboarding to be offered again, retaining saved choices.

Explicit Quit and navigation away also dismiss automatic onboarding. “Try it” remains part of onboarding and does not dismiss it. Crash recovery starts at the introduction with saved choices intact rather than remembering the exact step.

Manual replay starts at the introduction and shows current saved values and status. It never resets settings or automatically repeats permission prompts.

## Optional setup failures

Explain what remains unavailable, offer retry, and always allow continuation. Preserve successful changes and distinguish configured, skipped, and needs-attention states.

Saving Model Access does not automatically send a request or claim verified connectivity. Explain that connectivity has not been verified; the first explicitly requested Work Summary exercises it. A dedicated connection test is outside this issue.

## Implementation constraints found in the existing code

- SQL preload creates the database before the current first-run check. Installation classification must precede that creation and automatic settings writes; the existing pre-SQL restore startup seam provides an ordering reference.
- Hotkey migration currently uses nonempty settings as evidence of an existing installation. An onboarding marker must not accidentally change fresh-installation shortcut defaults; preserve the evidence gathered before writing it.
- Unfinished onboarding must take precedence over the journal and settings created by its own first launch. Replaying dismissed onboarding manually must not re-enable automatic onboarding.
- Capture normally restores focus to an external app. Returning to onboarding requires a return destination scoped to practice.
- Opening History to view the practice Note must explicitly choose its Journal Day and Project = Any, because manual replay may begin with an unrelated Filter.
- Optional setup retains the existing permission and storage contracts. Calendar permission alone imports nothing without selected calendars; Model Access retains Keychain storage for its API Key.

## Acceptance scenarios

- A fresh installation receives onboarding; an existing journal or saved settings suppresses automatic onboarding, including after reinstalling. An API Key alone does not suppress it.
- A user can finish without creating a Note or configuring any optional feature.
- Practice saves only a user-submitted real Note, returns focus to onboarding, and can reveal that Note in History regardless of the previous Filter.
- Back and per-step Skip keep onboarding open. Finish, Skip onboarding, Close, explicit Quit, and navigation away dismiss future automatic presentation while retaining saved changes.
- A crash during unfinished automatic onboarding causes it to start at the introduction next launch, retaining saved settings.
- Manual replay shows current settings without resets, automatic permission prompts, or re-enabling automatic presentation.
- Optional setup failure explains the unavailable capability, supports retry, and permits continuation without undoing successful changes.
- Model Access setup sends no automatic model request and does not claim verified connectivity.
- The old standalone first-run login question does not compete with onboarding, and Task Alert permission remains tied to the first timed Task save.
- Finishing opens History; fresh shortcut defaults and existing assignments remain correct.
