# Daily Tasks combines persistent chosen priorities with due work

Daily Tasks shows the Open Tasks the user has explicitly chosen, in their saved priority order, followed by other Open Tasks scheduled for Today or Overdue. It opens by default inside Tasks View, while every Open Task remains accessible in the broader list. Membership never creates a Task copy, and adding or removing a saved priority leaves its schedule unchanged. This revises the original manual-only decision in response to #360: scheduled commitments should be visible when due without displacing the user's chosen priorities.

Rejected: replacing chosen priorities with today's scheduled group, showing the entire backlog, or creating a separate record type. These would respectively discard manual priorities, force all Open work into the working list, or split one commitment across records.

## Membership and completion

Explicit selection and order persist across days and app restarts. Other Tasks enter automatically when the existing Open list's grouping rules classify them as Today or Overdue, including date-only schedules and timed commitments. Automatic work follows saved priorities, Overdue before Today, with the same order within each group as the Open list. A selected Task that is also due appears only in its saved position.

Add existing opens a searchable picker of Open Tasks without a saved priority, including automatically visible work, and appends the selected Task to the bottom of the saved priorities. Inline creation stays above the rows, even in an empty list; Enter still creates an Unscheduled Task at the bottom of the saved priorities and leaves the field ready for another.

Removing a saved priority leaves the Task in the broader list and, if it is still Today or Overdue, in the automatic section. The action says that it removes a priority. Automatic rows have no remove or reorder action: their visibility follows their schedule and completion, with no hidden exclusion state. Add existing can give one a persistent priority. Rescheduling automatic work to a future date or clearing its schedule takes it out of Daily Tasks; editing a selected Task retains its selection and position, even for a future or absent schedule. Local midnight, wake and regained focus refresh automatic eligibility without changing saved priorities.

Completed work leaves Daily Tasks immediately and retains its completion in the existing Completed view or recurring history. Immediate Undo of selected work restores its previous position. Reopening an ordinary Completed Task later does not restore its saved priority, but its schedule may make it automatically visible again.

Completing a Recurring Task ends its current selection. Its next Open Task Occurrence appears automatically only when Today or Overdue; it has no saved priority unless explicitly selected again. Immediate Undo restores the completed occurrence and its previous position where it had one, subject to the existing safe Undo Completion rules.

## Reordering and navigation

Saved priorities provide a drag handle, keyboard reordering, and Move to top and Move to bottom actions. Reordering changes only the order of explicitly selected Tasks, never Scheduled For, automatic ordering, or the broader list. Automatically visible Tasks are excluded from the saved-order concurrency check.

Opening a Task through Search or a Task Alert focuses it in Daily Tasks when selected or automatically visible there, otherwise in the appropriate broader list. Navigation never changes selection, priority order or schedules. This refines the destinations defined by [ADR 0036](0036-search-is-one-term-and-its-destination-is-what-changes.md) and [ADR 0035](0035-task-alerts-carry-a-complete-action.md) without changing their Search or Task Alert actions.
