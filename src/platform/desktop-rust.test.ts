/**
 * The names `desktop.ts` shares with the Rust side, checked. A window label, a
 * section name or an event name that stops matching its counterpart in
 * `src-tauri/src/lib.rs` is silent: no error, no failed build, and no symptom
 * except a window that never hears something. This reads the Rust source as
 * text, because that is enough — there is no build step and no generated file
 * in the Rust tree.
 *
 * The geometry constants are deliberately not here: the Rust numbers are only
 * the size a resident window is built at before its webview boots, and
 * `fitCapture` / `fitTaskCreation` set the real size from a mount effect. Drift
 * there costs one frame and then corrects itself.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  CAPTURE_SHOWN_EVENT,
  CAPTURE_WINDOW,
  COPY_YESTERDAY_DIGEST_EVENT,
  DATABASE_URL,
  HISTORY_SECTION,
  MAIN_WINDOW,
  ONBOARDING_KEY,
  PRACTICE_ENDED_EVENT,
  SECTION_REQUESTED_EVENT,
  WORK_SUMMARY_SECTION,
  SETTINGS_FILE,
  SETTINGS_SECTION,
  SYSTEM_WOKE_EVENT,
  TASK_ALERT_COMPLETED_EVENT,
  TASK_ALERT_OPENED_EVENT,
  TASK_CREATION_SHOWN_EVENT,
  TASK_CREATION_WINDOW,
  TASKS_SECTION,
  THEME_KEY,
} from './desktop'
import { backupFileName } from './tauri-desktop'

const TEST_FILE = 'src/platform/desktop-rust.test.ts'
const RUST_FILE = 'src-tauri/src/lib.rs'
const DESKTOP_FILE = 'src/platform/desktop.ts'

function read(file: string): string {
  return readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
}

/**
 * What the `MainSection` union is made of: the constants it refers to, and any
 * member written as a bare string instead. Read from the source rather than
 * imported, because `MainSection` is a type — a fourth section spelled out in
 * the union has no name to be checked under, and `vitest run` compiles nothing
 * that would say so.
 */
function sectionMembers(source: string): {
  names: string[]
  literals: string[]
} {
  const union = source.match(/export type MainSection =([\s\S]*?)\n\n/)?.[1] ?? ''

  return {
    names: [...union.matchAll(/typeof ([A-Z][A-Z0-9_]*)/g)].map(
      ([, name]) => name,
    ),
    literals: [...union.matchAll(/'([^']*)'/g)].map(([, member]) => member),
  }
}

const desktop = read(DESKTOP_FILE)

/** Every shared string, under the name the Rust side declares it by. */
const shared: Record<string, string> = {
  CAPTURE_WINDOW,
  TASK_CREATION_WINDOW,
  MAIN_WINDOW,
  HISTORY_SECTION,
  TASKS_SECTION,
  WORK_SUMMARY_SECTION,
  SETTINGS_SECTION,
  CAPTURE_SHOWN_EVENT,
  TASK_CREATION_SHOWN_EVENT,
  COPY_YESTERDAY_DIGEST_EVENT,
  SYSTEM_WOKE_EVENT,
  SECTION_REQUESTED_EVENT,
  TASK_ALERT_COMPLETED_EVENT,
  TASK_ALERT_OPENED_EVENT,
  SETTINGS_FILE,
  THEME_KEY,
  ONBOARDING_KEY,
  PRACTICE_ENDED_EVENT,
  DATABASE_URL,
}

/**
 * The strings `desktop.ts` declares, which is the list the checked ones are
 * drawn from: whatever is not checked against Rust has to be accounted for as
 * this side's own, so that a new one lands in neither by accident.
 *
 * A declaration wrapped after the `=` reads the same as one that fits, for the
 * reason the comments do: a name this cannot see is a name nothing accounts
 * for, and that is the one way to be missed here without a word being said.
 */
function desktopStrings(source: string): Map<string, string> {
  return new Map(
    [...source.matchAll(/^export const ([A-Z][A-Z0-9_]*) =\s+'([^']*)'/gm)].map(
      ([, name, value]) => [name, value],
    ),
  )
}

/**
 * The announcements spoken and heard only in TypeScript. They sit in
 * `desktop.ts` so that every event name in the app is in one place, and they
 * are named here so that a name arriving there is either checked against the
 * Rust side or deliberately one of these — never neither because a comment
 * happened to be worded in a way this file did not recognise.
 */
const typeScriptOnly = new Set([
  'NOTE_CAPTURED_EVENT',
  'THEME_CHANGED_EVENT',
  'IMPORT_CHANGED_EVENT',
  'JOURNAL_CHANGED_EVENT',
  'TASKS_CHANGED_EVENT',
  'TASK_ALERTS_RECONCILED_EVENT',
  // The start-at-login answer is this side's own now: it is stored in the
  // settings file, but no startup decision reads it any more — the first-run
  // question it answered was replaced by the Onboarding flow, whose state the
  // Rust side keeps under ONBOARDING_KEY instead.
  'START_AT_LOGIN_KEY',
])

/** `const NAME: &str = "value";`, which is how every shared name is declared. */
function rustStrings(source: string): Map<string, string> {
  return new Map(
    [...source.matchAll(/^const ([A-Z][A-Z0-9_]*): &str =\s+"([^"]*)";/gm)].map(
      ([, name, value]) => [name, value],
    ),
  )
}

/**
 * A comment as one line of prose. The line breaks and the prefixes go, because
 * a "must match" that a formatter wrapped over two lines has to read the same
 * as one that fits: a claim that goes unrecognised is a claim nothing enforces.
 */
function oneLine(comment: string): string {
  return comment
    .replace(/\/\*\*|\*\/|^\s*(\*|\/\/\/?)/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The `/** *\/` blocks of `desktop.ts`. */
function desktopComments(source: string): string[] {
  return (source.match(/\/\*\*[\s\S]*?\*\//g) ?? []).map(oneLine)
}

/**
 * Each run of `///` lines in the Rust file with the constant it documents.
 * What a comment is attached to is what says whether this test can hold it to
 * anything: the geometry constants are `f64` and deliberately unchecked, and a
 * comment documenting one of those is not making a claim about a shared
 * string. Judging by the names a comment happens to mention instead would let
 * a comment naming its counterpart under some other spelling say nothing at
 * all — and it would say it silently.
 */
function rustComments(source: string): { comment: string; documents: string }[] {
  return [
    ...source.matchAll(/((?:^[ \t]*\/\/\/[^\n]*\n)+)[ \t]*const ([A-Z][A-Z0-9_]*)/gm),
  ].map(([, comment, documents]) => ({ comment: oneLine(comment), documents }))
}

/** A comment claiming some names match the other side's, and those names. */
interface Claim {
  comment: string
  names: string[]
}

/**
 * The comments in one file that claim a name matches one in the other, with
 * the names they claim it of — so that a name declared with such a comment and
 * missing from `shared` above fails rather than going unchecked.
 *
 * A comment that names no constant of its own is not one of these: the
 * `__THEME__` global is written by a Rust method rather than declared as a
 * shared string, and there is nothing here for it to be checked against.
 */
function mustMatchComments(comments: string[], otherFile: string): Claim[] {
  return comments
    .map((comment) => ({
      comment,
      names: [...comment.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map(
        ([, name]) => name,
      ),
    }))
    .filter(
      ({ comment, names }) =>
        /[Mm]ust match/.test(comment) &&
        comment.includes(otherFile) &&
        names.length > 0,
    )
}

const rustSource = read(RUST_FILE)
const rust = rustStrings(rustSource)
const declared = desktopStrings(desktop)

/**
 * Every claim that has to be honoured here: all of `desktop.ts`'s, and the
 * Rust ones documenting a string the Rust side declares.
 */
const claims: Claim[] = [
  ...mustMatchComments(desktopComments(desktop), RUST_FILE),
  ...mustMatchComments(
    rustComments(rustSource)
      .filter(({ documents }) => rust.has(documents))
      .map(({ comment }) => comment),
    DESKTOP_FILE,
  ),
]

describe('the names shared with the Rust side', () => {
  for (const [name, value] of Object.entries(shared)) {
    it(`declares ${name} the same on both sides`, () => {
      expect(
        rust.get(name),
        `${name} is ${JSON.stringify(value)} in ${DESKTOP_FILE} and ` +
          `${JSON.stringify(rust.get(name))} in ${RUST_FILE}`,
      ).toBe(value)
    })
  }

  it('builds MainSection out of names this checks', () => {
    const { names, literals } = sectionMembers(desktop)

    // A member spelled out in the union has no constant behind it, so a drift
    // in it could only ever be reported as a section that appeared and one
    // that vanished, never as one name holding two values.
    expect(literals, literals.join('; ')).toEqual([])
    expect(names.length).toBeGreaterThan(0)
    expect(names.filter((name) => !(name in shared))).toEqual([])
  })

  it('accounts for every string desktop.ts declares', () => {
    // The comment rule below reads prose, and prose can be written a way it
    // does not recognise. This one reads the declarations themselves, so a
    // name arriving in `desktop.ts` is either checked or called this side's
    // own, whatever its comment says.
    const unaccounted = [...declared]
      .filter(([name]) => !(name in shared) && !typeScriptOnly.has(name))
      .map(([name, value]) => `${name} = ${JSON.stringify(value)}`)

    expect(declared.size).toBeGreaterThan(0)
    expect(unaccounted, unaccounted.join('; ')).toEqual([])
  })

  it('checks every name declared with a "must match" comment', () => {
    const claimed = [...new Set(claims.flatMap(({ names }) => names))]
    // Said with both sides' values: the two ways to get here are a name that
    // never had a counterpart and a name that has one under a spelling the
    // other side has since dropped, and what each holds says which.
    const unchecked = claimed
      .filter((name) => !(name in shared))
      .map(
        (name) =>
          `${name} is ${JSON.stringify(declared.get(name))} in ` +
          `${DESKTOP_FILE} and ${JSON.stringify(rust.get(name))} in ` +
          `${RUST_FILE}, and nothing checks the pair`,
      )

    expect(claimed.length).toBeGreaterThan(0)
    expect(unchecked, unchecked.join('; ')).toEqual([])
  })

  it('points every "must match" comment on either side at this test', () => {
    expect(claims.length).toBeGreaterThan(0)
    for (const { comment } of claims) {
      expect(comment, comment).toContain(TEST_FILE)
    }
  })
})

/**
 * The Onboarding marker's two states and its commands, checked the way the
 * shared strings are: a state name that drifts between the Rust side's writer
 * and the frontend's reader is silent — a first launch would still be
 * classified, but the introduction would never present itself — and a command
 * the webview calls by a name the handler does not register answers nothing.
 */
describe('the onboarding state and commands', () => {
  const onboardingSource = read('src-tauri/src/onboarding.rs')

  it('spells the two states the same on both sides', () => {
    const rustStates = [
      ...onboardingSource.matchAll(/^pub const ([A-Z_]+): &str = "([^"]*)";/gm),
    ].map(([, , value]) => value)

    expect(rustStates).toEqual(['unfinished', 'suppressed'])
    expect(tsUnionKinds(desktop, 'OnboardingState')).toEqual(rustStates)
  })

  it('registers the commands the desktop surface names', () => {
    // The webview calls these by name; a rename on either side is a Main
    // Window that never presents or never dismisses Onboarding. Each must be
    // both declared as a command and listed in the invoke handler.
    const handler = rustSource.match(
      /invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/,
    )?.[1]
    expect(handler, 'the invoke handler could not be read').toBeTruthy()

    for (const command of [
      'onboarding_state',
      'dismiss_onboarding',
      'start_practice_capture',
      'dismiss_practice_capture',
    ]) {
      expect(
        rustSource.match(new RegExp(`fn ${command}\\b`)),
        `${command} is not a command in ${RUST_FILE}`,
      ).toBeTruthy()
      expect(
        handler,
        `${command} is not registered in the invoke handler`,
      ).toContain(command)
    }
  })

  it('invokes practice through the command the desktop surface names', () => {
    // Practice reaches the real resident Capture window through the desktop
    // boundary: a rename on either side is a Try it button that answers
    // nothing.
    const tauriSource = read('src/platform/tauri-desktop.ts')
    expect(tauriSource).toContain("invoke('start_practice_capture'")
  })

  it('spells the practice outcome the same on both sides', () => {
    // The Capture view reports how its practice showing ended, and the Main
    // Window closes the attempt on it: a drift between the two is a practice
    // that never lands, or one that lands as the wrong outcome.
    const rustOutcomes = rustVariants(rustSource, 'PracticeEnded').map(kebab)
    const tsOutcomes = tsUnionKinds(desktop, 'PracticeEnded')

    expect(rustOutcomes).toEqual(['submitted', 'cancelled'])
    expect(tsOutcomes).toEqual(rustOutcomes)
  })

  it('spells the submitted day field the same on both sides', () => {
    // Variants alone are not the contract: the day travels inside
    // `Submitted`, and a field spelled `journal_day` on one side and
    // `journalDay` on the other refuses the dismiss call before its body
    // runs — leaving the Capture window standing.
    const enumBody =
      rustSource.match(/pub enum PracticeEnded \{([\s\S]*?)\n\}/)?.[1] ?? ''
    const rustFields = [...enumBody.matchAll(/Submitted\s*\{([^}]*)\}/g)]
      .flatMap(([, fields]) => [
        ...fields.matchAll(/([a-z_][a-z0-9_]*)\s*:/g),
      ])
      .map(([, field]) => camel(field))

    const unionBody =
      desktop.match(/export type PracticeEnded =\n([\s\S]*?)\n\n/)?.[1] ?? ''
    const submittedMember =
      [...unionBody.matchAll(/\{([^{}]*)\}/g)]
        .map(([, member]) => member)
        .find((member) => member.includes("'submitted'")) ?? ''
    const tsFields = [...submittedMember.matchAll(/([a-zA-Z_$][\w$]*)\s*:/g)]
      .map(([, field]) => field)
      .filter((field) => field !== 'outcome')

    expect(rustFields).toEqual(['journalDay'])
    expect(tsFields).toEqual(rustFields)

    // And the attribute that makes the spelling true on the wire: on an enum,
    // `rename_all` renames the variants only, so the field inside `Submitted`
    // needs `rename_all_fields` (or a per-variant attribute) — without it both
    // name lists above agree and the call still refuses `journalDay`. Read
    // from the attribute directly above the enum, so an unrelated `#[serde]`
    // elsewhere cannot satisfy this by accident.
    const enumAt = rustSource.indexOf('pub enum PracticeEnded')
    const attribute =
      rustSource
        .slice(Math.max(0, enumAt - 500), enumAt)
        .match(/#\[serde\(([\s\S]*?)\)\]\s*$/)?.[1] ?? ''
    expect(attribute).toContain('rename_all_fields')
  })

  it('dismisses practice with the outcome the command receives', () => {
    // The webview sends the outcome under the name the command receives it
    // under; a rename on either side refuses the call before its body runs.
    const tauriSource = read('src/platform/tauri-desktop.ts')
    expect(tauriSource).toContain(
      "invoke('dismiss_practice_capture', { ended })",
    )
  })
})

/**
 * A command that can leave a system dialog on screen must not hold the main
 * thread while it is there. `#[tauri::command]` runs the body on the main
 * thread; `#[tauri::command(async)]` runs it off it. The difference is silent —
 * it compiles, it works every time nobody is prompted, and it shows up only as
 * a frozen app in front of a prompt the user is still reading.
 *
 * The rule is not "anything that touches the OS": it is "anything that can
 * block on a person". The Keychain is one of those, because macOS puts an
 * authorization prompt in front of a read or a write whenever the binary
 * asking is not the one that saved the item — see
 * docs/adr/0026-the-api-key-lives-in-the-keychain-and-rust-makes-the-call.md,
 * which counts a denied prompt as an ordinary outcome.
 */
describe('the commands that can block on a person', () => {
  const rustSource = read(RUST_FILE)

  const BLOCKING_COMMANDS = [
    // The keychain prompts on a read or a write, not only on a first save.
    'api_key_set',
    'save_api_key',
    'clear_api_key',
    // The model call reads the Key — which can sit behind the same prompt —
    // and is then allowed 60 seconds of network.
    'generate_work_summary',
    // The two that already carry the rule, here so it reads as a rule.
    'request_calendar_access',
    'request_task_alert_permission',
  ]

  it('runs the backup status read off the main thread with its siblings', () => {
    // The automatic-backups read reaches the file system, so it rides the
    // same async shape as the commands beside it.
    const declaration = rustSource.match(
      /#\[tauri::command\(async\)\]\s*fn automatic_backups\b/,
    )
    expect(declaration).toBeTruthy()
  })

  it('carries every backup command the desktop surface names', () => {
    // The webview calls these by name; a rename on either side is a Settings
    // button that answers nothing. Each must be both declared as a command
    // and listed in the invoke handler.
    const handler = rustSource.match(
      /invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/,
    )?.[1]
    expect(handler, 'the invoke handler could not be read').toBeTruthy()

    for (const command of [
      'automatic_backups',
      'backup_journal',
      'reveal_backups',
      'stage_restore',
    ]) {
      expect(
        rustSource.match(new RegExp(`fn ${command}\\b`)),
        `${command} is not a command in ${RUST_FILE}`,
      ).toBeTruthy()
      expect(
        handler,
        `${command} is not registered in the invoke handler`,
      ).toContain(command)
    }
  })

  it.each(BLOCKING_COMMANDS)('runs %s off the main thread', (command) => {
    // An `async fn` command is off the main thread by its very shape; the
    // attribute is what a sync body needs, and is what the declaration is
    // checked for below.
    const declaration = rustSource.match(
      new RegExp(`(#\\[tauri::command[^\\]]*\\])\\s*(?:async\\s+)?fn ${command}\\b`),
    )

    expect(declaration, `${command} is not a command in ${RUST_FILE}`).toBeTruthy()
    expect(declaration?.[1]).toBe('#[tauri::command(async)]')
  })
})

/**
 * The argument names a command is invoked with, checked both ways. Tauri
 * matches the keys of the webview's invoke payload against the command's
 * parameter names — snake_case on the Rust side reads as camelCase in the
 * payload — and a name that matches nothing refuses the call before the
 * command's body runs. Silent is the cruelty of it: the build passes, the
 * fake desktop passes every test, and pressing the button reports nothing.
 *
 * Both sides are read as source, as the shared strings above are: the
 * payload keys each `invoke` in `tauri-desktop.ts` actually sends, and the
 * parameters each command receives. Nothing is asserted against a
 * hand-maintained table — the webview's own call sites are the source of
 * truth, so renaming a key there fails here.
 */
describe('the arguments commands are invoked with', () => {
  // The call sites, not the contract: `desktop.ts` declares the `Desktop`
  // surface but contains no `invoke` payloads — `tauri-desktop.ts` is where
  // arguments are actually sent, and so where drift can hide.
  const tauriSource = read('src/platform/tauri-desktop.ts')

  /**
   * The payload keys of every invoke that sends arguments, read straight
   * out of `tauri-desktop.ts`. Shorthand (`{ path }`) and explicit
   * (`{ path: value }`) both yield the key the payload carries; a payload
   * this parser cannot read fails the accounting test below rather than
   * passing silently.
   */
  function sentArguments(): Record<string, string[]> {
    const sent: Record<string, string[]> = {}

    for (const [, command, payload] of tauriSource.matchAll(
      /invoke[^'\n]*'([a-z_]+)'(?:,\s*\{([^}]*)\})?/g,
    )) {
      if (payload === undefined) continue
      const keys =
        payload.trim() === ''
          ? []
          : payload.split(',').map((entry) => {
              const key = entry.split(':')[0].trim()
              if (!/^[a-zA-Z_$][\w$]*$/.test(key)) {
                throw new Error(
                  `the payload of '${command}' is not the flat list of ` +
                    `identifiers this test reads — it saw "${entry.trim()}"`,
                )
              }
              return key
            })

      const previous = sent[command]
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(keys)) {
        throw new Error(
          `'${command}' is invoked with two different payloads — read ` +
            'both call sites into this test rather than one',
        )
      }
      sent[command] = keys
    }

    return sent
  }

  /** The parameter names of one Rust command, in snake_case as written. */
  function rustParameters(command: string): string[] {
    const signature = rustSource.match(
      new RegExp(`(?:async )?fn ${command}\\b([\\s\\S]*?)\\) ->`),
    )?.[1]
    if (signature === undefined) {
      throw new Error(`${command} is not a command in ${RUST_FILE}`)
    }

    return [...signature.matchAll(/[(,]\s*(?:mut )?([a-z_][a-z0-9_]*):/gm)]
      .map(([, name]) => name)
      // Handled by Tauri itself — the app handle, injected state, the
      // window — are not part of the payload the webview sends, and never
      // have been: `journal_transaction`'s `databases` and `set_hotkey`'s
      // `hotkeys` ride in the command's context, not its arguments.
      .filter((name) => !['app', '_app', 'window', 'state'].includes(name))
      // State's generic is a type, not a name; `databases` and `hotkeys`
      // are `State<'_, T>` parameters and are dropped here with their kind.
      .filter((name) => !new RegExp(`${name}:\\s*tauri::State`).test(signature))
  }

  it('sends every argument with the name the command receives', () => {
    const sent = sentArguments()
    expect(Object.keys(sent).length).toBeGreaterThan(0)

    for (const [command, keys] of Object.entries(sent)) {
      const parameters = rustParameters(command)
        .map((name) => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()))

      expect(
        parameters,
        `${command} receives [${parameters.join(', ')}] but the webview sends ` +
          `[${keys.join(', ')}] — a name the command does not receive refuses ` +
          'the call before its body runs',
      ).toEqual(keys)
    }
  })

  it('accounts for every command the webview invokes with arguments', () => {
    // Rust is the ledger, not the payload's shape: any command that takes
    // arguments and is invoked from the webview must have had a literal
    // payload parsed by `sentArguments`. Detecting payloads by seeing a
    // `{` would let `invoke('cmd', buildPayload())` — a payload this test
    // cannot read — pass in perfect silence.
    const sent = sentArguments()
    const names = [...new Set(
      [...tauriSource.matchAll(/invoke[^'\n]*'([a-z_]+)'/g)].map(([, command]) => command),
    )]

    const unparsed = names.filter(
      (command) => !(command in sent) && rustParameters(command).length > 0,
    )
    expect(
      unparsed,
      `${unparsed.join('; ')} — takes arguments, but sentArguments parsed ` +
        'no payload for it; the payload must be a literal this test can read',
    ).toEqual([])

    // And every `invoke` call site must have yielded a command name at all,
    // so a dynamically-named command cannot slip past both checks above.
    const callSites = [...tauriSource.matchAll(/\binvoke\s*[<(]/g)].length
    expect(
      names.length,
      `${callSites - names.length} invoke call site(s) this test cannot read ` +
        'a command name from — command names must be string literals',
    ).toBe(callSites)
  })
})

/**
 * The overwrite question is the save dialog's alone: it is the one that
 * shows "Replace?" and the user answers it there. A command that answers
 * it again — `path.exists()` and a hard error — turns the dialog's own
 * confirmation into "Could not back up the journal." The contract instead
 * settles the write beside whatever is there, exactly as export's
 * `free_path` does, and carries the settled path back so the toast names
 * where the snapshot actually went. Nothing on disk is ever replaced,
 * renamed or deleted to make room for a backup.
 */
describe('the manual backup settles beside rather than refuses', () => {
  /** The body of the backup_journal command, extracted whole. */
  function commandBody(): string {
    const body = rustSource.match(/async fn backup_journal\([\s\S]*?\n\}\n/)?.[0]
    if (body === undefined) {
      throw new Error('backup_journal is not a command in ' + RUST_FILE)
    }
    return body
  }

  it('settles the destination instead of refusing what the dialog confirmed', () => {
    const body = commandBody()
    expect(body).toContain('settle_destination')
    // The refusal this replaces: a taken path answered with an error after
    // the dialog had already asked the user about it.
    expect(body).not.toContain('.exists()')
  })

  it('reports where the snapshot went, not where it was asked', () => {
    const body = commandBody()
    // BackupResult is built from the settled destination — otherwise the
    // toast would name a file that is not the one holding the snapshot.
    expect(body).toMatch(/path:\s*destination/)
  })

  it('mirrors the settlement in the testing desktop the webview tests run on', () => {
    const fake = read('src/platform/testing/desktop.ts')
    expect(fake).toContain('nextSibling(path, desktop.backups)')
  })
})

/**
 * The manual backup's save dialog, checked where the drift actually happens:
 * `tauri-desktop.ts` opens the dialog from the webview — there is no Rust
 * command between the button and the OS — so the suggestion the user is
 * offered lives entirely on this side. A dialog with no `defaultPath` offers
 * no name and no folder, and the user meets it in whatever directory the OS
 * last had open: ADR 0032's "the dialog is offered the timestamped name, in
 * Downloads, so the common case is one confirm" quietly false. The test
 * reads `tauri-desktop.ts` and holds the dialog to what the ADR says.
 */
describe('the manual backup save dialog', () => {
  const tauriDesktopSource = read('src/platform/tauri-desktop.ts')

  it('offers a defaultPath built from the Downloads folder and the backup name', () => {
    const choose = tauriDesktopSource.match(
      /async chooseBackupLocation\(\) \{([\s\S]*?)\n\s*\},/,
    )?.[1]
    expect(
      choose,
      'chooseBackupLocation is not where it is expected to be',
    ).toBeTruthy()

    // The suggestion is one path, assembled where it is used: the folder and
    // the name together, as one `defaultPath`.
    expect(choose).toContain('defaultPath')
    expect(choose).toContain('downloadDir()')
    expect(choose).toContain('backupFileName()')
  })

  it('names the backup by the same convention the snapshots use', () => {
    // `work-journal-` + UTC second-precise stamp + `.db` — the format ADR
    // 0032 names, and the one the automatic snapshots carry. Asserted on the
    // produced string for a known instant rather than on the body's words:
    // a missing `T` or a wrong separator would otherwise read as fine. A
    // manual backup suggested under any other name would read as a different
    // family of file from the ones the app makes on its own.
    expect(backupFileName(new Date(Date.UTC(2026, 8, 3, 8, 45, 0)))).toBe(
      'work-journal-20260903T084500.db',
    )
  })
})

/**
 * The restore's open dialog and staged apply, checked where the drift
 * actually happens. Choosing a candidate opens the dialog from the webview
 * with no Rust command between the button and the OS, so the filter lives
 * entirely on this side; staging validates on the Rust side and the startup
 * hook applies before plugin-sql opens. A dialog with no filter offers every
 * file, and a hook registered after the sql plugin opens onto the journal it
 * was meant to replace.
 */
describe('the restore from a backup', () => {
  const tauriDesktopSource = read('src/platform/tauri-desktop.ts')

  it('opens the candidate dialog filtered to the backup extension', () => {
    const choose = tauriDesktopSource.match(
      /async chooseRestoreCandidate\(\) \{([\s\S]*?)\n\s*\},/,
    )?.[1]
    expect(
      choose,
      'chooseRestoreCandidate is not where it is expected to be',
    ).toBeTruthy()

    // No path is ever hand-typed: the dialog filters to the backup
    // extension, offers one file, and a cancelled dialog answers null.
    expect(choose).toContain('filters')
    expect(choose).toContain("'db'")
    expect(choose).toContain('multiple: false')
  })

  it('stages through the command the Rust side validates', () => {
    expect(tauriDesktopSource).toContain("invoke('stage_restore'")
  })

  it('registers the staged apply before plugin-sql opens', () => {
    // The only moment nothing holds the live journal is before the sql
    // plugin's setup connects the pool and runs the migrations. The restore
    // plugin's setup must run first, which registration order decides.
    const restoreAt = rustSource.indexOf('Builder::new("restore")')
    const sqlAt = rustSource.indexOf('tauri_plugin_sql::Builder::new()')
    expect(restoreAt).toBeGreaterThan(-1)
    expect(sqlAt).toBeGreaterThan(-1)
    expect(
      restoreAt,
      'the restore hook must be registered before plugin-sql',
    ).toBeLessThan(sqlAt)
    expect(rustSource).toContain('apply_staged_restore')
  })

  it('grants the open dialog beside the save dialog and nothing more', () => {
    const capabilities = read('src-tauri/capabilities/default.json')
    expect(capabilities).toContain('dialog:allow-open')
    expect(capabilities).toContain('dialog:allow-save')
  })

  it('mirrors the staging in the testing desktop the webview tests run on', () => {
    const fake = read('src/platform/testing/desktop.ts')
    expect(fake).toContain('chooseRestoreCandidate')
    expect(fake).toContain('stageRestore')
    expect(fake).toContain('stagedRestores')
  })
})

/**
 * The Work Summary call's wire contract, checked the way the rest of the
 * shared names are — by reading both sides' sources, because a drift between
 * them is silent: no error, no failed build, and no symptom except a failure
 * that renders as a blank line. `src-tauri/src/work_summary.rs` also pins the
 * exact serialized shapes from its own side; these tests hold the TypeScript
 * half of the same pairs.
 */
describe('the Work Summary call contract', () => {
  const workSummarySource = read('src-tauri/src/work_summary.rs')
  const desktopSource = read(DESKTOP_FILE)

  it('spells the failure kinds the same on both sides', () => {
    const rustKinds = rustVariants(workSummarySource, 'WorkSummaryFailure').map(kebab)
    const tsKinds = tsUnionKinds(desktopSource, 'WorkSummaryFailure')

    expect(rustKinds).toEqual([
      'model-access',
      'https-required',
      'keychain',
      'offline',
      'unauthorized',
      'rate-limited',
      'timeout',
      'other',
      'empty-response',
    ])
    // One kind is this side's own — a call that could not even be prepared
    // is never the model's answer, so Rust has no name for it — and it is
    // named first in the union, where the comment next to it says so.
    expect(tsKinds).toEqual(['local', ...rustKinds])
  })

  it('spells the response states the same on both sides', () => {
    const rustStates = rustVariants(workSummarySource, 'WorkSummaryResponse').map(kebab)
    const tsStates = tsUnionKinds(desktopSource, 'WorkSummaryResponse')

    expect(rustStates).toEqual(['generated', 'failed'])
    expect(tsStates).toEqual(rustStates)
  })

  it('names the request fields the same on both sides', () => {
    const rustFields = rustFieldNames(workSummarySource, 'WorkSummaryRequest').map(camel)
    const tsFields = tsFieldNames(desktopSource, 'WorkSummaryRequest')

    expect(rustFields).toEqual([
      'baseUrl',
      'model',
      'systemPrompt',
      'userContent',
    ])
    expect(tsFields).toEqual(rustFields)
  })
})

/**
 * The commit reader's wire contract, held the same way as the Work Summary's:
 * `src-tauri/src/commits.rs` pins the serialized shapes from its side, and
 * these hold the TypeScript half of each pair.
 */
describe('the commit reader contract', () => {
  const commitsSource = read('src-tauri/src/commits.rs')
  const desktopSource = read(DESKTOP_FILE)
  const tauriSource = read('src/platform/tauri-desktop.ts')

  it('spells the reasons a repository is unreadable the same on both sides', () => {
    const rustReasons = rustVariants(commitsSource, 'Unreadable').map(kebab)

    expect(rustReasons).toEqual([
      'missing',
      'not-a-repository',
      'no-head',
      'git-unavailable',
    ])
    expect(tsUnionKinds(desktopSource, 'RepositoryUnreadable')).toEqual(rustReasons)
  })

  it('spells both answers\' states the same on both sides', () => {
    for (const name of ['CommitsRead', 'IdentitiesRead']) {
      const rustStates = rustVariants(commitsSource, name).map(kebab)

      expect(rustStates, name).toEqual(['read', 'unreadable'])
      expect(tsUnionKinds(desktopSource, name), name).toEqual(rustStates)
    }
  })

  it('names a commit\'s fields the same on both sides', () => {
    const rustFields = rustFieldNames(commitsSource, 'Commit').map(camel)

    expect(rustFields).toEqual(['hash', 'subject', 'authoredAt', 'repository'])
    expect(tsFieldNames(desktopSource, 'Commit')).toEqual(rustFields)
  })

  it('reaches both commands under the names and arguments they take', () => {
    const rustSource = read(RUST_FILE)
    const handler = rustSource.match(
      /invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/,
    )?.[1]

    expect(rustSource).toMatch(
      /#\[tauri::command\(async\)\]\s*fn repository_commits\(path: String, identities: Vec<String>, since: f64\)/,
    )
    expect(rustSource).toMatch(
      /#\[tauri::command\(async\)\]\s*fn repository_identities\(path: String\)/,
    )
    expect(handler).toContain('repository_commits')
    expect(handler).toContain('repository_identities')
    expect(tauriSource).toContain(
      "invoke<CommitsRead>('repository_commits', { path, identities, since })",
    )
    expect(tauriSource).toContain(
      "invoke<IdentitiesRead>('repository_identities', { path })",
    )
  })
})

/** The variant names of one Rust enum, as written. */
function rustVariants(source: string, name: string): string[] {
  const body = source.match(new RegExp(`pub enum ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? ''
  return [...body.matchAll(/^\s*([A-Z][A-Za-z0-9]*)(?=\s*[,{(])/gm)].map(([, variant]) => variant)
}

/** The field names of one Rust struct, as written. */
function rustFieldNames(source: string, name: string): string[] {
  const body = source.match(new RegExp(`pub struct ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? ''
  return [...body.matchAll(/^\s*pub ([a-z_]+):/gm)].map(([, field]) => field)
}

/** The quoted member names of one TypeScript union, as written. */
function tsUnionKinds(source: string, name: string): string[] {
  const body = source.match(new RegExp(`export type ${name} =\\n([\\s\\S]*?)\\n\\n`))?.[1] ?? ''
  return [...body.matchAll(/'([a-z-]+)'/g)].map(([, kind]) => kind)
}

/** The field names of one TypeScript interface, as written. */
function tsFieldNames(source: string, name: string): string[] {
  const body = source.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? ''
  return [...body.matchAll(/^\s{2}([a-z][A-Za-z]*):/gm)].map(([, field]) => field)
}

/** `ModelAccess` to `model-access`, the serde rule the Rust side declares. */
function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter, at) =>
    at === 0 ? letter.toLowerCase() : `-${letter.toLowerCase()}`,
  )
}

/** `base_url` to `baseUrl`, matching `#[serde(rename_all = "camelCase")]`. */
function camel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
}
