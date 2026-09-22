// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import HistoryView from './HistoryView'
import { fakeDesktop } from '@/platform/testing/desktop'
import {
  closeTestDatabases,
  dayCell,
  installMeasurementStubs,
  journalHolding,
  noteById,
  showHistory,
} from './testing/history-view'

// One Note as it reads back, and the three corrections a reader can make to it
// — over a real journal, asserting on what is on screen. The Filter's header
// belongs to another file; nothing here reads it.

// Base UI positions its popups against measured elements, and jsdom measures
// nothing and ships neither observer.
beforeAll(installMeasurementStubs)

afterEach(() => {
  cleanup()
  closeTestDatabases()
  vi.restoreAllMocks()
})

describe('a Note row', () => {
  it('reads its Captured At in a gutter of its own', async () => {
    await showHistory([{ at: '2026-03-09T10:00:00', body: 'Monday' }])

    const captured = within(row('Monday')).getByText(
      timeOfDay('2026-03-09T10:00:00'),
    )
    expect(captured.tagName).toBe('TIME')
  })

  it('says the Project as a chip rather than as monospaced text', async () => {
    await showHistory([{ at: '2026-03-09T10:00:00', body: '#alpha Monday' }])

    const chip = within(row('Monday')).getByText('#alpha')
    expect(chip.className).not.toContain('font-mono')
    expect(row('Monday').querySelector('.font-mono')).toBeNull()
  })

  it('marks a corrected Note without saying the word out loud', async () => {
    const user = userEvent.setup()
    await showHistory([{ at: '2026-03-09T10:00:00', body: 'Monday' }])

    await user.click(within(row('Monday')).getByRole('button', { name: /Monday$/ }))
    await user.clear(screen.getByLabelText('Body'))
    await user.keyboard('Monday, corrected{Enter}')

    const corrected = await vi.waitFor(() => row('Monday, corrected'))
    // Heard, but not read: the marker itself is a mark, and it keeps the
    // description it has always carried on hover.
    const marker = within(corrected).getByText('edited')
    expect(marker.className).toContain('sr-only')
    expect(
      within(corrected).getByTitle('Changed since it was captured'),
    ).toBeTruthy()
  })

  it('mutes an Observed Note and shows its source only on hover', async () => {
    const { driver, core } = await journalHolding([])
    await core.capture('typed note')
    await core.observe({
      source: 'work-journal-ai',
      eventKey: '6f47772',
      body: 'shipped the migration',
      happenedAt: '2026-03-09T11:00:00.000Z',
    })
    expect(
      (await core.notesForFilter({ from: '2026-03-09', to: '2026-03-09' })).map(
        (note) => note.body,
      ),
    ).toEqual(['shipped the migration', 'typed note'])
    const desktop = fakeDesktop({ driver })
    render(<HistoryView desktop={desktop} journal={Promise.resolve(core)} />)
    await screen.findByRole('banner')
    expect(screen.getByRole('main').textContent).toContain('shipped the migration')

    const observedButton = (await screen.findByText('shipped the migration'))
      .closest('button')!
    const capturedButton = screen.getByText('typed note').closest('button')!
    expect(observedButton.className).toContain('text-muted-foreground')
    expect(capturedButton.className).not.toContain('text-muted-foreground')
    expect(observedButton.getAttribute('title')).toBe('work-journal-ai')
    expect(capturedButton.getAttribute('title')).toBeNull()
    expect(screen.queryByText('Observed')).toBeNull()
  })
})

describe('the row actions', () => {
  it('keep a gutter of their own rather than covering the Body', async () => {
    await showHistory([{ at: '2026-03-09T10:00:00', body: 'Monday' }])

    // Nothing in a row is laid over anything else: the actions are reserved
    // room in the flow, so the Body never rewraps when they appear.
    expect(row('Monday').querySelector('.absolute')).toBeNull()
  })

  it('stay focusable rather than hidden', async () => {
    await showHistory([{ at: '2026-03-09T10:00:00', body: 'Monday' }])

    // A combobox for the Project, buttons for the other two: what each one
    // opens is what it says it is.
    const actions = [
      within(row('Monday')).getByRole('button', { name: /under another day/ }),
      within(row('Monday')).getByRole('combobox', { name: /under a Project/ }),
      within(row('Monday')).getByRole('button', { name: /^Delete/ }),
    ]

    for (const action of actions) {
      action.focus()
      expect(document.activeElement).toBe(action)
    }
  })

  it('leave no native day picker and no datalist behind', async () => {
    const user = userEvent.setup()
    await showHistory([{ at: '2026-03-09T10:00:00', body: 'Monday' }])

    await user.click(
      within(row('Monday')).getByRole('button', { name: /under another day/ }),
    )
    await screen.findByRole('grid')

    expect(document.querySelector('input[type="date"]')).toBeNull()
    expect(document.querySelector('datalist')).toBeNull()
  })

  it('refile the Note onto a day picked from a calendar', async () => {
    const user = userEvent.setup()
    const { core, notes } = await showHistory([{ at: '2026-03-09T10:00:00', body: 'Monday' }])

    await user.click(
      within(row('Monday')).getByRole('button', { name: /under another day/ }),
    )
    await user.click(await dayCell('2026-03-11'))

    await vi.waitFor(async () => {
      const note = await noteById(core, notes[0].id)
      expect(note?.journalDay).toBe('2026-03-11')
    })
  })
})

describe('the Project combobox', () => {
  it('files the Note under a Project it predicts', async () => {
    const user = userEvent.setup()
    const { core, notes } = await showHistory([
      { at: '2026-03-09T09:00:00', body: '#alpha Earlier' },
      { at: '2026-03-09T10:00:00', body: 'Monday' },
    ])

    await user.click(
      within(row('Monday')).getByRole('combobox', { name: /under a Project/ }),
    )
    await user.click(await screen.findByRole('option', { name: '#alpha' }))

    await vi.waitFor(async () => {
      expect((await noteById(core, notes[1].id))?.project).toBe('alpha')
    })
  })

  it('accepts a Project name nothing has been filed under yet', async () => {
    const user = userEvent.setup()
    const { core, notes } = await showHistory([{ at: '2026-03-09T10:00:00', body: 'Monday' }])

    await user.click(
      within(row('Monday')).getByRole('combobox', { name: /under a Project/ }),
    )
    await user.type(await screen.findByLabelText('Project name'), 'beta{Enter}')

    await vi.waitFor(async () => {
      expect((await noteById(core, notes[0].id))?.project).toBe('beta')
    })
  })

  it('clears the Note to Unfiled from an emptied field', async () => {
    const user = userEvent.setup()
    const { core, notes } = await showHistory([
      { at: '2026-03-09T10:00:00', body: '#alpha Monday' },
    ])

    await user.click(
      within(row('Monday')).getByRole('combobox', { name: /under a Project/ }),
    )
    // Nothing typed is Unfiled waiting to be taken: it heads the list, so
    // Return on an empty field files the Note under no Project at all.
    await user.type(await screen.findByLabelText('Project name'), '{Enter}')

    await vi.waitFor(async () => {
      expect((await noteById(core, notes[0].id))?.project).toBeNull()
    })
  })

  it('clears the Note to Unfiled', async () => {
    const user = userEvent.setup()
    const { core, notes } = await showHistory([{ at: '2026-03-09T10:00:00', body: '#alpha Monday' }])

    await user.click(
      within(row('Monday')).getByRole('combobox', { name: /under a Project/ }),
    )
    await user.click(await screen.findByRole('option', { name: 'Unfiled' }))

    await vi.waitFor(async () => {
      expect((await noteById(core, notes[0].id))?.project).toBeNull()
    })
  })

  it('offers nothing under a name the journal would refuse', async () => {
    const user = userEvent.setup()
    await showHistory([{ at: '2026-03-09T10:00:00', body: 'Monday' }])

    await user.click(
      within(row('Monday')).getByRole('combobox', { name: /under a Project/ }),
    )
    await user.type(await screen.findByLabelText('Project name'), 'not a name')

    // A Project is one run of letters, digits, `_` or `-`; a list offering
    // anything else would be offering a choice that cannot be made.
    await vi.waitFor(() => {
      expect(screen.queryByRole('option')).toBeNull()
    })
  })

  it('abandons on Escape without filing what was typed, and keeps the window', async () => {
    const user = userEvent.setup()
    const { core, notes, desktop } = await showHistory([{ at: '2026-03-09T10:00:00', body: 'Monday' }])
    const closed = vi.spyOn(desktop, 'closeWindow')

    await user.click(
      within(row('Monday')).getByRole('combobox', { name: /under a Project/ }),
    )
    await user.type(await screen.findByLabelText('Project name'), 'beta{Escape}')

    await vi.waitFor(() => {
      expect(screen.queryByRole('option', { name: /beta/ })).toBeNull()
    })
    expect((await noteById(core, notes[0].id))?.project).toBeNull()
    expect(closed).not.toHaveBeenCalled()
  })
})

describe('rewording a Note', () => {
  it('commits on Return', async () => {
    const user = userEvent.setup()
    const { core, notes } = await showHistory([{ at: '2026-03-09T10:00:00', body: 'Monday' }])

    await user.click(within(row('Monday')).getByRole('button', { name: /Monday$/ }))
    await user.clear(screen.getByLabelText('Body'))
    await user.keyboard('Tuesday, really{Enter}')

    await vi.waitFor(async () => {
      expect((await noteById(core, notes[0].id))?.body).toBe('Tuesday, really')
    })
  })

  it('abandons on Escape, and Escape does not close the window', async () => {
    const user = userEvent.setup()
    const { core, notes, desktop } = await showHistory([{ at: '2026-03-09T10:00:00', body: 'Monday' }])
    const closed = vi.spyOn(desktop, 'closeWindow')

    await user.click(within(row('Monday')).getByRole('button', { name: /Monday$/ }))
    await user.clear(screen.getByLabelText('Body'))
    await user.keyboard('Tuesday{Escape}')

    expect((await noteById(core, notes[0].id))?.body).toBe('Monday')
    expect(closed).not.toHaveBeenCalled()
    expect(await screen.findByText('Monday')).toBeTruthy()
  })
})

describe('deleting a Note', () => {
  it('happens only once it is confirmed', async () => {
    const user = userEvent.setup()
    const { core, notes } = await showHistory([{ at: '2026-03-09T10:00:00', body: 'Monday' }])

    await user.click(
      within(row('Monday')).getByRole('button', { name: /^Delete/ }),
    )
    await user.click(
      await screen.findByRole('button', { name: 'Cancel' }),
    )
    expect(await noteById(core, notes[0].id)).not.toBeNull()

    await user.click(
      within(row('Monday')).getByRole('button', { name: /^Delete/ }),
    )
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Delete',
      }),
    )

    await vi.waitFor(async () => {
      expect(await noteById(core, notes[0].id)).toBeNull()
    })
  })
})

/** The row a Note reads on, found the way a reader finds it: by its Body. */
function row(body: string): HTMLElement {
  const found = screen
    .getAllByRole('listitem')
    .find((item) => item.textContent?.includes(body))
  if (found === undefined) throw new Error(`no row saying "${body}"`)
  return found
}

/** The Captured At as the row shows it, in whatever locale the test runs in. */
function timeOfDay(at: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(at))
}
