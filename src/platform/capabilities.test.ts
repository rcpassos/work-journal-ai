/**
 * Which window may ask for what, checked. A capability grants a list of
 * permissions to a list of windows by name, and nothing in the build objects
 * when one widens: `cargo build` resolves whether every permission named exists,
 * never who ended up holding it. A permission that reaches a window it was
 * never meant for is silent — no error, no failed build, and no symptom until
 * that window does something it should not have been able to do.
 *
 * The two resident panels are the ones to watch. Capture and Task Creation are
 * built at startup and only ever shown and hidden — see
 * docs/adr/0002-capture-window-is-hidden-never-closed.md — so anything granted
 * to them is held for the whole life of the app by a window with no screen to
 * report on it. Installing a release and ending the process to run it belong to
 * the Main Window alone: it is the window the user is looking at when they ask
 * for either, and the only one that can say how it went. See
 * docs/adr/0030-the-app-updates-itself-from-its-own-releases.md.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CAPTURE_WINDOW, MAIN_WINDOW, TASK_CREATION_WINDOW } from './desktop'

const CAPABILITIES = 'src-tauri/capabilities'

/** The window labels this app has, so a new one cannot be forgotten here. */
const EVERY_WINDOW = [CAPTURE_WINDOW, TASK_CREATION_WINDOW, MAIN_WINDOW]

/**
 * A capability as it is written down: a list of windows, and the permissions
 * they get. A permission may be a bare identifier or an object carrying scope,
 * and only the identifier matters here.
 */
interface Capability {
  identifier: string
  windows?: string[]
  permissions?: Array<string | { identifier: string }>
}

function capabilities(): Capability[] {
  return readdirSync(new URL(`../../${CAPABILITIES}`, import.meta.url))
    .filter((file) => file.endsWith('.json'))
    .map(
      (file) =>
        JSON.parse(
          readFileSync(
            new URL(`../../${CAPABILITIES}/${file}`, import.meta.url),
            'utf8',
          ),
        ) as Capability,
    )
}

/**
 * What each window is allowed to ask for, gathered from every capability at
 * once — which is the only way to read it, since a window's permissions are
 * the union of every capability that names it.
 *
 * A capability that names no window is read as naming all of them, which is
 * what Tauri does with it: the stricter reading is also the true one, and a
 * dropped `windows` key is exactly the drift this file exists to catch.
 */
function permissionsByWindow(): Map<string, string[]> {
  const held = new Map<string, string[]>(
    EVERY_WINDOW.map((window) => [window, []]),
  )

  for (const capability of capabilities()) {
    const windows = capability.windows ?? EVERY_WINDOW
    const permissions = (capability.permissions ?? []).map((permission) =>
      typeof permission === 'string' ? permission : permission.identifier,
    )

    for (const window of windows) {
      held.set(window, [...(held.get(window) ?? []), ...permissions])
    }
  }

  return held
}

/** Everything a window may ask of the updater or of its own process. */
function updateRelated(window: string): string[] {
  return (permissionsByWindow().get(window) ?? []).filter(
    (permission) =>
      permission.startsWith('updater:') || permission.startsWith('process:'),
  )
}

describe('who may update the app', () => {
  it('lets the Main Window find a release and restart into what it installed', () => {
    // Not merely "something is granted": a capability deleted or renamed in a
    // refactor leaves a button that fails at the moment it is pressed, and
    // nothing else in the build says so.
    expect(updateRelated(MAIN_WINDOW).sort()).toEqual([
      'process:allow-restart',
      'updater:default',
    ])
  })

  it('grants the resident panels nothing of the updater or the restart', () => {
    // The realistic drift is not a second update capability — it is somebody
    // adding `updater:default` to `default.json`, which names all three
    // windows, because that is the file the other plugins are already in.
    expect(updateRelated(CAPTURE_WINDOW)).toEqual([])
    expect(updateRelated(TASK_CREATION_WINDOW)).toEqual([])
  })

  it('checks every window the app actually builds', () => {
    // This file is only as good as its list of windows: a fourth window added
    // to `desktop.ts` and not to `EVERY_WINDOW` would be unexamined, and would
    // silently pass whatever it had been granted.
    const named = new Set(
      capabilities().flatMap((capability) => capability.windows ?? []),
    )

    expect([...named].sort()).toEqual([...EVERY_WINDOW].sort())
  })
})

describe('who may change Observing', () => {
  it('allows Main configuration and Capture tray actions, without granting Task Creation', () => {
    const permission = 'allow-compare-and-set-observing'
    const held = permissionsByWindow()
    expect(held.get(MAIN_WINDOW)).toContain(permission)
    expect(held.get(CAPTURE_WINDOW)).toContain(permission)
    expect(held.get(TASK_CREATION_WINDOW)).not.toContain(permission)
  })
})

describe('the established Desktop commands', () => {
  it('keeps every existing registered command available to local app windows', () => {
    const root = new URL('../../', import.meta.url)
    const source = readFileSync(new URL('src-tauri/src/lib.rs', root), 'utf8')
    const registered = source.match(/invoke_handler\(tauri::generate_handler!\[([\s\S]*?)\]\)/)?.[1]
      .split(',').map((command) => command.trim().split('::').at(-1))
      .filter((command) => command && command !== 'compare_and_set_observing')
    const permission = readFileSync(new URL('src-tauri/permissions/desktop-commands.toml', root), 'utf8')
    const granted = [...permission.matchAll(/^\s*"([a-z_]+)",?$/gm)].map(([, command]) => command)
    expect(granted).toEqual(registered)
    for (const window of EVERY_WINDOW) {
      expect(permissionsByWindow().get(window)).toContain('existing-desktop-commands')
    }
  })
})
