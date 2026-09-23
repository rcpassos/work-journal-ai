import { afterEach, describe, expect, it, vi } from 'vitest'
import { createJournal, type Journal } from './journal'
import { fixedClock, openTestDatabase } from './testing/database'
import { fakeDesktop, type FakeDesktop } from '../platform/testing/desktop'
import { createYesterdayDigest } from './yesterday-digest'

// Driven end to end, like the tray count: a real journal over real SQL, a fake
// desktop for the Tray Menu and the clipboard, and an injected clock so
// "yesterday" is a fact of the test rather than of the day it runs on.

const openJournals: Array<() => void> = []

afterEach(() => {
  for (const close of openJournals.splice(0)) close()
})

async function digestAt(instant: string) {
  const { driver, close } = await openTestDatabase()
  openJournals.push(close)
  const clock = fixedClock(instant)
  const journal = createJournal({ clock, driver })
  const desktop = fakeDesktop()
  const copier = createYesterdayDigest({
    journal: Promise.resolve(journal),
    desktop,
    clock,
  })
  return { journal, desktop, clock, copier }
}

/** Lets the read the request started finish before asserting. */
async function flushReads(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
}

async function captureOn(
  journal: Journal,
  clock: { set: (next: Date) => void },
  instant: string,
  text: string,
): Promise<void> {
  clock.set(new Date(instant))
  await journal.capture(text)
}

function onClipboard(desktop: FakeDesktop): string | null {
  return desktop.clipboard
}

describe("yesterday's Digest from the Tray Menu", () => {
  it('copies every Note filed under the previous calendar day', async () => {
    const { journal, desktop, clock, copier } =
      await digestAt('2026-03-12T09:00:00')

    await captureOn(journal, clock, '2026-03-11T09:30:00', 'the migration landed')
    await captureOn(journal, clock, '2026-03-11T16:00:00', 'reviewed the RFC')
    clock.set(new Date('2026-03-12T09:00:00'))
    await copier.start()

    desktop.requestYesterdayDigest()
    await flushReads()

    expect(onClipboard(desktop)).toBe(
      '- the migration landed\n- reviewed the RFC',
    )
  })

  it('reconstructs a day with no Captured Notes from its Observed ones, read exactly like typed', async () => {
    const { journal, desktop, copier } = await digestAt('2026-03-12T09:00:00')

    for (const [hash, subject, at] of [
      ['a1', 'Observe: the third Note origin', '2026-03-11T21:30:00'],
      ['a2', 'Fix the second scrollbar on Settings', '2026-03-11T23:40:00'],
    ]) {
      await journal.observe({
        source: 'commit',
        eventKey: `${hash}@/code/work-journal-ai/.git`,
        body: subject,
        happenedAt: new Date(at).toISOString(),
        project: null,
      })
    }
    await copier.start()

    desktop.requestYesterdayDigest()
    await flushReads()

    expect(onClipboard(desktop)).toBe(
      '- Observe: the third Note origin\n- Fix the second scrollbar on Settings',
    )
  })

  it('leaves out today, however much has been written since', async () => {
    const { journal, desktop, clock, copier } =
      await digestAt('2026-03-12T09:00:00')

    await captureOn(journal, clock, '2026-03-11T09:30:00', 'yesterday')
    await captureOn(journal, clock, '2026-03-12T08:00:00', 'today')
    await copier.start()

    desktop.requestYesterdayDigest()
    await flushReads()

    expect(onClipboard(desktop)).toBe('- yesterday')
  })

  it('carries the Project a Note was filed under into the paste', async () => {
    const { journal, desktop, clock, copier } =
      await digestAt('2026-03-12T09:00:00')

    await captureOn(journal, clock, '2026-03-11T09:30:00', '#atlas shipped it')
    await captureOn(journal, clock, '2026-03-11T10:00:00', 'and said so')
    clock.set(new Date('2026-03-12T09:00:00'))
    await copier.start()

    desktop.requestYesterdayDigest()
    await flushReads()

    expect(onClipboard(desktop)).toBe('- #atlas shipped it\n- and said so')
  })

  it('means the previous calendar day, not the previous Occupied Day', async () => {
    const { journal, desktop, clock, copier } =
      await digestAt('2026-03-12T09:00:00')

    await captureOn(journal, clock, '2026-03-09T09:30:00', 'last thing written')
    clock.set(new Date('2026-03-12T09:00:00'))
    await copier.start()

    desktop.requestYesterdayDigest()
    await flushReads()

    expect(onClipboard(desktop)).toBeNull()
  })

  it('leaves the clipboard alone when yesterday holds nothing', async () => {
    const { desktop, copier } = await digestAt('2026-03-12T09:00:00')
    await copier.start()

    desktop.requestYesterdayDigest()
    await flushReads()

    expect(onClipboard(desktop)).toBeNull()
  })

  it('asks the clock again on every request, so a run past midnight moves with it', async () => {
    const { journal, desktop, clock, copier } =
      await digestAt('2026-03-12T09:00:00')

    await captureOn(journal, clock, '2026-03-11T09:30:00', 'wednesday')
    await captureOn(journal, clock, '2026-03-12T09:30:00', 'thursday')
    clock.set(new Date('2026-03-12T09:00:00'))
    await copier.start()

    clock.set(new Date('2026-03-13T09:00:00'))
    desktop.requestYesterdayDigest()
    await flushReads()

    expect(onClipboard(desktop)).toBe('- thursday')
  })

  it('leaves the clipboard alone when the journal cannot be read', async () => {
    const clock = fixedClock('2026-03-12T09:00:00')
    const desktop = fakeDesktop()
    const copier = createYesterdayDigest({
      journal: Promise.resolve({
        digest: () => Promise.reject(new Error('no database')),
      } as unknown as Journal),
      desktop,
      clock,
    })
    const complaint = vi.spyOn(console, 'error').mockImplementation(() => {})

    await copier.start()
    desktop.requestYesterdayDigest()
    await flushReads()

    expect(onClipboard(desktop)).toBeNull()
    expect(complaint).toHaveBeenCalled()
    complaint.mockRestore()
  })

  it('stops answering the Tray Menu once it is stopped', async () => {
    const { journal, desktop, clock, copier } =
      await digestAt('2026-03-12T09:00:00')

    await captureOn(journal, clock, '2026-03-11T09:30:00', 'the migration landed')
    clock.set(new Date('2026-03-12T09:00:00'))
    await copier.start()
    copier.stop()

    desktop.requestYesterdayDigest()
    await flushReads()

    expect(onClipboard(desktop)).toBeNull()
  })
})
