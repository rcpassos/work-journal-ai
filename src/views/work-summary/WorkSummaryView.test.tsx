// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { fakeDesktop, type FakeDesktop } from '@/platform/testing/desktop'
import { createJournal, formatDayRange, type Journal } from '@/journal/journal'
import { fixedClock, openTestDatabase } from '@/journal/testing/database'
import { createAppSettings } from '@/settings/app-settings'
import type { WorkSummaryFailure } from '@/platform/desktop'
import {
  buildWorkSummaryMaterial,
  selectWorkSummary,
} from '@/journal/work-summary'
import WorkSummaryView from './WorkSummaryView'
import {
  dayCell,
  installMeasurementStubs,
} from '@/views/history/testing/history-view'

// Base UI positions its popups against measured elements, and jsdom measures
// nothing and ships neither observer.
beforeAll(installMeasurementStubs)

const openDatabases: Array<() => void> = []

afterEach(() => {
  cleanup()
  // Sonner keeps its messages outside React, so unmounting a view leaves
  // them standing for the next test to count.
  toast.dismiss()
  for (const close of openDatabases.splice(0)) close()
})

const STORED = { modelBaseUrl: 'https://api.openai.com/v1', model: 'gpt-test' }

async function workSummaryAt(stored: Record<string, unknown> = STORED) {
  const { driver, close } = await openTestDatabase()
  openDatabases.push(close)
  const clock = fixedClock('2026-03-12T09:00:00')
  const journal = createJournal({ clock, driver })
  const desktop = fakeDesktop({ driver, stored })
  const settings = createAppSettings(desktop)
  return { clock, desktop, settings, journal }
}

function renderWorkSummary({
  desktop,
  settings,
  journal,
  clock,
  onOpenSettings = () => undefined,
}: {
  desktop: FakeDesktop
  settings: ReturnType<typeof createAppSettings>
  journal: Journal
  clock: ReturnType<typeof fixedClock>
  onOpenSettings?: () => void
}) {
  render(
    <WorkSummaryView
      desktop={desktop}
      settings={settings}
      journal={Promise.resolve(journal)}
      clock={clock}
      onOpenSettings={onOpenSettings}
    />,
  )
}

/**
 * The summary lives one click past the chevron: the primary is always the
 * material, so copying the summary opens the menu first.
 */
async function copySummaryFromMenu(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'More copy options' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Copy summary' }))
}

/** A week holding Notes and a completed Task, and current commitments of every schedule. */
async function journalWithBothHalves(
  journal: Journal,
  clock: ReturnType<typeof fixedClock>,
): Promise<void> {
  clock.set(new Date('2026-03-09T09:00:00'))
  await journal.capture('#ops shipped the migration')
  clock.set(new Date('2026-03-10T09:00:00'))
  await journal.capture('plain note')
  const completed = await journal.createTask('kept tuesday')
  await journal.completeTask(completed.id)

  clock.set(new Date('2026-03-12T09:00:00'))
  await journal.createTask('overdue', { date: '2026-03-10', time: null })
  await journal.createTask('today', { date: '2026-03-12', time: '17:00' })
  await journal.createTask('upcoming', { date: '2026-03-13', time: null })
  await journal.createTask('unscheduled')
}

/**
 * A Recurring Task one of whose occurrences was completed in the range: the
 * series was created on the 11th for the 11th at 09:00, opened on that slot,
 * and was completed at 10:00 that morning. The parent continues among the
 * current commitments, and a reanchoring edit moves its Open slot out to next
 * week — which a schedule edit does without touching the kept history — so
 * the tests that use this see the occurrence and its count on their own.
 */
async function journalWithCompletedOccurrence(
  journal: Journal,
  clock: ReturnType<typeof fixedClock>,
): Promise<void> {
  clock.set(new Date('2026-03-11T08:00:00'))
  const daily = await journal.createTask(
    'water the plants',
    { date: '2026-03-11', time: '09:00' },
    { unit: 'day', interval: 1, weekdays: [] },
  )

  clock.set(new Date('2026-03-11T10:00:00'))
  await journal.completeTask(daily.id)

  clock.set(new Date('2026-03-12T09:00:00'))
  await journal.editTask(daily.id, {
    description: 'water the plants',
    schedule: { date: '2026-03-16', time: '09:00' },
  })
}

describe('Work Summary section', () => {
  it('shows this week’s range and the counts for both halves', async () => {
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })

    // The range carries the thin spaces `formatRange` writes, which the
    // text query cannot match exactly — so the Days button is queried by
    // prefix and the range itself is read off the element.
    const scope = await screen.findByRole('button', { name: /^Days / })
    expect(scope.textContent).toContain(
      formatDayRange('2026-03-09', '2026-03-12'),
    )
    expect(await screen.findByText('2 Notes')).toBeTruthy()
    expect(await screen.findByText('1 Completed Task')).toBeTruthy()
    expect(await screen.findByText('0 recurring completions')).toBeTruthy()
    expect(await screen.findByText('4 Open Tasks')).toBeTruthy()
    expect(await screen.findByRole('button', { name: 'Generate' })).toBeTruthy()
  })

  it('keeps the opening week’s range when the clock moves past midnight', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    const scope = await screen.findByRole('button', { name: /^Days / })
    expect(scope.textContent).toContain(
      formatDayRange('2026-03-09', '2026-03-12'),
    )

    // Past midnight into next week: a focus re-read refreshes the data, but
    // the range chosen when the window opened stands.
    clock.set(new Date('2026-03-16T09:00:00'))
    desktop.focus()
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /^Days / }).textContent,
      ).toContain(formatDayRange('2026-03-09', '2026-03-12'))
    })

    // And generation still sends the settled week, not the new one.
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText('The work summary the model wrote.')
    expect(desktop.workSummaryRequests[0].userContent).toContain(
      `# ${formatDayRange('2026-03-09', '2026-03-12')}`,
    )
  })

  it('copies and generates from the selection on screen when Notes change underneath', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    clock.set(new Date('2026-03-10T09:00:00'))
    const note = await journal.capture('about to go')
    await journal.createTask('still open')
    clock.set(new Date('2026-03-12T09:00:00'))

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByText('1 Note')

    // Deleted with no change announced, so the session still holds the
    // selection the section showed: counts, copy, and request all describe
    // that same selection rather than a mix of old and new.
    await journal.delete(note!.id)
    expect(screen.getByText('1 Note')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Copy material' }))
    await waitFor(() => {
      expect(desktop.clipboard).toContain('about to go')
    })

    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText('The work summary the model wrote.')
    expect(desktop.workSummaryRequests[0].userContent).toContain('about to go')

    // After a refresh the new selection is used instead.
    desktop.announceJournalChanged()
    await waitFor(() => {
      expect(screen.getByText('0 Notes')).toBeTruthy()
    })
    await user.click(screen.getByRole('button', { name: 'Copy material' }))
    await waitFor(() => {
      expect(desktop.clipboard).not.toContain('about to go')
    })
  })

  it('counts recurring completions separately from Completed Tasks', async () => {
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithCompletedOccurrence(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })

    // The occurrence is not a Completed Task, so the summary never folds it
    // into that count: the user sees what a billable call is about to spend
    // itself on, and a Task Occurrence is a different record.
    expect(await screen.findByText('0 Completed Tasks')).toBeTruthy()
    expect(await screen.findByText('1 recurring completion')).toBeTruthy()
  })

  it('sends the completed occurrence in the material a call is written from', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithCompletedOccurrence(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Generate' })

    await user.click(screen.getByRole('button', { name: 'Generate' }))

    await screen.findByText('The work summary the model wrote.')
    expect(desktop.workSummaryRequests[0].userContent).toContain(
      '- [x] water the plants (occurrence 2026-03-11 09:00)',
    )
  })

  it('says Nothing to say when both halves are empty, and refuses Generate without spending a call', async () => {
    const { clock, desktop, settings, journal } = await workSummaryAt()

    renderWorkSummary({ journal, clock, desktop, settings })

    expect(await screen.findByText('Nothing to say yet.')).toBeTruthy()
    expect(screen.getByText('0 Notes')).toBeTruthy()
    expect(screen.getByText('0 Completed Tasks')).toBeTruthy()
    expect(screen.getByText('0 Open Tasks')).toBeTruthy()

    // The refusal is on screen before a call could be spent: nothing was
    // asked for, and nothing could be.
    const generate = screen.getByRole('button', { name: 'Generate' })
    expect((generate as HTMLButtonElement).disabled).toBe(true)
    expect(desktop.workSummaryRequests).toEqual([])
    // And the clipboard is untouched: there is no material to write and no
    // claim about one.
    expect(desktop.clipboard).toBeNull()
  })

  it('generates from the week’s Notes and the Tasks, and Copy puts it on the clipboard', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Generate' })

    await user.click(screen.getByRole('button', { name: 'Generate' }))

    // The model's summary is on screen, named by the model that wrote it.
    expect(
      await screen.findByText('The work summary the model wrote.'),
    ).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Written by gpt-test' })).toBeTruthy()

    // What was sent: the settings' Base URL and Model, the system prompt the
    // settings hold — the shipped one while the store says nothing about it —
    // and the selection's own Digest and Task lists.
    expect(desktop.workSummaryRequests).toHaveLength(1)
    const request = desktop.workSummaryRequests[0]
    expect(request.baseUrl).toBe('https://api.openai.com/v1')
    expect(request.model).toBe('gpt-test')
    expect(request.systemPrompt).toContain('work summary')
    expect(request.userContent).toContain('- #ops shipped the migration')
    expect(request.userContent).toContain('## Completed')
    expect(request.userContent).toContain('## Currently open')

    await copySummaryFromMenu(user)

    await waitFor(() => {
      expect(desktop.clipboard).toBe('The work summary the model wrote.')
    })
    // Said twice, and naming its subject in both: the one live region — and
    // the toast, which is why the same words must be found exactly twice.
    expect(screen.getByRole('status').textContent).toBe(
      'Copied summary to the clipboard.',
    )
    expect(
      await screen.findAllByText('Copied summary to the clipboard.'),
    ).toHaveLength(2)
  })

  it('copies the exact Work Summary Material with zero model calls and no Model Access', async () => {
    const user = userEvent.setup()
    // No Model Access at all — the state this button exists for.
    const { journal, clock, desktop, settings } = await workSummaryAt({})
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Copy material' })

    await user.click(screen.getByRole('button', { name: 'Copy material' }))

    const expected = buildWorkSummaryMaterial(await selectWorkSummary({ journal, range: { from: '2026-03-09', to: '2026-03-12' } }))
    await waitFor(() => {
      expect(desktop.clipboard).toBe(expected)
    })
    // The Markdown carries both halves, exactly as a call would send it.
    expect(desktop.clipboard).toContain('- #ops shipped the migration')
    expect(desktop.clipboard).toContain('## Completed')
    expect(desktop.clipboard).toContain('## Currently open')
    // Naming its subject in the one live region — and said twice with the
    // toast.
    expect(screen.getByRole('status').textContent).toBe(
      "Copied the selected notes and tasks to the clipboard.",
    )
    expect(
      await screen.findAllByText(
        "Copied the selected notes and tasks to the clipboard.",
      ),
    ).toHaveLength(2)
    // No Model Access was read and no call was spent.
    expect(desktop.workSummaryRequests).toEqual([])
  })

  it('keeps Copy material enabled and correct after a summary exists', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Generate' })

    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText('The work summary the model wrote.')

    // Prose has arrived; the lossless rendering is still there on the
    // primary, still live — that is the point of a second rendering. The
    // primary never changes identity: the summary stays one click past the
    // chevron.
    const copyMaterial = screen.getByRole('button', {
      name: 'Copy material',
    }) as HTMLButtonElement
    expect(copyMaterial.disabled).toBe(false)

    // Built before the click: the fixture's clock is shared with the section,
    // and what the selection describes must not move while the copy lands.
    const expected = buildWorkSummaryMaterial(await selectWorkSummary({ journal, range: { from: '2026-03-09', to: '2026-03-12' } }))
    await user.click(copyMaterial)
    await waitFor(() => {
      expect(desktop.clipboard).toBe(expected)
    })
    // The one live region names whichever subject landed last.
    expect(screen.getByRole('status').textContent).toBe(
      "Copied the selected notes and tasks to the clipboard.",
    )
  })

  it('never resurrects an older copy when a re-read retires the latest', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Generate' })
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText('The work summary the model wrote.')

    await copySummaryFromMenu(user)
    await waitFor(() => {
      expect(desktop.clipboard).toBe('The work summary the model wrote.')
    })
    await user.click(screen.getByRole('button', { name: 'Copy material' }))
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(
        "Copied the selected notes and tasks to the clipboard.",
      )
    })

    // Focus re-reads the selection and retires the material claim. The
    // summary's older claim must not come back: one claim replaces the last,
    // so nothing is waiting behind it.
    desktop.focus()
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('')
    })
  })

  it('stops claiming a material copy the moment the section re-reads the selection', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    const copyMaterial = await screen.findByRole('button', {
      name: 'Copy material',
    })
    await user.click(copyMaterial)
    await waitFor(() => {
      expect(desktop.clipboard).not.toBeNull()
    })
    expect(screen.getByRole('status').textContent).toBe(
      "Copied the selected notes and tasks to the clipboard.",
    )

    // Focus is the routine case: alt-tab away and back re-reads the
    // selection, and a claim about material that re-read may have replaced
    // must not outlive it. A journal change and a midnight rollover reach
    // the same listener.
    desktop.focus()
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('')
    })
  })

  it('stops claiming a material copy when the next one fails', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    const copyMaterial = await screen.findByRole('button', {
      name: 'Copy material',
    })
    await user.click(copyMaterial)
    await waitFor(() => {
      expect(desktop.clipboard).not.toBeNull()
    })
    desktop.copyToClipboard = async () => {
      throw new Error('the clipboard refused')
    }

    await user.click(
      screen.getByRole('button', { name: 'Copy material' }),
    )

    // The toast says the copy failed; the live region may not go on saying
    // the opposite.
    await waitFor(() => {
      if (
        !document.body.textContent?.includes(
          "Could not copy the selected notes and tasks.",
        )
      ) {
        throw new Error('the failed copy was not said')
      }
    })
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('stops claiming a summary copy when the next one fails', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Generate' })
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText('The work summary the model wrote.')
    await copySummaryFromMenu(user)
    await waitFor(() => {
      expect(desktop.clipboard).toBe('The work summary the model wrote.')
    })
    desktop.copyToClipboard = async () => {
      throw new Error('the clipboard refused')
    }

    await copySummaryFromMenu(user)

    await waitFor(() => {
      if (
        !document.body.textContent?.includes(
          'Could not copy summary.',
        )
      ) {
        throw new Error('the failed copy was not said')
      }
    })
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('keeps Copy material working after a generation failure', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)
    desktop.workSummaryResponse = {
      state: 'failed',
      failure: { kind: 'offline' },
    }

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Generate' })

    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByRole('alert')

    // No summary ever arrived; the material is still one click away.
    await user.click(screen.getByRole('button', { name: 'Copy material' }))
    const expected = buildWorkSummaryMaterial(await selectWorkSummary({ journal, range: { from: '2026-03-09', to: '2026-03-12' } }))
    await waitFor(() => {
      expect(desktop.clipboard).toBe(expected)
    })
  })

  it('disables Copy material under the same refusal as Generate', async () => {
    const { clock, desktop, settings, journal } = await workSummaryAt()

    renderWorkSummary({ journal, clock, desktop, settings })

    expect(await screen.findByText('Nothing to say yet.')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Copy material' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('offers one copy control, with the summary waiting in its menu', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Copy material' })

    // One visible copy button rather than two: the summary is behind the
    // chevron until one exists.
    expect(
      screen.getAllByRole('button', { name: /copy (material|summary)/i }),
    ).toHaveLength(1)

    await user.click(
      screen.getByRole('button', { name: 'More copy options' }),
    )
    const copySummary = (await screen.findByRole('menuitem', {
      name: 'Copy summary',
    })) as HTMLElement
    expect(copySummary.getAttribute('aria-disabled')).toBe('true')
    expect(copySummary.parentElement?.textContent).toContain(
      'Generate a summary first.',
    )
  })

  it('keeps the primary on the material once a summary exists', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Generate' })
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText('The work summary the model wrote.')

    // Still one visible copy button, and it never changes identity: the
    // summary joins the menu rather than relabelling the primary.
    expect(
      screen.getAllByRole('button', { name: /copy (material|summary)/i }),
    ).toHaveLength(1)
    expect(
      screen.getByRole('button', { name: 'Copy material' }),
    ).toBeTruthy()

    await user.click(
      screen.getByRole('button', { name: 'More copy options' }),
    )
    const copySummary = (await screen.findByRole('menuitem', {
      name: 'Copy summary',
    })) as HTMLElement
    expect(copySummary.getAttribute('aria-disabled')).not.toBe('true')
  })

  it('says when copying the material could not be written', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)
    let copies = 0
    const write = desktop.copyToClipboard.bind(desktop)
    desktop.copyToClipboard = async (text) => {
      copies += 1
      // The summary copy, if any, still works; the material's write is refused.
      if (text === 'The work summary the model wrote.') return write(text)
      throw new Error('the clipboard refused')
    }

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Copy material' })

    await user.click(screen.getByRole('button', { name: 'Copy material' }))

    await waitFor(() => {
      if (
        !document.body.textContent?.includes(
          "Could not copy the selected notes and tasks.",
        )
      ) {
        throw new Error('the failed material copy was not said')
      }
    })
    expect(copies).toBe(1)
  })

  it('stops claiming a summary copy when Generate replaces the prose', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Generate' })
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText('The work summary the model wrote.')
    await copySummaryFromMenu(user)
    await waitFor(() => {
      expect(desktop.clipboard).toBe('The work summary the model wrote.')
    })
    expect(screen.getByRole('status').textContent).toBe(
      'Copied summary to the clipboard.',
    )

    // A replacement summary retires the claim with the prose it was about: the
    // third retire path, beside a failed copy and the material's re-read.
    desktop.workSummaryResponse = {
      state: 'generated',
      markdown: 'The second summary, replacing the first.',
    }
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText('The second summary, replacing the first.')

    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('announces a repeat copy that lands while the first is still live', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    const copyMaterial = await screen.findByRole('button', {
      name: 'Copy material',
    })
    await user.click(copyMaterial)
    await waitFor(() => {
      expect(desktop.clipboard).not.toBeNull()
    })
    const said = () => screen.getByRole('status')
    expect(said().textContent).toBe(
      "Copied the selected notes and tasks to the clipboard.",
    )

    // A region announces on change: identical text is silence, exactly when
    // the reader most needs telling. A repeat still live says it is a
    // repeat — no re-read gets in between these two clicks.
    await user.click(screen.getByRole('button', { name: 'Copy material' }))
    await waitFor(() => {
      expect(said().textContent).toBe(
        "Copied the selected notes and tasks to the clipboard. (2)",

      )
    })

    // And the retire paths still retire the counted claim whole.
    desktop.focus()
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe('')
    })
  })

  it('announces a repeat copy that overlaps the first', async () => {
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    const copyMaterial = await screen.findByRole('button', {
      name: 'Copy material',
    })

    // Both clicks dispatched before either copy's write has resolved, so
    // neither handler can have seen the other's claim. Counting from the
    // claim as this click first saw it would leave the second copy saying
    // exactly what the first did — silence, which is the failure the count
    // exists to prevent.
    fireEvent.click(copyMaterial)
    fireEvent.click(copyMaterial)

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(
        "Copied the selected notes and tasks to the clipboard. (2)",

      )
    })
  })

  it('announces a repeat summary copy that overlaps the first', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    // Held writes so both copies are in flight at once: the menu closes
    // after each pick, so the second pick reopens it while the first copy
    // has yet to land. Counting from the claim as it stands rather than as
    // this click first saw it leaves the second copy saying exactly what
    // the first did — silence, which is the failure the count exists to
    // prevent.
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const write = desktop.copyToClipboard.bind(desktop)
    desktop.copyToClipboard = async (text) => {
      await held
      return write(text)
    }

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Generate' })
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText('The work summary the model wrote.')

    await user.click(screen.getByRole('button', { name: 'More copy options' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy summary' }))
    await user.click(screen.getByRole('button', { name: 'More copy options' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy summary' }))
    release()

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toBe(
        'Copied summary to the clipboard. (2)',
      )
    })
  })

  it('shows a pending state naming the model while the call is in flight', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const answer = desktop.generateWorkSummary.bind(desktop)
    desktop.generateWorkSummary = async (request) => {
      await held
      return answer(request)
    }

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Generate' })

    await user.click(screen.getByRole('button', { name: 'Generate' }))

    // Ten silent seconds read as broken without this line naming the model.
    expect(await screen.findByText('Writing with gpt-test…')).toBeTruthy()
    expect(screen.queryByText('The work summary the model wrote.')).toBeNull()

    release()
    expect(
      await screen.findByText('The work summary the model wrote.'),
    ).toBeTruthy()
  })

  it('spends only one call when Generate is asked twice in a row', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const answer = desktop.generateWorkSummary.bind(desktop)
    desktop.generateWorkSummary = async (request) => {
      await held
      return answer(request)
    }

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Generate' })

    // Two clicks while the first call is still in flight: a model call is
    // billable, so the second must not become a second call.
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    release()

    await screen.findByText('The work summary the model wrote.')
    expect(desktop.workSummaryRequests).toHaveLength(1)
  })

  it('asks the model under the prompt the user wrote in Settings', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt({
      ...STORED,
      workSummaryPrompt: 'Write it in pirate speak.',
    })
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Generate' })

    await user.click(screen.getByRole('button', { name: 'Generate' }))

    await screen.findByText('The work summary the model wrote.')
    // A tone-only customization rides along, but the mandatory grounding
    // rules ride with it: no customization edits them out.
    expect(desktop.workSummaryRequests[0].systemPrompt).toContain(
      'Write it in pirate speak.',
    )
    expect(desktop.workSummaryRequests[0].systemPrompt).toContain(
      'Say only what the input supports',
    )
  })

  it('sends the shipped prompt, not an empty one, when the stored prompt is cleared', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt({
      ...STORED,
      workSummaryPrompt: '',
    })
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Generate' })

    await user.click(screen.getByRole('button', { name: 'Generate' }))

    await screen.findByText('The work summary the model wrote.')
    const prompt = desktop.workSummaryRequests[0].systemPrompt
    expect(prompt).not.toBe('')
    // A model asked nothing does not write a work summary: the cleared field
    // reads as the shipped voice again, still under the grounding rules.
    expect(prompt).toContain('work summary')
    expect(prompt).toContain('Say only what the input supports')
  })

  it('generates from the current commitments alone when the week holds no accomplishments', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journal.createTask('today', { date: '2026-03-12', time: '17:00' })

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Generate' })

    await user.click(screen.getByRole('button', { name: 'Generate' }))

    expect(
      await screen.findByText('The work summary the model wrote.'),
    ).toBeTruthy()
    expect(desktop.workSummaryRequests[0].userContent).toBe(
      `# ${formatDayRange('2026-03-09', '2026-03-12')}\n\n## Currently open\n- [ ] today (scheduled 2026-03-12 17:00)`,
    )
  })

  it('generates from the week’s accomplishments alone when nothing is currently open', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    clock.set(new Date('2026-03-10T09:00:00'))
    const kept = await journal.createTask('kept tuesday')
    await journal.completeTask(kept.id)
    clock.set(new Date('2026-03-12T09:00:00'))

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Generate' })

    await user.click(screen.getByRole('button', { name: 'Generate' }))

    expect(
      await screen.findByText('The work summary the model wrote.'),
    ).toBeTruthy()
    const userContent = desktop.workSummaryRequests[0].userContent
    expect(userContent).toContain('## Completed')
    expect(userContent).not.toContain('## Currently open')
  })

  it('reports Model Access missing without spending a call, and links to Settings', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt({})
    await journalWithBothHalves(journal, clock)
    const onOpenSettings = vi.fn()

    renderWorkSummary({ journal, clock, desktop, settings, onOpenSettings })
    await screen.findByRole('button', { name: 'Generate' })

    await user.click(screen.getByRole('button', { name: 'Generate' }))

    expect(
      await screen.findByText(
        'Model Access is not configured. Open Settings to add a Base URL, a Model and an API Key.',
      ),
    ).toBeTruthy()
    expect(desktop.workSummaryRequests).toEqual([])

    await user.click(screen.getByRole('button', { name: 'Open Settings' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  it('says a call could not be prepared rather than blaming the network', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)
    // The settings file itself will not open — a local failure, with no model
    // call behind it and no network involved.
    const settings = createAppSettings({
      ...desktop,
      openSettingsStore: async () => {
        throw new Error('the settings file would not open')
      },
    })

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Generate' })

    await user.click(screen.getByRole('button', { name: 'Generate' }))

    expect(
      await screen.findByText('Could not ask for a Work Summary. Try again.'),
    ).toBeTruthy()
    expect(desktop.workSummaryRequests).toEqual([])
  })

  it.each([
    [{ kind: 'model-access' }, 'Model Access is not configured', true],
    [{ kind: 'https-required' }, 'The Base URL must be https to send the API Key', true],
    [{ kind: 'keychain' }, 'macOS is not letting Work Journal reach the API Key', false],
    [{ kind: 'offline' }, 'The model could not be reached', false],
    [{ kind: 'unauthorized' }, 'The model refused the API Key (401)', false],
    [{ kind: 'rate-limited' }, 'The model is rate limited (429)', false],
    [{ kind: 'timeout' }, 'The model took longer than 60 seconds', false],
    [{ kind: 'other', status: 502 }, 'The model answered with an error (502)', false],
    [{ kind: 'empty-response' }, 'The model returned nothing', false],
  ] as Array<[WorkSummaryFailure, string, boolean]>)(
    'renders %s as a line, with Settings only where the fix lives there',
    async (failure, line, opensSettings) => {
      const user = userEvent.setup()
      const { journal, clock, desktop, settings } = await workSummaryAt()
      await journalWithBothHalves(journal, clock)
      desktop.workSummaryResponse = { state: 'failed', failure }

      renderWorkSummary({ journal, clock, desktop, settings })
      await screen.findByRole('button', { name: 'Generate' })

      await user.click(screen.getByRole('button', { name: 'Generate' }))

      expect((await screen.findByRole('alert')).textContent).toContain(line)
      // The way to the fix rides on the failures whose fix lives in Settings.
      const settingsButton = screen.queryByRole('button', {
        name: 'Open Settings',
      })
      if (opensSettings) {
        expect(settingsButton).not.toBeNull()
      } else {
        expect(settingsButton).toBeNull()
      }
      // No failure touches the clipboard.
      expect(desktop.clipboard).toBeNull()
      // And none writes the journal: the Notes are exactly the two captured.
      expect(
        (await journal.notesForFilter({ from: '2026-03-09', to: '2026-03-12' }))
          .length,
      ).toBe(2)
    },
  )

  it('keeps the previous summary on screen when a second Generate fails', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Generate' })

    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText('The work summary the model wrote.')

    // A second call goes wrong. The clipboard has never been touched, and the
    // summary the first call wrote stays on screen for the reader to still use.
    desktop.workSummaryResponse = {
      state: 'failed',
      failure: { kind: 'timeout' },
    }
    await user.click(screen.getByRole('button', { name: 'Generate' }))

    expect(
      await screen.findByText('The model took longer than 60 seconds to answer. Try again.'),
    ).toBeTruthy()
    expect(screen.getByText('The work summary the model wrote.')).toBeTruthy()
    expect(desktop.clipboard).toBeNull()
    expect(desktop.workSummaryRequests).toHaveLength(2)
  })

  it('replaces the summary when Generate is asked again', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Generate' })

    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText('The work summary the model wrote.')

    desktop.workSummaryResponse = {
      state: 'generated',
      markdown: 'The second summary, replacing the first.',
    }
    await user.click(screen.getByRole('button', { name: 'Generate' }))

    expect(
      await screen.findByText('The second summary, replacing the first.'),
    ).toBeTruthy()
    expect(screen.queryByText('The work summary the model wrote.')).toBeNull()
  })

  it('never writes the clipboard when generating, even after a Copy', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Generate' })

    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText('The work summary the model wrote.')
    await copySummaryFromMenu(user)
    await waitFor(() => {
      expect(desktop.clipboard).toBe('The work summary the model wrote.')
    })

    // The copy is the only thing that writes the clipboard: a fresh summary
    // replaces what is on screen, not what is on the clipboard.
    desktop.workSummaryResponse = {
      state: 'generated',
      markdown: 'The replacement summary.',
    }
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText('The replacement summary.')

    expect(desktop.clipboard).toBe('The work summary the model wrote.')
  })

  it('says when a copy could not be written', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)
    desktop.copyToClipboard = async () => {
      throw new Error('the clipboard refused')
    }

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByRole('button', { name: 'Generate' })

    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText('The work summary the model wrote.')
    await copySummaryFromMenu(user)

    await waitFor(() => {
      if (!document.body.textContent?.includes('Could not copy summary.')) {
        throw new Error('the failed copy was not said')
      }
    })
  })

  it('opens on This week with History’s presets on offer and no Project filter', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    const days = await screen.findByRole('button', { name: /^Days / })
    expect(days.textContent).toContain(
      formatDayRange('2026-03-09', '2026-03-12'),
    )

    await user.click(days)
    for (const preset of [
      'Today',
      'Yesterday',
      'This week',
      'Last week',
      'This month',
      'Last month',
    ]) {
      expect(
        await screen.findByRole('button', { name: preset }),
      ).toBeTruthy()
    }
    // No Project axis on this section: Notes and Tasks are considered
    // together, across all of the work.
    expect(screen.queryByLabelText('Project')).toBeNull()
    await user.keyboard('{Escape}')
    expect(desktop.workSummaryRequests).toEqual([])
  })

  it('moves the selection with a preset, without spending a call', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)
    // Last week's accomplishment, scheduled long before it was kept: a Task
    // scheduled outside the range but completed within it is included.
    clock.set(new Date('2026-03-05T09:00:00'))
    await journal.capture('last week’s note')
    const aged = await journal.createTask('aged commitment', {
      date: '2026-02-01',
      time: null,
    })
    await journal.completeTask(aged.id)
    clock.set(new Date('2026-03-12T09:00:00'))

    renderWorkSummary({ journal, clock, desktop, settings })
    expect(await screen.findByText('2 Notes')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /^Days / }))
    await user.click(await screen.findByRole('button', { name: 'Last week' }))

    // The control reads the concrete range the preset settled on — Monday
    // through Sunday of the prior week — and the counts follow it, while the
    // current commitments stand regardless of the range.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Days / }).textContent).toContain(
        formatDayRange('2026-03-02', '2026-03-08'),
      )
    })
    expect(await screen.findByText('1 Note')).toBeTruthy()
    expect(await screen.findByText('1 Completed Task')).toBeTruthy()
    expect(await screen.findByText('4 Open Tasks')).toBeTruthy()
    // Moving the range reads; it never asks the model.
    expect(desktop.workSummaryRequests).toEqual([])
  })

  it('generates and copies the chosen range, not the opening week', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)
    clock.set(new Date('2026-03-05T09:00:00'))
    await journal.capture('last week’s note')
    const aged = await journal.createTask('aged commitment', {
      date: '2026-02-01',
      time: null,
    })
    await journal.completeTask(aged.id)
    clock.set(new Date('2026-03-12T09:00:00'))

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByText('2 Notes')

    await user.click(screen.getByRole('button', { name: /^Days / }))
    await user.click(await screen.findByRole('button', { name: 'Last week' }))
    await screen.findByText('1 Note')

    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText('The work summary the model wrote.')
    const request = desktop.workSummaryRequests[0]
    expect(request.userContent).toContain(
      `# ${formatDayRange('2026-03-02', '2026-03-08')}`,
    )
    expect(request.userContent).toContain('last week’s note')
    expect(request.userContent).toContain(
      '- [x] aged commitment (scheduled 2026-02-01)',
    )
    expect(request.userContent).not.toContain('shipped the migration')
    expect(request.userContent).not.toContain('kept tuesday')

    const expected = buildWorkSummaryMaterial(
      await selectWorkSummary({
        journal,
        range: { from: '2026-03-02', to: '2026-03-08' },
      }),
    )
    await user.click(screen.getByRole('button', { name: 'Copy material' }))
    await waitFor(() => {
      expect(desktop.clipboard).toBe(expected)
    })
    expect(desktop.clipboard).toContain('## Currently open')
  })

  it('selects single days and multi-day periods on the calendar', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByText('2 Notes')

    // One day, picked by clicking it twice: the first click starts the range,
    // the second lands it.
    await user.click(screen.getByRole('button', { name: /^Days / }))
    await user.click(await dayCell('2026-03-10'))
    await user.click(await dayCell('2026-03-10'))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Days / }).textContent).toContain(
        formatDayRange('2026-03-10', '2026-03-10'),
      )
    })
    expect(await screen.findByText('1 Note')).toBeTruthy()
    expect(await screen.findByText('1 Completed Task')).toBeTruthy()

    // A multi-day historical period, whichever end picked first: the core
    // orders the range.
    await user.click(screen.getByRole('button', { name: /^Days / }))
    await user.click(await dayCell('2026-03-11'))
    await user.click(await dayCell('2026-03-09'))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Days / }).textContent).toContain(
        formatDayRange('2026-03-09', '2026-03-11'),
      )
    })
    expect(await screen.findByText('2 Notes')).toBeTruthy()
    expect(desktop.workSummaryRequests).toEqual([])
  })

  it('generates the current commitments alone for a selected day holding nothing accomplished', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByText('2 Notes')

    // Wednesday the 11th holds no Notes and no completions — only the current
    // commitments, which stand regardless of the range.
    await user.click(screen.getByRole('button', { name: /^Days / }))
    await user.click(await screen.findByRole('button', { name: 'Yesterday' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Days / }).textContent).toContain(
        formatDayRange('2026-03-11', '2026-03-11'),
      )
    })
    expect(await screen.findByText('0 Notes')).toBeTruthy()
    expect(await screen.findByText('0 Completed Tasks')).toBeTruthy()
    expect(await screen.findByText('4 Open Tasks')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(
      await screen.findByText('The work summary the model wrote.'),
    ).toBeTruthy()
    const userContent = desktop.workSummaryRequests[0].userContent
    expect(userContent).toContain('## Currently open')
    expect(userContent).not.toContain('## Completed')
  })

  it('selects and generates over a journal holding only Tasks', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    clock.set(new Date('2026-03-10T10:00:00'))
    const kept = await journal.createTask('kept tuesday')
    await journal.completeTask(kept.id)
    clock.set(new Date('2026-03-12T09:00:00'))
    await journal.createTask('still open')

    renderWorkSummary({ journal, clock, desktop, settings })
    expect(await screen.findByText('0 Notes')).toBeTruthy()
    expect(await screen.findByText('1 Completed Task')).toBeTruthy()

    // No Occupied Day is needed: the range moves over Tasks alone.
    await user.click(screen.getByRole('button', { name: /^Days / }))
    await user.click(await dayCell('2026-03-10'))
    await user.click(await dayCell('2026-03-10'))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Days / }).textContent).toContain(
        formatDayRange('2026-03-10', '2026-03-10'),
      )
    })
    expect(await screen.findByText('1 Completed Task')).toBeTruthy()
    expect(await screen.findByText('1 Open Task')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Generate' }))
    expect(
      await screen.findByText('The work summary the model wrote.'),
    ).toBeTruthy()
    expect(desktop.workSummaryRequests[0].userContent).toContain(
      '- [x] kept tuesday',
    )
  })

  it('lands rapid range changes on the latest choice', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)
    clock.set(new Date('2026-03-05T09:00:00'))
    await journal.capture('last week’s note')
    clock.set(new Date('2026-03-12T09:00:00'))

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByText('2 Notes')

    await user.click(screen.getByRole('button', { name: /^Days / }))
    await user.click(await screen.findByRole('button', { name: 'Last week' }))
    await user.click(screen.getByRole('button', { name: /^Days / }))
    await user.click(await screen.findByRole('button', { name: 'This week' }))

    // Both reads were asked; only the newest one's material may stand — and
    // neither spent a call.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Days / }).textContent).toContain(
        formatDayRange('2026-03-09', '2026-03-12'),
      )
    })
    expect(await screen.findByText('2 Notes')).toBeTruthy()
    expect(desktop.workSummaryRequests).toEqual([])
  })

  it('refuses an empty selected period without spending a call', async () => {    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()

    renderWorkSummary({ journal, clock, desktop, settings })
    expect(await screen.findByText('Nothing to say yet.')).toBeTruthy()

    // A moved range with nothing in either half refuses the same way the
    // opening week does: no Generate, no material copy, no call.
    await user.click(screen.getByRole('button', { name: /^Days / }))
    await user.click(await screen.findByRole('button', { name: 'Last week' }))
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Days / }).textContent).toContain(
        formatDayRange('2026-03-02', '2026-03-08'),
      )
    })
    expect(await screen.findByText('Nothing to say yet.')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Copy material' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(desktop.workSummaryRequests).toEqual([])
    expect(desktop.clipboard).toBeNull()
  })

  it('opens a fresh This week when the window is recreated', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    renderWorkSummary({ journal, clock, desktop, settings })
    await screen.findByText('2 Notes')
    await user.click(screen.getByRole('button', { name: /^Days / }))
    await user.click(await screen.findByRole('button', { name: 'Last week' }))
    await screen.findByText('0 Notes')
    cleanup()

    // A recreated Main Window builds the section over: the chosen range went
    // with the closed one.
    renderWorkSummary({ journal, clock, desktop, settings })
    expect(
      (await screen.findByRole('button', { name: /^Days / })).textContent,
    ).toContain(formatDayRange('2026-03-09', '2026-03-12'))
    expect(await screen.findByText('2 Notes')).toBeTruthy()
  })

  it('disables Generate and Copy material between a range move and its read landing', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    // Holds whichever digest read is asked for next, so the move's read can
    // be kept in flight while the control already reads the new range.
    let releaseHeld!: () => void
    const held = new Promise<void>((resolve) => {
      releaseHeld = resolve
    })
    let holdNextDigest = false
    const gated = {
      ...journal,
      digest: async (filter: { from: string; to: string }) => {
        if (holdNextDigest) {
          holdNextDigest = false
          await held
        }
        return journal.digest(filter)
      },
    }

    renderWorkSummary({ journal: gated, clock, desktop, settings })
    expect(await screen.findByText('2 Notes')).toBeTruthy()

    holdNextDigest = true
    await user.click(screen.getByRole('button', { name: /^Days / }))
    await user.click(await screen.findByRole('button', { name: 'Last week' }))

    // The control moved at once while the selection is still the old one —
    // and while it is, neither spending nor copying may go through on the
    // previous period.
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /^Days / }).textContent,
      ).toContain(formatDayRange('2026-03-02', '2026-03-08'))
    })
    expect(screen.getByText('2 Notes')).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Copy material' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    // And the greyed buttons say why: a read for the new range is in flight.
    expect(screen.getByText('Reading the journal…')).toBeTruthy()
    expect(desktop.workSummaryRequests).toEqual([])

    releaseHeld()
    expect(await screen.findByText('0 Notes')).toBeTruthy()
    expect(screen.queryByText('Reading the journal…')).toBeNull()
    expect(
      (screen.getByRole('button', { name: 'Generate' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false)
  })

  it('keeps the date control on screen while the journal is still reading', async () => {
    const user = userEvent.setup()
    const { clock, desktop, settings } = await workSummaryAt()

    render(
      <WorkSummaryView
        desktop={desktop}
        settings={settings}
        journal={new Promise<Journal>(() => {})}
        clock={clock}
        onOpenSettings={() => undefined}
      />,
    )

    // No read has landed, but the days can already be moved: the control is
    // not behind the read.
    expect(
      (await screen.findByRole('button', { name: /^Days / })).textContent,
    ).toContain(formatDayRange('2026-03-09', '2026-03-12'))
    expect(await screen.findByText('Reading the journal…')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: /^Days / }))
    await user.click(await screen.findByRole('button', { name: 'Yesterday' }))
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /^Days / }).textContent,
      ).toContain(formatDayRange('2026-03-11', '2026-03-11'))
    })
  })

  it('keeps the date control on screen when the range would not read', async () => {
    const user = userEvent.setup()
    const { clock, desktop, settings } = await workSummaryAt()
    const unreadable = {
      digest: async () => {
        throw new Error('the journal would not open')
      },
      completedTasks: async () => [],
      occurrencesKeptIn: async () => [],
      openTasks: async () => [],
    } as unknown as Journal

    renderWorkSummary({ journal: unreadable, clock, desktop, settings })
    expect(
      await screen.findByText('The selected period could not be read.'),
    ).toBeTruthy()

    // The failed range can be left: the control stays, and moving it reads
    // again rather than stranding the section.
    const days = await screen.findByRole('button', { name: /^Days / })
    expect(days.textContent).toContain(
      formatDayRange('2026-03-09', '2026-03-12'),
    )
    await user.click(days)
    await user.click(await screen.findByRole('button', { name: 'Yesterday' }))
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /^Days / }).textContent,
      ).toContain(formatDayRange('2026-03-11', '2026-03-11'))
    })
    expect(
      await screen.findByText('The selected period could not be read.'),
    ).toBeTruthy()
    expect(desktop.workSummaryRequests).toEqual([])
  })

  it('keeps paid-for prose on screen when a range move would not read', async () => {
    const user = userEvent.setup()
    const { journal, clock, desktop, settings } = await workSummaryAt()
    await journalWithBothHalves(journal, clock)

    let failNextDigest = false
    const gated = {
      ...journal,
      digest: async (filter: { from: string; to: string }) => {
        if (failNextDigest) throw new Error('the journal would not open')
        return journal.digest(filter)
      },
    }

    renderWorkSummary({ journal: gated, clock, desktop, settings })
    await screen.findByText('2 Notes')
    await user.click(screen.getByRole('button', { name: 'Generate' }))
    await screen.findByText('The work summary the model wrote.')

    // The move's read throws: the alert says so, but the prose stays — a
    // range that would not read must not take it with it.
    failNextDigest = true
    await user.click(screen.getByRole('button', { name: /^Days / }))
    await user.click(await screen.findByRole('button', { name: 'Last week' }))
    expect(
      await screen.findByText('The selected period could not be read.'),
    ).toBeTruthy()
    expect(
      screen.getByText('The work summary the model wrote.'),
    ).toBeTruthy()
    expect(desktop.workSummaryRequests).toHaveLength(1)
  })
})
