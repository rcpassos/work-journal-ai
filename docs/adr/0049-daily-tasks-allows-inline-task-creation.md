# Daily Tasks allows inline Task Creation

Daily Tasks accepts a Task Description inline: Enter creates an Unscheduled Task at the bottom and leaves the field ready for the next description, while details and scheduling remain available through the Task Editor. Ad hoc work arrives throughout the day, so adding several commitments should keep the user in the working list rather than repeatedly opening and dismissing the resident Task Creation window.

This revisits the single creation surface in [ADR 0022](0022-one-main-window-for-reading-and-settings.md): the resident window remains available through the existing entry points, retaining [ADR 0019](0019-task-creation-has-its-own-resident-window.md)'s immediate global entry and independent unfinished text. The accepted cost is a second creation surface in exchange for uninterrupted work inside Daily Tasks.

The resident window offers an initially unchecked Add to Daily Tasks checkbox. Inline creation always adds to Daily Tasks; creation through the resident window adds only when that choice is checked, so future commitments can be captured without entering the working list.
