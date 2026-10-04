// @vitest-environment jsdom

import { useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import OnScreenContext from '@/components/on-screen-context'
import { formatDayRange, journalDayFor } from '@/journal/journal'
import HistoryView from './HistoryView'
import { fakeDesktop } from '@/platform/testing/desktop'
import {
  closeTestDatabases,
  dayCell,
  firstListShown,
  installMeasurementStubs,
  journalHolding,
  noteById,
  showHistory,
} from './testing/history-view'

// The Filter's header as the reader meets it: a click on the days, a Project
// chosen, a term typed — over a real journal, asserting on what is on screen.
// The list below it belongs to other tests; nothing here reads a Note row.

// Base UI positions its popups against measured elements, and jsdom measures
// nothing and ships neither observer.
beforeAll(installMeasurementStubs)

afterEach(() => {
  cleanup()
  closeTestDatabases()
  vi.restoreAllMocks()
})

describe('the day axis', () => {
  it('is one control reading the current range in words', async () => {
    const { days } = await showFilter([
      { at: '2026-03-09T10:00:00', body: 'Monday' },
    ])

    expect(days().textContent).toContain(
      formatDayRange('2026-03-09', '2026-03-09'),
    )
  })

  it('leaves no native picker in the header', async () => {
    await showFilter([{ at: '2026-03-09T10:00:00', body: 'Monday' }])

    const header = screen.getByRole('banner')
    expect(header.querySelector('select')).toBeNull()
    expect(header.querySelector('input[type="date"]')).toBeNull()
  })

  it('moves the Filter to the range picked on its calendar', async () => {
    const user = userEvent.setup()
    const { days } = await showFilter([
      { at: '2026-03-09T10:00:00', body: 'Monday' },
      { at: '2026-03-11T10:00:00', body: 'Wednesday' },
    ])

    await user.click(days())
    await user.click(await dayCell('2026-03-09'))
    await user.click(await dayCell('2026-03-11'))

    expect(await screen.findByText('Monday')).toBeTruthy()
    expect(screen.getByText('Wednesday')).toBeTruthy()
    expect(days().textContent).toContain(
      formatDayRange('2026-03-09', '2026-03-11'),
    )
  })
})

describe('a Preset', () => {
  it('sets the days once and is then forgotten', async () => {
    const user = userEvent.setup()
    const { days } = await showFilter([
      { at: '2026-03-09T10:00:00', body: 'Monday' },
    ])
    const today = journalDayFor(new Date())

    await user.click(days())
    await user.click(screen.getByRole('button', { name: 'Today' }))

    // What the control reads is the range that was picked, not the name of
    // the Preset that picked it.
    expect(days().textContent).toContain(formatDayRange(today, today))
    expect(days().textContent).not.toContain('Today')
  })

  it('never touches the Project constraint', async () => {
    const user = userEvent.setup()
    const { days, project } = await showFilter([
      { at: '2026-03-09T10:00:00', body: '#alpha Monday' },
    ])

    await user.click(project())
    await user.click(await screen.findByRole('option', { name: '#alpha' }))
    await user.click(days())
    await user.click(screen.getByRole('button', { name: 'Yesterday' }))

    expect(project().textContent).toContain('#alpha')
  })
})

describe('the Project constraint', () => {
  it('still offers the Project it is narrowed to when no Note carries it', async () => {
    const user = userEvent.setup()
    const { project, desktop, core, notes } = await showFilter([
      { at: '2026-03-09T10:00:00', body: '#alpha Monday' },
    ])

    await user.click(project())
    await user.click(await screen.findByRole('option', { name: '#alpha' }))
    expect(project().textContent).toContain('#alpha')

    // The last Note under it goes, from another window; the constraint stands,
    // so the picker has to keep saying what the empty list is narrowed to.
    await core.delete(notes[0].id)
    await desktop.announceJournalChanged()

    await user.click(project())
    expect(await screen.findByRole('option', { name: '#alpha' })).toBeTruthy()
  })
})

describe('Rename Project', () => {
  /** One Friday under two Projects, so a rename can be told from a merge. */
  async function showTwoProjects() {
    const opened = await showFilter([
      { at: '2026-03-09T10:00:00', body: '#alpha the retry storm' },
      { at: '2026-03-09T11:00:00', body: '#beta invoices' },
    ])
    const user = userEvent.setup()

    await user.click(opened.project())
    await user.click(await screen.findByRole('option', { name: '#alpha' }))

    return { ...opened, user }
  }

  it('is offered next to the constraint only while narrowed to a Project', async () => {
    const { project } = await showFilter([
      { at: '2026-03-09T10:00:00', body: '#alpha Monday' },
    ])
    const user = userEvent.setup()

    expect(
      screen.queryByRole('button', { name: 'Rename Project' }),
    ).toBeNull()

    await user.click(project())
    await user.click(await screen.findByRole('option', { name: '#alpha' }))
    expect(
      screen.getByRole('button', { name: 'Rename Project' }),
    ).toBeTruthy()

    // Unfiled and Any are not a stream to rename: per-Note filing already
    // handles clearing, and there is no name to move.
    await user.click(project())
    await user.click(await screen.findByRole('option', { name: 'Unfiled' }))
    expect(
      screen.queryByRole('button', { name: 'Rename Project' }),
    ).toBeNull()
  })

  it('renames the stream once confirmed, and stays narrowed to it', async () => {
    const { user, core, notes, project } = await showTwoProjects()

    await user.click(screen.getByRole('button', { name: 'Rename Project' }))
    const dialog = await screen.findByRole('alertdialog')
    expect(dialog.textContent).toContain('#alpha')

    await user.type(within(dialog).getByLabelText('New Project name'), 'backend')
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }))

    await vi.waitFor(async () => {
      expect((await noteById(core, notes[0].id))?.project).toBe('backend')
    })
    expect((await noteById(core, notes[1].id))?.project).toBe('beta')
    expect(project().textContent).toContain('#backend')
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('reads a rename to the same name as neither rename nor merge', async () => {
    const { user, core, notes } = await showTwoProjects()

    await user.click(screen.getByRole('button', { name: 'Rename Project' }))
    const dialog = await screen.findByRole('alertdialog')

    // The placeholder suggests exactly this — the name it already has, typed
    // back in whatever case. It is not a merge: #alpha is the source, and the
    // button that would close the dialog while doing nothing must not be
    // offered as either Rename or Merge.
    await user.type(within(dialog).getByLabelText('New Project name'), 'Alpha')
    const confirm = within(dialog).getByRole('button', { name: 'Rename' })
    expect(confirm).toHaveProperty('disabled', true)
    expect(within(dialog).queryByRole('button', { name: 'Merge' })).toBeNull()
    expect(within(dialog).getByRole('alert').textContent).toBe(
      'That is already its name.',
    )

    expect((await noteById(core, notes[0].id))?.project).toBe('alpha')
  })

  it('says Merge when the target already exists, and merges on confirm', async () => {
    const { user, core, notes } = await showTwoProjects()

    await user.click(screen.getByRole('button', { name: 'Rename Project' }))
    const dialog = await screen.findByRole('alertdialog')

    await user.type(within(dialog).getByLabelText('New Project name'), 'beta')
    expect(within(dialog).getByRole('button', { name: 'Merge' })).toBeTruthy()

    await user.click(within(dialog).getByRole('button', { name: 'Merge' }))

    await vi.waitFor(async () => {
      expect((await noteById(core, notes[0].id))?.project).toBe('beta')
      expect((await noteById(core, notes[1].id))?.project).toBe('beta')
    })
  })

  it('offers nothing to confirm while the target is not a Project name', async () => {
    const { user } = await showTwoProjects()

    await user.click(screen.getByRole('button', { name: 'Rename Project' }))
    const dialog = await screen.findByRole('alertdialog')

    await user.type(
      within(dialog).getByLabelText('New Project name'),
      'not a name',
    )
    expect(within(dialog).getByRole('button', { name: 'Rename' })).toHaveProperty(
      'disabled',
      true,
    )

    // The dialog says what is wrong rather than leaving a dead button to say
    // nothing: a control that cannot be pressed still has to explain itself.
    expect(within(dialog).getByRole('alert')).toBeTruthy()
  })

  it('changes nothing when cancelled', async () => {
    const { user, core, notes } = await showTwoProjects()

    await user.click(screen.getByRole('button', { name: 'Rename Project' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.type(within(dialog).getByLabelText('New Project name'), 'backend')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await vi.waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })
    expect((await noteById(core, notes[0].id))?.project).toBe('alpha')
  })

  it('changes nothing when dismissed off screen, with the view', async () => {
    const { core, notes, dismissOffScreen, project } = await showOffScreenable()
    const user = userEvent.setup()

    await user.click(project())
    await user.click(await screen.findByRole('option', { name: '#alpha' }))
    await user.click(screen.getByRole('button', { name: 'Rename Project' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.type(within(dialog).getByLabelText('New Project name'), 'backend')

    // Leaving History takes the question with it, un-asked — ADR 0024.
    dismissOffScreen()

    await vi.waitFor(() => {
      expect(screen.queryByRole('alertdialog')).toBeNull()
    })
    expect((await noteById(core, notes[0].id))?.project).toBe('alpha')
  })

  it('says what failed rather than leaving the reader guessing', async () => {
    silenceErrors()
    const { user, core, notes } = await showTwoProjects()

    // The last Note under #alpha goes from another window between opening the
    // dialog and confirming: the core refuses a rename that would move none.
    await core.delete(notes[0].id)

    await user.click(screen.getByRole('button', { name: 'Rename Project' }))
    const dialog = await screen.findByRole('alertdialog')
    await user.type(within(dialog).getByLabelText('New Project name'), 'backend')
    await user.click(within(dialog).getByRole('button', { name: 'Rename' }))

    const said = await screen.findByRole('alert')
    expect(said.textContent).toContain('could not be renamed')
    expect(await noteById(core, notes[0].id)).toBeNull()
  })
})

describe('Copy notes', () => {
  it('reports through a toast, and says so politely as well', async () => {
    const user = userEvent.setup()
    const { desktop } = await showFilter([
      { at: '2026-03-09T10:00:00', body: 'Monday' },
    ])

    await user.click(screen.getByRole('button', { name: 'Copy notes (1)' }))

    const said = await screen.findByRole('status')
    expect(said.getAttribute('aria-live')).toBe('polite')
    await vi.waitFor(() => expect(said.textContent).not.toBe(''))
    expect(desktop.clipboard).toContain('Monday')

    // The same words the live region carries, up on screen as a toast.
    const toast = await vi.waitFor(() => {
      const found = document.querySelector('[data-sonner-toast]')
      if (found === null) throw new Error('no toast')
      return found
    })
    expect(toast.textContent).toContain(said.textContent)
  })

  it('previews how many Notes a copy would carry', async () => {
    await showFilter([
      { at: '2026-03-09T10:00:00', body: 'Monday' },
      { at: '2026-03-09T11:00:00', body: 'More Monday' },
    ])

    expect(
      screen.getByRole('button', { name: 'Copy notes (2)' }),
    ).toBeTruthy()
  })

  it('is not offered while a Search is showing', async () => {
    const user = userEvent.setup()
    await showFilter([{ at: '2026-03-09T10:00:00', body: 'Monday' }])

    await user.type(within(header()).getByLabelText('Search'), 'Mon')

    await vi.waitFor(() => {
      expect(screen.queryByRole('button', { name: /copy notes/i })).toBeNull()
      expect(
        screen.queryByRole('menuitem', { name: /copy notes/i }),
      ).toBeNull()
    })
  })
})

describe('Copy notes + completed work', () => {
  it('copies the Filter’s Notes and completed work, naming which copy landed', async () => {
    const user = userEvent.setup()
    const { desktop, core, clock } = await showHistory([
      { at: '2026-03-09T10:00:00', body: 'Monday' },
    ])

    clock.set(new Date('2026-03-09T11:00:00'))
    const kept = await core.createTask('kept Monday')
    await core.completeTask(kept.id)

    await user.click(
      screen.getByRole('button', { name: 'More copy options' }),
    )
    await user.click(
      await screen.findByRole('menuitem', {
        name: 'Copy notes + completed work',
      }),
    )

    const said = await screen.findByRole('status')
    await vi.waitFor(() =>
      expect(said.textContent).toContain('notes + completed work'),
    )
    expect(desktop.clipboard).toContain('Monday')
    expect(desktop.clipboard).toContain('## Completed')
    expect(desktop.clipboard).toContain('kept Monday')

    // The same words the live region carries, up on screen as a toast.
    const toast = await vi.waitFor(() => {
      const found = document.querySelector('[data-sonner-toast]')
      if (found === null) throw new Error('no toast')
      return found
    })
    expect(toast.textContent).toContain(said.textContent)
  })

  it('lives in the copy menu rather than beside the copy button', async () => {
    const user = userEvent.setup()
    await showHistory([{ at: '2026-03-09T10:00:00', body: 'Monday' }])

    // One visible copy button: the variant is behind the chevron.
    expect(
      screen.getAllByRole('button', { name: /copy notes/i }),
    ).toHaveLength(1)

    await user.click(
      screen.getByRole('button', { name: 'More copy options' }),
    )
    expect(
      await screen.findByRole('menuitem', {
        name: 'Copy notes + completed work',
      }),
    ).toBeTruthy()
  })

  it('is disabled with the reason under a named Project', async () => {
    const user = userEvent.setup()
    const { project } = await showFilter([
      { at: '2026-03-09T10:00:00', body: '#alpha Monday' },
    ])

    await user.click(project())
    await user.click(await screen.findByRole('option', { name: '#alpha' }))
    await user.click(
      screen.getByRole('button', { name: 'More copy options' }),
    )

    const copy = (await screen.findByRole('menuitem', {
      name: 'Copy notes + completed work',
    })) as HTMLElement
    expect(copy.getAttribute('aria-disabled')).toBe('true')
    // The rule is readable rather than hidden: the disabled row carries it as
    // visible text…
    expect(copy.parentElement?.textContent).toContain(
      'Completed work has no Project, so this is only offered for Any Project.',
    )
    // …and said, to whoever is listening rather than looking.
    expect(ruleSaidTo(copy)).toContain(
      'Completed work has no Project, so this is only offered for Any Project.',
    )
  })

  it('is disabled with the reason under Unfiled', async () => {
    const user = userEvent.setup()
    const { project } = await showFilter([
      { at: '2026-03-09T10:00:00', body: '#alpha Monday' },
    ])

    await user.click(project())
    await user.click(await screen.findByRole('option', { name: 'Unfiled' }))
    await user.click(
      screen.getByRole('button', { name: 'More copy options' }),
    )

    const copy = (await screen.findByRole('menuitem', {
      name: 'Copy notes + completed work',
    })) as HTMLElement
    expect(copy.getAttribute('aria-disabled')).toBe('true')
    expect(copy.parentElement?.textContent).toContain(
      'Completed work has no Project, so this is only offered for Any Project.',
    )
    expect(ruleSaidTo(copy)).toContain(
      'Completed work has no Project, so this is only offered for Any Project.',
    )
  })

  it('writes nothing for an empty range, saying so', async () => {
    const user = userEvent.setup()
    const { days, desktop } = await showFilter([
      { at: '2026-03-09T10:00:00', body: 'Monday' },
    ])

    await user.click(days())
    await user.click(await dayCell('2026-03-10'))
    await user.click(await dayCell('2026-03-11'))

    await user.click(
      screen.getByRole('button', { name: 'More copy options' }),
    )
    await user.click(
      await screen.findByRole('menuitem', {
        name: 'Copy notes + completed work',
      }),
    )

    const said = await screen.findByRole('status')
    await vi.waitFor(() =>
      expect(said.textContent).toContain(
        'No notes or completed work to copy.',
      ),
    )
    expect(desktop.clipboard).toBeNull()
  })

  it('is not offered while a Search is showing', async () => {
    const user = userEvent.setup()
    await showFilter([{ at: '2026-03-09T10:00:00', body: 'Monday' }])

    await user.type(within(header()).getByLabelText('Search'), 'Mon')

    await vi.waitFor(() => {
      expect(
        screen.queryByRole('button', { name: /copy notes/i }),
      ).toBeNull()
    })
  })
})

describe('every filter control', () => {
  it('says what it is to a screen reader', async () => {
    await showFilter([{ at: '2026-03-09T10:00:00', body: 'Monday' }])

    // Each says what it is — and the two that hold a value say that too,
    // rather than letting a label swallow it.
    expect(
      within(header()).getByRole('button', {
        name: `Days ${formatDayRange('2026-03-09', '2026-03-09')}`,
      }),
    ).toBeTruthy()
    expect(
      within(header()).getByRole('combobox', { name: 'Project Any Project' }),
    ).toBeTruthy()
    expect(within(header()).getByLabelText('Search')).toBeTruthy()
  })
})

describe('Escape', () => {
  it('clears a Search before it closes the window', async () => {
    const user = userEvent.setup()
    const { desktop } = await showFilter([
      { at: '2026-03-09T10:00:00', body: 'Monday' },
    ])
    const closed = vi.spyOn(desktop, 'closeWindow')

    const search = within(header()).getByLabelText('Search') as HTMLInputElement
    await user.type(search, 'Mon')
    await vi.waitFor(() => {
      expect(screen.queryByRole('button', { name: /copy notes/i })).toBeNull()
    })

    await user.keyboard('{Escape}')
    await vi.waitFor(() => expect(search.value).toBe(''))
    expect(closed).not.toHaveBeenCalled()

    await user.keyboard('{Escape}')
    expect(closed).toHaveBeenCalled()
  })

  it('closes an open day picker without closing the window', async () => {
    const user = userEvent.setup()
    const { desktop, days } = await showFilter([
      { at: '2026-03-09T10:00:00', body: 'Monday' },
    ])
    const closed = vi.spyOn(desktop, 'closeWindow')

    await user.click(days())
    await screen.findByRole('button', { name: 'Today' })

    await user.keyboard('{Escape}')

    await vi.waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Today' })).toBeNull()
    })
    expect(closed).not.toHaveBeenCalled()
  })
})

/** History as this file reads it: opened, with the header's two controls. */
async function showFilter(captured: Array<{ at: string; body: string }>) {
  const opened = await showHistory(captured)

  return {
    ...opened,
    // Found by what a screen reader hears: the name of the control, and then
    // what it is currently set to. Scoped to the header, because a Note row
    // has a Project of its own and this file is about the Filter.
    days: () => within(header()).getByRole('button', { name: /^Days/ }),
    project: () => within(header()).getByRole('combobox', { name: /^Project/ }),
  }
}

/**
 * The same History under a visibility the test can take away, for what the
 * Main Window seam does to an open dialog: the section is hidden, and the
 * dialog it portalled out of the document goes with it — ADR 0024.
 */
async function showOffScreenable() {
  const { driver, core, notes } = await journalHolding([
    { at: '2026-03-09T10:00:00', body: '#alpha the retry storm' },
    { at: '2026-03-09T11:00:00', body: '#beta invoices' },
  ])

  const desktop = fakeDesktop({ driver })
  const control = { hide: () => {} }
  function Host() {
    const [onScreen, setOnScreen] = useState(true)
    control.hide = () => setOnScreen(false)

    return (
      <div hidden={!onScreen}>
        <OnScreenContext.Provider value={onScreen}>
          <HistoryView desktop={desktop} journal={Promise.resolve(core)} />
        </OnScreenContext.Provider>
      </div>
    )
  }

  render(<Host />)
  await firstListShown(2)

  return {
    desktop,
    core,
    notes,
    dismissOffScreen: control.hide,
    project: () => within(header()).getByRole('combobox', { name: /^Project/ }),
  }
}

/** The Filter's header, which is the whole of what this file is about. */
function header(): HTMLElement {
  return screen.getByRole('banner')
}

/**
 * What a screen reader makes of the nodes a control's description points at:
 * the description is the AT contract, so the assertion reads what it resolves
 * to rather than which DOM structure carries it.
 */
function ruleSaidTo(control: HTMLElement): string {
  const described = control.getAttribute('aria-describedby')?.split(' ') ?? []
  return described
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The record's refusals are the subject here, not noise on the console. */
function silenceErrors() {
  vi.spyOn(console, 'error').mockImplementation(() => {})
}
