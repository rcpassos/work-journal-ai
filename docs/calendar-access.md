# Calendar access

Import reads the local macOS calendar store through EventKit — Google accounts
included, since Calendar.app syncs them down as an ordinary `CalDAV` source. No
OAuth, no network call, no token to store.

macOS gates that read behind TCC, and the gate has one hard requirement and one
surprising consequence.

## The requirement

`NSCalendarsFullAccessUsageDescription` must be in the running bundle's
`Info.plist`. Tauri merges [`src-tauri/Info.plist`](../src-tauri/Info.plist)
into the `.app` it builds, which is where ours comes from.

Without it macOS does not deny the request — it refuses in about 150ms, shows
no dialog, and leaves the status at `NotDetermined`. There is then nothing to
grant in System Settings either, so it looks exactly like a bug in the app.

## The consequence: `pnpm tauri:dev` cannot hold a grant

`tauri dev` builds a bare Mach-O at `src-tauri/target/debug/app` with no `.app`
around it. No bundle means no `Info.plist`, which means no prompt, ever.

Putting the same binary inside a bundle fixes it outright, and there is no need
to hand-roll one — `tauri build --debug` produces a real `.app` with the real
merged plist:

```bash
pnpm tauri:dev:app
```

It writes `src-tauri/target/debug/bundle/macos/Work Journal (Dev).app`. Open
that when you are working on Import; `pnpm tauri:dev` is fine for everything
else. It keeps the `.dev` bundle identifier, so it has its own database, its
own settings and its own calendar grant, separate from any release build in
`/Applications`.

There is no live reload in it: it serves the built frontend, so run
`pnpm tauri:dev:app` again after a frontend change.

## Being asked again is routine

The grant is keyed to the binary's **cdhash**, not to its bundle id and not to
its version:

- rebuild → new cdhash → macOS prompts once more;
- reinstall byte-identical bits → same cdhash → the grant survives;
- bump the version without changing the code → nothing happens to the grant,
  because TCC never reads the version.

So every released DMG re-prompts the user exactly once, and every rebuild
during development does too. This is designed for rather than worked around:
Settings turns Import back off and says why, the journal keeps working
untouched, and the app never nags.

Measured in [#61](https://github.com/rcpassos/work-journal-ai/issues/61)
against a real Google account, ad-hoc signed, `TeamIdentifier=not set`.

## Resetting the grant while testing

Changes a privacy setting, so run it yourself:

```bash
tccutil reset Calendar com.pipecodes.work-journal && tccutil reset Calendar com.pipecodes.work-journal.dev
```
