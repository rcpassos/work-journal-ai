# A Backup is a SQLite snapshot, taken with VACUUM INTO, and never a file copy

Export writes prose, so a Markdown file carries no Note ID, no Captured At, no
Task ID and no recurrence anchor — it is the way out of the journal, not a way
back into it, and nothing filled the slot its own _Avoid_ list reserved for
"Backup". A backup is a snapshot of the SQLite journal itself: every table, the
rows as stored, and `_sqlx_migrations` with them, so the schema a snapshot
carries is readable rather than guessed at.

A snapshot is taken with `VACUUM INTO` through the pool `tauri-plugin-sql`
already has open — the same one `journal_transaction` reaches through
`DbInstances` / `DbPool::Sqlite` — and never by copying `work-journal.db` while
the app runs. A raw copy races the journal's own writes and, with a WAL-mode
database, hands over a file whose sidecar holds committed transactions the copy
does not contain. `VACUUM INTO` is atomic and mode-agnostic: the source may be
in `wal` or in rollback-journal mode — nothing in this repository sets that
pragma, sqlx deliberately does not either, and which one an install has depends
on how its file was created — and the snapshot comes out consistent either way.
The destination is a bound parameter (`VACUUM INTO ?`), never an interpolated
path; a SQLite version that refuses a bound target stops this design rather
than bending it into string formatting.

"The pool already has open" is made true by the plugin's own config:
`plugins.sql.preload` names `sqlite:work-journal.db` in `tauri.conf.json`, so
the plugin's `initialize` — which runs before the app's `setup` — connects the
pool and applies the migrations before any window or command can ask for them.
Without that line nothing had ever asked the plugin to open the database until
a webview called `Database.load`, which is after the first paint: the snapshot
task spawned in `setup` would find `DbInstances` empty on every launch and the
automatic backup would never run at all. The preload also makes the ordering
claim below literal — migrations have finished before `setup` runs anything.

A Backup contains the journal and nothing else. The API Key lives in the
Keychain (ADR 0026) and never enters a snapshot; settings, Hotkeys and the
login-item answer live in `settings.json` and are not journal. Restoring a
snapshot is #161's problem; nothing here renames, replaces or deletes
`work-journal.db` itself.

## Considered options

- **A raw file copy.** Rejected: unsafe with a live WAL — the copy can miss
  transactions still in `-wal` — and it carries mode-specific sidecars.
- **`sqlite3` CLI or a second sqlx connection.** Rejected: a second connection
  to the file is a second writer to coordinate, and the plugin's pool is
  already open and already migrated. `VACUUM INTO` on the existing pool has no
  ordering hazard with migrations and no new dependency.
- **Scheduled snapshots on a timer.** Rejected: a backup that only happens on a
  schedule misses the launch that matters (the one after a crash) and needs a
  scheduling UI to explain itself. Snapshots are taken at startup when the
  newest is older than the interval, and the numbers — the interval and the
  retention count — are constants, not settings. The journal is tens of
  kilobytes; thirty snapshots is a couple of megabytes and not a policy
  question.

## Consequences

- **Automatic snapshots live in `app_config_dir()/backups/`, beside the
  journal, and are therefore not disaster recovery.** Same disk, same directory
  tree: they do not survive a failed disk, and nothing in the app may claim
  otherwise.
- **The offsite path is the manual backup**, and it goes wherever the user says
  through a native save dialog — iCloud, an external drive, anywhere off this
  disk. That is the whole reason the manual one exists beside the automatic
  one: a fixed destination would make the two differ only in timing. Choosing
  where and writing there are two Desktop operations (`chooseBackupLocation`,
  `backupJournal`), one gesture to the user and two moments to the app, the
  same split `installUpdate` and `restart` already make.
- **The overwrite question is asked once, by the save dialog, and the answer
  is never second-guessed with a refusal.** The dialog is the one that shows
  "Replace?"; a command that then answers `path.exists()` with a hard error
  would turn the user's own confirmation into "Could not back up the
  journal." A name nevertheless taken by the time the write runs — or a
  dialog whose Replace the user accepted — is settled beside, `-2.db`,
  `-3.db`, exactly as export's `free_path` does, and `VACUUM INTO` could not
  overwrite a file in any case without deleting it first, which a backup
  must never do. Nothing on disk is replaced, renamed or deleted to make
  room for a snapshot, and `BackupResult` carries the settled path so the
  toast names the file that is really there.
- **The filename carries its instant**: `work-journal-YYYYMMDDTHHMMSS.db`, UTC,
  parsed back to the instant it names — pruning reads it rather than the file
  system's mtime. The extension is `.db`; a backup is a SQLite file, not a
  document.
- **Retention keeps the newest N and touches nothing else**: only files that
  parse as a snapshot's own name are ever pruned, and an unrelated file in the
  backups directory is left exactly where it is.
- **A failed snapshot is a log line, never a dialog.** Startup must not block,
  delay a window, or put an error in front of the user on launch because a
  backup could not be taken; pruning happens only after a successful snapshot,
  never before.
  The line reaches a file: the logger is registered in every build, ahead of
  the restore plugin, with a file target in the app's log directory — without
  one the `log` crate drops every record and the line says nothing.
- **Every future migration raises the newest schema version a backup can
  carry.** This issue only has to keep `_sqlx_migrations` inside the snapshot
  so that boundary is readable at all; #161 validates it on the way back in.
