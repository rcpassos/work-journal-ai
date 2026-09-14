# Work Journal

A personal, local-first log of short work notes captured throughout the day, so that what you did is recoverable later — in a work summary, in a review, or as context for an LLM.

macOS on Apple Silicon only. No account, no server. Notes and Tasks live in a SQLite file on your Mac.

**[Download for macOS](https://rp-pipecodes.github.io/work-journal-ai/)** — or [build it yourself](CONTRIBUTING.md#building-locally).

## How it works

1. **Capture** — one Hotkey opens a text field over whatever you are doing. Write one line, press Enter, the window is gone.
2. **File** — start the line with `#name` and the Note is filed under that Project. Names you already used are offered as you type.
3. **Read back** — the Tray Menu copies Yesterday's Digest with no window open. One click further gives the Work Summary Material or a Work Summary.

The [download page](https://rp-pipecodes.github.io/work-journal-ai/) has a live demo of this loop.

## What it does

- **Notes** — capture from the Hotkey, the Tray Menu, or relaunch. Read any range (today, yesterday, this or last week or month), narrowed to one Project or not at all. Search every Note's text to jump to the day it lives on. Reword, refile to another day, or delete — no trash.
- **Tasks** — commitments beside Notes, with their own Hotkey and always-ready window. A date, with an optional time; past dates read as overdue. Daily, weekly, monthly, yearly, or every-N repeats with one open occurrence, never a backlog. A dated Task with a time raises a local macOS alert.
- **Work Summary** — Yesterday's Digest from the tray (Markdown, nothing to configure), Work Summary Material one click in (this week's Notes and completed work plus every current commitment), or a Work Summary in prose from your own OpenAI-compatible model. The summary is read before copying — it may be wrong and is never kept. Each result shows the range it was written from and when, and is marked outdated when the selected notes and tasks change. The API key stays in your keychain; everything else works without it.
- **The rest** — today's macOS calendar meetings can become Notes on their own (off until you pick the calendars). Export the whole journal to Markdown any time. Automatic and on-demand Backup of the SQLite file, Restore with rollback, and self-updates from Settings.

## Privacy

The network is touched only for a Work Summary you request and an update you confirm. Meeting Import reads the local macOS calendar store — no OAuth, no network call.

## Install

The build is unsigned and unnotarized by design, so macOS quarantines the download. After dragging Work Journal to Applications, run once:

```bash
xattr -dr com.apple.quarantine "/Applications/Work Journal.app"
```

A copy you compiled yourself was never quarantined and needs nothing. Updates need nothing either — the app unpacks its own signed payload and restarts into it.

Already running Work Journal? **Settings › Updates › Check for updates** installs the next version with no download and no terminal.

What changed in each version is in [CHANGELOG.md](CHANGELOG.md).

## Vocabulary

The words the app uses — Note, Task, Capture, Project, Digest, Work Summary, and the rest — are defined in [CONTEXT.md](CONTEXT.md) and are normative there and in the code.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, checks, and releases.

## Licence

MIT — see [LICENSE](LICENSE).
