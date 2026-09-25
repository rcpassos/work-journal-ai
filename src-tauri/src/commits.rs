//! The commits a person wrote in a repository on this machine, read and never
//! written.
//!
//! Nothing here decides anything. Which repositories are read, whose commits
//! count, since when, and what becomes a Note are all the journal's; this
//! module answers two questions and no others: what did these identities
//! commit since then, and who has been committing here lately.
//!
//! **Read by the system `git`, read-only.** Every call sets
//! `GIT_OPTIONAL_LOCKS=0` and `GIT_TERMINAL_PROMPT=0`, and none of them is
//! `fetch`, `pull` or anything else that reaches a remote — so what is read is
//! what this machine already has. No hook is installed, no ref moved, no
//! config touched; the tests below snapshot every fixture before and after to
//! hold that.
//!
//! **Which ref.** `origin/HEAD` as this machine has it, then the current
//! branch's upstream, then `HEAD`. A fetch advances the remote-tracking branch
//! without advancing the local one, so reading the local branch could miss for
//! good work a fetch had already brought here. `origin/HEAD` is only set by a
//! clone, which is why a remote added by hand falls through to the upstream.
//!
//! **First-parent.** On a squash-merge workflow that is one commit per merged
//! pull request, and the branch commits behind it are never read. It follows
//! ancestry, though, and knows nothing of pull requests: a branch merged by
//! fast-forward or rebase puts every one of its commits on first-parent, and
//! each is read. A merge commit authored by somebody else is filtered out by
//! authorship, so the user's work behind it is not read at all. Both are what
//! the history says happened, and both are accepted rather than corrected for.
//!
//! **Authorship is a set** of addresses, matched on the address alone and
//! regardless of case. **Dates are author dates**, filtered here rather than
//! by `--since`, which prunes by committer date — a rebase moves that, and the
//! work did not move with it — and which cannot even narrow the walk: git
//! stops at the first commit older than its date and reads nothing behind
//! that one, so a tip committed before the lookback would hide the work under
//! it, on every walk that ever met the tip.
//!
//! **A repository is its common directory**, which every worktree of it
//! shares: one project reached through three directories is one repository.
//!
//! The wire shapes are a two-sided contract with `src/platform/desktop.ts`, as
//! `src/platform/desktop-rust.test.ts` checks.

use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

/// One commit, as the journal will read it. Must match `Commit` in
/// `src/platform/desktop.ts`, as `src/platform/desktop-rust.test.ts` checks.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    /// The subject, verbatim.
    pub subject: String,
    /// The author date, in milliseconds since the epoch — when the work was
    /// done, which a rebase or a squash-merge on a server does not move.
    pub authored_at: f64,
    /// The repository's identity: its common directory, the same from every
    /// worktree of it.
    pub repository: String,
}

/// Why a repository could not be read — an ordinary answer about that one
/// repository, never a failure of the reader. Must match
/// `RepositoryUnreadable` in `src/platform/desktop.ts`, as
/// `src/platform/desktop-rust.test.ts` checks.
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RepositoryUnreadable {
    /// Nothing is at the path any more.
    Missing,
    /// Something is there, and it is not in a repository.
    NotARepository,
    /// A repository with nothing to read yet: no commit at any of the refs.
    NoHead,
    /// The path, or a folder on the way to it, is one the app may not open —
    /// on macOS, typically a folder whose access was refused. Still there,
    /// unlike `Missing`.
    Denied,
    /// `git` could not be run, or failed in a way that says nothing about
    /// the repository.
    GitUnavailable,
}

/// The commits, or why there are none to read. Must match `CommitsRead` in
/// `src/platform/desktop.ts`, as `src/platform/desktop-rust.test.ts` checks.
#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum CommitsRead {
    /// Newest first along first-parent.
    Read {
        commits: Vec<Commit>,
    },
    Unreadable {
        reason: RepositoryUnreadable,
    },
}

/// Who might be the user here, or why the repository could not be asked.
/// Must match `IdentitiesRead` in `src/platform/desktop.ts`, as
/// `src/platform/desktop-rust.test.ts` checks.
#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum IdentitiesRead {
    Read {
        repository: String,
        /// `git config user.email` first, then the recent first-parent
        /// authors, most recent first, each address once. Suggestions only:
        /// nothing counts as the user until the user says so.
        identities: Vec<String>,
        /// Why nothing can be read from this repository yet, beside the
        /// suggestions above: `NoHead`, the one reason that leaves them worth
        /// offering, and the very reason the commit read gives. None when its
        /// commits can be read. This is how Settings hears it — the sweep's
        /// own answer never reaches the section.
        reason: Option<RepositoryUnreadable>,
    },
    Unreadable {
        reason: RepositoryUnreadable,
    },
}

/// The commits `identities` authored at or after `since` (milliseconds since
/// the epoch), along first-parent of the ref this machine has the latest of.
/// No identities is nobody's commits, not everybody's.
pub fn read(path: &Path, identities: &[String], since: f64) -> CommitsRead {
    Git::SYSTEM.read(path, identities, since)
}

/// How far back suggestions look for authors. Must match
/// `SUGGESTION_LOOKBACK` in `src/platform/testing/desktop.ts`, as
/// `src/platform/desktop-rust.test.ts` checks.
const SUGGESTION_LOOKBACK: f64 = 90.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// The addresses that might be the user in this repository: the configured
/// one, and whoever authored first-parent commits in the last ninety days.
pub fn identities(path: &Path) -> IdentitiesRead {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as f64)
        .unwrap_or(0.0);
    Git::SYSTEM.identities(path, now - SUGGESTION_LOOKBACK)
}

/// The `git` every call goes through. A seam only so the tests can name a
/// program that is not there.
struct Git {
    program: &'static str,
}

impl Git {
    const SYSTEM: Git = Git { program: "git" };

    fn read(&self, path: &Path, identities: &[String], since: f64) -> CommitsRead {
        match self.commits(path, identities, since) {
            Ok(commits) => CommitsRead::Read { commits },
            Err(reason) => CommitsRead::Unreadable { reason },
        }
    }

    fn identities(&self, path: &Path, since: f64) -> IdentitiesRead {
        match self.candidates(path, since) {
            Ok((repository, identities, reason)) => IdentitiesRead::Read {
                repository,
                identities,
                reason,
            },
            Err(reason) => IdentitiesRead::Unreadable { reason },
        }
    }

    fn commits(
        &self,
        path: &Path,
        identities: &[String],
        since: f64,
    ) -> Result<Vec<Commit>, RepositoryUnreadable> {
        let repository = self.repository(path)?;
        let tip = self.tip(path)?.ok_or(RepositoryUnreadable::NoHead)?;
        // Without an `--author`, `git log` answers with everybody's.
        if identities.is_empty() {
            return Ok(Vec::new());
        }

        // Fixed strings, so an address is the address and not a pattern, and
        // wrapped in the brackets git writes it in, so it is anchored on the
        // whole address rather than found inside a longer one.
        let authors: Vec<String> = identities
            .iter()
            .map(|identity| format!("--author=<{identity}>"))
            .collect();
        let mut args = vec![
            "log",
            "--first-parent",
            "--fixed-strings",
            "--regexp-ignore-case",
            "--no-mailmap",
            "--no-show-signature",
            "-z",
            "--format=%H%x00%at%x00%s",
        ];
        args.extend(authors.iter().map(String::as_str));
        args.extend([tip.as_str(), "--"]);

        let log = self.succeed(path, &args)?;
        records(&log, 3)
            .into_iter()
            .map(|record| {
                Some(Commit {
                    hash: record[0].to_string(),
                    subject: record[2].to_string(),
                    authored_at: milliseconds(record[1])?,
                    repository: repository.clone(),
                })
            })
            .collect::<Option<Vec<_>>>()
            .map(|commits| {
                commits
                    .into_iter()
                    .filter(|c| c.authored_at >= since)
                    .collect()
            })
            .ok_or(RepositoryUnreadable::GitUnavailable)
    }

    fn candidates(
        &self,
        path: &Path,
        since: f64,
    ) -> Result<(String, Vec<String>, Option<RepositoryUnreadable>), RepositoryUnreadable> {
        let repository = self.repository(path)?;

        // Unset is an answer too: exit 1 and nothing said.
        let configured = self.run(path, &["config", "--get", "user.email"])?;
        let mut identities: Vec<String> = String::from_utf8_lossy(&configured.stdout)
            .split_whitespace()
            .map(str::to_string)
            .collect();

        // A repository with nothing committed yet still has a configured
        // address worth offering — and says so beside them, as the reason the
        // commit read gives for there being nothing to read.
        let tip = self.tip(path)?;
        if let Some(tip) = tip.as_deref() {
            let log = self.succeed(
                path,
                &[
                    "log",
                    "--first-parent",
                    "--no-mailmap",
                    "--no-show-signature",
                    "-z",
                    "--format=%at%x00%ae",
                    tip,
                    "--",
                ],
            )?;
            let mut authors = Vec::new();
            for record in records(&log, 2) {
                let authored_at =
                    milliseconds(record[0]).ok_or(RepositoryUnreadable::GitUnavailable)?;
                if authored_at >= since {
                    authors.push((authored_at, record[1].to_string()));
                }
            }
            // Most recent by author date, which a rebase leaves out of walk
            // order; stable, so a tie keeps the order the walk met it in.
            authors.sort_by(|a, b| b.0.total_cmp(&a.0));
            identities.extend(authors.into_iter().map(|(_, author)| author));
        }

        // An address is the same address in any case, as the reader matches
        // it; the first spelling met is the one offered.
        let mut seen = HashSet::new();
        identities.retain(|identity| !identity.is_empty() && seen.insert(identity.to_lowercase()));
        Ok((
            repository,
            identities,
            tip.is_none().then_some(RepositoryUnreadable::NoHead),
        ))
    }

    /// The repository's identity: its common directory, which every worktree
    /// of it shares, canonical so a symlinked path is the same repository.
    fn repository(&self, path: &Path) -> Result<String, RepositoryUnreadable> {
        // `exists` answers false for a path it was refused a look at, too.
        match path.try_exists() {
            Ok(true) => {}
            Ok(false) => return Err(RepositoryUnreadable::Missing),
            Err(_) => return Err(RepositoryUnreadable::Denied),
        }
        if !path.is_dir() {
            return Err(RepositoryUnreadable::NotARepository);
        }
        // A macOS privacy refusal lets a folder be found and entered and
        // refuses what is in it, so git would call it "not a git repository".
        // Reading it is the question that tells the two apart — EACCES and
        // EPERM alike come back as `PermissionDenied`.
        if let Err(error) = std::fs::read_dir(path) {
            if error.kind() == std::io::ErrorKind::PermissionDenied {
                return Err(RepositoryUnreadable::Denied);
            }
        }

        let output = self.run(
            path,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )?;
        if !output.status.success() {
            let said = String::from_utf8_lossy(&output.stderr);
            return Err(if said.contains("not a git repository") {
                RepositoryUnreadable::NotARepository
            } else {
                RepositoryUnreadable::GitUnavailable
            });
        }

        let common = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim_end());
        let common = common.canonicalize().unwrap_or(common);
        Ok(common.display().to_string())
    }

    /// The commit to walk back from: `origin/HEAD`, then the current branch's
    /// upstream, then `HEAD` — the first this machine can resolve to a
    /// commit, as a hash. None when not one of them can be.
    fn tip(&self, path: &Path) -> Result<Option<String>, RepositoryUnreadable> {
        for candidate in ["refs/remotes/origin/HEAD", "@{upstream}", "HEAD"] {
            let target = format!("{candidate}^{{commit}}");
            let output = self.run(path, &["rev-parse", "--verify", "--quiet", &target])?;
            if output.status.success() {
                return Ok(Some(
                    String::from_utf8_lossy(&output.stdout).trim().to_string(),
                ));
            }
        }
        Ok(None)
    }

    /// Runs one read-only `git` call in `path`, answering with what it said
    /// only if it succeeded.
    fn succeed(&self, path: &Path, args: &[&str]) -> Result<String, RepositoryUnreadable> {
        let output = self.run(path, args)?;
        if !output.status.success() {
            return Err(RepositoryUnreadable::GitUnavailable);
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    /// Runs one `git` call in `path`. Never one that writes or reaches a
    /// remote: optional locks — the index refresh `status` would write — are
    /// off, a prompt can never be put up, git speaks untranslated, and any
    /// repository the environment
    /// names is dropped so the one at `path` is what is read.
    fn run(&self, path: &Path, args: &[&str]) -> Result<Output, RepositoryUnreadable> {
        Command::new(self.program)
            .arg("-C")
            .arg(path)
            .args(args)
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            // English, whatever git was built to say: "not a git repository"
            // is read off its error.
            .env("LC_ALL", "C")
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_COMMON_DIR")
            .env_remove("GIT_INDEX_FILE")
            .stdin(Stdio::null())
            .output()
            .map_err(|_| RepositoryUnreadable::GitUnavailable)
    }
}

/// `-z` output cut into records of `fields` NUL-separated fields each. Every
/// record, the last included, ends in one more NUL.
fn records(output: &str, fields: usize) -> Vec<Vec<&str>> {
    let body = output.strip_suffix('\0').unwrap_or(output);
    if body.is_empty() {
        return Vec::new();
    }
    let values: Vec<&str> = body.split('\0').collect();
    values.chunks_exact(fields).map(<[&str]>::to_vec).collect()
}

/// Epoch seconds, as `%at` writes them, in the milliseconds the webview
/// counts in.
fn milliseconds(seconds: &str) -> Option<f64> {
    seconds
        .parse::<i64>()
        .ok()
        .map(|seconds| (seconds * 1000) as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    /// A directory of this run's own, removed when the test is done with it.
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(name: &str) -> Self {
            // Tests run in parallel in one process, so a counter makes every
            // call's directory its own.
            use std::sync::atomic::{AtomicU64, Ordering};
            static CALLS: AtomicU64 = AtomicU64::new(0);
            let call = CALLS.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "work-journal-commits-{name}-{}-{call}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("could not make a temporary directory");
            // Canonical, because macOS reaches the temporary directory through
            // a symlink and git reports where it really is.
            let path = path.canonicalize().expect("could not resolve it");
            TempDir { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    const ME: &str = "r.passos@outlook.pt";
    const ME_ON_GITHUB: &str = "81316043+rp-pipecodes@users.noreply.github.com";
    const MAINTAINER: &str = "maintainer@example.com";

    /// An hour, in seconds. Fixture dates are counted in these from `DAY`.
    const HOUR: i64 = 3600;
    /// 14 September 2026, 00:00 UTC.
    const DAY: i64 = 1_789_344_000;

    fn at(hours: i64) -> f64 {
        ((DAY + hours * HOUR) * 1000) as f64
    }

    /// Runs `git` to build a fixture — never the reader's own calls. Global
    /// and system configuration are shut out so a signing or hook setting on
    /// this machine cannot change what a fixture is.
    fn git(dir: &Path, args: &[&str]) -> String {
        git_as(dir, ME, DAY, DAY, args)
    }

    fn git_as(dir: &Path, author: &str, authored: i64, committed: i64, args: &[&str]) -> String {
        let output = Command::new("git")
            .current_dir(dir)
            .args(args)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "Author")
            .env("GIT_AUTHOR_EMAIL", author)
            .env("GIT_AUTHOR_DATE", format!("@{authored} +0000"))
            .env("GIT_COMMITTER_NAME", "Committer")
            .env("GIT_COMMITTER_EMAIL", author)
            .env("GIT_COMMITTER_DATE", format!("@{committed} +0000"))
            .stdin(Stdio::null())
            .output()
            .expect("git could not be run");
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn init(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "--quiet", "--initial-branch=main"]);
    }

    /// One commit touching a file of its own, authored by `author` at `hours`
    /// past `DAY` and committed then too.
    fn commit(dir: &Path, author: &str, hours: i64, subject: &str) -> String {
        commit_at(dir, author, hours, hours, subject)
    }

    fn commit_at(dir: &Path, author: &str, authored: i64, committed: i64, subject: &str) -> String {
        let file = subject.replace(|c: char| !c.is_alphanumeric(), "-");
        std::fs::write(dir.join(file), subject).unwrap();
        let (authored, committed) = (DAY + authored * HOUR, DAY + committed * HOUR);
        git_as(dir, author, authored, committed, &["add", "--all"]);
        git_as(
            dir,
            author,
            authored,
            committed,
            &["commit", "--quiet", "-m", subject],
        );
        git(dir, &["rev-parse", "HEAD"])
    }

    fn read_by(path: &Path, identities: &[&str], since: f64) -> CommitsRead {
        let identities: Vec<String> = identities.iter().map(|i| i.to_string()).collect();
        read(path, &identities, since)
    }

    fn identities_since(path: &Path, since: f64) -> IdentitiesRead {
        Git::SYSTEM.identities(path, since)
    }

    fn subjects(answer: &CommitsRead) -> Vec<&str> {
        match answer {
            CommitsRead::Read { commits } => commits.iter().map(|c| c.subject.as_str()).collect(),
            CommitsRead::Unreadable { reason } => panic!("unreadable: {reason:?}"),
        }
    }

    fn reason(answer: &CommitsRead) -> RepositoryUnreadable {
        match answer {
            CommitsRead::Unreadable { reason } => *reason,
            CommitsRead::Read { commits } => panic!("read {commits:?}"),
        }
    }

    /// Every file under `dir`, with its contents — what "nothing was
    /// written" is checked against.
    fn snapshot(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut files = BTreeMap::new();
        let mut pending = vec![dir.to_path_buf()];
        while let Some(next) = pending.pop() {
            for entry in std::fs::read_dir(&next).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    pending.push(path);
                } else {
                    files.insert(path.clone(), std::fs::read(&path).unwrap());
                }
            }
        }
        files
    }

    /// A project on a server that squash-merges, and this machine's clone of
    /// it. The server is an ordinary repository, so the fixture can commit
    /// straight onto its `main` the way a merge button would.
    struct Cloned {
        _root: TempDir,
        server: PathBuf,
        clone: PathBuf,
    }

    fn cloned(name: &str, build: impl FnOnce(&Path)) -> Cloned {
        let root = TempDir::new(name);
        let server = root.path.join("server");
        let clone = root.path.join("clone");
        init(&server);
        build(&server);
        git(&root.path, &["clone", "--quiet", "server", "clone"]);
        Cloned {
            _root: root,
            server,
            clone,
        }
    }

    #[test]
    fn a_squash_merged_pull_request_is_one_commit_and_its_branch_commits_none() {
        let repo = cloned("squash", |server| {
            commit(server, ME, 1, "Start");
            git(server, &["switch", "--quiet", "-c", "scrollbar"]);
            commit(server, ME, 2, "Try a fix");
            commit(server, ME, 3, "Fix the second scrollbar on Settings");
            git(server, &["switch", "--quiet", "main"]);
            git(server, &["merge", "--squash", "--quiet", "scrollbar"]);
            git_as(
                server,
                ME,
                DAY + 4 * HOUR,
                DAY + 4 * HOUR,
                &[
                    "commit",
                    "--quiet",
                    "-m",
                    "Fix the second scrollbar on Settings (#256)",
                ],
            );
        });

        let answer = read_by(&repo.clone, &[ME], at(0));

        assert_eq!(
            subjects(&answer),
            ["Fix the second scrollbar on Settings (#256)", "Start"]
        );
    }

    #[test]
    fn a_merge_commit_by_somebody_else_is_not_the_users_and_neither_is_what_it_hides() {
        let repo = cloned("merge-commit", |server| {
            commit(server, MAINTAINER, 1, "Start");
            git(server, &["switch", "--quiet", "-c", "feature"]);
            commit(server, ME, 2, "Add the reader");
            git(server, &["switch", "--quiet", "main"]);
            commit(server, MAINTAINER, 3, "Tidy the README");
            git_as(
                server,
                MAINTAINER,
                DAY + 4 * HOUR,
                DAY + 4 * HOUR,
                &[
                    "merge",
                    "--no-ff",
                    "--quiet",
                    "-m",
                    "Merge branch 'feature'",
                    "feature",
                ],
            );
        });

        let answer = read_by(&repo.clone, &[ME], at(0));

        assert_eq!(subjects(&answer), Vec::<&str>::new());
        // The maintainer's own view of the same history, to show the merge is
        // on first-parent and was filtered by authorship, not by the walk.
        assert_eq!(
            subjects(&read_by(&repo.clone, &[MAINTAINER], at(0))),
            ["Merge branch 'feature'", "Tidy the README", "Start"],
        );
    }

    #[test]
    fn a_fast_forwarded_branch_is_each_of_its_own_commits() {
        let repo = cloned("fast-forward", |server| {
            commit(server, ME, 1, "Start");
            git(server, &["switch", "--quiet", "-c", "feature"]);
            commit(server, ME, 2, "One");
            commit(server, ME, 3, "Two");
            commit(server, ME, 4, "Three");
            git(server, &["switch", "--quiet", "main"]);
            git(server, &["merge", "--ff-only", "--quiet", "feature"]);
        });

        let answer = read_by(&repo.clone, &[ME], at(0));

        assert_eq!(subjects(&answer), ["Three", "Two", "One", "Start"]);
    }

    #[test]
    fn a_rebased_branch_is_each_of_its_commits_on_the_day_they_were_authored() {
        let repo = cloned("rebase", |server| {
            commit(server, ME, -48, "Start");
            git(server, &["switch", "--quiet", "-c", "feature"]);
            // Written two days ago and yesterday; rebased today, which moves
            // their committer dates to today and leaves their author dates.
            commit(server, ME, -30, "Written two days ago");
            commit(server, ME, -6, "Written yesterday");
            git(server, &["switch", "--quiet", "main"]);
            commit(server, MAINTAINER, 1, "Somebody else's");
            git(server, &["switch", "--quiet", "feature"]);
            git_as(
                server,
                ME,
                DAY + 2 * HOUR,
                DAY + 2 * HOUR,
                &["rebase", "--quiet", "main"],
            );
            git(server, &["switch", "--quiet", "main"]);
            git(server, &["merge", "--ff-only", "--quiet", "feature"]);
        });

        assert_eq!(
            subjects(&read_by(&repo.clone, &[ME], at(-48))),
            ["Written yesterday", "Written two days ago", "Start"],
        );
        // Since yesterday morning by author date, although all of it was
        // committed today.
        assert_eq!(
            subjects(&read_by(&repo.clone, &[ME], at(-24))),
            ["Written yesterday"]
        );
    }

    #[test]
    fn commits_are_authored_at_or_after_the_instant() {
        let root = TempDir::new("since");
        init(&root.path);
        commit(&root.path, ME, 1, "Before");
        commit(&root.path, ME, 2, "Exactly then");
        commit(&root.path, ME, 3, "After");

        assert_eq!(
            subjects(&read_by(&root.path, &[ME], at(2))),
            ["After", "Exactly then"]
        );
    }

    #[test]
    fn a_commit_carries_its_hash_subject_author_date_and_repository() {
        let root = TempDir::new("fields");
        init(&root.path);
        let hash = commit_at(&root.path, ME, 5, 9, "add check for updates to tray menu");

        let CommitsRead::Read { commits } = read_by(&root.path, &[ME], at(0)) else {
            panic!("unreadable")
        };

        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].hash, hash);
        assert_eq!(commits[0].subject, "add check for updates to tray menu");
        assert_eq!(commits[0].authored_at, at(5));
        assert_eq!(
            commits[0].repository,
            root.path.join(".git").display().to_string()
        );
    }

    #[test]
    fn authorship_is_a_set_of_addresses_matched_on_the_address_alone() {
        let root = TempDir::new("authorship");
        init(&root.path);
        commit(&root.path, ME, 1, "From the laptop");
        commit(&root.path, ME_ON_GITHUB, 2, "From GitHub");
        commit(&root.path, MAINTAINER, 3, "From somebody else");
        // An address that contains one of the user's is not the user's.
        commit(&root.path, "not.r.passos@outlook.pt", 4, "From a lookalike");
        // Regex metacharacters in an address are the address, not a pattern.
        commit(&root.path, "r+passos@outlook.pt", 5, "From a plus");
        commit(
            &root.path,
            "rXpassos@outlook.pt",
            6,
            "From what a dot would match",
        );

        assert_eq!(
            subjects(&read_by(&root.path, &[ME, ME_ON_GITHUB], at(0))),
            ["From GitHub", "From the laptop"],
        );
        assert_eq!(
            subjects(&read_by(&root.path, &["R.Passos@Outlook.pt"], at(0))),
            ["From the laptop"],
        );
        assert_eq!(
            subjects(&read_by(&root.path, &["r+passos@outlook.pt"], at(0))),
            ["From a plus"],
        );
    }

    #[test]
    fn no_identities_is_nobodys_commits() {
        let root = TempDir::new("nobody");
        init(&root.path);
        commit(&root.path, ME, 1, "Mine");

        assert_eq!(
            subjects(&read_by(&root.path, &[], at(0))),
            Vec::<&str>::new()
        );
    }

    #[test]
    fn a_stale_local_branch_is_read_as_the_remote_tracking_branch_has_it() {
        let repo = cloned("stale", |server| {
            commit(server, ME, 1, "Start");
        });
        commit(&repo.server, ME, 2, "Merged on GitHub");
        git(&repo.clone, &["fetch", "--quiet"]);
        assert_eq!(git(&repo.clone, &["log", "--format=%s", "main"]), "Start");

        assert_eq!(
            subjects(&read_by(&repo.clone, &[ME], at(0))),
            ["Merged on GitHub", "Start"],
        );
    }

    #[test]
    fn a_remote_added_by_hand_is_read_through_the_upstream() {
        let root = TempDir::new("upstream");
        let server = root.path.join("server");
        let local = root.path.join("local");
        init(&server);
        commit(&server, ME, 1, "Start");
        init(&local);
        git(
            &local,
            &["remote", "add", "origin", server.to_str().unwrap()],
        );
        git(
            &local,
            &[
                "-c",
                "remote.origin.followRemoteHEAD=never",
                "fetch",
                "--quiet",
                "origin",
            ],
        );
        git(
            &local,
            &["switch", "--quiet", "-c", "main", "--track", "origin/main"],
        );
        commit(&server, ME, 2, "Merged on GitHub");
        git(
            &local,
            &[
                "-c",
                "remote.origin.followRemoteHEAD=never",
                "fetch",
                "--quiet",
                "origin",
            ],
        );
        // A branch of the user's own, checked out and tracking main, is where
        // they are — and the upstream is what is read from it.
        git(
            &local,
            &["switch", "--quiet", "-c", "wip", "--track", "origin/main"],
        );
        git(&local, &["reset", "--quiet", "--hard", "main"]);
        commit(&local, ME, 3, "Not pushed");
        assert!(
            !local.join(".git/refs/remotes/origin/HEAD").exists(),
            "the fixture has an origin/HEAD, so it tests nothing"
        );

        assert_eq!(
            subjects(&read_by(&local, &[ME], at(0))),
            ["Merged on GitHub", "Start"],
        );
    }

    #[test]
    fn a_repository_with_no_remote_is_read_on_its_head() {
        let root = TempDir::new("local-only");
        init(&root.path);
        commit(&root.path, ME, 1, "Start");
        git(&root.path, &["switch", "--quiet", "-c", "feature"]);
        commit(&root.path, ME, 2, "On the branch");

        assert_eq!(
            subjects(&read_by(&root.path, &[ME], at(0))),
            ["On the branch", "Start"]
        );
    }

    #[test]
    fn two_worktrees_of_one_repository_are_one_repository() {
        let repo = cloned("worktrees", |server| {
            commit(server, ME, 1, "Start");
        });
        let other = repo
            .clone
            .with_file_name("clone--claude-worktrees-analysis");
        git(
            &repo.clone,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "analysis",
                other.to_str().unwrap(),
            ],
        );

        let repository = |path: &Path| match read_by(path, &[ME], at(0)) {
            CommitsRead::Read { commits } => commits[0].repository.clone(),
            CommitsRead::Unreadable { reason } => panic!("unreadable: {reason:?}"),
        };
        let identity = |path: &Path| match identities_since(path, at(0)) {
            IdentitiesRead::Read { repository, .. } => repository,
            IdentitiesRead::Unreadable { reason } => panic!("unreadable: {reason:?}"),
        };

        assert_eq!(repository(&repo.clone), repository(&other));
        assert_eq!(identity(&repo.clone), identity(&other));
        assert_eq!(identity(&repo.clone), repository(&repo.clone));
        // Reached through a subdirectory, or a path that is not canonical,
        // it is still the same one.
        std::fs::create_dir_all(other.join("src")).unwrap();
        assert_eq!(identity(&other.join("src/..")), identity(&repo.clone));
    }

    #[test]
    fn candidate_identities_are_the_configured_address_then_recent_authors() {
        let root = TempDir::new("candidates");
        init(&root.path);
        git(&root.path, &["config", "user.email", ME]);
        commit(
            &root.path,
            "long.gone@example.com",
            -24 * 100,
            "A hundred days ago",
        );
        commit(&root.path, ME_ON_GITHUB, 1, "Earlier");
        commit(&root.path, MAINTAINER, 2, "Somebody else");
        commit(&root.path, ME, 3, "Me, configured");
        commit(
            &root.path,
            "Maintainer@Example.com",
            4,
            "Somebody else, shouting",
        );
        git(&root.path, &["switch", "--quiet", "-c", "feature"]);
        // Not on first-parent of what is read — this repository has no remote,
        // so that is HEAD — once main is checked out again.
        commit(&root.path, "branch.only@example.com", 5, "On a branch");
        git(&root.path, &["switch", "--quiet", "main"]);

        let IdentitiesRead::Read { identities, .. } = identities_since(&root.path, at(-24 * 90))
        else {
            panic!("unreadable")
        };

        assert_eq!(identities, [ME, "Maintainer@Example.com", ME_ON_GITHUB]);
    }

    /// The commit at the top can be dated behind the one under it — a clock
    /// that was behind on the machine that made it, or a rebuild that kept
    /// committer dates. Nothing may be narrowed by `--since` here: git stops
    /// the walk at the first commit older than its date and reads nothing
    /// behind that one, so the tip alone would hide the work under it, and
    /// hide it again on every later walk.
    #[test]
    fn a_tip_committed_before_the_lookback_hides_nothing_behind_it() {
        let root = TempDir::new("backwards");
        init(&root.path);
        git(&root.path, &["config", "user.email", ME]);
        // The work, inside the lookback, by nobody configured: it reaches the
        // suggestions only through the log.
        commit(&root.path, ME_ON_GITHUB, -24 * 2, "Two days ago");
        // And on top of it, dated behind — which the lookback still refuses.
        commit_at(
            &root.path,
            "long.gone@example.com",
            -24 * 10,
            -24 * 10,
            "Dated back",
        );

        assert_eq!(
            subjects(&read_by(
                &root.path,
                &[ME_ON_GITHUB, "long.gone@example.com"],
                at(-24 * 7)
            )),
            ["Two days ago"]
        );
        let IdentitiesRead::Read { identities, .. } = identities_since(&root.path, at(-24 * 7))
        else {
            panic!("unreadable")
        };
        assert_eq!(identities, [ME, ME_ON_GITHUB]);
    }

    #[test]
    fn candidates_are_most_recent_by_author_date_not_by_walk_order() {
        let root = TempDir::new("candidate-order");
        init(&root.path);
        git(&root.path, &["config", "user.email", ME]);
        commit_at(&root.path, "earlier@example.com", 5, 5, "Written last");
        // On top in the walk, as a rebase leaves it, but written first.
        commit_at(&root.path, "rebased@example.com", 1, 6, "Written first");

        let IdentitiesRead::Read { identities, .. } = identities_since(&root.path, at(0)) else {
            panic!("unreadable")
        };

        assert_eq!(
            identities,
            [ME, "earlier@example.com", "rebased@example.com"]
        );
    }

    #[test]
    fn an_empty_repository_still_suggests_the_configured_address() {
        let root = TempDir::new("empty-candidates");
        init(&root.path);
        git(&root.path, &["config", "user.email", ME]);

        let IdentitiesRead::Read {
            identities,
            reason,
            ..
        } = identities_since(&root.path, at(0))
        else {
            panic!("unreadable")
        };

        // The suggestions are worth offering even with nothing to read — and
        // the reason nothing can be read sits beside them, because Settings
        // reads this answer and the sweep's never reaches it.
        assert_eq!(identities, [ME]);
        assert_eq!(reason, Some(RepositoryUnreadable::NoHead));
    }

    #[test]
    fn a_folder_the_app_may_not_open_is_denied_not_missing() {
        use std::os::unix::fs::PermissionsExt;
        let root = TempDir::new("denied");
        let locked = root.path.join("locked");
        let repository = locked.join("repository");
        init(&repository);
        commit(&repository, ME, 1, "Start");
        let lock = |mode| std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(mode));

        // Behind a folder the app may not look inside — ~/Documents with
        // access refused — the path is there, and saying it is gone would be
        // a lie Settings could act on.
        lock(0o000).unwrap();
        let behind = (
            reason(&read_by(&repository, &[ME], at(0))),
            identities_since(&repository, at(0)),
        );
        // The folder itself refused, rather than its parent.
        lock(0o755).unwrap();
        std::fs::set_permissions(&repository, std::fs::Permissions::from_mode(0o000)).unwrap();
        let inside = reason(&read_by(&repository, &[ME], at(0)));
        // Found and entered, but its contents refused — the shape of a macOS
        // privacy refusal, where `stat` and `cd` work and reading does not.
        // git itself still gets through here; the answer must not depend on
        // it, since under a real refusal git says "not a git repository".
        std::fs::set_permissions(&repository, std::fs::Permissions::from_mode(0o311)).unwrap();
        let unlisted = reason(&read_by(&repository, &[ME], at(0)));
        std::fs::set_permissions(&repository, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(behind.0, RepositoryUnreadable::Denied);
        assert!(matches!(
            behind.1,
            IdentitiesRead::Unreadable {
                reason: RepositoryUnreadable::Denied
            }
        ));
        assert_eq!(inside, RepositoryUnreadable::Denied);
        assert_eq!(unlisted, RepositoryUnreadable::Denied);
    }

    #[test]
    fn a_missing_path_is_a_stated_reason() {
        let root = TempDir::new("missing");
        let gone = root.path.join("deleted");

        assert_eq!(
            reason(&read_by(&gone, &[ME], at(0))),
            RepositoryUnreadable::Missing
        );
        assert!(matches!(
            identities_since(&gone, at(0)),
            IdentitiesRead::Unreadable {
                reason: RepositoryUnreadable::Missing
            }
        ));
    }

    #[test]
    fn a_directory_that_is_not_a_repository_is_a_stated_reason() {
        let root = TempDir::new("not-a-repository");
        std::fs::write(root.path.join("file"), "").unwrap();

        assert_eq!(
            reason(&read_by(&root.path, &[ME], at(0))),
            RepositoryUnreadable::NotARepository
        );
        assert_eq!(
            reason(&read_by(&root.path.join("file"), &[ME], at(0))),
            RepositoryUnreadable::NotARepository
        );
        assert!(matches!(
            identities_since(&root.path, at(0)),
            IdentitiesRead::Unreadable {
                reason: RepositoryUnreadable::NotARepository
            }
        ));
    }

    #[test]
    fn an_unresolvable_head_is_a_stated_reason() {
        let root = TempDir::new("no-head");
        init(&root.path);

        assert_eq!(
            reason(&read_by(&root.path, &[ME], at(0))),
            RepositoryUnreadable::NoHead
        );
        // And beside the suggestions, as `Read`'s own reason: this is the
        // read Settings makes, and it must say the same as the commit read.
        let IdentitiesRead::Read { reason, .. } = identities_since(&root.path, at(0)) else {
            panic!("a repository with nothing to read is still readable")
        };
        assert_eq!(reason, Some(RepositoryUnreadable::NoHead));
    }

    #[test]
    fn a_git_that_cannot_be_run_is_a_stated_reason() {
        let root = TempDir::new("no-git");
        init(&root.path);
        commit(&root.path, ME, 1, "Start");
        let absent = Git {
            program: "/nonexistent/git",
        };

        assert!(matches!(
            absent.read(&root.path, &[ME.to_string()], at(0)),
            CommitsRead::Unreadable {
                reason: RepositoryUnreadable::GitUnavailable
            }
        ));
        assert!(matches!(
            absent.identities(&root.path, at(0)),
            IdentitiesRead::Unreadable {
                reason: RepositoryUnreadable::GitUnavailable
            }
        ));
    }

    #[test]
    fn nothing_is_written_to_any_repository() {
        let repo = cloned("read-only", |server| {
            commit(server, ME, 1, "Start");
            git(server, &["switch", "--quiet", "-c", "feature"]);
            commit(server, ME, 2, "One");
            git(server, &["switch", "--quiet", "main"]);
            git(
                server,
                &["merge", "--no-ff", "--quiet", "-m", "Merge", "feature"],
            );
        });
        commit(&repo.server, ME, 3, "Merged on GitHub");
        git(&repo.clone, &["fetch", "--quiet"]);
        let worktree = repo.clone.with_file_name("worktree");
        git(
            &repo.clone,
            &[
                "worktree",
                "add",
                "--quiet",
                "-b",
                "w",
                worktree.to_str().unwrap(),
            ],
        );
        // An edit in the working tree, so an index refresh would have
        // something to write if anything asked for one.
        std::fs::write(repo.clone.join("Start"), "changed").unwrap();
        let root = repo.clone.parent().unwrap().to_path_buf();
        let before = snapshot(&root);

        for path in [&repo.server, &repo.clone, &worktree] {
            let _ = read_by(path, &[ME, MAINTAINER], at(0));
            let _ = identities_since(path, at(-24 * 90));
        }

        assert_eq!(snapshot(&root), before);
    }

    /// The wire shapes, pinned as serde writes them — what the webview
    /// matches on.
    #[test]
    fn every_answer_serializes_as_the_webview_declares_it() {
        let read = CommitsRead::Read {
            commits: vec![Commit {
                hash: "6f47772".into(),
                subject: "Fix it".into(),
                authored_at: 1000.0,
                repository: "/r/.git".into(),
            }],
        };
        assert_eq!(
            serde_json::to_string(&read).unwrap(),
            r#"{"state":"read","commits":[{"hash":"6f47772","subject":"Fix it","authoredAt":1000.0,"repository":"/r/.git"}]}"#,
        );
        for (reason, name) in [
            (RepositoryUnreadable::Missing, "missing"),
            (RepositoryUnreadable::NotARepository, "not-a-repository"),
            (RepositoryUnreadable::NoHead, "no-head"),
            (RepositoryUnreadable::Denied, "denied"),
            (RepositoryUnreadable::GitUnavailable, "git-unavailable"),
        ] {
            assert_eq!(
                serde_json::to_string(&CommitsRead::Unreadable { reason }).unwrap(),
                format!(r#"{{"state":"unreadable","reason":"{name}"}}"#),
            );
        }
        assert_eq!(
            serde_json::to_string(&IdentitiesRead::Read {
                repository: "/r/.git".into(),
                identities: vec![ME.into()],
                reason: None,
            })
            .unwrap(),
            format!(
                r#"{{"state":"read","repository":"/r/.git","identities":["{ME}"],"reason":null}}"#
            ),
        );
        assert_eq!(
            serde_json::to_string(&IdentitiesRead::Read {
                repository: "/r/.git".into(),
                identities: vec![ME.into()],
                reason: Some(RepositoryUnreadable::NoHead),
            })
            .unwrap(),
            format!(
                r#"{{"state":"read","repository":"/r/.git","identities":["{ME}"],"reason":"no-head"}}"#
            ),
        );
    }
}
