-- Where the latest completion took this Task from, kept only so that an
-- immediate Undo can put it back exactly there. NULL when the completion
-- removed no selection, and cleared by reopening or by the Undo that consumes
-- it, so a later reopening never reclaims a priority on its own.
ALTER TABLE tasks ADD COLUMN previous_daily_position INTEGER;
