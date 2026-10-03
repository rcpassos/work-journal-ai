import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The Tauri CLI refuses to build when an npm package and its Rust crate differ
// in major.minor, and CI never runs `tauri build`, so a routine `cargo update`
// would otherwise first fail inside `tauri-action` on a release tag.

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
}

const packageJson = JSON.parse(read('package.json')) as {
  dependencies: Record<string, string>
}
const pnpmLock = read('pnpm-lock.yaml')
const cargoToml = read('src-tauri/Cargo.toml')
const cargoLock = read('src-tauri/Cargo.lock')

// `@tauri-apps/api` is the `tauri` crate's side; `@tauri-apps/plugin-x` is
// `tauri-plugin-x`'s.
const npmPackages = Object.keys(packageJson.dependencies).filter(
  (name) =>
    name === '@tauri-apps/api' || name.startsWith('@tauri-apps/plugin-'),
)

function crateOf(npmPackage: string): string {
  return npmPackage === '@tauri-apps/api'
    ? 'tauri'
    : npmPackage.replace('@tauri-apps/plugin-', 'tauri-plugin-')
}

function majorMinor(version: string): string {
  return version.split('.').slice(0, 2).join('.')
}

function lockedNpm(name: string): string {
  const escaped = name.replace(/[/-]/g, '\\$&')
  const match = new RegExp(`^ {2}'${escaped}@(\\d+\\.\\d+\\.\\d+)':`, 'm').exec(
    pnpmLock,
  )
  if (!match) throw new Error(`${name} is not in pnpm-lock.yaml`)
  return match[1]
}

function lockedCrate(name: string): string {
  const match = new RegExp(
    `^name = "${name}"\\nversion = "(\\d+\\.\\d+\\.\\d+)"`,
    'm',
  ).exec(cargoLock)
  if (!match) throw new Error(`${name} is not in Cargo.lock`)
  return match[1]
}

function crateRange(name: string): string {
  const match = new RegExp(
    `^${name} = (?:\\{ version = )?"([^"]+)"`,
    'm',
  ).exec(cargoToml)
  if (!match) throw new Error(`${name} is not in Cargo.toml`)
  return match[1]
}

describe('the Tauri npm packages and their Rust crates', () => {
  it('finds the packages it is meant to compare', () => {
    expect(npmPackages).toContain('@tauri-apps/api')
    expect(npmPackages).toContain('@tauri-apps/plugin-sql')
  })

  // The operator and major.minor must match, so neither side can move to a
  // minor the other cannot follow. The patch itself may differ: `api` and the
  // `tauri` crate are released apart.
  it.each(npmPackages)('%s is allowed the same range as its crate', (name) => {
    const withoutPatch = (range: string) => range.replace(/\.\d+$/, '')
    expect(withoutPatch(crateRange(crateOf(name)))).toBe(
      withoutPatch(packageJson.dependencies[name]),
    )
  })

  it.each(npmPackages)("%s is locked to its crate's major.minor", (name) => {
    expect(majorMinor(lockedNpm(name))).toBe(
      majorMinor(lockedCrate(crateOf(name))),
    )
  })
})
