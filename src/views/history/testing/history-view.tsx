import { vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createJournal, type Journal, type Note } from '@/journal/journal'
import { fixedClock, openTestDatabase } from '@/journal/testing/database'
import { fakeDesktop } from '@/platform/testing/desktop'
import type { HotkeyStatuses } from '@/settings/hotkey'
import HistoryView from '../HistoryView'

/**
 * History over a real journal, for the files that drive it: the Filter's
 * header, the Note rows under it, and the Main Window it is a section of.
 * Shared because they all read the same screen — a second copy of the harness
 * is a second answer to what "open History" means, and only one of them would
 * get fixed.
 */

/** Every database a test opened, so the file can close them all afterwards. */
const openDatabases: Array<() => void> = []

/** Closes what `showHistory` opened. Call from `afterEach`. */
export function closeTestDatabases() {
  for (const close of openDatabases.splice(0)) close()
}

/**
 * What the harness is asked for beside the Captures: how the desktop should
 * answer the Hotkey question, and which Notes arrive by another origin.
 */
export interface HistoryOptions {
  hotkey?: HotkeyStatuses
  /** The OS refusing the question, rather than answering it unfavourably. */
  refuseHotkeyStatus?: boolean
  /**
   * Notes that arrive after the Captures and before History reads — an
   * Import or an Observe, neither of which is a Capture the harness seeds.
   */
  arrive?: (core: Journal) => Promise<unknown>
}

/** History opened over the given journal, already showing its first list. */
export async function showHistory(
  captured: Array<{ at: string; body: string }>,
  { hotkey, refuseHotkeyStatus = false, arrive }: HistoryOptions = {},
) {
  const { driver, core, clock, notes } = await journalHolding(captured)
  await arrive?.(core)

  const desktop = fakeDesktop({ driver, hotkey })
  if (refuseHotkeyStatus) {
    desktop.hotkeyStatus = () => Promise.reject(new Error('no answer'))
  }
  render(<HistoryView desktop={desktop} journal={Promise.resolve(core)} />)
  await firstListShown(await journalSize(core))

  return { desktop, core, clock, notes }
}

/** How many Notes the journal holds — what tells the wait there is a list at all. */
async function journalSize(core: Journal): Promise<number> {
  const all = await core.notesForFilter({ from: '2000-01-01', to: '2100-01-01' })
  return all.length
}

/**
 * A journal holding exactly these Captures, on a database the file will close
 * afterwards. Apart from `showHistory` because the Main Window opens the same
 * History over the same journal and only renders it differently.
 */
export async function journalHolding(
  captured: Array<{ at: string; body: string }>,
) {
  const { driver, close } = await openTestDatabase()
  openDatabases.push(close)

  const clock = fixedClock(new Date('2026-03-09T10:00:00'))
  const core = createJournal({ clock, driver })

  const notes: Note[] = []
  for (const { at, body } of captured) {
    clock.set(new Date(at))
    const note = await core.capture(body)
    if (note === null) throw new Error('nothing was captured')
    notes.push(note)
  }

  return { driver, core, clock, notes }
}

/**
 * Waits for History's first read to land: until it does there is no Filter,
 * and the header is not on screen at all. A journal holding nothing never
 * grows one, so there is nothing to wait for.
 */
export async function firstListShown(captured: number): Promise<void> {
  if (captured > 0) await screen.findByRole('banner')
}

/** One Note as the journal holds it now, whatever day it is filed under. */
export async function noteById(
  core: Journal,
  id: string,
): Promise<Note | null> {
  const notes = await core.notesForFilter({
    from: '2000-01-01',
    to: '2100-01-01',
  })
  return notes.find((note) => note.id === id) ?? null
}

/** A day on the open calendar, pointed at the way a reader points at one. */
export async function dayCell(journalDay: string): Promise<HTMLElement> {
  const [year, month, day] = journalDay.split('-').map(Number)
  const stamp = new Date(year, month - 1, day).toLocaleDateString()

  return await vi.waitFor(() => {
    const cell = document.querySelector(`[data-day="${stamp}"]`)
    if (cell === null) throw new Error(`no ${journalDay} on the calendar`)
    return cell as HTMLElement
  })
}

/**
 * What jsdom does not implement and a positioned popup needs. Stubs rather
 * than a library: these tests assert on what is on screen, never on where.
 */
export function installMeasurementStubs() {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver

  Element.prototype.scrollIntoView ??= () => {}

  globalThis.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof matchMedia
}
