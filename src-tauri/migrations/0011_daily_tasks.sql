-- Membership is explicit: an upgrade starts with no selected Tasks.
-- The sequence orders appends independently of scheduling and creation time.
CREATE TABLE daily_tasks (
    position INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE
);
