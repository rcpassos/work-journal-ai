-- A Note now comes into existence one of exactly three ways: a Capture, an
-- Import or an Observe — see docs/adr/0010-notes-have-two-origins.md — and a
-- Note records where it came from. This amends 0001's "no source column"
-- comment, which was written about voice capture: `source` and `source_key`
-- are provenance like `captured_at` — written with the Note, never changed by
-- an edit or a refile, read only by History's hover — and they are null for a
-- Captured Note and for an Imported Note written before this migration. They
-- are not a replacement for the handled-events table below: deletion still
-- has to be remembered after the Note is gone, which is the table's whole
-- reason to exist. 0001 itself is never edited, because an applied migration
-- is immutable (docs/adr/0009-applied-migrations-are-immutable.md), so the
-- amendment lives here.
--
-- SQLite cannot change CHECK (origin IN ('capture', 'import')) from
-- migration 0003 in place, so `notes` is rebuilt: created fresh holding the
-- same columns in the same order — with `source` and `source_key` appended
-- after `origin`, because a version's columns are a prefix of the next
-- version's, which `expected_schema` in src-tauri/src/backup.rs relies on —
-- then the rows are copied, the old table is dropped, the new one is renamed
-- into place, and its two indexes are recreated.
CREATE TABLE notes_rebuilt (
    -- Application-generated, so a Note has an identity before it is stored.
    id TEXT PRIMARY KEY NOT NULL,
    -- One line, never empty or whitespace-only.
    body TEXT NOT NULL CHECK (length(trim(body)) > 0),
    -- The instant the Note is about: UTC ISO-8601, never updated. For an
    -- Observed Note, the instant the work happened — never the instant a
    -- sweep found it.
    captured_at TEXT NOT NULL,
    -- YYYY-MM-DD. Decided when the Note comes into existence from Captured
    -- At, and never recomputed, so it survives a timezone change.
    journal_day TEXT NOT NULL,
    -- Null until the Body or the Journal Day is changed after capture.
    edited_at TEXT,
    -- NULL is Unfiled; identity is case-insensitive and stored lowercase.
    project TEXT
        CHECK (
            project IS NULL
            OR (
                length(project) > 0
                AND project = lower(project)
                AND project NOT GLOB '*[^a-z0-9_-]*'
            )
        ),
    -- The origin the Note came into existence by. `observe` is the third
    -- value; anything else is refused, so a Note never passes as typed when
    -- it was not.
    origin TEXT NOT NULL DEFAULT 'capture'
        CHECK (origin IN ('capture', 'import', 'observe')),
    -- Where a Note nobody typed came from, and its identity within that
    -- source: the same pair handled_events keys on. Written with the Note
    -- and never changed — provenance like captured_at. Null together: a
    -- Note with a source always carries its key, or it could never be told
    -- from another event of the same source.
    source TEXT,
    source_key TEXT,
    CHECK ((source IS NULL) = (source_key IS NULL))
);

INSERT INTO notes_rebuilt (
    id, body, captured_at, journal_day, edited_at, project, origin
)
    SELECT id, body, captured_at, journal_day, edited_at, project, origin
    FROM notes;

DROP TABLE notes;
ALTER TABLE notes_rebuilt RENAME TO notes;

-- Journal Day is the only column ever filtered on.
CREATE INDEX notes_journal_day ON notes (journal_day);

CREATE INDEX notes_project ON notes (project);

-- Which source events have already been handled, remembered separately from
-- the Notes on purpose: deleting a Note is how the user refuses its event
-- for good, and an id kept on the Note would be destroyed by the very
-- deletion that has to be remembered. imported_meetings' exact shape and
-- exact reason — a row is written before the Note the event becomes, and is
-- never removed — now keyed on source and event key together, so two sources
-- can never collide. The old table's rows come across as source 'import'.
CREATE TABLE handled_events (
    -- Which source produced the event, e.g. the calendar or a repository.
    source TEXT NOT NULL,
    -- One occurrence of one source event within its source.
    event_key TEXT NOT NULL,
    -- When the sweep handled it. Never read by the app; it is here so a human
    -- reading the file can tell when a refusal was recorded.
    handled_at TEXT NOT NULL,
    PRIMARY KEY (source, event_key)
);

INSERT INTO handled_events (source, event_key, handled_at)
    SELECT 'import', event_key, handled_at
    FROM imported_meetings;

DROP TABLE imported_meetings;
