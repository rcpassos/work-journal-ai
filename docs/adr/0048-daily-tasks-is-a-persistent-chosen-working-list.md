# Daily Tasks is a persistent chosen working list

Daily Tasks is a manually chosen subset of existing Open Tasks, with position expressing priority independently of Scheduled For. It persists across days and opens by default inside Tasks View, while the broader Task list remains accessible: the user's next work needs a deliberate order without turning a scheduling change or midnight into a new plan. Membership never creates a Task copy, and adding or removing an existing Task leaves its schedule unchanged; new additions go to the bottom to preserve the priorities already chosen.

Rejected: treating Daily Tasks as today's scheduled group, all Open Tasks, or a separate record type. These would respectively tie priorities to calendar rollover, force the entire backlog into the working list, or split one commitment across records.

## Membership and completion

Membership and order persist across days and app restarts. Scheduled Tasks never enter automatically when they become Today or Overdue; the broader list continues to expose those groups. Add existing opens a searchable picker of Open Tasks without leaving Daily Tasks, appends the selected Task, and excludes Tasks already in the working list so that each appears at most once. Removing a Task from Daily Tasks keeps it in the broader list.

Completed work leaves Daily Tasks immediately and retains its completion in the existing Completed view or recurring history. Immediate Undo restores its previous position; reopening an ordinary Completed Task later restores it only to the broader list, and adding it to Daily Tasks again is an explicit choice.

Completing a Recurring Task ends its current selection: the next Open Task Occurrence remains in the broader list until explicitly selected again, even if its date arrives. Immediate Undo restores the completed occurrence and its previous position, subject to the existing safe Undo Completion rules. Editing a selected Task's schedule, including rescheduling it to a future date, retains its selection and position and displays the updated schedule; editing does not imply removing work from the list.

## Reordering and navigation

Daily Tasks provides a drag handle, keyboard reordering, and Move to top and Move to bottom actions. A reordering changes only priority within Daily Tasks, never Scheduled For or the ordering of the broader list.

Opening a Task through Search or a Task Alert focuses it in Daily Tasks when it is selected there, otherwise in the appropriate broader list. Navigation never adds a Task to Daily Tasks. This refines the destinations defined by [ADR 0036](0036-search-is-one-term-and-its-destination-is-what-changes.md) and [ADR 0035](0035-task-alerts-carry-a-complete-action.md) without changing their Search or Task Alert actions.
