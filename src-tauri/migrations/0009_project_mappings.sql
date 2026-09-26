-- A Project Mapping: the Project one repository's Observed Notes arrive filed
-- under. A mapping is a value on the mapping, naming a Project exactly as a
-- Note names one — lowercase, the same letters, digits, `_` and `-` — so
-- ADR 0007 survives intact: a Project still exists only as a value, and this
-- table is not a registry of Projects. It is one row per repository, keyed on
-- the repository's identity (its common directory, which every worktree of it
-- shares) rather than on the directory the user picked: worktrees put one
-- project in many directories, and the filing has to be one.
--
-- A repository with no row is Unfiled, which is why `project` is NOT NULL
-- here: Unfiled is the absence of a mapping, not a mapping to nothing. The
-- table lives in the journal rather than in the settings store because a
-- mapping decides the filing of Notes, and a Backup has to carry it — see
-- `expected_schema` in src-tauri/src/backup.rs.
CREATE TABLE project_mappings (
    -- The repository's identity: its common directory, as the commit reader
    -- answered when it was added to the Observing list.
    repository TEXT PRIMARY KEY NOT NULL,
    -- The Project its Observed Notes are filed under. The Note's own rule:
    -- identity is case-insensitive and stored lowercase.
    project TEXT NOT NULL
        CHECK (
            length(project) > 0
            AND project = lower(project)
            AND project NOT GLOB '*[^a-z0-9_-]*'
        )
);
