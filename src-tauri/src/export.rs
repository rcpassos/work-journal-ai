//! Export: the whole journal — Notes and Tasks alike — out of the SQLite file
//! and into a Markdown one, so nothing kept in this app is locked inside it.
//! What to write is the journal core's decision — see `src/journal/journal.ts`;
//! where to put it, and never on top of something already there, is decided
//! here.

use serde::Serialize;
use std::io;
use std::path::{Path, PathBuf};

/// Where an export ended up, so the app can say so rather than leaving the
/// user to guess whether anything happened. Must match `ExportedFile` in
/// `src/platform/desktop.ts`, as `src/platform/desktop-rust.test.ts` checks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedFile {
    /// The full path written to, for display.
    pub path: String,
    /// Just the file, for a sentence that fits on one line.
    pub file_name: String,
}

/// Writes the export into `directory`, under `file_name` or the nearest name
/// beside it that is free. An export is a copy of the journal, not a claim on
/// the file system: it never writes over a file that is already there, and it
/// never escapes the directory it was given.
pub fn write(directory: &Path, file_name: &str, markdown: &str) -> io::Result<ExportedFile> {
    let file_name = plain_file_name(file_name)?;
    let path = free_path(directory, &file_name)?;

    std::fs::create_dir_all(directory)?;
    std::fs::write(&path, markdown)?;

    Ok(ExportedFile {
        file_name: path
            .file_name()
            .unwrap_or(file_name.as_os_str())
            .to_string_lossy()
            .into_owned(),
        path: path.to_string_lossy().into_owned(),
    })
}

/// A name that is a file and nothing else: no directories to traverse into and
/// no parent to climb out to.
fn plain_file_name(file_name: &str) -> io::Result<PathBuf> {
    let candidate = Path::new(file_name);

    if candidate.file_name() == Some(candidate.as_os_str()) && !file_name.trim().is_empty() {
        return Ok(candidate.to_path_buf());
    }

    Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        format!("not a file name: {file_name}"),
    ))
}

/// The first name not already taken: `work-journal-2026-03-11.md`, then
/// `work-journal-2026-03-11-2.md`, and so on — the name itself is
/// `exportFileName`'s in `src/journal/journal.ts`. Exporting twice in one day
/// leaves two files rather than one. Shared with backup, whose save dialog
/// has the same shape of question: a name the user chose, a directory it must
/// not write over anything in.
pub(crate) fn free_path(directory: &Path, file_name: &Path) -> io::Result<PathBuf> {
    let first = directory.join(file_name);

    if !first.exists() {
        return Ok(first);
    }

    let stem = file_name
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let extension = file_name
        .extension()
        .map(|extension| format!(".{}", extension.to_string_lossy()))
        .unwrap_or_default();

    // Bounded, so a directory in which every name is taken ends in an error
    // rather than in a loop that never returns — and never in writing over
    // one of the exports already sitting there.
    for attempt in 2..1000 {
        let next = directory.join(format!("{stem}-{attempt}{extension}"));
        if !next.exists() {
            return Ok(next);
        }
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        format!("there is nowhere left to export to beside {}", first.display()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory of this run's own, removed when the test is done with it.
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!("work-journal-export-{name}"));
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

    #[test]
    fn the_file_holds_exactly_the_markdown_it_was_given() {
        let directory = TempDir::new("holds-the-markdown");

        let exported = write(&directory.path, "work-journal.md", "## Fri 13 Mar\n- a Note")
            .expect("the export failed");

        assert_eq!(
            std::fs::read_to_string(&exported.path).unwrap(),
            "## Fri 13 Mar\n- a Note"
        );
        assert_eq!(exported.file_name, "work-journal.md");
    }

    #[test]
    fn a_second_export_writes_beside_the_first_rather_than_over_it() {
        let directory = TempDir::new("never-overwrites");

        let first = write(&directory.path, "work-journal.md", "the first").unwrap();
        let second = write(&directory.path, "work-journal.md", "the second").unwrap();

        assert_ne!(first.path, second.path);
        assert_eq!(second.file_name, "work-journal-2.md");
        assert_eq!(std::fs::read_to_string(&first.path).unwrap(), "the first");
        assert_eq!(std::fs::read_to_string(&second.path).unwrap(), "the second");
    }

    #[test]
    fn a_file_name_that_is_a_path_is_refused() {
        let directory = TempDir::new("refuses-paths");

        for name in ["../escaped.md", "nested/notes.md", "/tmp/notes.md", "  "] {
            assert!(
                write(&directory.path, name, "anything").is_err(),
                "{name} should not be a file name"
            );
        }
    }
}
