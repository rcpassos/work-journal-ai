## Problem Statement

New users can capture Notes and manage Tasks immediately, but the app does not guide them through finding those capabilities or configuring optional features. First launch currently asks only about Start at Login. Users need to understand how to capture a Note and find it again, and which setup choices unlock Meeting Import and Model Access, without mistaking optional configuration for a prerequisite to using the journal.

## Solution

Offer a short, skippable Onboarding flow inside the Main Window on a fresh installation. Introduce Capture and History, offer optional practice using the real Capture window, then guide users through Start at Login, Meeting Import, and Model Access. End in History. Preserve successful changes immediately and allow continuation through optional setup failures.

Existing installations keep their normal startup experience. Everyone can replay Onboarding from Settings using their current configuration. Deliberate departure dismisses automatic Onboarding; a crash during unfinished automatic Onboarding offers it again from the introduction with saved choices intact.

## User Stories

1. As a new user, I want an introduction on first launch, so that I know how to begin using the journal.
2. As an existing user, I want updates to preserve my normal startup experience, so that a new introduction does not interrupt established work.
3. As a returning user reinstalling with a retained journal or saved settings, I want to be recognized as an existing user, so that reinstalling does not restart automatic Onboarding.
4. As a new user with only a surviving API Key, I want the introduction to remain available automatically, so that a retained secret does not hide guidance.
5. As a user, I want to reopen Onboarding from Settings, so that I can revisit the introduction and optional setup later.
6. As a new user, I want to understand that Notes and Tasks work without integrations, so that I can start without calendar or model setup.
7. As a new user, I want to see my current Note and Task Hotkeys, so that I learn the shortcuts that actually apply to my installation.
8. As a new user, I want to learn the Tray Menu fallback, so that I can capture a Note when a Hotkey is unavailable.
9. As a new user, I want to learn where History lives, so that I can recover what I captured.
10. As a new user, I want optional practice, so that I can try Capture without being forced to write a Note.
11. As a practicing user, I want my submitted Note to be a real journal record, so that practice demonstrates the actual product.
12. As a practicing user, I want cancellation to create nothing and return to the introduction, so that trying Capture is safe to abandon.
13. As a practicing user, I want focus to return to Onboarding after saving or cancelling, so that I can continue the introduction.
14. As a practicing user who saved a Note, I want to choose between viewing it and continuing setup, so that I control my next step.
15. As a user viewing my practice Note, I want History to show its Journal Day with Project = Any, so that an earlier Filter cannot hide it.
16. As a user, I want optional Start at Login setup, so that the app launches at login only when I choose it.
17. As a new user, I want one Start at Login invitation within Onboarding, so that a separate first-run question does not compete with the flow.
18. As a user, I want optional Meeting Import setup to explain permission and calendar selection, so that I choose which calendars contribute Notes.
19. As a user who refuses calendar permission or selects no calendars, I want to understand why Import is unavailable, so that I can decide whether to retry or continue.
20. As a user, I want optional Model Access setup, so that I can configure the endpoint, model, and API Key used for a Work Summary.
21. As a user saving Model Access, I want no automatic model request, so that setup does not unexpectedly send content or incur a charge.
22. As a user saving Model Access, I want to know that connectivity remains unverified, so that saved configuration is not mistaken for a working endpoint.
23. As a user, I want optional features clearly distinguished as configured, skipped, or needing attention, so that I understand what is available.
24. As a user encountering setup failure, I want an explanation and retry while retaining the option to continue, so that an optional service cannot block the journal.
25. As a user, I want each successful configuration saved immediately, so that leaving later does not undo my choices.
26. As a user, I want Back and per-step Skip, so that I can review or omit setup without leaving Onboarding.
27. As a user, I want a separate Skip onboarding action, so that I can dismiss the entire introduction deliberately.
28. As a user closing Onboarding, quitting the app, or navigating away, I want automatic Onboarding dismissed, so that it does not keep asking after I leave.
29. As a user whose app crashed during unfinished automatic Onboarding, I want the introduction offered again with saved choices retained, so that an interruption does not silently lose guidance or configuration.
30. As a user replaying Onboarding, I want current saved values and status without resets or automatic permission prompts, so that revisiting guidance preserves my decisions.
31. As a user replaying dismissed Onboarding, I want future launches to remain normal, so that manual replay does not re-enable automatic presentation.
32. As a user finishing Onboarding, I want Open History to take me directly to History, so that I can use the journal without an extra completion screen.
33. As a user skipping all setup and practice, I want to finish successfully, so that optional features remain optional.
34. As a user, I want Task Alert permission requested when I first save a timed Task, so that the request has a clear purpose.
35. As an existing user, I want my Hotkey assignments preserved, so that adding Onboarding does not change how I capture Notes or create Tasks.

## Implementation Decisions

- Extend the Main Window composition with a temporary guided Onboarding flow and an entry from Settings. Reuse the existing Settings capabilities, Capture window, journal operations, and desktop boundary rather than introducing parallel implementations.
- Sequence the flow as introduction and optional practice, Start at Login, Meeting Import, Model Access, then History. Provide Back, per-step Skip, and a distinct Skip onboarding action. The final action is Open History; do not add a completion screen.
- Keep control state in the view. A session abstraction is justified only by actual sequencing, consistent with the existing architectural rule; do not create a second settings state owner.
- Replace the standalone first-run Start at Login invitation with the optional Onboarding step. Preserve the existing permission, validation, secret storage, and immediate-save contracts of the underlying settings.
- Persist whether automatic Onboarding remains unfinished or has been dismissed/completed. Absence of this state triggers installation classification once. Existing unfinished state takes precedence over the database and settings produced during its own first launch. Manual replay must not reset a dismissed state.
- Classify a pre-existing journal or saved settings as an existing installation, including after reinstalling. A surviving API Key alone is insufficient. Capture the evidence before SQL preload creates the journal and before default settings are written. Record fresh unfinished state before those side effects can make an interrupted fresh installation appear existing.
- Preserve the installation evidence used by Hotkey migration. Adding an Onboarding setting must not cause fresh installations to receive legacy shortcut defaults or alter existing assignments.
- Finish, Skip onboarding, closing, explicit Quit, and navigation away dismiss automatic presentation. Back, per-step Skip, and opening practice do not. A crash during unfinished automatic Onboarding restarts at the introduction with saved choices, without persisting the exact step.
- Manual replay starts at the introduction, reflects current values and status, and never resets configuration or automatically repeats permission requests.
- Try it raises the real resident Capture window through the desktop boundary. Scope its return destination to Onboarding so saving and cancellation restore Main Window focus without changing normal Capture behavior elsewhere.
- A submitted practice Note is an ordinary Captured Note. Cancellation creates no record. After saving, offer View your note and Continue setup. Viewing opens History on that Note's Journal Day with Project = Any and dismisses Onboarding as navigation away.
- Explain optional setup failures, allow retry and continuation, and preserve successful changes. Distinguish configured, skipped, and needs-attention states without claiming that saved Model Access proves connectivity.
- Calendar access is requested through the existing explicit enablement path; selected calendars are still required for Import. Task Alert permission remains tied to the first timed Task save. The API Key remains in the operating system's Keychain.
- Save Model Access without an automatic request. Explain that it has not been connectivity-tested; the first explicitly requested Work Summary exercises it.
- Display current shortcuts without requiring remapping. Theme customization remains in Settings. No changes to Note or Task record schemas are required by this design; Onboarding persistence belongs with application settings.

## Testing Decisions

Use the following testing seams, confirmed for publication with this specification.

- Prefer tests of visible behavior and durable outcomes: what users see, what their actions save, which destination opens, and what happens on the next launch. Avoid testing component internals, exact private state shapes, or source text as a substitute for execution.
- Use the existing rendered Main Window integration seam as the primary automated seam, backed by the existing fake desktop/settings boundary and real test journal. Extend this harness for Onboarding navigation, replay, immediate saves, optional setup failures, absent automatic model requests, and practice-to-History routing. Reuse existing Capture view tests for actual Note submission and cancellation rather than duplicating the entire Capture suite.
- Prior art is the Main Window suite that drives sections through accessible controls and desktop events, the Settings suite that exercises real controls over a fake desktop with controllable failures and delayed saves, and the Capture suite that verifies committed Notes and dismissal behavior.
- Add only the native lifecycle coverage that this view seam cannot establish. Exercise installation classification and durable Onboarding eligibility at the Rust startup/settings boundary with fresh, existing, unfinished, and dismissed fixtures. Prefer a single startup operation over tests for every helper. Cover detection before database/default creation, restart after interruption, and Hotkey default/assignment preservation. Existing Rust Hotkey tests provide prior art for compatibility cases.
- Validate native focus and process behavior in a targeted macOS smoke pass: Try it returns to the Main Window after save and cancel; ordinary Capture retains its usual return behavior; Close and explicit Quit suppress later automatic presentation; forced termination during unfinished automatic Onboarding causes it to be offered again. A fake desktop alone cannot prove macOS focus or startup ordering.
- Cover the full skip path, every deliberate departure, crash/relaunch with retained changes, replay with existing settings, practice Note visibility under a previously unrelated Filter, calendar refusal/no selection, failed configuration saves, and successful completion in History. Verify that the old login question does not appear alongside Onboarding and that timed Task permission behavior remains unchanged.

## Out of Scope

- Mandatory practice, generated sample Notes, or required integrations.
- Automatic Onboarding for existing installations, recurring prompts after dismissal, or replay that resets settings.
- A separate Onboarding window, a new Capture implementation, or an additional completion screen.
- Automatic model requests, a dedicated connection-test feature, or automatic Work Summary generation.
- Upfront Task Alert permission requests, required shortcut customization, or a theme setup step.
- Remembering the exact interrupted step, transactional rollback of previously saved settings, or changes to existing Note and Task domain behavior.

## Further Notes

This specification synthesizes the confirmed design interview for issue #174 and is ready for implementation. No application implementation is included in the specification task.

Implementation tickets: [first-launch Onboarding, replay, and Start at Login (#202)](https://github.com/rcpassos/work-journal-ai/issues/202), [practice Capture (#203)](https://github.com/rcpassos/work-journal-ai/issues/203), [Meeting Import setup (#204)](https://github.com/rcpassos/work-journal-ai/issues/204), and [Model Access setup (#205)](https://github.com/rcpassos/work-journal-ai/issues/205). Ticket #202 blocks the other three, which can proceed independently afterward.

The main implementation risks are startup ordering, accidental interaction between the persisted Onboarding marker and Hotkey migration, and focus restoration from practice. The current product already provides the relevant settings and Capture behavior; the feature should compose those capabilities with the smallest necessary lifecycle changes.
