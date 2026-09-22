-- An Observed Note is a third origin: work the user did, recorded without a
-- Capture or a calendar Import. Migration 0001's "no source column" describes
-- voice capture and remains immutable; provenance belongs to the Note now.
-- SQLite cannot replace the CHECK constraint in place, so rebuild notes while
-- keeping the existing column order and appending the two provenance columns.
CREATE TABLE notes_new (
    id TEXT PRIMARY KEY NOT NULL,
    body TEXT NOT NULL CHECK (length(trim(body)) > 0),
    captured_at TEXT NOT NULL,
    journal_day TEXT NOT NULL,
    edited_at TEXT,
    project TEXT
        CHECK (
            project IS NULL
            OR (
                length(project) > 0
                AND project = lower(project)
                AND project NOT GLOB '*[^a-z0-9_-]*'
            )
        ),
    origin TEXT NOT NULL DEFAULT 'capture'
        CHECK (origin IN ('capture', 'import', 'observe')),
    source TEXT,
    source_key TEXT,
    CHECK (
        (source IS NULL AND source_key IS NULL)
        OR (source IS NOT NULL AND source_key IS NOT NULL)
    ),
    CHECK (origin != 'capture' OR source IS NULL),
    CHECK (origin != 'observe' OR source IS NOT NULL)
);

INSERT INTO notes_new (
    id, body, captured_at, journal_day, edited_at, project, origin, source, source_key
)
SELECT id, body, captured_at, journal_day, edited_at, project, origin, NULL, NULL
FROM notes;

DROP TABLE notes;
ALTER TABLE notes_new RENAME TO notes;

CREATE INDEX notes_journal_day ON notes (journal_day);
CREATE INDEX notes_project ON notes (project);

-- Import's handled rows already refuse the same meeting after its Note is
-- removed. Keep that history under a source-qualified identity so it can sit
-- beside other event sources without collisions.
CREATE TABLE handled_events (
    source TEXT NOT NULL,
    event_key TEXT NOT NULL,
    handled_at TEXT NOT NULL,
    PRIMARY KEY (source, event_key)
);

INSERT INTO handled_events (source, event_key, handled_at)
SELECT 'calendar', event_key, handled_at
FROM imported_meetings;

DROP TABLE imported_meetings;
