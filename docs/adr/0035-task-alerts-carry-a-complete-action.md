# Task Alerts carry a Complete action

Supersedes the deferral in [ADR 0017](0017-the-os-schedules-task-alerts.md), which shipped Alerts that only open their Task: a Task Alert now also offers Complete as its one and only notification action, while the default click still opens the Task. One action is the whole design — it sits inside every action limit Apple states and keeps the banner a single button rather than a menu, which is what the research in `docs/notification-actions.md` found and the timing measurement confirmed worth building. Snooze remains explicitly deferred.

The delivered notification carries the Alert's identifier plus the exact Scheduled For date and time it represented: the pending request keeps the Task's own identifier, so reconciliation replacement and cancellation behave exactly as before, and the slot travels in the notification content's `userInfo`, never interpolated into an identifier. Choosing Complete never trusts the banner. The resident Task Alerts session completes through the guarded core operation, which proceeds only if the journal still holds that Task Open at that exact slot. Otherwise the action is stale: it performs no mutation and opens Tasks View focused on the Task for review — or does nothing further when the Task is gone.

For a Recurring Task, a successful Complete uses the existing atomic complete-and-advance transaction, so an older banner can never complete the successor occurrence. The same response arriving twice — written down for a cold launch and announced to a window already listening — is processed once. The action carries no foreground option, so choosing it never brings the app forward: a success opens nothing, and anything else — a stale Task, or a completion that failed — opens Tasks View on it for review.

## Completion guards survive concurrent writes

A read before completion is not enough: another window can reschedule, complete or delete the commitment before the write. Completion therefore compares the Task state it read inside the mutation's transaction: still Open, with the same schedule, recurrence rule, anchor, description and details. For a series, the specific Open occurrence read must also still be Open at that slot. Keeping the occurrence, opening its successor and moving the Task head commit together; a miss at any step writes nothing.

The storage contract supports this with optional `SqlStatement.expectedRows`. `SqlDriver.transaction` checks each statement's affected-row count against that exact expectation, including zero when specified, and rolls the whole transaction back on a mismatch. Rust's `journal_transaction` returns the distinct `journal transaction guard missed` rejection, which the Desktop driver translates into `TransactionGuardMiss`; the SQLite test driver follows the same contract. Other storage errors retain their existing failure behavior.

`completeTaskAt` never retries a guard miss: it answers `stale` with a freshly read Task, or null after deletion. The checkbox's `completeTask` means the Task rather than one delivered slot, so it re-reads and retries up to three completion attempts. If another window has completed the Task, it returns that Task unchanged; if all attempts miss while the Task remains Open, it reports the guard miss. Undo Completion retains its existing behavior.

## Considered options

- **Interpolating the slot into the request identifier** (`task:ID:DATE:TIME`), so staleness falls out of identifier mismatch. Rejected: the identifier is what makes re-registering replace rather than duplicate, and a Recurring Task advancing would orphan its own request.
- **Trusting the notification and completing without rechecking the journal.** Rejected outright: a banner delivered Monday and acted on Wednesday would silently complete Wednesday's occurrence. The database stays authoritative across the non-atomic OS boundary, as ADR 0017 already requires.
- **A foreground action that opens the app to complete.** Rejected: a success would open a window the user never asked for, and a cold launch through the action would race the session reading the same handoff.
- **Processing the action in Tasks View instead of the resident session.** Rejected: the view may not exist — the app is a menu bar glyph until a window opens — while the Capture window lives as long as the app, which is why reconciliation already lives there.
- **Snooze beside Complete.** Rejected for now, as in ADR 0017: any future Snooze must decide whether it mutates Scheduled For or adds a separate durable delivery override, never unmanaged OS-only state that reconciliation overwrites.

## Consequences

- **ADR 0017 still holds except for its deferral.** Scheduling, reconciliation, permission policy and banner presentation are unchanged; only "Alerts only open the relevant Task" is superseded by this record.
- **`objc2-user-notifications` gains two feature flags** (`UNNotificationAction`, `UNNotificationCategory`) on its existing pin. Features only: no version change, no new dependency.
- **Response classification is a pure function** of the action identifier and the `userInfo` payload, outside the macOS-only delegate, so it is unit-tested on any platform. Anything that is not a Complete with a whole slot behind it opens the Task, so a malformed action degrades to the old click rather than vanishing.
- **A default click behaves exactly as before**: same routing to the Main Window, same handoff, same focus. The Complete response travels its own event to the Capture window and never touches that path.
