//! Backup: a snapshot of the journal's SQLite file itself, so the journal is
//! never only as durable as the one file it lives in. What a Backup is, and
//! why `VACUUM INTO` and never a file copy, is
//! docs/adr/0032-a-backup-is-a-sqlite-snapshot-taken-with-vacuum-into.md;
//! restoring one is
//! docs/adr/0033-a-restore-replaces-the-journal-at-startup-and-keeps-a-rollback.md.
//!
//! Everything in this module is narrow and Tauri-free: filenames, due and
//! prune arithmetic, one snapshot through a `SqlitePool`, and the restore
//! side — validating a candidate read-only, staging it, and applying a staged
//! file at startup. The commands and the startup hook in `lib.rs` hand it
//! what it needs; nothing here reaches for the app.

use serde::Serialize;
use sqlx::{Connection, SqlitePool};
use crate::export::free_path;
use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// How long a snapshot waits before the next one is worth taking. A constant,
/// not a setting: the journal is tens of kilobytes, so the interval costs
/// nothing and asks nothing of the user.
pub const SNAPSHOT_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);

/// How many snapshots are kept. Oldest pruned past this, and nothing else in
/// the directory is ever touched.
pub const RETAINED_SNAPSHOTS: usize = 30;

/// The stem every snapshot is named with, and the only name pruning will
/// touch. An unrelated file in the backups directory parses as nothing and is
/// left exactly where it is.
const FILE_STEM: &str = "work-journal";

/// The extension a snapshot carries: a backup is a SQLite file, not a
/// document.
const FILE_EXTENSION: &str = "db";

/// The live journal's file name, named once here. `DATABASE_URL` in `lib.rs`
/// is `sqlite:` plus this, and every restore path below is built from it, so
/// the database path is named in exactly one place.
pub const DATABASE_FILE_NAME: &str = "work-journal.db";

/// The newest `_sqlx_migrations` version this build understands. An older
/// snapshot is accepted and migrated forward by the immutable list; a newer
/// one is refused before anything is touched. Every future migration raises
/// this.
pub const SUPPORTED_MIGRATION_VERSION: i64 = 8;

/// The staged file a validated candidate is copied to, beside the live
/// journal. Not a snapshot name, so pruning never touches it, and never
/// opened by plugin-sql — it becomes the live journal only when the startup
/// hook renames it into place.
const STAGED_FILE_NAME: &str = "work-journal-restore-staged.db";

/// The stem a rollback file carries: `work-journal-rollback-` plus the
/// instant in UTC, second-precise, plus `.db`. Beside the live journal, never
/// deleted by the app, and openable in `sqlite3` directly.
const ROLLBACK_STEM: &str = "work-journal-rollback";

/// What Settings says about the automatic backups: how many there are, and
/// when the newest was taken. Null when there are none — a first run, or a
/// directory the user emptied.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomaticBackups {
    pub count: u32,
    /// The instant the newest snapshot was taken, as epoch seconds, or null.
    pub newest_taken_at: Option<i64>,
}

/// The filename a snapshot of `instant` carries: `work-journal-` plus the
/// instant in UTC, second-precise, plus `.db` —
/// `work-journal-20260903T084500.db`. UTC rather than local, so the name is
/// stable against timezone changes and sorts with its own instant.
pub fn snapshot_file_name(instant: SystemTime) -> String {
    let seconds = instant
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0);
    format!("{FILE_STEM}-{}.{FILE_EXTENSION}", timestamp(seconds))
}

/// Reads a snapshot's instant back out of its name, and nothing else: a file
/// that is not a snapshot's name — including a neighbour's export, or a
/// snapshot renamed by hand — is not one, and pruning never touches it.
pub fn snapshot_instant(file_name: &str) -> Option<SystemTime> {
    let (stem, extension) = split_extension(file_name)?;
    if extension != FILE_EXTENSION {
        return None;
    }

    let stamped = stem.strip_prefix(FILE_STEM)?;
    let stamped = stamped.strip_prefix('-')?;
    let seconds = parse_timestamp(stamped)?;
    Some(UNIX_EPOCH + Duration::from_secs(seconds))
}

/// The name a destination from the save dialog is reined back to: the chosen
/// name only, refusing anything that is a path — the dialog already asked
/// where, and this side never climbs a directory tree it was handed. A
/// destination that would clobber a directory rather than a file is not a
/// plain file name either.
pub fn plain_destination(destination: &str) -> Option<String> {
    let candidate = Path::new(destination);
    if candidate.file_name() == Some(candidate.as_os_str()) && !destination.trim().is_empty() {
        return Some(candidate.to_string_lossy().into_owned());
    }
    None
}

/// Where a manual backup actually goes. The save dialog owns the overwrite
/// question — it shows "Replace?" and the user answers it — so by the time a
/// destination arrives here, any collision it names has been confirmed.
/// Rather than answer it again with a refusal, the name is settled to the
/// first free sibling (`…-2.db`, `-3.db`, …) exactly as export does, and
/// nothing that was on disk is ever replaced, renamed or deleted by a backup.
/// The snapshot must not care where it landed: the toast reports the settled
/// path, which is why `BackupResult` carries it back.
pub fn settle_destination(directory: &Path, file_name: &str) -> io::Result<PathBuf> {
    let plain =
        plain_destination(file_name).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("not a plain file name: {file_name}"),
            )
        })?;
    free_path(directory, Path::new(&plain))
}

/// The whole automatic pass: whether a snapshot is due given what is already
/// in `directory`, and — once one has been taken — which files to prune.
/// Split rather than one function so a caller that took no snapshot prunes
/// nothing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Automatic {
    /// Whether the interval has passed since the newest snapshot, or there
    /// are none yet: take one.
    pub due: bool,
    /// What the directory holds after the pass: count and newest instant,
    /// for Settings to say.
    pub status: AutomaticBackups,
}

/// Decides, from the directory's listing and a clock, whether a snapshot is
/// due and what the automatic backups look like right now. Unrelated files
/// are invisible to this: they are not snapshots, so they neither delay one
/// nor count as one.
pub fn automatic(directory: &Path, now: SystemTime) -> Automatic {
    let snapshots = listed_snapshots(directory);
    let status = status_of(&snapshots);

    let due = match snapshots.first() {
        Some(newest) => match newest.instant {
            Some(taken) => now
                .duration_since(taken)
                .is_ok_and(|age| age >= SNAPSHOT_INTERVAL),
            // A snapshot whose name cannot be read is a snapshot gone wrong;
            // taking a fresh one over it is the recovery.
            None => true,
        },
        None => true,
    };

    Automatic { due, status }
}

/// Which snapshots to prune once a new one is safely on disk: all but the
/// newest N, oldest first. Only files that parse as snapshots are ever
/// returned, so an unrelated file in the directory is left alone.
pub fn prunable(directory: &Path) -> Vec<PathBuf> {
    // Counted by what is a snapshot, not by what is in the directory: the
    // limit is on backups, and a neighbour that is not one is outside the
    // arithmetic entirely.
    let snapshots: Vec<Listed> = listed_snapshots(directory)
        .into_iter()
        .filter(|listed| listed.instant.is_some())
        .collect();
    if snapshots.len() <= RETAINED_SNAPSHOTS {
        return Vec::new();
    }

    // `listed_snapshots` is newest first, so skipping keeps the newest N and
    // offers the oldest beyond them. Reversed to oldest first, so pruning
    // walks down from the edge of retention.
    let mut pruned: Vec<PathBuf> = snapshots
        .into_iter()
        .skip(RETAINED_SNAPSHOTS)
        .filter_map(|snapshot| snapshot.path)
        .collect();
    pruned.reverse();
    pruned
}

/// Takes a snapshot of `source` into `destination` through the pool the
/// journal is already served from — one statement, no second connection.
///
/// The destination is bound, never interpolated: `VACUUM INTO ?`. A snapshot
/// opens, passes `quick_check`, and carries every journal table including
/// `_sqlx_migrations`, whether the source runs WAL or rollback-journal.
pub async fn take_snapshot(destination: &Path, pool: &SqlitePool) -> Result<(), String> {
    let destination = destination.to_string_lossy().into_owned();
    sqlx::query("VACUUM INTO ?")
        .bind(destination)
        .execute(pool)
        .await
        .map_err(|error| format!("the snapshot could not be written: {error}"))?;
    Ok(())
}

/// The live journal plugin-sql opens, resolved from the config directory it
/// resolves every relative `sqlite:` URL into. Named from
/// `DATABASE_FILE_NAME`, so the database path is named once.
pub fn live_database_path(config_dir: &Path) -> PathBuf {
    config_dir.join(DATABASE_FILE_NAME)
}

/// Where a validated candidate waits for the next launch, beside the live
/// journal.
pub fn staged_restore_path(config_dir: &Path) -> PathBuf {
    config_dir.join(STAGED_FILE_NAME)
}

/// The temp sibling a stage copies through, beside the staged path. The same
/// directory, so the final rename is atomic — a partial file can never occupy
/// the staged path. Not a snapshot name, so pruning never touches it, and
/// never opened by plugin-sql.
fn staged_temp_path(staged: &Path) -> PathBuf {
    PathBuf::from(format!("{}.tmp", staged.display()))
}

/// The filename a rollback of `instant` carries:
/// `work-journal-rollback-20260903T084500.db`. UTC, second-precise, like a
/// snapshot name, so it sorts with its own instant.
pub fn rollback_file_name(instant: SystemTime) -> String {
    let seconds = instant
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0);
    format!("{ROLLBACK_STEM}-{}.{FILE_EXTENSION}", timestamp(seconds))
}

/// The previous journal's resting place after a restore, beside the live one.
pub fn rollback_path(config_dir: &Path, now: SystemTime) -> PathBuf {
    config_dir.join(rollback_file_name(now))
}

/// What applying a staged file did: nothing to do on an ordinary launch, or
/// the restore that just happened. A restored file that found no live journal
/// — a first run with a staged file — carries no rollback, because there was
/// nothing to keep.
#[derive(Debug)]
pub enum ApplyOutcome {
    Absent,
    Restored { rollback: Option<PathBuf> },
}

/// Opens a candidate read-only and validates it: `quick_check`, the schema
/// the version it claims must carry — every expected table, every column of
/// each, and nothing a journal never makes — and the `_sqlx_migrations`
/// boundary. Never opens it with the app's own pool, never writes to the
/// file, and never mutates anything on a refusal. A refusal names which check
/// failed. Answers with the migration version the candidate carries, so the
/// caller can log what it staged.
pub async fn validate_restore_candidate(candidate: &Path) -> Result<i64, String> {
    if !candidate.is_file() {
        return Err(format!(
            "the backup is not a plain file: {}",
            candidate.display()
        ));
    }

    let options = sqlx::sqlite::SqliteConnectOptions::new()
        .filename(candidate)
        .read_only(true)
        .create_if_missing(false);
    let mut connection = sqlx::sqlite::SqliteConnection::connect_with(&options)
        .await
        .map_err(|error| format!("the backup could not be opened as a SQLite database: {error}"))?;

    // `quick_check` answers one row holding `ok` when the file is sound, and
    // one row per problem when it is not. Anything but exactly `ok` refuses.
    use sqlx::Row;
    let rows: Vec<String> = sqlx::query("PRAGMA quick_check")
        .try_map(|row: sqlx::sqlite::SqliteRow| row.try_get(0))
        .fetch_all(&mut connection)
        .await
        .map_err(|error| {
            format!("the backup failed its integrity check (quick_check could not run): {error}")
        })?;
    if rows != [String::from("ok")] {
        return Err(format!(
            "the backup failed its integrity check (quick_check): {}",
            rows.join("; ")
        ));
    }

    let tables: HashSet<String> = sqlx::query("SELECT name FROM sqlite_master WHERE type = 'table'")
        .try_map(|row: sqlx::sqlite::SqliteRow| row.try_get(0))
        .fetch_all(&mut connection)
        .await
        .map_err(|error| format!("the backup's tables could not be read: {error}"))?
        .into_iter()
        .collect();
    if !tables.contains("_sqlx_migrations") {
        return Err("the backup is not a journal (missing _sqlx_migrations)".to_string());
    }

    let version: Option<i64> = sqlx::query_scalar("SELECT MAX(version) FROM _sqlx_migrations")
        .fetch_one(&mut connection)
        .await
        .map_err(|error| {
            format!("the backup's migration version could not be read: {error}")
        })?;
    let Some(version) = version else {
        return Err("the backup carries no migration version".to_string());
    };
    if version > SUPPORTED_MIGRATION_VERSION {
        return Err(format!(
            "the backup needs migration version {version}, newer than this build understands ({SUPPORTED_MIGRATION_VERSION})"
        ));
    }
    if version < 1 {
        return Err(format!("the backup carries an unknown migration version: {version}"));
    }

    let expected = expected_schema(version);

    // A journal this app makes holds nothing but tables and indexes: none of
    // its migrations create a view or a trigger, so a candidate that carries
    // either has been altered or is not a journal at all. Refused rather than
    // trusted — a trigger could fire on the app's own writes.
    let unexpected: Vec<String> =
        sqlx::query(
            "SELECT name FROM sqlite_master
             WHERE type IN ('view', 'trigger') AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )
        .try_map(|row: sqlx::sqlite::SqliteRow| row.try_get(0))
        .fetch_all(&mut connection)
        .await
        .map_err(|error| format!("the backup's views and triggers could not be read: {error}"))?;
    if !unexpected.is_empty() {
        return Err(format!(
            "the backup carries unexpected views or triggers: {}",
            unexpected.join(", ")
        ));
    }

    let missing: Vec<&&str> = expected
        .iter()
        .map(|(table, _)| table)
        .filter(|table| !tables.contains(**table))
        .collect();
    if !missing.is_empty() {
        let missing = missing
            .into_iter()
            .map(|table| table.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!("the backup is missing tables: {missing}"));
    }

    // The tables named right are not enough: a `notes` table carrying only
    // `(id, body)` would pass a names check and fail the next launch's
    // `SELECT journal_day`. Each expected table must hold every column the
    // version it claims leaves it with.
    let mut missing_columns: Vec<String> = Vec::new();
    for (table, required) in expected.iter() {
        let held = columns_of(&mut connection, table).await?;
        let absent: Vec<&&str> = required
            .iter()
            .filter(|column| !held.contains(**column))
            .collect();
        if !absent.is_empty() {
            let absent = absent
                .into_iter()
                .map(|column| column.to_string())
                .collect::<Vec<_>>()
                .join(", ");
            missing_columns.push(format!("{table} ({absent})"));
        }
    }
    if !missing_columns.is_empty() {
        return Err(format!(
            "the backup is missing columns: {}",
            missing_columns.join("; ")
        ));
    }

    Ok(version)
}

/// Reads the columns a table actually holds, by name. Through
/// `pragma_table_info`'s table-valued form, so the table name is a bound
/// parameter — a name from this file is data, never interpolated into SQL.
async fn columns_of(
    connection: &mut sqlx::sqlite::SqliteConnection,
    table: &str,
) -> Result<HashSet<String>, String> {
    use sqlx::Row;
    sqlx::query("SELECT name FROM pragma_table_info(?)")
        .bind(table)
        .try_map(|row: sqlx::sqlite::SqliteRow| row.try_get(0))
        .fetch_all(&mut *connection)
        .await
        .map_err(|error| format!("the backup's {table} columns could not be read: {error}"))
        .map(|columns| columns.into_iter().collect())
}

/// Whether two paths name the same file. Canonicalization covers `.`, `..`,
/// symlinks and spelling differences; when either side cannot be
/// canonicalized — the staged path usually does not exist yet — the paths as
/// written are compared instead.
fn same_file(first: &Path, second: &Path) -> bool {
    if first == second {
        return true;
    }
    match (std::fs::canonicalize(first), std::fs::canonicalize(second)) {
        (Ok(first), Ok(second)) => first == second,
        _ => false,
    }
}

/// Stages a validated candidate beside the live journal. Validates first, so
/// a refusal stages nothing and touches neither the staged path nor the live
/// database. A candidate that is the staged file itself is refused before the
/// copy — copying a file onto itself truncates it to zero bytes, and
/// validation passes first, on the intact file — as is one that is the live
/// journal, which there is nothing to restore from. The copy goes to a temp
/// sibling, which is validated before an atomic rename onto the staged path,
/// so a copy that fails partway leaves no truncated file where the next
/// launch would apply it. Answers with the staged path.
pub async fn stage_restore(candidate: &Path, config_dir: &Path) -> Result<PathBuf, String> {
    stage_restore_with_copy(candidate, config_dir, copy_candidate).await
}

/// The file copy staging goes through, so the seam above can swap it in
/// tests.
fn copy_candidate(candidate: &Path, temp: &Path) -> io::Result<u64> {
    std::fs::copy(candidate, temp)
}

/// The staging body with the file copy as a seam: production passes
/// `std::fs::copy`, tests pass a copy that fails partway to prove the staged
/// path is never left truncated.
async fn stage_restore_with_copy(
    candidate: &Path,
    config_dir: &Path,
    copy: fn(&Path, &Path) -> io::Result<u64>,
) -> Result<PathBuf, String> {
    validate_restore_candidate(candidate).await?;

    let staged = staged_restore_path(config_dir);
    if same_file(candidate, &staged) {
        return Err(format!(
            "the backup is the staged restore itself: {}",
            candidate.display()
        ));
    }
    if same_file(candidate, &live_database_path(config_dir)) {
        return Err(format!(
            "the backup is the live journal itself: {}",
            candidate.display()
        ));
    }
    let temp = staged_temp_path(&staged);
    if same_file(candidate, &temp) {
        return Err(format!(
            "the backup is the staged restore itself: {}",
            candidate.display()
        ));
    }
    if let Some(parent) = staged.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("the staged restore could not be prepared: {error}"))?;
    }
    if let Err(error) = copy(candidate, &temp) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("the backup could not be staged: {error}"));
    }
    if let Err(error) = validate_restore_candidate(&temp).await {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("the backup could not be staged: {error}"));
    }
    if let Err(error) = std::fs::rename(&temp, &staged) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("the backup could not be staged: {error}"));
    }
    Ok(staged)
}

/// Applies a staged restore, before plugin-sql opens. When a staged file is
/// present it renames the live journal to the timestamped rollback path —
/// with its `-wal` and `-shm` sidecars alongside it, since they hold
/// committed transactions the main file alone does not contain — and renames
/// the staged file into the exact path plugin-sql will open, leaving the
/// rollback file in place. The restored file has its own history, and the old
/// journal's WAL applied to it is the corruption case, so no sidecar ever
/// outlives the journal it belonged to: sidecars travel with the rollback
/// when there is one, and orphans of a missing live journal — a WAL without
/// its main file is unrecoverable — are removed before the staged file takes
/// the live path. Applying is renames only, no copies; staging is the one
/// copy, through a temp sibling validated before an atomic rename onto the
/// staged path, so a half-written journal never occupies the staged path and
/// is never the live one. An absent staged file is the ordinary path and costs
/// nothing, as are missing sidecars. If any step fails, every rename already
/// made is undone, the journal is left as it was, and the failure is answered
/// as an error for the caller to log.
pub fn apply_staged_restore(
    config_dir: &Path,
    now: SystemTime,
) -> Result<ApplyOutcome, String> {
    let staged = staged_restore_path(config_dir);
    if !staged.is_file() {
        return Ok(ApplyOutcome::Absent);
    }
    let live = live_database_path(config_dir);

    // The previous journal, kept before the live path is touched. Absent on a
    // first run with a staged file — then there is nothing to keep.
    let rollback = if live.is_file() {
        let rollback = rollback_path(config_dir, now);
        std::fs::rename(&live, &rollback)
            .map_err(|error| format!("the live journal could not be kept as a rollback: {error}"))?;
        Some(rollback)
    } else {
        None
    };

    // Each sidecar moved, so a later failure can move every one back.
    let mut moved_sidecars: Vec<(PathBuf, PathBuf)> = Vec::new();
    match &rollback {
        Some(rollback) => {
            for kind in ["wal", "shm"] {
                let from = sidecar_path(&live, kind);
                let to = sidecar_path(rollback, kind);
                match std::fs::rename(&from, &to) {
                    Ok(()) => moved_sidecars.push((from, to)),
                    // A journal in rollback-journal mode leaves none behind.
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => {
                        undo_restore(&live, rollback, &moved_sidecars);
                        return Err(format!(
                            "the stale {} sidecar could not be kept with its journal: {error}",
                            from.display()
                        ));
                    }
                }
            }
        }
        // No live journal, so no rollback — but orphans must not survive to
        // meet the staged file: a stale WAL replaying onto it restores the
        // old data under a healthy `quick_check`. A WAL without its main
        // file is unrecoverable, so removing loses nothing.
        None => {
            for kind in ["wal", "shm"] {
                let orphan = sidecar_path(&live, kind);
                match std::fs::remove_file(&orphan) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(format!(
                            "the orphan {} sidecar could not be removed: {error}",
                            orphan.display()
                        ));
                    }
                }
            }
        }
    }

    if let Err(error) = std::fs::rename(&staged, &live) {
        // The staged file is still where it was; put the live journal — and
        // any sidecar already moved — back where each was too.
        if let Some(rollback) = rollback.as_ref() {
            undo_restore(&live, rollback, &moved_sidecars);
        }
        return Err(format!(
            "the staged backup could not replace the journal: {error}"
        ));
    }

    Ok(ApplyOutcome::Restored { rollback })
}

/// Puts back everything `apply_staged_restore` moved: each sidecar, then the
/// journal itself. Best effort — renames that already succeeded once are
/// expected to succeed again — and deliberately silent, since it only runs on
/// a path that is already answering an error.
fn undo_restore(live: &Path, rollback: &Path, moved_sidecars: &[(PathBuf, PathBuf)]) {
    for (from, to) in moved_sidecars.iter().rev() {
        let _ = std::fs::rename(to, from);
    }
    let _ = std::fs::rename(rollback, live);
}

/// `work-journal.db` plus `-wal` or `-shm`: the sidecars a WAL-mode journal
/// leaves beside itself.
fn sidecar_path(live: &Path, sidecar: &str) -> PathBuf {
    PathBuf::from(format!("{}-{sidecar}", live.display()))
}

/// The schema a journal at `version` must hold: every table the version must
/// have, and every column of each. Version-aware because an older snapshot is
/// accepted and migrated forward: a version 5 snapshot cannot be expected to
/// hold the version 6 occurrence table, or nothing old would ever be
/// migratable. What is checked is that the tables — and the columns — the
/// claimed version must have are there.
///
/// Columns read in the order the migrations left them; a version's list is
/// always a prefix of a newer version's, because a migration adds columns to
/// a table it never drops or reorders. Every arm is an explicit version: the
/// `_` fallback is the latest known schema, and validation never sends it
/// anything newer than `SUPPORTED_MIGRATION_VERSION` — while
/// `the_supported_version_tracks_the_migrations_list` and
/// `expected_schema_covers_the_real_schema_at_every_version` fail if a
/// migration lands without teaching this function its tables and columns.
fn expected_schema(version: i64) -> &'static [(&'static str, &'static [&'static str])] {
    const LATEST: &[(&str, &[&str])] = &[
        (
            "notes",
            &[
                "id",
                "body",
                "captured_at",
                "journal_day",
                "edited_at",
                "project",
                "origin",
                "source",
                "source_key",
            ],
        ),
        (
            "handled_events",
            &["source", "event_key", "handled_at"],
        ),
        (
            "tasks",
            &[
                "id",
                "description",
                "created_at",
                "completed_at",
                "scheduled_date",
                "scheduled_time",
                "recurrence_unit",
                "recurrence_interval",
                "recurrence_weekdays",
                "recurrence_anchor_date",
            ],
        ),
        (
            "task_occurrences",
            &[
                "id",
                "task_id",
                "scheduled_date",
                "scheduled_time",
                "completed_at",
                "created_at",
                "advanced_from",
            ],
        ),
    ];
    const VERSION_7: &[(&str, &[&str])] = &[
        (
            "notes",
            &[
                "id",
                "body",
                "captured_at",
                "journal_day",
                "edited_at",
                "project",
                "origin",
            ],
        ),
        ("imported_meetings", &["event_key", "handled_at"]),
        (
            "tasks",
            &[
                "id",
                "description",
                "created_at",
                "completed_at",
                "scheduled_date",
                "scheduled_time",
                "recurrence_unit",
                "recurrence_interval",
                "recurrence_weekdays",
                "recurrence_anchor_date",
            ],
        ),
        (
            "task_occurrences",
            &[
                "id",
                "task_id",
                "scheduled_date",
                "scheduled_time",
                "completed_at",
                "created_at",
                "advanced_from",
            ],
        ),
    ];
    // Migration 1 creates `notes`; 2 appends `project`; 3 appends `origin`
    // and creates `imported_meetings`; 4 creates `tasks`; 5 appends its
    // schedule; 6 appends its recurrence and creates `task_occurrences`;
    // 7 adds an index; 8 rebuilds Notes to allow `observe`, adds provenance
    // and moves handled meeting keys into source-qualified `handled_events`.
    match version {
        1 => &[("notes", &["id", "body", "captured_at", "journal_day", "edited_at"])],
        2 => &[(
            "notes",
            &["id", "body", "captured_at", "journal_day", "edited_at", "project"],
        )],
        3 => &[
            (
                "notes",
                &["id", "body", "captured_at", "journal_day", "edited_at", "project", "origin"],
            ),
            ("imported_meetings", &["event_key", "handled_at"]),
        ],
        4 => &[
            (
                "notes",
                &["id", "body", "captured_at", "journal_day", "edited_at", "project", "origin"],
            ),
            ("imported_meetings", &["event_key", "handled_at"]),
            ("tasks", &["id", "description", "created_at", "completed_at"]),
        ],
        5 => &[
            (
                "notes",
                &["id", "body", "captured_at", "journal_day", "edited_at", "project", "origin"],
            ),
            ("imported_meetings", &["event_key", "handled_at"]),
            (
                "tasks",
                &[
                    "id",
                    "description",
                    "created_at",
                    "completed_at",
                    "scheduled_date",
                    "scheduled_time",
                ],
            ),
        ],
        6 | 7 => VERSION_7,
        8 => LATEST,
        _ => LATEST,
    }
}

/// Reads what Settings says about the automatic backups, out of the live
/// directory: how many snapshots are there, and when the newest was taken.
pub fn automatic_backups(directory: &Path) -> AutomaticBackups {
    status_of(&listed_snapshots(directory))
}

/// One file in the backups directory, as far as this module can read it.
struct Listed {
    path: Option<PathBuf>,
    instant: Option<SystemTime>,
}

/// Every snapshot in `directory`, newest first. A file whose name does not
/// parse — including a file that is not a snapshot at all — is carried with
/// `path` and `instant` both null when it is there at all: it must neither be
/// counted as a snapshot nor pruned, and `prunable` uses the null path to
/// drop it. Unparsable names sort oldest so a retention pass takes them
/// first.
fn listed_snapshots(directory: &Path) -> Vec<Listed> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };

    let mut listed: Vec<Listed> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let instant = snapshot_instant(&name);
            Listed {
                instant,
                path: instant.map(|_| entry.path()),
            }
        })
        // A directory cannot hold two files of one name, so an instant that
        // parses is on disk exactly once — and the None sort key must never
        // compare as greater than a real instant, or an unparsable neighbour
        // would read as the newest backup in the directory.
        .collect();

    listed.sort_by(|a, b| match (&a.instant, &b.instant) {
        (Some(a), Some(b)) => b.cmp(a),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    listed
}

/// Count and newest, for the one line Settings says about the automatics.
fn status_of(snapshots: &[Listed]) -> AutomaticBackups {
    AutomaticBackups {
        count: snapshots.iter().filter(|listed| listed.instant.is_some()).count() as u32,
        newest_taken_at: snapshots.first().and_then(|newest| {
            newest
                .instant
                .and_then(|instant| instant.duration_since(UNIX_EPOCH).ok())
                .map(|since| since.as_secs() as i64)
        }),
    }
}

/// `YYYYMMDDTHHMMSS`, in the calendar-agnostic arithmetic UTC makes honest.
fn timestamp(seconds: u64) -> String {
    let (year, month, day, hour, minute, second) = civil_from_seconds(seconds);
    format!("{year:04}{month:02}{day:02}T{hour:02}{minute:02}{second:02}")
}

/// Reads one of the above back, refusing anything that is not exactly it.
/// A name before the epoch is not a snapshot — snapshots are named from
/// `SystemTime` — and neither is an impossible date, which must not
/// normalise into a different day. Both parse as nothing, so the caller
/// leaves the file exactly where it is.
fn parse_timestamp(stamped: &str) -> Option<u64> {
    let bytes = stamped.as_bytes();
    if bytes.len() != 15 || bytes[8] != b'T' {
        return None;
    }
    for (at, byte) in bytes.iter().enumerate() {
        let digit = if at == 8 { continue } else { byte.is_ascii_digit() };
        if !digit {
            return None;
        }
    }

    let number = |from: usize, to: usize| stamped.get(from..to)?.parse::<u64>().ok();
    let year = number(0, 4)?;
    let month = number(4, 6)?;
    let day = number(6, 8)?;
    let hour = number(9, 11)?;
    let minute = number(11, 13)?;
    let second = number(13, 15)?;

    if year < 1970 {
        return None;
    }
    if !(1..=12).contains(&month) || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    if day < 1 || day > days_in_month(year, month) {
        return None;
    }

    Some(seconds_from_civil(year, month, day, hour, minute, second))
}

/// The days February holds, or any other month: the proleptic Gregorian
/// calendar, the same one the civil arithmetic above reads.
fn days_in_month(year: u64, month: u64) -> u64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// Leap years are divisible by four, except centuries, except centuries
/// divisible by four hundred.
fn is_leap_year(year: u64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn split_extension(file_name: &str) -> Option<(&str, &str)> {
    let (stem, extension) = file_name.rsplit_once('.')?;
    if stem.is_empty() || extension.is_empty() {
        return None;
    }
    Some((stem, extension))
}

/// Days-from-civil and back again (Howard Hinnant's algorithms): the civil
/// calendar read straight off a Unix second, with no timezone in between —
/// UTC is the point of the name, so the conversion is exact arithmetic and
/// no dependency.
fn civil_from_seconds(seconds: u64) -> (i64, u64, u64, u64, u64, u64) {
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    (
        year,
        month,
        day,
        rest / 3_600,
        (rest % 3_600) / 60,
        rest % 60,
    )
}

/// The proleptic Gregorian civil date of a count of days since the epoch.
fn civil_from_days(z: i64) -> (i64, u64, u64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u64;
    let month = if mp < 10 { (mp + 3) as u64 } else { (mp - 9) as u64 };
    (
        if month <= 2 { y + 1 } else { y },
        month,
        day,
    )
}

/// The count of days since the epoch of a civil date — the inverse above.
fn days_from_civil(year: i64, month: u64, day: u64) -> i64 {
    let y = year - if month <= 2 { 1 } else { 0 };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if month > 2 { month as i64 - 3 } else { month as i64 + 9 };
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn seconds_from_civil(year: u64, month: u64, day: u64, hour: u64, minute: u64, second: u64) -> u64 {
    let days = days_from_civil(year as i64, month, day);
    (days as u64) * 86_400 + hour * 3_600 + minute * 60 + second
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Runs one async test on Tauri's own runtime: the same runtime the app
    /// and the startup snapshot task run on, reached through the `tauri` crate
    /// the module already depends on. No test-only runtime, no extra dep.
    macro_rules! async_test {
        ($name:ident, $body:block) => {
            #[test]
            fn $name() {
                tauri::async_runtime::block_on(async { $body });
            }
        };
    }

    /// A directory of this run's own, removed when the test is done with it.
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(name: &str) -> Self {
            // Tests run in parallel and share one process, so the name alone
            // is not enough to own a directory: a counter makes every call's
            // directory its own.
            use std::sync::atomic::{AtomicU64, Ordering};
            static CALLS: AtomicU64 = AtomicU64::new(0);
            let call = CALLS.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!("work-journal-backup-{name}-{call}"));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("could not make a temporary directory");
            TempDir { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    /// A journal-shaped database with one row in it, so a snapshot has
    /// something to carry and a `quick_check` is worth running.
    async fn seeded_journal(mode: &str) -> (TempDir, SqlitePool) {
        // Its own subdirectory: `VACUUM INTO` refuses to create a directory
        // on the way, so wherever a snapshot goes, the caller has made.
        let directory = TempDir::new("mode");
        let url = format!("sqlite:{}/journal.db?mode=rwc", directory.path.display());
        let pool = SqlitePool::connect(&url).await.expect("could not open the source");

        sqlx::query(&format!("PRAGMA journal_mode = {mode}"))
            .execute(&pool)
            .await
            .expect("could not set the journal mode");

        sqlx::query(
            "CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL);
             CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT NOT NULL);
             INSERT INTO notes VALUES ('n1', 'a Note');
             INSERT INTO _sqlx_migrations VALUES (6, 'task recurrence');",
        )
        .execute(&pool)
        .await
        .expect("could not seed the journal");

        (directory, pool)
    }

    /// The snapshot's own checks, run against the file rather than against
    /// the pool: it opens standalone, holds the rows, and passes
    /// `quick_check`.
    async fn assert_healthy_snapshot(destination: &Path) {
        let url = format!("sqlite:{}?mode=ro", destination.display());
        let snapshot = SqlitePool::connect(&url)
            .await
            .expect("the snapshot did not open standalone");

        let check: (String,) = sqlx::query_as("PRAGMA quick_check")
            .fetch_one(&snapshot)
            .await
            .expect("quick_check did not run");
        assert_eq!(check.0, "ok");

        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM notes")
            .fetch_one(&snapshot)
            .await
            .expect("notes did not read back");
        assert_eq!(count, 1);

        let (migrations,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM _sqlx_migrations")
            .fetch_one(&snapshot)
            .await
            .expect("migrations did not read back");
        assert_eq!(migrations, 1);

        snapshot.close().await;
    }

    async_test!(a_snapshot_of_a_healthy_journal_opens_and_passes_quick_check, {
        let (_source, pool) = seeded_journal("delete").await;
        let directory = TempDir::new("healthy");
        let destination = directory.path.join("work-journal-20260903T084500.db");

        take_snapshot(&destination, &pool)
            .await
            .expect("the snapshot failed");

        assert_healthy_snapshot(&destination).await;
    });

    async_test!(a_snapshot_taken_while_a_write_transaction_is_open_is_consistent, {
        let (_source, pool) = seeded_journal("delete").await;
        let mut transaction = pool.begin().await.expect("could not begin");
        sqlx::query("INSERT INTO notes VALUES ('n2', 'uncommitted')")
            .execute(&mut *transaction)
            .await
            .expect("could not write in the transaction");

        let directory = TempDir::new("open-transaction");
        let destination = directory.path.join("work-journal-20260903T084500.db");
        take_snapshot(&destination, &pool)
            .await
            .expect("the snapshot failed");
        transaction.rollback().await.expect("could not roll back");

        // The snapshot is the journal as committed, not the transaction half
        // taken: one Note, the one that was committed before it began.
        let url = format!("sqlite:{}?mode=ro", destination.display());
        let snapshot = SqlitePool::connect(&url).await.expect("did not open");
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM notes")
            .fetch_one(&snapshot)
            .await
            .expect("did not read");
        assert_eq!(count, 1);
        snapshot.close().await;
    });

    async_test!(a_snapshot_works_from_a_wal_source, {
        let (_source, pool) = seeded_journal("wal").await;
        let directory = TempDir::new("wal");
        let destination = directory.path.join("work-journal-20260903T084500.db");

        take_snapshot(&destination, &pool)
            .await
            .expect("the snapshot failed");

        assert_healthy_snapshot(&destination).await;
    });

    async_test!(the_destination_is_bound_not_interpolated, {
        // The one thing a path with a quote in it proves: interpolated, this
        // statement breaks or worse; bound, the name is data and survives.
        let (_source, pool) = seeded_journal("delete").await;
        let directory = TempDir::new("quoted-path");
        let destination = directory.path.join("it's-2026's backup.db");

        take_snapshot(&destination, &pool)
            .await
            .expect("the snapshot failed");

        assert_healthy_snapshot(&destination).await;
    });

    async_test!(a_destination_that_is_a_directory_is_refused, {
        let (_source, pool) = seeded_journal("delete").await;
        let directory = TempDir::new("refuses-directory");

        let result = take_snapshot(&directory.path, &pool).await;

        assert!(result.is_err());
        // And the directory is still a directory — clobbered by nothing.
        assert!(directory.path.is_dir());
    });

    #[test]
    fn a_snapshot_name_carries_its_instant_and_reads_back_to_it() {
        // 2026-09-03T08:45:00Z — the instant the ADR names.
        let instant = UNIX_EPOCH + Duration::from_secs(1_788_425_100);
        let name = snapshot_file_name(instant);

        assert_eq!(name, "work-journal-20260903T084500.db");
        assert_eq!(snapshot_instant(&name), Some(instant));
    }

    #[test]
    fn every_instant_of_a_wide_range_round_trips_through_its_name() {
        // A day at a time across several years, the ends of months and a
        // leap day included — the arithmetic the name is built on has to
        // survive all of it, since pruning reads names, not mtimes.
        let start = 86_400; // 1970-01-02
        for days in 0..(365 * 60) {
            let instant = UNIX_EPOCH + Duration::from_secs((start + days * 86_400) as u64);
            assert_eq!(snapshot_instant(&snapshot_file_name(instant)), Some(instant));
        }
    }

    #[test]
    fn names_that_are_not_snapshots_read_back_as_nothing() {
        for name in [
            "work-journal.db",
            "work-journal-2.db",
            "export-20260903T084500.md",
            "work-journal-20260903T084500.md",
            "work-journal-20260903T0845.db",
            "work-journal-20261303T084500.db",
            "work-journal-20260903T084500",
            "",
        ] {
            assert!(snapshot_instant(name).is_none(), "{name} parsed as a snapshot");
        }
    }

    #[test]
    fn pre_epoch_and_impossible_dates_read_back_as_nothing() {
        // Pre-1970 names must parse as nothing instead of wrapping around
        // the epoch and panicking; impossible dates must not normalise into
        // a different day.
        for name in [
            "work-journal-19000101T000000.db",
            "work-journal-19691231T235959.db",
            "work-journal-20260231T120000.db",
            "work-journal-20260431T120000.db",
            "work-journal-20260229T120000.db",
            "work-journal-20250000T120000.db",
            "work-journal-20250001T240000.db",
        ] {
            assert!(snapshot_instant(name).is_none(), "{name} parsed as a snapshot");
        }
        // Boundaries that must keep parsing: the epoch itself and a real
        // leap day.
        assert!(snapshot_instant("work-journal-19700101T000000.db").is_some());
        assert!(snapshot_instant("work-journal-20240229T120000.db").is_some());
    }

    #[test]
    fn a_destination_that_is_a_path_is_refused() {
        for destination in ["../escaped.db", "nested/notes.db", "/tmp/notes.db", "  ", ""] {
            assert!(plain_destination(destination).is_none(), "{destination} is not plain");
        }
        // And what the dialog hands over — a bare name — is kept as itself.
        assert_eq!(
            plain_destination("work-journal-20260903T084500.db").as_deref(),
            Some("work-journal-20260903T084500.db")
        );
    }

    #[test]
    fn a_taken_destination_settles_beside_rather_than_on_what_is_there() {
        let directory = TempDir::new("settle-beside");
        let taken = directory.path.join("work-journal-20260903T084500.db");
        std::fs::write(&taken, "the file the dialog asked about replacing").unwrap();

        let settled =
            settle_destination(&directory.path, "work-journal-20260903T084500.db")
                .expect("a taken name must settle beside, not refuse");

        assert_eq!(
            settled.file_name().unwrap().to_string_lossy(),
            "work-journal-20260903T084500-2.db"
        );
        // The file the dialog's "Replace?" was about is still there, whole.
        assert_eq!(
            std::fs::read_to_string(&taken).unwrap(),
            "the file the dialog asked about replacing"
        );
    }

    #[test]
    fn a_settlement_into_a_qualified_name_is_refused() {
        let directory = TempDir::new("settle-refuses-paths");

        for name in ["../escaped.db", "nested/notes.db", "  "] {
            assert!(
                settle_destination(&directory.path, name).is_err(),
                "{name} should not be a file name to settle"
            );
        }
    }

    #[test]
    fn a_snapshot_is_due_past_the_interval_and_not_before() {
        let directory = TempDir::new("due-decision");
        let now = UNIX_EPOCH + Duration::from_secs(1_788_425_100);
        std::fs::write(
            directory.path.join(snapshot_file_name(now - SNAPSHOT_INTERVAL - Duration::from_secs(1))),
            "older than the interval",
        )
        .unwrap();

        assert!(automatic(&directory.path, now).due);

        std::fs::write(
            directory.path.join(snapshot_file_name(now - SNAPSHOT_INTERVAL + Duration::from_secs(1))),
            "newer than the interval",
        )
        .unwrap();

        assert!(!automatic(&directory.path, now).due);
    }

    #[test]
    fn an_empty_directory_is_always_due() {
        let directory = TempDir::new("due-empty");
        let now = UNIX_EPOCH + Duration::from_secs(1_788_425_100);

        let decision = automatic(&directory.path, now);

        assert!(decision.due);
        assert_eq!(decision.status.count, 0);
        assert_eq!(decision.status.newest_taken_at, None);
    }

    #[test]
    fn an_unreadable_snapshot_name_means_take_a_fresh_one() {
        let directory = TempDir::new("due-unreadable");
        let now = UNIX_EPOCH + Duration::from_secs(1_788_425_100);
        // A snapshot renamed by hand is no longer a snapshot; the interval
        // cannot be read off it, so the pass errs toward taking one.
        std::fs::write(directory.path.join("work-journal.db"), "not a snapshot name").unwrap();

        assert!(automatic(&directory.path, now).due);
    }

    #[test]
    fn retention_keeps_exactly_the_newest_n() {
        let directory = TempDir::new("prune");
        for seconds in 0..RETAINED_SNAPSHOTS + 5 {
            let instant = UNIX_EPOCH + Duration::from_secs(1_788_425_100 + seconds as u64);
            std::fs::write(directory.path.join(snapshot_file_name(instant)), "a snapshot").unwrap();
        }

        let pruned = prunable(&directory.path);

        // The five oldest go — oldest first, the order `prunable` promises —
        // the thirty newest stay, and what is named is what is on disk, so
        // the caller's deletes cannot miss.
        assert_eq!(pruned.len(), 5);
        let pruned_names: Vec<String> = pruned
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        let expected: Vec<String> = (0..5)
            .map(|seconds| {
                let instant =
                    UNIX_EPOCH + Duration::from_secs(1_788_425_100 + seconds as u64);
                snapshot_file_name(instant)
            })
            .collect();
        assert_eq!(pruned_names, expected);
        for path in &pruned {
            assert!(path.exists(), "{} is not on disk", path.display());
        }
        // Pruning is the caller's delete; having done it, nothing more is
        // ever offered.
        for path in &pruned {
            std::fs::remove_file(path).unwrap();
        }
        assert!(prunable(&directory.path).is_empty());
    }

    #[test]
    fn retention_touches_nothing_but_snapshots() {
        let directory = TempDir::new("prune-unrelated");
        for seconds in 0..RETAINED_SNAPSHOTS + 2 {
            let instant = UNIX_EPOCH + Duration::from_secs(1_788_425_100 + seconds as u64);
            std::fs::write(directory.path.join(snapshot_file_name(instant)), "a snapshot").unwrap();
        }
        // The neighbours a user, or an export, put there.
        std::fs::write(directory.path.join("read-me-first.txt"), "unrelated").unwrap();
        std::fs::write(directory.path.join("work-journal.db"), "not a snapshot name").unwrap();

        let pruned = prunable(&directory.path);

        // Two over the limit means the two oldest *snapshots* go — oldest
        // first, the order `prunable` promises — and neither neighbour is
        // among them, whatever either is named.
        assert_eq!(pruned.len(), 2);
        let pruned_names: Vec<String> = pruned
            .iter()
            .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        let expected: Vec<String> = (0..2)
            .map(|seconds| {
                let instant =
                    UNIX_EPOCH + Duration::from_secs(1_788_425_100 + seconds as u64);
                snapshot_file_name(instant)
            })
            .collect();
        assert_eq!(pruned_names, expected);
        for path in &pruned {
            let name = path.file_name().unwrap().to_string_lossy();
            assert_ne!(name, "read-me-first.txt");
            assert_ne!(name, "work-journal.db");
        }
        assert!(directory.path.join("read-me-first.txt").exists());
        assert!(directory.path.join("work-journal.db").exists());
    }

    #[test]
    fn the_automatic_status_counts_snapshots_and_names_the_newest() {
        let directory = TempDir::new("status");
        let older = UNIX_EPOCH + Duration::from_secs(1_788_425_100);
        let newer = UNIX_EPOCH + Duration::from_secs(1_788_425_200);
        std::fs::write(directory.path.join(snapshot_file_name(older)), "a").unwrap();
        std::fs::write(directory.path.join(snapshot_file_name(newer)), "b").unwrap();
        std::fs::write(directory.path.join("work-journal.db"), "not a snapshot").unwrap();

        let status = automatic_backups(&directory.path);

        // Two snapshots, not three: the file that is not one is not counted.
        assert_eq!(status.count, 2);
        assert_eq!(status.newest_taken_at, Some(1_788_425_100 + 100));
    }

    /// A journal file at `version`, carrying the real schema that version's
    /// migrations leave — so a file that must pass validation is shaped
    /// exactly as this app makes one — with one Note carrying `marker`, so a
    /// replacement can be told apart from what it replaced.
    async fn write_journal_file(path: &Path, version: i64, marker: &str) {
        let url = format!("sqlite:{}?mode=rwc", path.display());
        let pool = SqlitePool::connect(&url)
            .await
            .expect("could not create the journal file");
        seed_real_schema(&pool, version, marker).await;
        pool.close().await;
    }

    async fn healthy_candidate(directory: &TempDir, name: &str, marker: &str) -> PathBuf {
        let path = directory.path.join(name);
        write_journal_file(&path, SUPPORTED_MIGRATION_VERSION, marker).await;
        path
    }

    fn candidate_bytes(path: &Path) -> Vec<u8> {
        std::fs::read(path).expect("could not read the candidate")
    }

    /// The migration files, in version order — the very files
    /// `migrations()` in `lib.rs` serves plugin-sql.
    const REAL_MIGRATIONS: [&str; 8] = [
        include_str!("../migrations/0001_create_notes.sql"),
        include_str!("../migrations/0002_notes_project.sql"),
        include_str!("../migrations/0003_note_origin_and_imported_meetings.sql"),
        include_str!("../migrations/0004_create_tasks.sql"),
        include_str!("../migrations/0005_task_schedule.sql"),
        include_str!("../migrations/0006_task_recurrence.sql"),
        include_str!("../migrations/0007_task_occurrences_one_kept_per_slot.sql"),
        include_str!("../migrations/0008_observed_note_origin_and_event_sources.sql"),
    ];

    /// Seeds `pool` with the real schema up to `up_to`, recording each
    /// version in a `_sqlx_migrations` table shaped exactly like the one
    /// sqlx itself keeps — so validation meets the production schema rather
    /// than a hand-written approximation of it. `write_journal_file` and
    /// `real_journal_file` both come through here.
    async fn seed_real_schema(pool: &SqlitePool, up_to: i64, marker: &str) {
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS _sqlx_migrations (
                version BIGINT PRIMARY KEY,
                description TEXT NOT NULL,
                installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                success BOOLEAN NOT NULL,
                checksum BLOB NOT NULL,
                execution_time BIGINT NOT NULL
            );",
        )
        .execute(pool)
        .await
        .expect("could not create the migrations table");
        for (index, ddl) in REAL_MIGRATIONS.iter().enumerate().take(up_to as usize) {
            let version = index as i64 + 1;
            sqlx::query(ddl)
                .execute(pool)
                .await
                .unwrap_or_else(|_| panic!("real migration {version} failed"));
            sqlx::query(
                "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
                 VALUES (?, ?, 1, X'00', 0)",
            )
            .bind(version)
            .bind(format!("migration {version}"))
            .execute(pool)
            .await
            .expect("could not record the migration");
        }
        sqlx::query(
            "INSERT INTO notes (id, body, captured_at, journal_day)
             VALUES ('n1', ?, '2026-09-03T08:45:00Z', '2026-09-03')",
        )
        .bind(marker)
        .execute(pool)
        .await
        .expect("could not seed the Note");
    }

    /// A journal file carrying the real schema at the supported version, with
    /// one Note carrying `marker`.
    async fn real_journal_file(directory: &TempDir, name: &str, marker: &str) -> PathBuf {
        let path = directory.path.join(name);
        let url = format!("sqlite:{}?mode=rwc", path.display());
        let pool = SqlitePool::connect(&url)
            .await
            .expect("could not create the journal file");
        seed_real_schema(&pool, SUPPORTED_MIGRATION_VERSION, marker).await;
        pool.close().await;
        path
    }

    async_test!(a_healthy_candidate_validates_at_the_supported_version, {
        let directory = TempDir::new("restore-healthy");
        let candidate = healthy_candidate(&directory, "candidate.db", "the journal").await;
        let before = candidate_bytes(&candidate);

        let version = validate_restore_candidate(&candidate)
            .await
            .expect("a healthy candidate must validate");

        assert_eq!(version, SUPPORTED_MIGRATION_VERSION);
        // Read-only: validation leaves the file it was handed exactly as it
        // found it.
        assert_eq!(candidate_bytes(&candidate), before);
    });

    async_test!(a_malformed_file_is_refused_without_touching_it, {
        let directory = TempDir::new("restore-malformed");
        let candidate = directory.path.join("candidate.db");
        std::fs::write(&candidate, "this is not a SQLite file at all").unwrap();
        let before = candidate_bytes(&candidate);

        let refusal = validate_restore_candidate(&candidate)
            .await
            .expect_err("a malformed file must not validate");

        assert!(
            refusal.contains("quick_check") || refusal.contains("could not be opened"),
            "a refusal names which check failed, got: {refusal}"
        );
        assert_eq!(candidate_bytes(&candidate), before);
    });

    async_test!(a_truncated_snapshot_is_refused, {
        let directory = TempDir::new("restore-truncated");
        let candidate = healthy_candidate(&directory, "candidate.db", "the journal").await;
        let length = std::fs::metadata(&candidate).unwrap().len();
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&candidate)
            .unwrap();
        file.set_len(length / 2).unwrap();
        drop(file);

        let refusal = validate_restore_candidate(&candidate)
            .await
            .expect_err("a truncated file must not validate");

        assert!(
            refusal.contains("quick_check") || refusal.contains("could not be opened"),
            "a refusal names which check failed, got: {refusal}"
        );
    });

    async_test!(a_valid_sqlite_file_that_is_not_a_journal_is_refused, {
        let directory = TempDir::new("restore-not-a-journal");
        let candidate = directory.path.join("candidate.db");
        let url = format!("sqlite:{}?mode=rwc", candidate.display());
        let pool = SqlitePool::connect(&url).await.expect("could not create");
        sqlx::query("CREATE TABLE foo (id TEXT PRIMARY KEY);")
            .execute(&pool)
            .await
            .expect("could not create");
        pool.close().await;
        let before = candidate_bytes(&candidate);

        let refusal = validate_restore_candidate(&candidate)
            .await
            .expect_err("a non-journal must not validate");

        assert!(
            refusal.contains("not a journal") || refusal.contains("missing"),
            "a refusal names which check failed, got: {refusal}"
        );
        assert_eq!(candidate_bytes(&candidate), before);
    });

    async_test!(a_journal_missing_a_table_for_its_version_is_refused, {
        let directory = TempDir::new("restore-missing-table");
        let candidate = healthy_candidate(&directory, "candidate.db", "the journal").await;
        let url = format!("sqlite:{}?mode=rwc", candidate.display());
        let pool = SqlitePool::connect(&url).await.expect("could not open");
        sqlx::query("DROP TABLE tasks;")
            .execute(&pool)
            .await
            .expect("could not drop");
        pool.close().await;
        let before = candidate_bytes(&candidate);

        let refusal = validate_restore_candidate(&candidate)
            .await
            .expect_err("a journal missing a table must not validate");

        assert!(
            refusal.contains("missing tables") && refusal.contains("tasks"),
            "a refusal names which check failed, got: {refusal}"
        );
        assert_eq!(candidate_bytes(&candidate), before);
    });

    async_test!(a_journal_whose_notes_table_lacks_required_columns_is_refused, {
        // The shape the issue names: every expected table is there, but
        // `notes` carries only `(id, body)`. A names-only check lets it
        // through, and the next launch fails on `SELECT journal_day` with the
        // original already renamed away — so columns are checked, not just
        // tables.
        let directory = TempDir::new("restore-missing-columns");
        let candidate = healthy_candidate(&directory, "candidate.db", "the journal").await;
        let url = format!("sqlite:{}?mode=rwc", candidate.display());
        let pool = SqlitePool::connect(&url).await.expect("could not open");
        sqlx::query("DROP TABLE notes;")
            .execute(&pool)
            .await
            .expect("could not drop");
        sqlx::query(
            "CREATE TABLE notes (id TEXT PRIMARY KEY NOT NULL, body TEXT NOT NULL);",
        )
        .execute(&pool)
        .await
        .expect("could not recreate");
        pool.close().await;
        let before = candidate_bytes(&candidate);

        let refusal = validate_restore_candidate(&candidate)
            .await
            .expect_err("a journal with a truncated notes table must not validate");

        assert!(
            refusal.contains("missing columns")
                && refusal.contains("notes")
                && refusal.contains("journal_day"),
            "a refusal names which check failed, got: {refusal}"
        );
        assert_eq!(candidate_bytes(&candidate), before);
    });

    async_test!(an_older_journal_missing_a_column_its_version_added_is_refused, {
        // Version-aware, like the tables: a journal claiming version 5 must
        // carry the columns migration 5 added to `tasks`, not the version 4
        // shape — anything less would migrate forward onto a table the app
        // cannot read its schedule from.
        let directory = TempDir::new("restore-old-missing-columns");
        let candidate = directory.path.join("candidate.db");
        write_journal_file(&candidate, SUPPORTED_MIGRATION_VERSION - 1, "the old journal").await;
        let url = format!("sqlite:{}?mode=rwc", candidate.display());
        let pool = SqlitePool::connect(&url).await.expect("could not open");
        sqlx::query("DROP TABLE tasks;")
            .execute(&pool)
            .await
            .expect("could not drop");
        sqlx::query(
            "CREATE TABLE tasks (id TEXT PRIMARY KEY, description TEXT NOT NULL,
                created_at TEXT NOT NULL, completed_at TEXT);",
        )
        .execute(&pool)
        .await
        .expect("could not recreate");
        pool.close().await;

        let refusal = validate_restore_candidate(&candidate)
            .await
            .expect_err("a journal missing a column its version added must not validate");

        assert!(
            refusal.contains("missing columns")
                && refusal.contains("tasks")
                && refusal.contains("scheduled_date"),
            "a refusal names which check failed, got: {refusal}"
        );
    });

    async_test!(a_journal_carrying_a_view_or_trigger_is_refused, {
        // A journal this app makes never holds a view or a trigger — no
        // migration creates one — so a candidate that does has been altered
        // or is not a journal at all. Refused rather than trusted: a trigger
        // would fire on the app's own writes once the file is live.
        let directory = TempDir::new("restore-unexpected-objects");
        let candidate = healthy_candidate(&directory, "candidate.db", "the journal").await;
        let url = format!("sqlite:{}?mode=rwc", candidate.display());
        let pool = SqlitePool::connect(&url).await.expect("could not open");
        sqlx::query("CREATE VIEW note_bodies AS SELECT body FROM notes;")
            .execute(&pool)
            .await
            .expect("could not create the view");
        sqlx::query(
            "CREATE TRIGGER refuse_deletes AFTER DELETE ON notes
             BEGIN SELECT RAISE(ABORT, 'notes are never deleted'); END;",
        )
        .execute(&pool)
        .await
        .expect("could not create the trigger");
        pool.close().await;
        let before = candidate_bytes(&candidate);

        let refusal = validate_restore_candidate(&candidate)
            .await
            .expect_err("a journal with a view or trigger must not validate");

        assert!(
            refusal.contains("unexpected")
                && refusal.contains("note_bodies")
                && refusal.contains("refuse_deletes"),
            "a refusal names which check failed, got: {refusal}"
        );
        assert_eq!(candidate_bytes(&candidate), before);
    });

    async_test!(a_newer_migration_version_is_refused_before_anything_is_touched, {
        let directory = TempDir::new("restore-newer");
        let candidate = directory.path.join("candidate.db");
        write_journal_file(&candidate, SUPPORTED_MIGRATION_VERSION, "the journal").await;
        let url = format!("sqlite:{}?mode=rwc", candidate.display());
        let pool = SqlitePool::connect(&url).await.expect("could not open");
        sqlx::query(
            "INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time)
             VALUES (?, ?, 1, X'00', 0)",
        )
        .bind(SUPPORTED_MIGRATION_VERSION + 1)
        .bind("a future migration")
        .execute(&pool)
        .await
        .expect("could not insert the newer version");
        pool.close().await;
        let before = candidate_bytes(&candidate);

        let refusal = validate_restore_candidate(&candidate)
            .await
            .expect_err("a newer snapshot must not validate");

        assert!(
            refusal.contains("newer"),
            "a refusal names which check failed, got: {refusal}"
        );
        assert_eq!(candidate_bytes(&candidate), before);
    });

    async_test!(an_older_snapshot_is_accepted_and_names_its_version, {
        let directory = TempDir::new("restore-older");
        let candidate = directory.path.join("candidate.db");
        write_journal_file(&candidate, SUPPORTED_MIGRATION_VERSION - 1, "the old journal").await;

        let version = validate_restore_candidate(&candidate)
            .await
            .expect("an older snapshot must validate");

        assert_eq!(version, SUPPORTED_MIGRATION_VERSION - 1);
    });

    async_test!(a_path_that_is_not_a_plain_file_is_refused, {
        let directory = TempDir::new("restore-not-a-file");
        let missing = directory.path.join("missing.db");

        for candidate in [&directory.path, &missing] {
            let refusal = validate_restore_candidate(candidate)
                .await
                .expect_err("a directory or a missing file must not validate");
            assert!(
                refusal.contains("not a plain file"),
                "a refusal names which check failed, got: {refusal}"
            );
        }
    });

    async_test!(a_refusal_touches_neither_the_live_database_nor_the_staged_path, {
        let config = TempDir::new("restore-refusal-leaves-live");
        let live = live_database_path(&config.path);
        write_journal_file(&live, SUPPORTED_MIGRATION_VERSION, "the live journal").await;
        let live_before = std::fs::read(&live).expect("could not read the live journal");

        let elsewhere = TempDir::new("restore-refusal-candidate");
        let candidate = elsewhere.path.join("candidate.db");
        std::fs::write(&candidate, "not a database").unwrap();

        let refusal = stage_restore(&candidate, &config.path).await;
        assert!(refusal.is_err(), "an invalid candidate must not stage");

        // The live journal is byte-identical, and nothing was staged.
        assert_eq!(std::fs::read(&live).unwrap(), live_before);
        assert!(!staged_restore_path(&config.path).exists());
    });

    async_test!(a_validated_candidate_stages_byte_identical, {
        let config = TempDir::new("restore-stage");
        let elsewhere = TempDir::new("restore-stage-candidate");
        let candidate = healthy_candidate(&elsewhere, "candidate.db", "the journal").await;
        let candidate_before = candidate_bytes(&candidate);

        let staged = stage_restore(&candidate, &config.path)
            .await
            .expect("a healthy candidate must stage");

        assert_eq!(staged, staged_restore_path(&config.path));
        assert_eq!(std::fs::read(&staged).unwrap(), candidate_before);
        // The candidate itself is left alone.
        assert_eq!(candidate_bytes(&candidate), candidate_before);
    });

    #[test]
    fn the_database_path_is_named_once() {
        let config = PathBuf::from("/tmp/config");
        assert_eq!(
            live_database_path(&config),
            PathBuf::from("/tmp/config").join(DATABASE_FILE_NAME)
        );
        assert_eq!(DATABASE_FILE_NAME, "work-journal.db");
        assert_ne!(staged_restore_path(&config), live_database_path(&config));
        assert_ne!(rollback_path(&config, UNIX_EPOCH), live_database_path(&config));
        assert_ne!(
            rollback_path(&config, UNIX_EPOCH),
            staged_restore_path(&config)
        );
    }

    #[test]
    fn a_rollback_name_carries_its_instant() {
        let instant = UNIX_EPOCH + Duration::from_secs(1_788_425_100);
        assert_eq!(
            rollback_file_name(instant),
            "work-journal-rollback-20260903T084500.db"
        );
    }

    async_test!(an_absent_staged_file_costs_nothing, {
        let config = TempDir::new("restore-absent");
        let live = live_database_path(&config.path);
        write_journal_file(&live, SUPPORTED_MIGRATION_VERSION, "the live journal").await;
        let live_before = std::fs::read(&live).unwrap();

        let outcome = apply_staged_restore(&config.path, SystemTime::now())
            .expect("an absent staged file must not fail");

        assert!(matches!(outcome, ApplyOutcome::Absent));
        assert_eq!(std::fs::read(&live).unwrap(), live_before);
    });

    async_test!(a_successful_replacement_keeps_the_previous_journal_as_a_rollback, {
        let config = TempDir::new("restore-replace");
        let live = live_database_path(&config.path);
        write_journal_file(&live, SUPPORTED_MIGRATION_VERSION, "the live journal").await;
        let live_before = std::fs::read(&live).unwrap();

        let elsewhere = TempDir::new("restore-replace-candidate");
        let candidate = healthy_candidate(&elsewhere, "candidate.db", "the earlier journal").await;
        let candidate_bytes = candidate_bytes(&candidate);
        stage_restore(&candidate, &config.path)
            .await
            .expect("staging must succeed");

        let now = UNIX_EPOCH + Duration::from_secs(1_788_425_100);
        let outcome = apply_staged_restore(&config.path, now).expect("apply must succeed");
        let rollback = match outcome {
            ApplyOutcome::Restored { rollback } => rollback.expect("a live journal must be kept"),
            ApplyOutcome::Absent => panic!("a staged file was present"),
        };

        // Byte-identical: the live journal is the candidate, whole.
        assert_eq!(std::fs::read(&live).unwrap(), candidate_bytes);
        // The previous journal survives, whole, and is never deleted by a
        // second apply with nothing staged.
        assert_eq!(std::fs::read(&rollback).unwrap(), live_before);
        assert_eq!(
            rollback.file_name().unwrap().to_string_lossy(),
            "work-journal-rollback-20260903T084500.db"
        );
        assert!(!staged_restore_path(&config.path).exists());
        let again = apply_staged_restore(&config.path, SystemTime::now()).expect("second apply");
        assert!(matches!(again, ApplyOutcome::Absent));
        assert!(rollback.exists());
    });

    async_test!(sidecars_travel_with_the_journal_they_belonged_to, {
        let config = TempDir::new("restore-sidecars");
        let live = live_database_path(&config.path);
        write_journal_file(&live, SUPPORTED_MIGRATION_VERSION, "the live journal").await;
        // A WAL-mode journal leaves these beside itself; they hold committed
        // transactions the main file alone does not contain, so deleting them
        // with the journal they belong to would silently lose commits.
        let wal = PathBuf::from(format!("{}-wal", live.display()));
        let shm = PathBuf::from(format!("{}-shm", live.display()));
        std::fs::write(&wal, "stale wal").unwrap();
        std::fs::write(&shm, "stale shm").unwrap();

        let elsewhere = TempDir::new("restore-sidecars-candidate");
        let candidate = healthy_candidate(&elsewhere, "candidate.db", "the earlier journal").await;
        let candidate_bytes = candidate_bytes(&candidate);
        stage_restore(&candidate, &config.path)
            .await
            .expect("staging must succeed");

        let now = UNIX_EPOCH + Duration::from_secs(1_788_425_100);
        let outcome = apply_staged_restore(&config.path, now).expect("apply must succeed");
        let rollback = match outcome {
            ApplyOutcome::Restored { rollback } => rollback.expect("a live journal must be kept"),
            ApplyOutcome::Absent => panic!("a staged file was present"),
        };

        // The live path holds the restored journal with no stale sidecars
        // beside it — applying the old journal's WAL to it is the corruption
        // case — while the rollback keeps its own history whole.
        assert_eq!(std::fs::read(&live).unwrap(), candidate_bytes);
        assert!(!wal.exists(), "the stale -wal must not outlive its journal");
        assert!(!shm.exists(), "the stale -shm must not outlive its journal");
        let rollback_wal = PathBuf::from(format!("{}-wal", rollback.display()));
        let rollback_shm = PathBuf::from(format!("{}-shm", rollback.display()));
        assert_eq!(std::fs::read(&rollback_wal).unwrap(), b"stale wal");
        assert_eq!(std::fs::read(&rollback_shm).unwrap(), b"stale shm");
    });

    async_test!(a_failed_sidecar_move_leaves_the_journal_as_it_was, {
        let config = TempDir::new("restore-sidecar-failure");
        let live = live_database_path(&config.path);
        write_journal_file(&live, SUPPORTED_MIGRATION_VERSION, "the live journal").await;
        let live_before = std::fs::read(&live).unwrap();
        let wal = PathBuf::from(format!("{}-wal", live.display()));
        let shm = PathBuf::from(format!("{}-shm", live.display()));
        std::fs::write(&wal, "stale wal").unwrap();
        std::fs::write(&shm, "stale shm").unwrap();

        let elsewhere = TempDir::new("restore-sidecar-failure-candidate");
        let candidate = healthy_candidate(&elsewhere, "candidate.db", "the earlier journal").await;
        let staged = stage_restore(&candidate, &config.path)
            .await
            .expect("staging must succeed");
        let staged_before = std::fs::read(&staged).unwrap();

        // A non-empty directory where the rollback `-shm` has to go makes
        // that rename fail after the `-wal` already moved.
        let now = UNIX_EPOCH + Duration::from_secs(1_788_425_100);
        let rollback_shm = PathBuf::from(format!(
            "{}-shm",
            rollback_path(&config.path, now).display()
        ));
        std::fs::create_dir_all(&rollback_shm).unwrap();
        std::fs::write(rollback_shm.join("junk"), "someone else's file").unwrap();

        let failure = apply_staged_restore(&config.path, now)
            .expect_err("a failed sidecar move must not restore");

        assert!(
            failure.contains("sidecar"),
            "a refusal names which check failed, got: {failure}"
        );
        // Everything is where it was: the live journal, both sidecars with
        // their bytes, and the staged file still waiting.
        assert_eq!(std::fs::read(&live).unwrap(), live_before);
        assert_eq!(std::fs::read(&wal).unwrap(), b"stale wal");
        assert_eq!(std::fs::read(&shm).unwrap(), b"stale shm");
        assert_eq!(std::fs::read(&staged).unwrap(), staged_before);
        assert!(!rollback_path(&config.path, now).exists());
    });

    async_test!(orphan_sidecars_do_not_survive_a_restore_without_a_live_journal, {
        // Narrow but real: the main file gone with its `-wal` still beside
        // the live path. Left there, the old WAL replays onto the restored
        // file — the restore silently does not happen and `quick_check`
        // still says ok.
        let config = TempDir::new("restore-orphans");
        let live = live_database_path(&config.path);
        assert!(!live.exists());
        let wal = PathBuf::from(format!("{}-wal", live.display()));
        let shm = PathBuf::from(format!("{}-shm", live.display()));
        std::fs::write(&wal, "orphan wal").unwrap();
        std::fs::write(&shm, "orphan shm").unwrap();

        let elsewhere = TempDir::new("restore-orphans-candidate");
        let candidate = healthy_candidate(&elsewhere, "candidate.db", "the earlier journal").await;
        let candidate_bytes = candidate_bytes(&candidate);
        stage_restore(&candidate, &config.path)
            .await
            .expect("staging must succeed");

        let outcome = apply_staged_restore(&config.path, SystemTime::now())
            .expect("apply must succeed");
        let rollback = match outcome {
            ApplyOutcome::Restored { rollback } => rollback,
            ApplyOutcome::Absent => panic!("a staged file was present"),
        };

        // No live journal, so nothing to keep — but the orphans are gone all
        // the same, and the live path holds the staged bytes whole.
        assert!(rollback.is_none());
        assert!(!wal.exists(), "the orphan -wal must be gone");
        assert!(!shm.exists(), "the orphan -shm must be gone");
        assert_eq!(std::fs::read(&live).unwrap(), candidate_bytes);
    });

    async_test!(an_older_snapshot_is_migrated_forward_after_replacement, {
        let config = TempDir::new("restore-migrate");
        let live = live_database_path(&config.path);
        write_journal_file(&live, SUPPORTED_MIGRATION_VERSION, "the live journal").await;

        let elsewhere = TempDir::new("restore-migrate-candidate");
        let candidate = elsewhere.path.join("candidate.db");
        write_journal_file(&candidate, SUPPORTED_MIGRATION_VERSION - 1, "the old journal").await;
        let old_url = format!("sqlite:{}?mode=rwc", candidate.display());
        let old = SqlitePool::connect(&old_url)
            .await
            .expect("could not open the older snapshot");
        sqlx::query(
            "INSERT INTO imported_meetings (event_key, handled_at)
             VALUES ('calendar-event@2026-09-21T09:30:00.000Z', '2026-09-21T18:40:00.000Z')",
        )
        .execute(&old)
        .await
        .expect("could not seed the old handled meeting");
        old.close().await;
        stage_restore(&candidate, &config.path)
            .await
            .expect("an older snapshot must stage");
        apply_staged_restore(&config.path, SystemTime::now()).expect("apply must succeed");

        // The existing immutable list brings the restored file forward: the
        // version 8 DDL — the same file `migrations()` in `lib.rs` serves
        // plugin-sql for version 8 — applies cleanly on top of it.
        let url = format!("sqlite:{}?mode=rwc", live.display());
        let pool = SqlitePool::connect(&url).await.expect("could not open");
        let migration: &str = include_str!("../migrations/0008_observed_note_origin_and_event_sources.sql");
        sqlx::query(migration)
            .execute(&pool)
            .await
            .expect("the older snapshot must be migratable to version 8");
        let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM handled_events")
            .fetch_one(&pool)
            .await
            .expect("the migrated table must read back");
        assert_eq!(count, 1);
        let (source, event_key): (String, String) =
            sqlx::query_as("SELECT source, event_key FROM handled_events")
                .fetch_one(&pool)
                .await
                .expect("the migrated handled event must read back");
        assert_eq!(source, "calendar");
        assert_eq!(event_key, "calendar-event@2026-09-21T09:30:00.000Z");
        pool.close().await;
    });

    async_test!(a_candidate_equal_to_the_staged_path_is_refused_without_truncating_it, {
        let config = TempDir::new("restore-self-stage");
        let elsewhere = TempDir::new("restore-self-stage-candidate");
        let candidate = healthy_candidate(&elsewhere, "candidate.db", "the journal").await;
        let staged = stage_restore(&candidate, &config.path)
            .await
            .expect("staging must succeed");
        let staged_before = std::fs::read(&staged).unwrap();
        assert!(!staged_before.is_empty());

        // Copying a file onto itself truncates it to zero bytes — validation
        // passes first, on the intact file, so the guard must come before
        // the copy.
        let refusal = stage_restore(&staged, &config.path)
            .await
            .expect_err("staging the staged file onto itself must not succeed");

        assert!(
            refusal.contains("staged"),
            "a refusal names which check failed, got: {refusal}"
        );
        assert_eq!(std::fs::read(&staged).unwrap(), staged_before);
    });

    async_test!(a_candidate_equal_to_the_live_path_is_refused, {
        let config = TempDir::new("restore-live-as-candidate");
        let live = live_database_path(&config.path);
        write_journal_file(&live, SUPPORTED_MIGRATION_VERSION, "the live journal").await;
        let live_before = std::fs::read(&live).unwrap();

        let refusal = stage_restore(&live, &config.path)
            .await
            .expect_err("staging the live journal must not succeed");

        assert!(
            refusal.contains("live"),
            "a refusal names which check failed, got: {refusal}"
        );
        assert_eq!(std::fs::read(&live).unwrap(), live_before);
        assert!(!staged_restore_path(&config.path).exists());
    });

    #[test]
    fn the_supported_version_tracks_the_migrations_list() {
        // Every future migration must raise the version boundary a restore
        // refuses on: the constant and the list have to move together, and
        // this is what holds them together.
        let newest = crate::migrations()
            .iter()
            .map(|migration| migration.version)
            .max()
            .expect("the app ships migrations");
        assert_eq!(SUPPORTED_MIGRATION_VERSION, newest);
    }

    async_test!(expected_schema_covers_the_real_schema_at_every_version, {
        // `expected_schema` is what validation trusts a restore candidate
        // against. Hand-written lists drift from the migrations that made
        // them, so this pins the check to the production schema at *every*
        // version — not just the newest, because an older snapshot is
        // accepted and must stay migratable. A migration that adds a table,
        // or a column to an existing table, without teaching `expected_schema`
        // fails here. The helper below hardcodes one entry per migration
        // file, and `.take()` truncates silently — so a ninth migration
        // would compare a v8 schema against `expected_schema(9)` and pass
        // exactly when the guard is needed. The lengths move together or this
        // fails first.
        assert_eq!(REAL_MIGRATIONS.len(), crate::migrations().len());
        use sqlx::Row;
        for version in 1..=SUPPORTED_MIGRATION_VERSION {
            let directory = TempDir::new(&format!("restore-real-schema-{version}"));
            let journal = directory.path.join("journal.db");
            write_journal_file(&journal, version, "the journal").await;
            let url = format!("sqlite:{}?mode=ro", journal.display());
            let pool = SqlitePool::connect(&url).await.expect("could not open");

            // The migrations table is sqlx's own; its presence is checked
            // separately, so the schema under comparison is the app's alone.
            let tables: HashSet<String> = sqlx::query(
                "SELECT name FROM sqlite_master
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_sqlx_migrations'",
            )
            .try_map(|row: sqlx::sqlite::SqliteRow| row.try_get(0))
            .fetch_all(&pool)
            .await
            .expect("the tables could not be read")
            .into_iter()
            .collect();

            let expected = expected_schema(version);
            let expected_tables: HashSet<&str> =
                expected.iter().map(|(table, _)| *table).collect();

            // The real schema holds exactly the tables the check expects for
            // the version — nothing more, nothing less.
            for table in &tables {
                assert!(
                    expected_tables.contains(table.as_str()),
                    "at version {version} the real schema holds {table}, which the check does not expect"
                );
            }
            for table in &expected_tables {
                assert!(
                    tables.contains(*table),
                    "at version {version} the check expects {table}, which the real schema does not hold"
                );
            }

            // And each expected table holds exactly the columns the check
            // demands: every one it names is really there, and no column the
            // migrations made is left out of the check.
            for (table, required) in expected {
                let held: HashSet<String> =
                    sqlx::query("SELECT name FROM pragma_table_info(?)")
                        .bind(table)
                        .try_map(|row: sqlx::sqlite::SqliteRow| row.try_get(0))
                        .fetch_all(&pool)
                        .await
                        .unwrap_or_else(|_| {
                            panic!("at version {version} the {table} columns could not be read")
                        })
                        .into_iter()
                        .collect();
                for column in required.iter() {
                    assert!(
                        held.contains(*column),
                        "at version {version} the check expects {table}.{column}, which the real schema does not hold"
                    );
                }
                for column in &held {
                    assert!(
                        required.contains(&column.as_str()),
                        "at version {version} the real schema holds {table}.{column}, which the check does not expect"
                    );
                }
            }
            pool.close().await;
        }
    });

    async_test!(a_real_schema_journal_missing_its_newest_table_is_refused, {
        let directory = TempDir::new("restore-real-missing");
        let journal = real_journal_file(&directory, "journal.db", "the journal").await;
        let url = format!("sqlite:{}?mode=rwc", journal.display());
        let pool = SqlitePool::connect(&url).await.expect("could not open");
        sqlx::query("DROP TABLE task_occurrences;")
            .execute(&pool)
            .await
            .expect("could not drop");
        pool.close().await;

        let refusal = validate_restore_candidate(&journal)
            .await
            .expect_err("a real journal missing a table must not validate");

        assert!(
            refusal.contains("missing tables") && refusal.contains("task_occurrences"),
            "a refusal names which check failed, got: {refusal}"
        );
    });

    async_test!(a_snapshot_round_trips_byte_identical_through_validate_stage_apply, {
        // Done criterion: a backup taken by the snapshot path restores to a
        // byte-identical journal — through the real schema, not hand DDL.
        let source = TempDir::new("round-trip-source");
        let source_path = source.path.join("work-journal.db");
        let url = format!("sqlite:{}?mode=rwc", source_path.display());
        let pool = SqlitePool::connect(&url)
            .await
            .expect("could not create the source journal");
        seed_real_schema(&pool, SUPPORTED_MIGRATION_VERSION, "the snapshot note").await;
        sqlx::query(
            "INSERT INTO notes (
                 id, body, captured_at, journal_day, edited_at, origin, source, source_key
             ) VALUES (
                 'observed', 'shipped the migration', '2026-09-22T09:30:00.000Z',
                 '2026-09-22', NULL, 'observe', 'work-journal-ai', '6f47772'
             )",
        )
        .execute(&pool)
        .await
        .expect("could not seed the Observed Note");
        sqlx::query(
            "INSERT INTO handled_events (source, event_key, handled_at)
             VALUES ('work-journal-ai', '6f47772', '2026-09-22T10:00:00.000Z')",
        )
        .execute(&pool)
        .await
        .expect("could not seed the handled event");

        let elsewhere = TempDir::new("round-trip-snapshot");
        let snapshot = elsewhere.path.join("work-journal-20260903T084500.db");
        take_snapshot(&snapshot, &pool)
            .await
            .expect("the snapshot failed");
        pool.close().await;
        let snapshot_bytes = std::fs::read(&snapshot).unwrap();

        let version = validate_restore_candidate(&snapshot)
            .await
            .expect("a snapshot taken by this app must validate");
        assert_eq!(version, SUPPORTED_MIGRATION_VERSION);

        let config = TempDir::new("round-trip-config");
        let live = live_database_path(&config.path);
        write_journal_file(&live, SUPPORTED_MIGRATION_VERSION, "the live journal").await;
        let live_before = std::fs::read(&live).unwrap();

        stage_restore(&snapshot, &config.path)
            .await
            .expect("the snapshot must stage");
        let now = UNIX_EPOCH + Duration::from_secs(1_788_425_100);
        let outcome = apply_staged_restore(&config.path, now).expect("apply must succeed");
        let rollback = match outcome {
            ApplyOutcome::Restored { rollback } => rollback.expect("a live journal must be kept"),
            ApplyOutcome::Absent => panic!("a staged file was present"),
        };

        assert_eq!(std::fs::read(&live).unwrap(), snapshot_bytes);
        assert_eq!(std::fs::read(&rollback).unwrap(), live_before);

        // The restored journal opens standalone with the snapshot's rows.
        let url = format!("sqlite:{}?mode=ro", live.display());
        let restored = SqlitePool::connect(&url).await.expect("did not open");
        let (body,): (String,) = sqlx::query_as("SELECT body FROM notes WHERE id = 'n1'")
            .fetch_one(&restored)
            .await
            .expect("the snapshot Note did not read back");
        assert_eq!(body, "the snapshot note");
        let (source, source_key, origin): (String, String, String) = sqlx::query_as(
            "SELECT source, source_key, origin FROM notes WHERE id = 'observed'",
        )
        .fetch_one(&restored)
        .await
        .expect("the Observed Note did not read back");
        assert_eq!(source, "work-journal-ai");
        assert_eq!(source_key, "6f47772");
        assert_eq!(origin, "observe");
        let (handled_source, handled_key): (String, String) = sqlx::query_as(
            "SELECT source, event_key FROM handled_events",
        )
        .fetch_one(&restored)
        .await
        .expect("the handled event did not read back");
        assert_eq!(handled_source, "work-journal-ai");
        assert_eq!(handled_key, "6f47772");
        restored.close().await;
    });

    async_test!(a_copy_failure_mid_stage_leaves_no_staged_file_and_apply_is_a_noop, {
        // A copy that fails partway must never leave a truncated file at the
        // staged path: the next ordinary launch must find nothing to apply
        // and leave the live journal exactly as it was.
        let config = TempDir::new("restore-partial-stage");
        let live = live_database_path(&config.path);
        write_journal_file(&live, SUPPORTED_MIGRATION_VERSION, "the live journal").await;
        let live_before = std::fs::read(&live).unwrap();

        let elsewhere = TempDir::new("restore-partial-candidate");
        let candidate = healthy_candidate(&elsewhere, "candidate.db", "the journal").await;

        let failure = stage_restore_with_copy(&candidate, &config.path, |_from, to| {
            std::fs::write(to, b"partial")?;
            Err(io::Error::other("injected copy failure"))
        })
        .await
        .expect_err("a copy failure must not stage");

        assert!(
            failure.contains("could not be staged"),
            "a staging failure names the stage, got: {failure}"
        );
        assert!(
            !staged_restore_path(&config.path).exists(),
            "a partial copy must never occupy the staged path"
        );
        assert!(
            !staged_temp_path(&staged_restore_path(&config.path)).exists(),
            "a partial copy must not linger as a temp file"
        );
        assert_eq!(std::fs::read(&live).unwrap(), live_before);

        let outcome = apply_staged_restore(&config.path, SystemTime::now())
            .expect("apply with nothing staged must not fail");
        assert!(matches!(outcome, ApplyOutcome::Absent));
        assert_eq!(std::fs::read(&live).unwrap(), live_before);
    });

    async_test!(a_failed_second_stage_keeps_the_first_staged_file, {
        // Atomic replacement: a second stage that fails partway keeps the
        // first staged file whole, so the next launch restores the first
        // candidate rather than a truncation.
        let config = TempDir::new("restore-partial-second");
        let live = live_database_path(&config.path);
        write_journal_file(&live, SUPPORTED_MIGRATION_VERSION, "the live journal").await;

        let first_dir = TempDir::new("restore-partial-first");
        let first = healthy_candidate(&first_dir, "first.db", "the first journal").await;
        let staged = stage_restore(&first, &config.path)
            .await
            .expect("the first stage must succeed");
        let staged_before = std::fs::read(&staged).unwrap();

        let second_dir = TempDir::new("restore-partial-second-candidate");
        let second = healthy_candidate(&second_dir, "second.db", "the second journal").await;
        let failure = stage_restore_with_copy(&second, &config.path, |_from, to| {
            std::fs::write(to, b"partial")?;
            Err(io::Error::other("injected copy failure"))
        })
        .await
        .expect_err("a copy failure must not stage");

        assert!(
            failure.contains("could not be staged"),
            "a staging failure names the stage, got: {failure}"
        );
        assert_eq!(
            std::fs::read(&staged).unwrap(),
            staged_before,
            "a failed stage must leave the previous staged file whole"
        );
    });
}
