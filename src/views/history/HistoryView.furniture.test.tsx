// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  closeTestDatabases,
  dayCell,
  installMeasurementStubs,
  showHistory,
  type HistoryOptions,
} from './testing/history-view'

// The furniture around the list: the heading that says which day a run of
// Notes is filed under, the empty states that stand in for a list that is not
// there, and the Nudge. Nothing here reads a Note row or a Filter control.

// Base UI positions its popups against measured elements, and jsdom measures
// nothing and ships neither observer.
beforeAll(installMeasurementStubs)

afterEach(() => {
  cleanup()
  closeTestDatabases()
  vi.restoreAllMocks()
})

describe('a day heading', () => {
  it('names the day its Notes are filed under, once per day', async () => {
    const user = userEvent.setup()
    const { days } = await showFurniture([
      { at: '2026-03-09T10:00:00', body: 'Monday' },
      { at: '2026-03-09T14:00:00', body: 'Monday again' },
      { at: '2026-03-11T10:00:00', body: 'Wednesday' },
    ])

    await user.click(days())
    await user.click(await dayCell('2026-03-09'))
    await user.click(await dayCell('2026-03-11'))
    await screen.findByText('Monday again')

    const headings = await screen.findAllByRole('heading', { level: 2 })
    expect(headings).toHaveLength(2)
    // Every heading stays put while the list under it scrolls, so a run of
    // Notes never loses the day it belongs to.
    for (const heading of headings) {
      expect(heading.className).toContain('sticky')
    }
  })
})

describe('the beginning', () => {
  it('teaches the Hotkey as keys rather than as a string', async () => {
    await showFurniture([], {
      hotkey: {
        note: { state: 'registered', hotkey: 'Cmd+Shift+J' },
        task: { state: 'registered', hotkey: 'Ctrl+Shift+Cmd+T' },
      },
    })

    const empty = await emptyState('No Notes yet')
    expect(
      [...empty.querySelectorAll('kbd[data-slot="kbd"]')].map(
        (key) => key.textContent,
      ),
    ).toEqual(['Cmd', 'Shift', 'J'])
  })

  it('falls back to the Tray Menu when the Hotkey is unavailable', async () => {
    await showFurniture([], {
      hotkey: {
        note: { state: 'unavailable', hotkey: 'Cmd+Shift+J', reason: 'taken' },
        task: { state: 'registered', hotkey: 'Ctrl+Shift+Cmd+T' },
      },
    })

    const empty = await emptyState('No Notes yet')
    expect(empty.textContent).toContain('Work Journal menu')
    // A combination doing nothing is worse than the slow way in, so nothing
    // on screen teaches one.
    expect(empty.querySelector('kbd')).toBeNull()
  })

  it('falls back when the status could not be read at all', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await showFurniture([], { refuseHotkeyStatus: true })

    const empty = await emptyState('No Notes yet')
    expect(empty.textContent).toContain('Work Journal menu')
    expect(empty.querySelector('kbd')).toBeNull()
  })

  it('is anchored by an icon', async () => {
    await showFurniture([])

    const empty = await emptyState('No Notes yet')
    expect(empty.querySelector('svg')).toBeTruthy()
  })

  it('names a Project that exists only as a mapping, with the rename question', async () => {
    const user = userEvent.setup()
    // A repository mapped before anything was captured: the journal holds no
    // Notes at all, and the Project is one anyway.
    await showFurniture([], {
      arrive: (core) =>
        core.setProjectMapping('/code/work-journal-ai/.git', 'work-journal-ai'),
    })

    const empty = await emptyState('No Notes yet')
    expect(empty.textContent).toContain('#work-journal-ai')

    await user.click(
      within(empty).getByRole('button', { name: 'Rename #work-journal-ai' }),
    )
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('#work-journal-ai')
    expect(within(dialog).getByLabelText('New Project name')).toBeTruthy()
  })

  it('names no Project at all when nothing names one', async () => {
    await showFurniture([])

    const empty = await emptyState('No Notes yet')
    expect(empty.textContent).not.toContain('Projects')
    expect(screen.queryByRole('button', { name: /^Rename / })).toBeNull()
  })
})

describe('an empty list', () => {
  it('says the days are empty when nothing narrows them', async () => {
    const user = userEvent.setup()
    const { days } = await showFurniture([
      { at: '2026-03-09T10:00:00', body: 'Monday' },
    ])

    await moveToEmptyDays(user, days)

    const empty = await emptyState('No Notes in these days.')
    expect(empty.querySelector('svg')).toBeTruthy()
  })

  it('says Unfiled when that is what it is narrowed to', async () => {
    const user = userEvent.setup()
    const { project } = await showFurniture([
      { at: '2026-03-09T10:00:00', body: '#alpha Monday' },
    ])

    await user.click(project())
    await user.click(await screen.findByRole('option', { name: 'Unfiled' }))

    await emptyState('No Unfiled Notes in these days.')
  })

  it('names the Project when one is what it is narrowed to', async () => {
    const user = userEvent.setup()
    const { project, days } = await showFurniture([
      { at: '2026-03-09T10:00:00', body: '#alpha Monday' },
      { at: '2026-03-09T11:00:00', body: '#beta Monday' },
    ])

    await user.click(project())
    await user.click(await screen.findByRole('option', { name: '#beta' }))
    await moveToEmptyDays(user, days)

    await emptyState('No Notes under #beta in these days.')
  })

  it('quotes the term when a Search found nothing', async () => {
    const user = userEvent.setup()
    await showFurniture([{ at: '2026-03-09T10:00:00', body: 'Monday' }])

    await user.type(within(header()).getByLabelText('Search'), 'Friday')

    const empty = await emptyState('No Notes say “Friday”.')
    expect(empty.querySelector('svg')).toBeTruthy()
  })
})

describe('the Nudge', () => {
  it('says what happened and waits, as a status', async () => {
    const { desktop, days } = await showFurniture([
      { at: '2026-03-09T10:00:00', body: 'Monday' },
    ])
    const before = days().textContent

    await desktop.announceCapturedNote('2026-03-12')

    const nudge = await vi.waitFor(() => {
      const found = screen
        .getAllByRole('status')
        .find((element) => element.textContent?.includes('A new Note on'))
      if (found === undefined) throw new Error('no nudge')
      return found
    })
    // What is being read has not moved: the Filter is where the reader left it
    // until they act on the Nudge.
    expect(days().textContent).toBe(before)
    expect(within(nudge).getByRole('button', { name: 'Show' })).toBeTruthy()
    expect(within(nudge).getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })
})

/** History as this file reads it: opened, with the header's two controls. */
async function showFurniture(
  captured: Array<{ at: string; body: string }>,
  answer: HistoryOptions = {},
) {
  const opened = await showHistory(captured, answer)

  return {
    ...opened,
    days: () => within(header()).getByRole('button', { name: /^Days/ }),
    project: () => within(header()).getByRole('combobox', { name: /^Project/ }),
  }
}

describe('the window chrome', () => {
  it('keeps a strip above everything for the traffic lights to sit in', async () => {
    await showFurniture([{ at: '2026-03-09T10:00:00', body: 'Monday' }])

    const strip = titleBarStrip()
    // The window's own first row, ahead of the Filter's header: the title bar
    // is an overlay, so whatever is drawn at the top of the window is drawn
    // underneath the close, minimise and zoom buttons.
    expect(strip.parentElement?.firstElementChild).toBe(strip)
    expect(
      strip.compareDocumentPosition(header()) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })
})

/** The room the overlay title bar's traffic lights are left. */
function titleBarStrip(): HTMLElement {
  const strip = document.querySelector<HTMLElement>(
    '[data-slot="window-title-bar"]',
  )
  if (strip === null) throw new Error('the window left no room for the chrome')
  return strip
}

/** The Filter's header, which the furniture is read around. */
function header(): HTMLElement {
  return screen.getByRole('banner')
}

/** Whatever stands in for the list when there is none, by its own answer. */
async function emptyState(heading: string): Promise<HTMLElement> {
  return await screen.findByRole('region', { name: heading })
}

/** Moves the day axis onto days nothing was ever written on. */
async function moveToEmptyDays(
  user: ReturnType<typeof userEvent.setup>,
  days: () => HTMLElement,
): Promise<void> {
  await user.click(days())
  await user.click(await dayCell('2026-03-20'))
  await user.click(await dayCell('2026-03-21'))
}
