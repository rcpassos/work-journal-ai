# Contributing

## Prerequisites

- Node 24+ and [pnpm](https://pnpm.io)
- A Rust toolchain via [rustup](https://rustup.rs)

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

## Development

```bash
pnpm install
```

```bash
pnpm tauri:dev
```

There is no Dock icon and no `Cmd+Tab` entry — the app is in the menu bar. Quit it from the Tray Menu.

`pnpm tauri:dev` merges [`tauri.dev.conf.json`](src-tauri/tauri.dev.conf.json) over the release config, which swaps the bundle identifier for `com.pipecodes.work-journal.dev`. Everything the app stores — the journal database, `settings.json`, the login item — lives under the identifier, so the dev build gets its own copy and cannot touch the notes of an installed release. Plain `pnpm tauri dev` shares them; use it only when that is what you want.

`pnpm tauri:dev` cannot hold a calendar grant: it builds a bare binary with no bundle around it, so macOS never prompts. Work on Import against `pnpm tauri:dev:app`, which builds a real debug `.app` under the same `.dev` identifier — see [docs/calendar-access.md](docs/calendar-access.md).

Both builds can run at once, but a combination can only be held once: for each of the Note Hotkey and the Task Hotkey, whichever build registers second finds it taken and reports it unavailable. Give the dev build its own combination for both in its Settings — those choices persist separately too.

## Checks

```bash
pnpm test
```

Vitest, run once. `pnpm test:watch` re-runs on change. OS integrations that a test could only assert mocks against are covered by [the manual checklist](docs/manual-verification.md) instead.

```bash
pnpm build
```

```bash
pnpm lint
```

`pnpm build` runs `tsc -b` before bundling, so it doubles as the type check. CI also runs `cargo test` and `cargo clippy -- -D warnings` against `src-tauri` — see [ci.yml](.github/workflows/ci.yml).

## Docs

- [CONTEXT.md](CONTEXT.md) — the app's vocabulary; normative for code and copy.
- [docs/adr/](docs/adr/) — architectural decisions.
- [docs/manual-verification.md](docs/manual-verification.md) — the manual checklist; run it against a release build before calling a ticket done.
- [docs/calendar-access.md](docs/calendar-access.md) — why Import needs a bundled build and why macOS re-prompts.
- [docs/onboarding.md](docs/onboarding.md) — the confirmed Onboarding design.
- [`site/index.html`](site/index.html) — the [download page](https://rcpassos.github.io/work-journal-ai/) source, published by [`pages.yml`](.github/workflows/pages.yml) on every push to `main` that touches it.

Agent rules live in [AGENTS.md](AGENTS.md).

## Building locally

```bash
pnpm tauri build --bundles app
```

The result lands in `src-tauri/target/release/bundle/macos/Work Journal.app`.

## Cutting a release

Pushing a `vX.Y.Z` tag builds the DMG and publishes it as a GitHub release. The version lives in `src-tauri/tauri.conf.json` and nowhere else — the versions in `package.json` and `src-tauri/Cargo.toml` are fixed at `0.0.0` and mean nothing.

Entries go into the `## Unreleased` section of [CHANGELOG.md](CHANGELOG.md) as the work lands. Cutting a release renames that section to the version and dates it: the workflow publishes it verbatim as the release notes, above the install instructions, and refuses to build if the tag has no section of its own.

Each bullet is one plain sentence about what changed for the user, with no Markdown emphasis: the workflow also writes the section over `latest.json`'s `notes`, where Settings shows it line by line to someone deciding whether to update — see [ADR 0039](docs/adr/0039-an-update-shows-the-changelog-the-release-was-written-with.md).

Bump the version, rename the section, commit both, then tag the commit that carries them:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

The workflow refuses to build if the tag and `tauri.conf.json` disagree, and runs the tests before the build, so a red suite produces no release at all. It builds for Apple Silicon only, and the DMG is unsigned — the release notes carry the `xattr` instruction from the README below the version's changelog section.

Every release also publishes a signed `.app.tar.gz` and a `latest.json`, which is what installed copies update themselves from — see [ADR 0030](docs/adr/0030-the-app-updates-itself-from-its-own-releases.md).

### The update signing key

The update bundle is signed with a minisign key whose public half is compiled into the app, and refused if it does not verify. The private half lives in the `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` repository secrets and nowhere else — **lose it and no installed copy can ever be updated again**; every user would have to reinstall from a DMG once.

This is Tauri's own signature over the update payload, not Apple code signing: builds remain unsigned and unnotarized. The `xattr` step applies to a DMG, never to an update, which the app unpacks itself.

### Gatekeeper and the quarantine attribute

Builds are unsigned and unnotarized by design. macOS attaches a quarantine attribute to anything that arrives from another machine — via AirDrop, a download, or a shared drive — and Gatekeeper then refuses to open the app, usually with "the app is damaged and can't be opened".

Clear the attribute on the copy you received:

```bash
xattr -dr com.apple.quarantine "/Applications/Work Journal.app"
```

A build you produced locally and never moved is not quarantined and needs nothing.
