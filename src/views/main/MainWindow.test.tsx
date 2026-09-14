// @vitest-environment jsdom

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import ThemeProvider from '@/components/ThemeProvider'
import { fakeDesktop, type FakeDesktop } from '@/platform/testing/desktop'
import type { CalendarAccess, CalendarInfo, MainSection } from '@/platform/desktop'
import type { Task } from '@/journal/journal'
import type { SettingsStore } from '@/settings/settings'
import { formatDayRange } from '@/views/history/range-label'
import { createAppSettings } from '@/settings/app-settings'
import {
  closeTestDatabases,
  dayCell,
  firstListShown,
  installMeasurementStubs,
  journalHolding,
} from '@/views/history/testing/history-view'
import { holdFrames } from '@/views/settings/testing/frames'
import CaptureView from '@/views/capture/CaptureView'
import MainWindow from './MainWindow'

// The Main Window as the user meets it: a sidebar naming the section on
// screen, exactly one section showing, and each of them reading the journal
// exactly as it read it when it had a window of its own.

// Base UI positions its popups against measured elements, and jsdom measures
// nothing and ships neither observer.
beforeAll(installMeasurementStubs)

afterEach(() => {
  cleanup()
  // Sonner keeps its messages outside React, so unmounting a window leaves
  // them standing for the next one to draw.
  toast.dismiss()
  closeTestDatabases()
  vi.restoreAllMocks()
})

describe('the Main Window', () => {
  it('opens on History, with the Notes already read back', async () => {
    await showMainWindow({ captured: [MONDAY] })

    expect(await screen.findByText('Monday')).toBeTruthy()
    // History's own header, untouched by the sidebar beside it.
    const header = screen.getByRole('banner')
    expect(within(header).getByLabelText('Search')).toBeTruthy()
    expect(within(header).getByRole('button', { name: /^Days/ })).toBeTruthy()
  })

  it('names the section on screen and marks it as the current one', async () => {
    await showMainWindow({ captured: [MONDAY] })

    const history = within(sidebar()).getByRole('button', { name: 'History' })
    expect(history.getAttribute('aria-current')).toBe('page')
    expect(
      within(sidebar())
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['History', 'Tasks', 'Work Summary', 'Settings'])
  })

  it('puts every section a Tab away, as an ordinary button', async () => {
    await showMainWindow({ captured: [MONDAY] })

    for (const name of ['History', 'Tasks', 'Work Summary', 'Settings']) {
      const section = within(sidebar()).getByRole('button', { name })
      // Nothing takes the section out of the tab order or rebinds a key to
      // reach it: the sidebar is a short list of named places.
      expect(section.tabIndex).toBe(0)
      expect(section.getAttribute('disabled')).toBeNull()
    }
  })

  it('leaves the traffic lights the sidebar’s top row', async () => {
    await showMainWindow({ captured: [MONDAY] })

    // The title bar is an overlay drawn over the window's top-left corner,
    // which is over the sidebar rather than over the section.
    expect(sidebar().firstElementChild?.getAttribute('data-slot')).toBe(
      'window-title-bar',
    )
  })
})

describe('the section the Main Window opens on', () => {
  it('is the one the Entry Point that opened it named', async () => {
    await showMainWindow({ captured: [MONDAY], section: 'tasks', tasks: ['renew the cert'] })

    await showsTasks()
  })

  it('lands on Settings when the Entry Point names it', async () => {
    await showMainWindow({ captured: [MONDAY], section: 'settings' })

    await showsSettings()
    expect(
      within(sidebar()).getByRole('button', { name: 'Settings' }).getAttribute('aria-current'),
    ).toBe('page')
  })

  it('lands on Work Summary when the Entry Point names it', async () => {
    await showMainWindow({ captured: [MONDAY], section: 'work-summary' })

    await showsWorkSummary()
  })

  it('is History when the Entry Point named none', async () => {
    await showMainWindow({ captured: [MONDAY], tasks: ['renew the cert'] })

    await showsHistory()
  })

  it('is the one named while the window was still starting up', async () => {
    await showMainWindow({
      captured: [MONDAY],
      tasks: ['renew the cert'],
      // The Tray Menu reached before the webview has come up: nothing is
      // listening yet, so the window has to find the section as it asks.
      whileStartingUp: (desktop) => desktop.requestSection('tasks'),
    })

    await showsTasks()
  })

  it('is the one named last when two requests arrive back to back', async () => {
    await showMainWindow({
      captured: [MONDAY],
      tasks: ['renew the cert'],
      // A clicked Task Alert builds the window, and the Tray Menu is reached
      // before it is on screen. The window lands where the user last asked.
      section: 'tasks',
      whileStartingUp: (desktop) => desktop.requestSection('settings'),
    })

    await showsSettings()
  })

  it('is History for a Dock click, whatever an earlier request named', async () => {
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      tasks: ['renew the cert'],
      section: 'tasks',
      // A click on the Dock icon names no section, and the window it opens
      // does not inherit the section left over from the Tray Menu.
      whileStartingUp: (desktop) => desktop.requestSection(null),
    })

    // History is where the window starts, so the claim has to have come back
    // before this says anything: it came back with nothing.
    await expect.poll(() => desktop.sectionsClaimed).toBe(1)
    await showsHistory()
  })

  it('presents the introduction instead when the window opens on its own', async () => {
    // A fresh installation — no Entry Point named a section — is offered the
    // introduction automatically rather than shown a section it has never
    // seen explained.
    await showMainWindow({ captured: [MONDAY], onboarding: 'unfinished' })

    expect(
      await screen.findByRole('heading', { name: 'Welcome to Work Journal' }),
    ).toBeTruthy()
  })
})

describe('an update installing while the user goes elsewhere', () => {
  it('defers the restart until Settings is being looked at again', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({ captured: [MONDAY] })
    desktop.availableUpdate = { version: '0.9.0', notes: [] }

    // The frames the restart waits for, held so the moment between the install
    // and the paint can be widened to whatever this test needs.
    const frames = holdFrames()

    try {
      await user.click(within(sidebar()).getByRole('button', { name: 'Settings' }))
      await showsSettings()

      await user.click(
        await screen.findByRole('button', { name: 'Check for updates' }),
      )
      await user.click(
        await screen.findByRole('button', { name: 'Install 0.9.0' }),
      )
      await expect.poll(() => frames.pending()).toBeGreaterThan(0)

      // The download is done and the restart is a frame away when the user
      // goes back to their journal. Settings is hidden, not unmounted — the
      // section they left is the one they will come back to.
      await user.click(within(sidebar()).getByRole('button', { name: 'History' }))
      await showsHistory()

      frames.drain()

      // Quitting out from under a section that never said a word about it is
      // the app disappearing for no reason the user can see.
      expect(desktop.restarts).toBe(0)

      // Deferred, not abandoned: the release is installed and the line under
      // the button still says so, so coming back is where the restart lands.
      await user.click(
        within(sidebar()).getByRole('button', { name: 'Settings' }),
      )
      await showsSettings()
      await expect.poll(() => frames.pending()).toBeGreaterThan(0)

      frames.drain()

      expect(desktop.restarts).toBe(1)
    } finally {
      frames.restore()
    }
  })
})

describe('switching sections', () => {
  it('shows the one the sidebar names, and only that one', async () => {
    const user = userEvent.setup()
    await showMainWindow({ captured: [MONDAY], tasks: ['renew the cert'] })

    await user.click(within(sidebar()).getByRole('button', { name: 'Tasks' }))

    await showsTasks()
    expect(
      within(sidebar()).getByRole('button', { name: 'Tasks' }).getAttribute('aria-current'),
    ).toBe('page')
  })

  it('shows Settings when the sidebar names it', async () => {
    const user = userEvent.setup()
    await showMainWindow({ captured: [MONDAY] })

    await user.click(within(sidebar()).getByRole('button', { name: 'Settings' }))

    await showsSettings()
  })

  it('follows an Entry Point that names a section while the window is open', async () => {
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      tasks: ['renew the cert'],
    })

    // The Tray Menu's "View Tasks", reaching a window already on History.
    desktop.requestSection('tasks')
    await showsTasks()

    // And "View Notes", reaching the same window on Tasks View.
    desktop.requestSection('history')
    await showsHistory()
  })

  it('leaves the Filter exactly as it was through a round trip', async () => {
    const user = userEvent.setup()
    await showMainWindow({
      captured: [MONDAY, { at: '2026-03-11T10:00:00', body: 'Wednesday' }],
      tasks: ['renew the cert'],
    })

    await user.click(days())
    await user.click(await dayCell('2026-03-09'))
    await user.click(await dayCell('2026-03-11'))
    const narrowed = days().textContent
    expect(narrowed).toContain(formatDayRange('2026-03-09', '2026-03-11'))

    await user.click(within(sidebar()).getByRole('button', { name: 'Tasks' }))
    await showsTasks()
    await user.click(within(sidebar()).getByRole('button', { name: 'History' }))
    await showsHistory()

    // The reader comes back to the days they left, not to the days History
    // opens on: the section was hidden, never torn down.
    expect(days().textContent).toBe(narrowed)
    expect(screen.getByText('Monday')).toBeTruthy()
  })

  it('does not touch History’s Filter when Work Summary is opened', async () => {
    const user = userEvent.setup()
    await showMainWindow({
      captured: [MONDAY, { at: '2026-03-11T10:00:00', body: 'Wednesday' }],
    })

    await user.click(days())
    await user.click(await dayCell('2026-03-09'))
    await user.click(await dayCell('2026-03-11'))
    const narrowed = days().textContent

    await user.click(
      within(sidebar()).getByRole('button', { name: 'Work Summary' }),
    )
    await showsWorkSummary()
    await user.click(within(sidebar()).getByRole('button', { name: 'History' }))
    await showsHistory()

    expect(days().textContent).toBe(narrowed)
  })

  it('keeps Work Summary’s range and History’s Filter apart in both directions', async () => {
    const user = userEvent.setup()
    await showMainWindow({
      captured: [MONDAY, { at: '2026-03-11T10:00:00', body: 'Wednesday' }],
    })

    // History opens on the most recent Occupied Day; the section is left
    // there while Work Summary moves to a range of its own.
    const historyOpening = days().textContent
    expect(historyOpening).toContain(formatDayRange('2026-03-11', '2026-03-11'))

    await user.click(
      within(sidebar()).getByRole('button', { name: 'Work Summary' }),
    )
    await showsWorkSummary()
    await user.click(screen.getByRole('button', { name: /^Days / }))
    await user.click(await screen.findByRole('button', { name: 'Last week' }))
    await waitForWorkSummaryDays(formatDayRange('2026-03-02', '2026-03-08'))

    // History's Filter sat out the whole move.
    await user.click(within(sidebar()).getByRole('button', { name: 'History' }))
    await showsHistory()
    expect(days().textContent).toBe(historyOpening)

    // And narrowing History leaves the chosen Work Summary range alone: the
    // trip back finds last week still on screen — on either axis.
    await user.click(days())
    await user.click(await dayCell('2026-03-09'))
    await user.click(await dayCell('2026-03-11'))
    const narrowed = days().textContent
    expect(narrowed).toContain(formatDayRange('2026-03-09', '2026-03-11'))
    await user.click(
      within(screen.getByRole('banner')).getByRole('combobox', {
        name: /^Project/,
      }),
    )
    await user.click(await screen.findByRole('option', { name: 'Unfiled' }))

    await user.click(
      within(sidebar()).getByRole('button', { name: 'Work Summary' }),
    )
    await showsWorkSummary()
    await waitForWorkSummaryDays(formatDayRange('2026-03-02', '2026-03-08'))

    await user.click(within(sidebar()).getByRole('button', { name: 'History' }))
    await showsHistory()
    expect(days().textContent).toBe(narrowed)
  })

  it('opens Work Summary on a fresh This week in a recreated window', async () => {
    const user = userEvent.setup()
    const captured = [MONDAY, { at: '2026-03-11T10:00:00', body: 'Wednesday' }]
    await showMainWindow({ captured })

    await user.click(
      within(sidebar()).getByRole('button', { name: 'Work Summary' }),
    )
    await showsWorkSummary()
    await user.click(screen.getByRole('button', { name: /^Days / }))
    await user.click(await screen.findByRole('button', { name: 'Last week' }))
    await waitForWorkSummaryDays(formatDayRange('2026-03-02', '2026-03-08'))
    cleanup()

    // A recreated window builds every section over: the chosen range went
    // with the closed one, and This week is back.
    await showMainWindow({ captured })
    await user.click(
      within(sidebar()).getByRole('button', { name: 'Work Summary' }),
    )
    await showsWorkSummary()
    await waitForWorkSummaryDays(formatDayRange('2026-03-09', '2026-03-11'))
  })

  it('keeps a generated Work Summary through a trip to History and back', async () => {
    const user = userEvent.setup()
    await showMainWindow({
      // The last capture is what leaves the journal's clock on today, so
      // yesterday is the 8th and the section has something to generate from.
      captured: [
        { at: '2026-03-08T10:00:00', body: 'Yesterday\u2019s work' },
        { at: '2026-03-09T09:00:00', body: 'Today\u2019s own note' },
      ],
      stored: {
        startAtLogin: false,
        modelBaseUrl: 'https://api.openai.com/v1',
        model: 'gpt-test',
      },
    })

    await user.click(
      within(sidebar()).getByRole('button', { name: 'Work Summary' }),
    )
    await showsWorkSummary()
    await user.click(await screen.findByRole('button', { name: 'Generate' }))
    await screen.findByText('The work summary the model wrote.')

    await user.click(within(sidebar()).getByRole('button', { name: 'History' }))
    await showsHistory()
    await user.click(
      within(sidebar()).getByRole('button', { name: 'Work Summary' }),
    )
    await showsWorkSummary()

    // Nothing was persisted and nothing was lost: the post lives as long as
    // the Main Window that generated it, and the section kept it.
    expect(screen.getByText('The work summary the model wrote.')).toBeTruthy()
  })

  it('opens Settings from a missing Model Access failure', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [
        { at: '2026-03-08T10:00:00', body: 'Yesterday\u2019s work' },
        { at: '2026-03-09T09:00:00', body: 'Today\u2019s own note' },
      ],
      stored: { startAtLogin: false },
    })

    await user.click(
      within(sidebar()).getByRole('button', { name: 'Work Summary' }),
    )
    await showsWorkSummary()
    await user.click(await screen.findByRole('button', { name: 'Generate' }))

    // Model Access is not configured: the line points at Settings, and the
    // action switches the section there.
    expect(
      await screen.findByText(
        'Model Access is not configured. Open Settings to add a Base URL, a Model and an API Key.',
      ),
    ).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Open Settings' }))
    await showsSettings()

    // The refusal happened before anything was asked: the Model Access line
    // is the view's own, and the call never had a chance to spend.
    expect(desktop.workSummaryRequests).toEqual([])
  })

  it('leaves a Nudge waiting on History, with nothing on the sidebar', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      tasks: ['renew the cert'],
    })
    await user.click(within(sidebar()).getByRole('button', { name: 'Tasks' }))
    await showsTasks()

    await desktop.announceCapturedNote('2026-03-12')

    // Nothing on screen says so while Tasks View is showing: the sidebar is a
    // list of places, not a set of counters.
    expect(nudge()).toBeUndefined()
    expect(sidebar().textContent).toBe('HistoryTasksWork SummarySettings')

    await user.click(within(sidebar()).getByRole('button', { name: 'History' }))
    await expect.poll(() => nudge()?.textContent).toContain('A new Note on')
  })
})

describe('a section that is not showing', () => {
  it('takes an open confirmation off the screen when an Entry Point switches', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      tasks: ['renew the cert'],
      section: 'tasks',
    })
    await showsTasks()

    await user.click(
      await screen.findByRole('button', { name: 'Delete \u201Crenew the cert\u201D' }),
    )
    expect(await screen.findByRole('alertdialog')).toBeTruthy()

    // A clicked Task Alert, or the Tray Menu, while the confirmation is up.
    desktop.requestSection('history')
    await showsHistory()

    // The confirmation belonged to a section nobody can see: it is portalled
    // out of the wrapper that hides it, so it has to go rather than hide.
    await expect.poll(() => screen.queryByRole('alertdialog')).toBeNull()
    // And History answers: nothing modal is standing over it.
    await user.click(days())
    expect(await dayCell('2026-03-09')).toBeTruthy()
  })

  it('does not resurrect the confirmation on the way back', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      tasks: ['renew the cert'],
      section: 'tasks',
    })
    await showsTasks()
    await user.click(
      await screen.findByRole('button', { name: 'Delete \u201Crenew the cert\u201D' }),
    )
    await screen.findByRole('alertdialog')

    desktop.requestSection('history')
    await showsHistory()
    await user.click(within(sidebar()).getByRole('button', { name: 'Tasks' }))
    await showsTasks()

    // Switching away dismissed it. Coming back is not asking again.
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByText('renew the cert')).toBeTruthy()
  })

  it('takes the Editor\u2019s own question with it, and leaves the Editor', async () => {
    const { core, created, desktop } = await showMainWindow({
      captured: [MONDAY],
      tasks: ['water the plants'],
      section: 'tasks',
    })
    await showsTasks()
    await core.editTask(created[0].id, {
      description: 'water the plants',
      schedule: { date: '2026-03-16', time: null },
      recurrence: { unit: 'day', interval: 1, weekdays: [] },
    })
    await desktop.announceTasksChanged()

    // The cadence on screen, so the row clicked below is the re-read one.
    await screen.findByText('every day')

    fireEvent.click(screen.getByText('water the plants'))
    await screen.findByRole('dialog', { name: 'Edit Task' })
    fireEvent.click(screen.getByRole('button', { name: 'Clear the schedule' }))
    expect(await screen.findByRole('alertdialog')).toBeTruthy()

    desktop.requestSection('history')
    await showsHistory()
    await expect.poll(() => screen.queryByRole('alertdialog')).toBeNull()

    desktop.requestSection('tasks')
    await showsTasks()

    // The question is gone and nothing was answered on the user's behalf: the
    // Task still repeats, and the Editor is where they left it.
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Edit Task' })).toBeTruthy()
    expect((screen.getByLabelText('Repeats') as HTMLSelectElement).value).toBe(
      'day',
    )
  })

  it('takes a toast with it when an Entry Point switches', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      tasks: ['renew the cert'],
    })

    await user.click(screen.getByRole('button', { name: /copy notes \(1\)/i }))
    await vi.waitFor(() => {
      if (document.querySelector('[data-sonner-toast]') === null) {
        throw new Error('no toast')
      }
    })

    // Settings, rather than Tasks: Settings mounts a Toaster of its own, and
    // Sonner draws every message in all of them — the one History raised is
    // drawn over Settings unless History takes it away as it goes.
    desktop.requestSection('settings')
    await showsSettings()

    await expect.poll(toastsOnScreen).toEqual([])
  })

  it('takes Settings\u2019 own toast with it when an Entry Point switches', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      tasks: ['renew the cert'],
      section: 'settings',
    })

    await user.click(
      await screen.findByRole('button', { name: 'Export all to Markdown' }),
    )
    await expect.poll(() => desktop.exported.length).toBe(1)
    await vi.waitFor(() => {
      if (toastsOnScreen().length === 0) throw new Error('the export has not been confirmed yet')
    })
    expect(toastsOnScreen().join(' ')).toContain('Exported')

    // History, rather than Tasks: History mounts a Toaster of its own, and
    // Sonner draws every message in all of them \u2014 the one Settings raised is
    // drawn over History unless Settings takes it away as it goes.
    desktop.requestSection('history')
    await showsHistory()

    // Every section owns what it said, not only History: the line under the
    // button keeps the answer for the reader who comes back.
    await expect.poll(toastsOnScreen).toEqual([])
  })

  it('does not raise a toast after an Entry Point has taken it off screen', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      tasks: ['renew the cert'],
    })
    let releaseCopy!: () => void
    const held = new Promise<void>((resolve) => {
      releaseCopy = resolve
    })
    const write = desktop.copyToClipboard.bind(desktop)
    desktop.copyToClipboard = async (text) => {
      await held
      await write(text)
    }

    await user.click(screen.getByRole('button', { name: /copy notes \(1\)/i }))
    desktop.requestSection('settings')
    await showsSettings()
    releaseCopy()
    await expect.poll(() => desktop.clipboard).toContain('Monday')
    await vi.waitFor(() => {
      if (!document.body.textContent?.includes('Copied 1 note')) {
        throw new Error('copy not confirmed')
      }
    })

    expect(toastsOnScreen()).toEqual([])
  })

  it('does not raise Settings\u2019 export confirmation after leaving', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      tasks: ['renew the cert'],
      section: 'settings',
    })
    let releaseExport!: () => void
    const held = new Promise<void>((resolve) => {
      releaseExport = resolve
    })
    const write = desktop.exportJournal.bind(desktop)
    desktop.exportJournal = async (markdown, fileName) => {
      await held
      return write(markdown, fileName)
    }

    await user.click(
      await screen.findByRole('button', { name: 'Export all to Markdown' }),
    )
    desktop.requestSection('history')
    await showsHistory()
    releaseExport()
    await expect.poll(() => desktop.exported.length).toBe(1)
    await vi.waitFor(() => {
      if (!document.body.textContent?.includes('Exported')) {
        throw new Error('the export has not been confirmed yet')
      }
    })

    // The export finished for a section nobody can see: the line under the
    // button keeps the answer, and nothing is said over History.
    expect(toastsOnScreen()).toEqual([])
  })

  it('takes History\u2019s own confirmation with it', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      tasks: ['renew the cert'],
    })

    await user.click(
      await screen.findByRole('button', { name: 'Delete \u201CMonday\u201D' }),
    )
    expect(await screen.findByRole('alertdialog')).toBeTruthy()

    desktop.requestSection('tasks')
    await showsTasks()

    // Every section owns what it put on screen, not only Tasks View.
    await expect.poll(() => screen.queryByRole('alertdialog')).toBeNull()
    desktop.requestSection('history')
    await showsHistory()
    expect(screen.queryByRole('alertdialog')).toBeNull()
    // Dismissed, never confirmed: the Note is still there.
    expect(screen.getByText('Monday')).toBeTruthy()
  })

  it('takes an open picker with it, and leaves the Filter alone', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      tasks: ['renew the cert'],
    })
    const before = days().textContent

    await user.click(days())
    expect(await dayCell('2026-03-09')).toBeTruthy()

    // The Tray Menu, rather than a click on the sidebar: an outside click
    // would have closed the popup on its own, and the Entry Point is the path
    // that reaches the window with nothing dismissed.
    desktop.requestSection('tasks')
    await showsTasks()

    // The calendar is portalled to the end of the document, so hiding History
    // does not reach it.
    await expect.poll(() => document.querySelector('[data-day]')).toBeNull()

    desktop.requestSection('history')
    await showsHistory()
    // Closing a picker picks nothing: the days are the days the reader left.
    expect(days().textContent).toBe(before)
  })
})

describe('automatic Onboarding', () => {
  it('introduces the app over the sections, with the current Hotkeys', async () => {
    await showMainWindow({ captured: [MONDAY], onboarding: 'unfinished' })

    // The introduction is what is on screen: it names the app and explains
    // the Note and Task Entry Points with the combinations that actually
    // apply.
    expect(
      await screen.findByRole('heading', { name: 'Welcome to Work Journal' }),
    ).toBeTruthy()
    expect(
      screen.getByRole('group', { name: 'Current Note Hotkey' }),
    ).toBeTruthy()
    expect(
      screen.getByRole('group', { name: 'Current Task Hotkey' }),
    ).toBeTruthy()
    // Every section is off the accessibility tree while the flow is up.
    expect(allSectionsHidden()).toBe(true)
  })

  it('keeps the flow on Back, without dismissing anything', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })

    await user.click(
      await screen.findByRole('button', { name: 'Continue' }),
    )
    await screen.findByRole('heading', { name: 'Start Work Journal at login?' })

    await user.click(screen.getByRole('button', { name: 'Back' }))

    // Back is a step of the walk, not a departure: the introduction returns
    // and the flow is still due.
    expect(
      screen.getByRole('heading', { name: 'Welcome to Work Journal' }),
    ).toBeTruthy()
    expect(desktop.onboarding).toBe('unfinished')
  })

  it('records Skip onboarding as the dismissal', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })

    await user.click(
      await screen.findByRole('button', { name: 'Skip onboarding' }),
    )

    await showsHistory()
    await expect.poll(() => desktop.onboarding).toBe('suppressed')
  })

  it('records Open History — Finish — as the dismissal, and lands in History', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })

    await user.click(
      await screen.findByRole('button', { name: 'Continue' }),
    )
    // Through Start at Login and Meeting Import to Model Access, the last
    // setup step, where the flow finishes.
    await user.click(
      await screen.findByRole('button', { name: 'Continue' }),
    )
    await user.click(
      await screen.findByRole('button', { name: 'Continue' }),
    )
    await user.click(
      await screen.findByRole('button', { name: 'Open History' }),
    )

    await showsHistory()
    await expect.poll(() => desktop.onboarding).toBe('suppressed')
  })

  it('records choosing a section from the sidebar as the dismissal', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })
    await screen.findByRole('heading', { name: 'Welcome to Work Journal' })

    await user.click(within(sidebar()).getByRole('button', { name: 'Tasks' }))

    await showsTasks()
    await expect.poll(() => desktop.onboarding).toBe('suppressed')
  })

  it('records an Entry Point naming a section as the dismissal', async () => {
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })
    await screen.findByRole('heading', { name: 'Welcome to Work Journal' })

    // The Tray Menu's "View Tasks", reaching the window while the
    // introduction is up: navigating away is leaving the flow.
    desktop.requestSection('tasks')

    await showsTasks()
    await expect.poll(() => desktop.onboarding).toBe('suppressed')
  })

  it('records closing the window as the dismissal', async () => {
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })
    await screen.findByRole('heading', { name: 'Welcome to Work Journal' })

    desktop.requestClose()

    // The write lands before the window can be gone: the next launch opens
    // normally rather than offering the introduction again.
    await expect.poll(() => desktop.onboarding).toBe('suppressed')
  })

  it('records Escape — which closes the window — as the dismissal too', async () => {
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })
    await screen.findByRole('heading', { name: 'Welcome to Work Journal' })

    await userEvent.setup().keyboard('{Escape}')

    await expect.poll(() => desktop.onboarding).toBe('suppressed')
    await expect.poll(() => desktop.windowsClosed).toBe(1)
  })

  it('saves a Start at Login choice made during the flow', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })

    await user.click(
      await screen.findByRole('button', { name: 'Continue' }),
    )
    await user.click(
      await screen.findByRole('switch', { name: 'Start at login' }),
    )

    // The same operating-system behaviour the Settings switch drives, saved
    // the moment it is made.
    await expect.poll(() => desktop.loginItem).toBe(true)
    await expect.poll(() => desktop.stored.startAtLogin).toBe(true)
  })

  it('shows the choice the flow saved, when Settings is opened afterwards', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })

    await user.click(
      await screen.findByRole('button', { name: 'Continue' }),
    )
    await user.click(
      await screen.findByRole('switch', { name: 'Start at login' }),
    )
    await expect.poll(() => desktop.loginItem).toBe(true)

    // Finish into History, then open Settings: its switch is the same login
    // item the flow just changed, so it must read the new answer back rather
    // than the snapshot it took when the window opened.
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Open History' }))
    await showsHistory()
    await user.click(within(sidebar()).getByRole('button', { name: 'Settings' }))
    await showsSettings()

    const control = await screen.findByRole('switch', {
      name: 'Start at login',
    })
    await expect
      .poll(() => control.getAttribute('aria-checked'))
      .toBe('true')
  })

  it('reflects a Start at Login save that settles after the flow has left', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })
    // The login item takes its time: the step is left before the save
    // settles, which is exactly when the Settings row must still hear it.
    let releaseLogin = () => {}
    const loginHeld = new Promise<void>((resolve) => {
      releaseLogin = resolve
    })
    const realSet = desktop.setStartAtLogin.bind(desktop)
    desktop.setStartAtLogin = async (value) => {
      await loginHeld
      await realSet(value)
    }

    await user.click(
      await screen.findByRole('button', { name: 'Continue' }),
    )
    await user.click(
      await screen.findByRole('switch', { name: 'Start at login' }),
    )

    // Continue on through Meeting Import while the save is still settling.
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Open History' }))
    await showsHistory()

    releaseLogin()
    await expect.poll(() => desktop.loginItem).toBe(true)

    await user.click(within(sidebar()).getByRole('button', { name: 'Settings' }))
    await showsSettings()

    // The save finished after the flow had gone: the row that stayed mounted
    // still heard it, rather than the window's snapshot keeping the old no.
    const control = await screen.findByRole('switch', {
      name: 'Start at login',
    })
    await expect
      .poll(() => control.getAttribute('aria-checked'))
      .toBe('true')
  })

  it('reports a refused Start at Login choice, with retry and continuation', async () => {
    const user = userEvent.setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })
    desktop.setStartAtLogin = () => Promise.reject(new Error('macOS refused'))

    await user.click(
      await screen.findByRole('button', { name: 'Continue' }),
    )
    await user.click(
      await screen.findByRole('switch', { name: 'Start at login' }),
    )

    // The refusal is said plainly, the retry stays available, and the way on
    // is never blocked by it.
    expect(
      await screen.findByText(
        'Could not change whether Work Journal starts at login.',
      ),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', {
        name: 'Try saving the Start at Login choice again',
      }),
    ).toBeTruthy()
    expect(desktop.loginItem).toBe(false)

    // The refusal never blocks the way on: through the remaining setup steps
    // to History.
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Open History' }))

    await showsHistory()
    // Nothing was saved on the user's behalf.
    expect(desktop.loginItem).toBe(false)
  })
})

describe('replaying Onboarding from Settings', () => {
  it('opens the flow with the current saved Start at Login choice', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      section: 'settings',
      stored: { startAtLogin: true },
    })
    // An earlier run left the login item there, which is what the choice is
    // really stored as.
    desktop.loginItem = true
    await showsSettings()

    await user.click(
      await screen.findByRole('button', { name: 'Replay introduction' }),
    )
    expect(
      await screen.findByRole('heading', { name: 'Welcome to Work Journal' }),
    ).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Continue' }))

    // The step reads the setting back, not a reset to the default.
    const control = await screen.findByRole('switch', { name: 'Start at login' })
    await expect
      .poll(() => control.getAttribute('aria-checked'))
      .toBe('true')
  })

  it('keeps unsaved Settings input through a replay of the flow', async () => {
    const user = userEvent.setup()
    await showMainWindow({ captured: [MONDAY], section: 'settings' })
    await showsSettings()

    // A key being typed, on its way out of the window — not saved yet, so it
    // lives only in the input. A replay of the flow must not take it.
    await user.type(await screen.findByLabelText('API Key'), 'sk-replay-secret')

    await user.click(
      await screen.findByRole('button', { name: 'Replay introduction' }),
    )
    await screen.findByRole('heading', { name: 'Welcome to Work Journal' })
    await user.click(screen.getByRole('button', { name: 'Skip onboarding' }))
    await showsHistory()

    await user.click(within(sidebar()).getByRole('button', { name: 'Settings' }))
    await showsSettings()

    // The section stayed mounted, so the half-typed key is still under the
    // cursor.
    expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe(
      'sk-replay-secret',
    )
  })

  it('finishes into History without re-enabling automatic presentation', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      section: 'settings',
    })
    await showsSettings()

    await user.click(
      await screen.findByRole('button', { name: 'Replay introduction' }),
    )
    await screen.findByRole('heading', { name: 'Welcome to Work Journal' })
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Open History' }))

    await showsHistory()
    // Replaying by hand is a replay: it never puts the automatic offer back.
    expect(desktop.onboarding).toBe('suppressed')
  })
})

describe('Meeting Import during Onboarding', () => {
  /** Walks automatic Onboarding through Start at Login to Meeting Import. */
  async function atTheMeetingImportStep() {
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', { name: 'Continue' }),
    )
    await user.click(
      await screen.findByRole('button', { name: 'Continue' }),
    )
    await screen.findByRole('heading', {
      name: "Add today's meetings to the journal?",
    })
    return user
  }

  function importSwitch(): HTMLElement {
    return screen.getByRole('switch', {
      name: "Add today's meetings to the journal",
    })
  }

  function readsOn(control: HTMLElement): boolean {
    return control.getAttribute('aria-checked') === 'true'
  }

  /** Walks from Meeting Import through Model Access to the finish. */
  async function finishFromMeetingImport(
    user: ReturnType<typeof userEvent.setup>,
  ) {
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', {
      name: 'Summarize your work with a model?',
    })
    await user.click(screen.getByRole('button', { name: 'Open History' }))
  }

  it('enables Import and ticks work calendars through the existing settings', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
      calendars: [{ id: 'work', title: 'Work', source: 'iCloud' }],
    })
    await atTheMeetingImportStep()

    // Explicit enablement walks the existing calendar-permission path.
    await user.click(importSwitch())

    await expect.poll(() => desktop.prompted).toBe(true)
    await expect.poll(() => desktop.stored.importMeetings).toBe(true)
    await user.click(await screen.findByRole('checkbox', { name: /Work/ }))
    // The tick lands in the very list the Import sweep reads — no second
    // import service, and Task Alert permission is untouched by all of it.
    await expect.poll(() => desktop.stored.importCalendars).toEqual(['work'])
    expect(desktop.alertPermission).toBe('undetermined')
    expect(desktop.alertPrompted).toBe(false)

    await finishFromMeetingImport(user)
    await showsHistory()
    await expect.poll(() => desktop.onboarding).toBe('suppressed')
  })

  it('explains a refused permission and still finishes', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
      answersPrompt: 'denied',
    })
    await atTheMeetingImportStep()

    await user.click(importSwitch())

    // The refusal is said in the step — and mirrored into the mounted but
    // hidden Settings section, which hears the flow's save through the
    // in-window announcement. Two copies in the DOM (role queries only ever
    // see the step's), one retry on screen, and the wish kept for a grant
    // given later in System Settings.
    await expect
      .poll(
        () => screen.getAllByText(/macOS is not allowing Work Journal/),
      )
      .toHaveLength(2)
    expect(
      screen.getByRole('button', { name: 'Try allowing calendar access again' }),
    ).toBeTruthy()
    await expect.poll(() => desktop.stored.importMeetings).toBe(true)

    await finishFromMeetingImport(user)
    await showsHistory()
    await expect.poll(() => desktop.onboarding).toBe('suppressed')
  })

  it('says no selection imports nothing and still finishes', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
      access: 'granted',
      calendars: [{ id: 'work', title: 'Work', source: 'iCloud' }],
    })
    await atTheMeetingImportStep()

    await user.click(importSwitch())
    await screen.findByRole('checkbox', { name: /Work/ })

    // Granted and on, but nothing ticked: nothing is swept, and the step
    // says so rather than claiming Import is running.
    expect(
      await screen.findByText(/permission alone imports nothing/),
    ).toBeTruthy()
    // Already granted, so enabling asked macOS for nothing new.
    expect(desktop.prompted).toBe(false)

    await finishFromMeetingImport(user)
    await showsHistory()
    await expect.poll(() => desktop.onboarding).toBe('suppressed')
  })

  it('says a failed save, with retry and continuation', async () => {
    const user = userEvent.setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const stored: Record<string, unknown> = { startAtLogin: false }
    let writes = 0
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
      stored,
      access: 'granted',
      calendars: [{ id: 'work', title: 'Work', source: 'iCloud' }],
      openSettingsStore: async () => ({
        async get<T>(key: string) {
          return stored[key] as T | undefined
        },
        async has(key: string) {
          return key in stored
        },
        async set(key: string, value: unknown) {
          if (key === 'importMeetings') {
            writes += 1
            if (writes === 1) throw new Error('the file is read-only')
          }
          stored[key] = value
        },
      }),
    })
    await atTheMeetingImportStep()

    await user.click(importSwitch())

    expect(
      await screen.findByText('Could not change how meetings are imported.'),
    ).toBeTruthy()

    await user.click(
      screen.getByRole('button', { name: 'Try saving Import again' }),
    )
    await expect.poll(() => desktop.stored.importMeetings).toBe(true)

    await finishFromMeetingImport(user)
    await showsHistory()
    await expect.poll(() => desktop.onboarding).toBe('suppressed')
  })

  it('skips the step without rolling back saves', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
      calendars: [{ id: 'work', title: 'Work', source: 'iCloud' }],
    })
    await atTheMeetingImportStep()

    await user.click(importSwitch())
    await user.click(await screen.findByRole('checkbox', { name: /Work/ }))
    await expect.poll(() => desktop.stored.importCalendars).toEqual(['work'])

    // Per-step Skip is the walk advancing, not the flow dismissed early:
    // the Model Access step opens and the saves stand.
    await user.click(screen.getByRole('button', { name: 'Skip this step' }))
    await screen.findByRole('heading', {
      name: 'Summarize your work with a model?',
    })
    expect(desktop.stored.importMeetings).toBe(true)
    expect(desktop.stored.importCalendars).toEqual(['work'])
    await user.click(screen.getByRole('button', { name: 'Open History' }))
    await showsHistory()
    await expect.poll(() => desktop.onboarding).toBe('suppressed')
  })

  it('shows the Import the flow saved, when Settings is opened afterwards', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
      calendars: [{ id: 'work', title: 'Work', source: 'iCloud' }],
    })
    await atTheMeetingImportStep()

    await user.click(importSwitch())
    await user.click(await screen.findByRole('checkbox', { name: /Work/ }))
    await expect.poll(() => desktop.stored.importCalendars).toEqual(['work'])

    // Finish into History, then open Settings: its switch and its ticks are
    // the same wish and the same list the flow just saved, so they must read
    // the new answers back rather than the snapshot the window opened with.
    await finishFromMeetingImport(user)
    await showsHistory()
    await user.click(within(sidebar()).getByRole('button', { name: 'Settings' }))
    await showsSettings()

    const control = await screen.findByRole('switch', {
      name: "Add today's meetings to the journal",
    })
    await expect
      .poll(() => control.getAttribute('aria-checked'))
      .toBe('true')
    expect(
      screen
        .getByRole('checkbox', { name: /Work/ })
        .getAttribute('aria-checked'),
    ).toBe('true')
  })

  it('hears the last-landing save in Settings, however the saves overlapped', async () => {
    // The calendars write is held while the wish is switched off and back
    // on over it: every settled save announces the file as it stands, so
    // the mounted section ends agreeing with the file rather than pinned to
    // a snapshot taken before the held write landed.
    const user = userEvent.setup()
    const stored: Record<string, unknown> = { startAtLogin: false }
    let releaseCalendars = () => {}
    const calendarsHeld = new Promise<void>((resolve) => {
      releaseCalendars = resolve
    })
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
      stored,
      access: 'granted',
      calendars: [{ id: 'work', title: 'Work', source: 'iCloud' }],
      openSettingsStore: async () => ({
        async get<T>(key: string) {
          return stored[key] as T | undefined
        },
        async has(key: string) {
          return key in stored
        },
        async set(key: string, value: unknown) {
          // A write in flight has not landed: what the file holds is what
          // settled before it.
          if (key === 'importCalendars') {
            await calendarsHeld
          }
          stored[key] = value
        },
      }),
    })
    await atTheMeetingImportStep()

    await user.click(importSwitch())
    await user.click(await screen.findByRole('checkbox', { name: /Work/ }))
    // Off and back on over the held tick: the wish writes land around it.
    await user.click(importSwitch())
    await user.click(importSwitch())
    releaseCalendars()
    await expect.poll(() => desktop.stored.importCalendars).toEqual(['work'])

    await finishFromMeetingImport(user)
    await showsHistory()
    await user.click(within(sidebar()).getByRole('button', { name: 'Settings' }))
    await showsSettings()

    // The file says on with Work ticked, and so does the section — the
    // held write's announcement was heard last, as it landed last.
    const control = await screen.findByRole('switch', {
      name: "Add today's meetings to the journal",
    })
    await expect
      .poll(() => control.getAttribute('aria-checked'))
      .toBe('true')
    expect(
      screen
        .getByRole('checkbox', { name: /Work/ })
        .getAttribute('aria-checked'),
    ).toBe('true')
  })

  it('replays with the saved Import and without prompting', async () => {    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      section: 'settings',
      stored: { importMeetings: true, importCalendars: ['work'] },
      access: 'granted',
      calendars: [{ id: 'work', title: 'Work', source: 'iCloud' }],
    })
    await showsSettings()

    await user.click(
      await screen.findByRole('button', { name: 'Replay introduction' }),
    )
    await screen.findByRole('heading', { name: 'Welcome to Work Journal' })
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', {
      name: "Add today's meetings to the journal?",
    })

    // The step reads the saved Import back — and asks macOS for nothing.
    await expect.poll(() => readsOn(importSwitch())).toBe(true)
    expect(
      screen
        .getByRole('checkbox', { name: /Work/ })
        .getAttribute('aria-checked'),
    ).toBe('true')
    expect(desktop.prompted).toBe(false)
  })
})

describe('Model Access during Onboarding', () => {
  /** Walks automatic Onboarding through Start at Login and Meeting Import. */
  async function atTheModelAccessStep() {
    const user = userEvent.setup()
    await user.click(
      await screen.findByRole('button', { name: 'Continue' }),
    )
    await user.click(
      await screen.findByRole('button', { name: 'Continue' }),
    )
    await user.click(
      await screen.findByRole('button', { name: 'Continue' }),
    )
    await screen.findByRole('heading', {
      name: 'Summarize your work with a model?',
    })
    return user
  }

  // A label query matches the hidden Settings controls too — every surface
  // stays mounted under the flow — so each field is the visible one, found
  // the way the user finds it. (Role queries cannot name the Key field: a
  // password input exposes no textbox role.)
  function field(label: string): HTMLInputElement {
    const matches = screen
      .getAllByLabelText(label)
      .filter((element): element is HTMLInputElement => {
        return element instanceof HTMLInputElement && onScreen(element)
      })
    if (matches.length !== 1) {
      throw new Error(`expected one visible ${label} field, found ${matches.length}`)
    }
    return matches[0]
  }

  function baseUrlField(): HTMLInputElement {
    return field('Base URL')
  }

  function modelField(): HTMLInputElement {
    return field('Model')
  }

  function apiKeyField(): HTMLInputElement {
    return field('API Key')
  }

  function saveKeyButton(): HTMLElement {
    return screen.getByRole('button', { name: 'Save' })
  }

  it('configures Model Access through the existing settings, shown in Settings afterwards', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })
    await atTheModelAccessStep()

    // The two ordinary fields save on every keystroke through the same
    // writes Settings uses; the Key goes to the Keychain and nowhere else.
    fireEvent.change(baseUrlField(), {
      target: { value: 'http://localhost:11434/v1' },
    })
    fireEvent.change(modelField(), { target: { value: 'llama3.1' } })
    fireEvent.change(apiKeyField(), { target: { value: 'sk-a-real-key' } })
    await user.click(saveKeyButton())

    await expect.poll(() => desktop.stored.modelBaseUrl).toBe(
      'http://localhost:11434/v1',
    )
    await expect.poll(() => desktop.stored.model).toBe('llama3.1')
    await expect.poll(() => desktop.apiKey).toBe('sk-a-real-key')
    expect(Object.values(desktop.stored)).not.toContain('sk-a-real-key')
    // Configured but unverified: saving is not a connection test.
    expect(
      await screen.findByText(/set to ask llama3\.1/),
    ).toBeTruthy()
    expect(screen.getByText(/has not been tried/)).toBeTruthy()

    // Finish into History, then open Settings: its fields and its Key line
    // are the same Base URL, Model and Key the flow just saved — they must
    // read the new answers back rather than the snapshot the window opened
    // with. The secret itself never appears.
    await user.click(screen.getByRole('button', { name: 'Open History' }))
    await showsHistory()
    await user.click(within(sidebar()).getByRole('button', { name: 'Settings' }))
    await showsSettings()

    await expect.poll(() => baseUrlField().value).toBe(
      'http://localhost:11434/v1',
    )
    expect(modelField().value).toBe('llama3.1')
    expect(await screen.findByText(/A key is saved/)).toBeTruthy()
    expect(apiKeyField().value).toBe('')
    expect(document.body.textContent).not.toContain('sk-a-real-key')
  })

  it('sends nothing automatically, and asks a model only on the explicit Generate', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [
        { at: '2026-03-08T10:00:00', body: 'Yesterday\u2019s work' },
        { at: '2026-03-09T09:00:00', body: 'Today\u2019s own note' },
      ],
      onboarding: 'unfinished',
    })

    // Entering, saving and finishing the step never ask the model: no
    // automatic request is made by any of it.
    await atTheModelAccessStep()
    fireEvent.change(modelField(), { target: { value: 'gpt-test' } })
    fireEvent.change(apiKeyField(), { target: { value: 'sk-a-real-key' } })
    await user.click(saveKeyButton())
    await expect.poll(() => desktop.apiKey).toBe('sk-a-real-key')
    await user.click(screen.getByRole('button', { name: 'Open History' }))
    await showsHistory()
    expect(desktop.workSummaryRequests).toEqual([])

    // The only request is the explicitly asked-for Work Summary.
    await user.click(
      within(sidebar()).getByRole('button', { name: 'Work Summary' }),
    )
    await showsWorkSummary()
    await user.click(await screen.findByRole('button', { name: 'Generate' }))
    await expect.poll(() => desktop.workSummaryRequests).toHaveLength(1)
  })

  it('says partial configuration stays needs-attention and still finishes', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })
    await atTheModelAccessStep()

    // A Model alone is partial: the step names what is missing instead of
    // claiming Model Access is configured or the endpoint works.
    fireEvent.change(modelField(), { target: { value: 'llama3.1' } })
    expect(await screen.findByText(/add an API Key/)).toBeTruthy()
    expect(desktop.workSummaryRequests).toEqual([])

    // Partial configuration never blocks the way on: the step finishes.
    await user.click(screen.getByRole('button', { name: 'Open History' }))
    await showsHistory()
    await expect.poll(() => desktop.onboarding).toBe('suppressed')
    expect(desktop.stored.model).toBe('llama3.1')
  })

  it('says a refused Base URL save, with retry and continuation', async () => {
    const user = userEvent.setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const stored: Record<string, unknown> = { startAtLogin: false }
    let writes = 0
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
      stored,
      openSettingsStore: async () => ({
        async get<T>(key: string) {
          return stored[key] as T | undefined
        },
        async has(key: string) {
          return key in stored
        },
        async set(key: string, value: unknown) {
          if (key === 'modelBaseUrl') {
            writes += 1
            if (writes === 1) throw new Error('the file is read-only')
          }
          stored[key] = value
        },
      }),
    })
    await atTheModelAccessStep()

    fireEvent.change(baseUrlField(), {
      target: { value: 'http://localhost:11434/v1' },
    })

    // The refused field is named, and the step still lets the user on.
    expect(
      await screen.findByText(/Base URL could not be saved/),
    ).toBeTruthy()

    await user.click(
      screen.getByRole('button', { name: 'Try saving the Base URL again' }),
    )
    await expect.poll(() => desktop.stored.modelBaseUrl).toBe(
      'http://localhost:11434/v1',
    )

    await user.click(screen.getByRole('button', { name: 'Open History' }))
    await showsHistory()
    await expect.poll(() => desktop.onboarding).toBe('suppressed')
  })

  it('says why a Keychain save refused, lets the retry land it, and finishes', async () => {
    const user = userEvent.setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })
    await atTheModelAccessStep()

    // The Keychain shuts as Save is pressed. The typed Key stays under the
    // cursor, still the user's.
    desktop.keychainRefuses = true
    fireEvent.change(apiKeyField(), { target: { value: 'sk-a-real-key' } })
    await user.click(saveKeyButton())

    expect(
      await screen.findByText(/the keychain could not be reached/),
    ).toBeTruthy()
    expect(desktop.apiKey).toBe(null)
    expect(apiKeyField().value).toBe('sk-a-real-key')

    desktop.keychainRefuses = false
    await user.click(
      screen.getByRole('button', { name: 'Try saving the API Key again' }),
    )
    await expect.poll(() => desktop.apiKey).toBe('sk-a-real-key')
    await expect.poll(() => apiKeyField().value).toBe('')

    await user.click(screen.getByRole('button', { name: 'Open History' }))
    await showsHistory()
    await expect.poll(() => desktop.onboarding).toBe('suppressed')
  })

  it('replays with the saved Model Access and key status, asking nothing new', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      section: 'settings',
      stored: {
        modelBaseUrl: 'https://example.test/v1',
        model: 'gpt-test',
      },
      apiKey: 'sk-from-an-earlier-run',
    })
    await showsSettings()

    await user.click(
      await screen.findByRole('button', { name: 'Replay introduction' }),
    )
    await screen.findByRole('heading', { name: 'Welcome to Work Journal' })
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await screen.findByRole('heading', {
      name: 'Summarize your work with a model?',
    })

    // The step reads the saved answers back — never the secret itself — and
    // makes no model request while it does.
    await expect.poll(() => baseUrlField().value).toBe(
      'https://example.test/v1',
    )
    expect(modelField().value).toBe('gpt-test')
    expect(apiKeyField().value).toBe('')
    // The key status is carried: the step offers the way out of a Keychain
    // entry. The secret itself never appears.
    expect(await screen.findByRole('button', { name: 'Clear' })).toBeTruthy()
    expect(document.body.textContent).not.toContain('sk-from-an-earlier-run')
    expect(desktop.prompted).toBe(false)
    expect(desktop.workSummaryRequests).toEqual([])
  })

  it('reaches History with every optional setup step skipped', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })
    await screen.findByRole('heading', { name: 'Welcome to Work Journal' })

    // Per-step Skip walks through the optional setup without it: no Meeting
    // Import, no Model Access, and no practice Note are required to finish.
    await user.click(screen.getByRole('button', { name: 'Continue' }))
    await user.click(screen.getByRole('button', { name: 'Skip this step' }))
    await user.click(screen.getByRole('button', { name: 'Skip this step' }))
    await user.click(screen.getByRole('button', { name: 'Skip this step' }))

    await showsHistory()
    await expect.poll(() => desktop.onboarding).toBe('suppressed')
    expect(desktop.stored.startAtLogin).toBe(false)
    expect(desktop.stored.importMeetings ?? false).toBe(false)
    expect(desktop.stored.model ?? '').toBe('')
    expect(desktop.apiKey).toBe(null)
    expect(desktop.workSummaryRequests).toEqual([])
  })
})

describe('practicing Capture from Onboarding', () => {
  it('opens the real Capture window without dismissing Onboarding', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })

    await user.click(await screen.findByRole('button', { name: 'Try it' }))

    // Through the desktop boundary, and the introduction stays up: trying it
    // is part of Onboarding, not a departure from it.
    await expect.poll(() => desktop.practiceCapturesBegun).toBe(1)
    expect(
      screen.getByRole('heading', { name: 'Welcome to Work Journal' }),
    ).toBeTruthy()
    expect(allSectionsHidden()).toBe(true)
    expect(desktop.onboarding).toBe('unfinished')
  })

  it('returns to the introduction when practice is cancelled, creating nothing', async () => {
    const user = userEvent.setup()
    const { desktop, core } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })

    await user.click(await screen.findByRole('button', { name: 'Try it' }))
    await expect.poll(() => desktop.practiceCapturesBegun).toBe(1)

    // Cancelling reports its outcome explicitly: the Capture window says the
    // practice ended with nothing created.
    await desktop.announcePracticeEnded({ outcome: 'cancelled' })

    await expect.poll(() => (screen.getByRole('button', { name: 'Try it' }) as HTMLButtonElement).disabled).toBe(false)
    expect(
      screen.getByRole('heading', { name: 'Welcome to Work Journal' }),
    ).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: 'View your note' }),
    ).toBeNull()
    expect(desktop.onboarding).toBe('unfinished')
    // Cancellation created nothing: the journal still holds Monday alone.
    const notes = await core.notesForFilter({
      from: '2000-01-01',
      to: '2100-01-01',
    })
    expect(notes).toHaveLength(1)
  })

  it('ignores focus arriving while practice is open', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })

    await user.click(await screen.findByRole('button', { name: 'Try it' }))
    await expect.poll(() => desktop.practiceCapturesBegun).toBe(1)

    // Focus alone is neither a submission nor a cancellation: the attempt
    // stays open and nothing is offered for it.
    desktop.focus()

    await expect.poll(() => (screen.getByRole('button', { name: 'Try it' }) as HTMLButtonElement).disabled).toBe(true)
    expect(
      screen.queryByRole('button', { name: 'View your note' }),
    ).toBeNull()

    await desktop.announcePracticeEnded({ outcome: 'cancelled' })

    await expect.poll(() => (screen.getByRole('button', { name: 'Try it' }) as HTMLButtonElement).disabled).toBe(false)
    expect(
      screen.queryByRole('button', { name: 'View your note' }),
    ).toBeNull()
    expect(desktop.onboarding).toBe('unfinished')
  })

  it('ignores an ordinary Note announcement while practice is open', async () => {
    const user = userEvent.setup()
    const { desktop, core, clock } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })

    await user.click(await screen.findByRole('button', { name: 'Try it' }))
    await expect.poll(() => desktop.practiceCapturesBegun).toBe(1)

    // A Note captured anywhere else while the attempt is open belongs to no
    // practice: the attempt stays open and offers nothing for it.
    clock.set(new Date('2026-03-11T10:00:00'))
    const ordinary = await core.capture('an ordinary note')
    if (ordinary === null) throw new Error('nothing was captured')
    await desktop.announceCapturedNote(ordinary.journalDay)

    await expect.poll(() => (screen.getByRole('button', { name: 'Try it' }) as HTMLButtonElement).disabled).toBe(true)
    expect(
      screen.queryByRole('button', { name: 'View your note' }),
    ).toBeNull()

    // Only the practice outcome closes the attempt, on the practice day.
    clock.set(new Date('2026-03-12T10:00:00'))
    const note = await core.capture('my practice note')
    if (note === null) throw new Error('nothing was captured')
    await desktop.announceCapturedNote(note.journalDay)
    await desktop.announcePracticeEnded({
      outcome: 'submitted',
      journalDay: note.journalDay,
    })

    await user.click(
      await screen.findByRole('button', { name: 'View your note' }),
    )

    await showsHistory()
    expect(await screen.findByText('my practice note')).toBeTruthy()
    expect(days().textContent).toContain('March 12')
  })

  it('offers View your note and Continue setup after a saved practice Note', async () => {
    const user = userEvent.setup()
    const { desktop, core, clock } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })

    await user.click(await screen.findByRole('button', { name: 'Try it' }))
    await expect.poll(() => desktop.practiceCapturesBegun).toBe(1)

    // An explicit submission is an ordinary Captured Note, announced the way
    // any Capture announces one — and the practice outcome carries its day,
    // which is what closes the attempt. Reuse that behavior rather than
    // duplicating the Capture suite: the journal holds it.
    clock.set(new Date('2026-03-09T15:00:00'))
    const note = await core.capture('my practice note')
    if (note === null) throw new Error('nothing was captured')
    await desktop.announceCapturedNote(note.journalDay)
    await desktop.announceJournalChanged()
    await desktop.announcePracticeEnded({
      outcome: 'submitted',
      journalDay: note.journalDay,
    })

    // Saving returns to Onboarding with the next choice: viewing the Note or
    // continuing setup. No Note is required to continue, and none was
    // inserted on the user's behalf — this one is the submission itself.
    expect(
      await screen.findByRole('button', { name: 'View your note' }),
    ).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Continue setup' }),
    ).toBeTruthy()
    expect(
      screen.getByRole('heading', { name: 'Welcome to Work Journal' }),
    ).toBeTruthy()
    expect(desktop.onboarding).toBe('unfinished')
    const notes = await core.notesForFilter({
      from: '2000-01-01',
      to: '2100-01-01',
    })
    expect(notes).toHaveLength(2)
  })

  it('continues setup after practice without dismissing Onboarding', async () => {
    const user = userEvent.setup()
    const { desktop, core, clock } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })

    await user.click(await screen.findByRole('button', { name: 'Try it' }))
    clock.set(new Date('2026-03-09T15:00:00'))
    const note = await core.capture('my practice note')
    if (note === null) throw new Error('nothing was captured')
    await desktop.announceCapturedNote(note.journalDay)
    await desktop.announcePracticeEnded({
      outcome: 'submitted',
      journalDay: note.journalDay,
    })

    await user.click(
      await screen.findByRole('button', { name: 'Continue setup' }),
    )

    // Continuing setup walks on through the optional settings: the flow is
    // still up, and still due.
    await screen.findByRole('heading', { name: 'Start Work Journal at login?' })
    expect(allSectionsHidden()).toBe(true)
    expect(desktop.onboarding).toBe('unfinished')
  })

  it('views the saved Note on its day with Project Any, dismissing Onboarding', async () => {
    const user = userEvent.setup()
    const { desktop, core, clock } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })

    await user.click(await screen.findByRole('button', { name: 'Try it' }))
    // Wednesday, so viewing has a day to move to rather than the day already
    // open.
    clock.set(new Date('2026-03-11T10:00:00'))
    const note = await core.capture('my practice note')
    if (note === null) throw new Error('nothing was captured')
    await desktop.announceCapturedNote(note.journalDay)
    await desktop.announceJournalChanged()
    await desktop.announcePracticeEnded({
      outcome: 'submitted',
      journalDay: note.journalDay,
    })

    await user.click(
      await screen.findByRole('button', { name: 'View your note' }),
    )

    // Viewing is navigating away: History shows the Note's day with Project
    // Any, and automatic presentation is dismissed as it goes.
    await showsHistory()
    await expect.poll(() => desktop.onboarding).toBe('suppressed')
    expect(await screen.findByText('my practice note')).toBeTruthy()
    expect(days().textContent).toContain('March 11')
  })

  it('resets an unrelated Filter left before replay when viewing the Note', async () => {
    const user = userEvent.setup()
    const { desktop, core, clock } = await showMainWindow({
      captured: [
        { at: '2026-03-09T10:00:00', body: '#alpha Monday' },
        { at: '2026-03-09T11:00:00', body: '#beta Monday' },
      ],
      section: 'settings',
    })
    await showsSettings()

    // A Filter narrowed before replay: Monday under #alpha. History stays
    // mounted while Settings shows, so leaving it narrowed is leaving it.
    await user.click(within(sidebar()).getByRole('button', { name: 'History' }))
    await showsHistory()
    const project = () =>
      within(screen.getByRole('banner')).getByRole('combobox', {
        name: /^Project/,
      })
    await user.click(project())
    await user.click(await screen.findByRole('option', { name: '#alpha' }))
    await expect.poll(() => project().textContent).toContain('#alpha')

    await user.click(within(sidebar()).getByRole('button', { name: 'Settings' }))
    await showsSettings()
    await user.click(
      await screen.findByRole('button', { name: 'Replay introduction' }),
    )
    await screen.findByRole('heading', { name: 'Welcome to Work Journal' })

    await user.click(screen.getByRole('button', { name: 'Try it' }))
    await expect.poll(() => desktop.practiceCapturesBegun).toBe(1)
    clock.set(new Date('2026-03-11T10:00:00'))
    const note = await core.capture('my practice note')
    if (note === null) throw new Error('nothing was captured')
    await desktop.announceCapturedNote(note.journalDay)
    await desktop.announceJournalChanged()
    await desktop.announcePracticeEnded({
      outcome: 'submitted',
      journalDay: note.journalDay,
    })

    // Manual replay never touches the dismissal marker: count the calls
    // rather than reading the default value back.
    let dismissCalls = 0
    const dismiss = desktop.dismissOnboarding.bind(desktop)
    desktop.dismissOnboarding = async () => {
      dismissCalls += 1
      await dismiss()
    }

    await user.click(
      await screen.findByRole('button', { name: 'View your note' }),
    )

    // Whatever the Filter said before, the Note's day shows with Project Any:
    // the earlier narrowing cannot hide the practice Note.
    await showsHistory()
    expect(await screen.findByText('my practice note')).toBeTruthy()
    await expect.poll(() => project().textContent).toContain('Any')
    expect(dismissCalls).toBe(0)
  })

  it('does not claim an ordinary Capture after a cancelled practice', async () => {
    const user = userEvent.setup()
    const { desktop, core, clock } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })

    await user.click(await screen.findByRole('button', { name: 'Try it' }))
    await expect.poll(() => desktop.practiceCapturesBegun).toBe(1)
    await desktop.announcePracticeEnded({ outcome: 'cancelled' })

    // The attempt closed with nothing recorded: the Try it control is
    // enabled again before anything else happens.
    await expect.poll(() => (screen.getByRole('button', { name: 'Try it' }) as HTMLButtonElement).disabled).toBe(false)

    // An ordinary Capture from anywhere else — the hotkey, the Tray — after
    // the cancellation belongs to no practice.
    clock.set(new Date('2026-03-11T10:00:00'))
    const ordinary = await core.capture('an ordinary note')
    if (ordinary === null) throw new Error('nothing was captured')
    await desktop.announceCapturedNote(ordinary.journalDay)
    await desktop.announceJournalChanged()

    // Let the announcement land: the introduction still offers no View.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(
      screen.queryByRole('button', { name: 'View your note' }),
    ).toBeNull()
    expect(
      screen.getByRole('heading', { name: 'Welcome to Work Journal' }),
    ).toBeTruthy()
    expect(desktop.onboarding).toBe('unfinished')
  })

  it('reveals the second day after two practices', async () => {
    const user = userEvent.setup()
    const { desktop, core, clock } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })

    await user.click(await screen.findByRole('button', { name: 'Try it' }))
    clock.set(new Date('2026-03-11T10:00:00'))
    const first = await core.capture('first practice note')
    if (first === null) throw new Error('nothing was captured')
    await desktop.announceCapturedNote(first.journalDay)
    await desktop.announcePracticeEnded({
      outcome: 'submitted',
      journalDay: first.journalDay,
    })
    await screen.findByRole('button', { name: 'View your note' })

    // A second attempt starts from no Note recorded yet, and its outcome —
    // one explicit event — is what the introduction offers.
    await user.click(screen.getByRole('button', { name: 'Try it' }))
    await expect.poll(() => desktop.practiceCapturesBegun).toBe(2)
    expect(
      screen.queryByRole('button', { name: 'View your note' }),
    ).toBeNull()

    clock.set(new Date('2026-03-12T10:00:00'))
    const second = await core.capture('second practice note')
    if (second === null) throw new Error('nothing was captured')
    await desktop.announceCapturedNote(second.journalDay)
    await desktop.announcePracticeEnded({
      outcome: 'submitted',
      journalDay: second.journalDay,
    })

    await user.click(
      await screen.findByRole('button', { name: 'View your note' }),
    )

    await showsHistory()
    expect(await screen.findByText('second practice note')).toBeTruthy()
    expect(days().textContent).toContain('March 12')
  })

  it('records a practice Note submitted through the real Capture window', async () => {
    const user = userEvent.setup()
    const { desktop, core, clock } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })

    // The resident window, mounted before the practice raises it — as in the
    // app, where the Capture view outlives every showing — so it hears the
    // showing carry that it is practice.
    clock.set(new Date('2026-03-09T15:00:00'))
    render(
      <CaptureView desktop={desktop} journal={Promise.resolve(core)} />,
    )

    await user.click(await screen.findByRole('button', { name: 'Try it' }))
    await expect.poll(() => desktop.practiceCapturesBegun).toBe(1)

    // Typing and Enter commit through CaptureView's own path: the Note, its
    // announcements, the practice outcome, and the practice dismiss.
    const field = (await screen.findByLabelText(
      'What did you just do?',
    )) as HTMLInputElement
    fireEvent.change(field, { target: { value: 'my practice note' } })
    fireEvent.keyDown(field, { key: 'Enter' })

    expect(
      await screen.findByRole('button', { name: 'View your note' }),
    ).toBeTruthy()
    await expect.poll(() => desktop.capturesDismissed).toBe(1)
    const notes = await core.notesForFilter({
      from: '2000-01-01',
      to: '2100-01-01',
    })
    expect(notes).toHaveLength(2)
  })

  it('returns to the introduction when the real Capture window is abandoned', async () => {
    const user = userEvent.setup()
    const { desktop, core } = await showMainWindow({
      captured: [MONDAY],
      onboarding: 'unfinished',
    })

    render(
      <CaptureView desktop={desktop} journal={Promise.resolve(core)} />,
    )

    await user.click(await screen.findByRole('button', { name: 'Try it' }))
    await expect.poll(() => desktop.practiceCapturesBegun).toBe(1)

    const field = (await screen.findByLabelText(
      'What did you just do?',
    )) as HTMLInputElement
    fireEvent.keyDown(field, { key: 'Escape' })
    await expect.poll(() => desktop.capturesDismissed).toBe(1)

    // Focus arriving late changes nothing: the attempt already closed on the
    // abandonment the Capture window reported.
    desktop.focus()

    await expect.poll(() => (screen.getByRole('button', { name: 'Try it' }) as HTMLButtonElement).disabled).toBe(false)
    expect(
      screen.queryByRole('button', { name: 'View your note' }),
    ).toBeNull()
    const notes = await core.notesForFilter({
      from: '2000-01-01',
      to: '2100-01-01',
    })
    expect(notes).toHaveLength(1)
  })
})

describe('Escape', () => {
  it('reaches the section the Entry Point opened the window on', async () => {
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      tasks: ['renew the cert'],
      section: 'tasks',
    })
    await showsTasks()

    await userEvent.setup().keyboard('{Escape}')

    // Escape is the section's, bound to its own root: a window opened on Tasks
    // View closes from Tasks View.
    await expect.poll(() => desktop.windowsClosed).toBe(1)
  })

  it('reaches the section the sidebar switched to', async () => {
    const user = userEvent.setup()
    const { desktop } = await showMainWindow({
      captured: [MONDAY],
      tasks: ['renew the cert'],
    })

    await user.click(within(sidebar()).getByRole('button', { name: 'Tasks' }))
    await showsTasks()
    await user.keyboard('{Escape}')

    // The click left the focus on the sidebar button, which is in neither
    // section — so the section switched to is handed it.
    await expect.poll(() => desktop.windowsClosed).toBe(1)
  })
})

describe('a clicked Task Alert', () => {
  it('opens the window on Tasks View, focused on that Task', async () => {
    const { created } = await showMainWindow({
      captured: [MONDAY],
      tasks: ['renew the cert'],
      // Both, as the Rust side leaves them for a window the click builds: the
      // section is the window's to switch to, the Task is Tasks View's to
      // single out.
      section: 'tasks',
      alertFor: 0,
    })

    await showsTasks()
    await singlesOut(created[0])
  })

  it('switches a window already on History, and focuses the Task', async () => {
    const { desktop, created } = await showMainWindow({
      captured: [MONDAY],
      tasks: ['renew the cert'],
    })
    await showsHistory()

    desktop.requestSection('tasks')
    desktop.openTaskAlert(`task:${created[0].id}`)

    await showsTasks()
    await singlesOut(created[0])
  })
})

const MONDAY = { at: '2026-03-09T10:00:00', body: 'Monday' }

/** The Main Window over a real journal, already showing its first list. */
async function showMainWindow({
  captured,
  tasks = [],
  section,
  whileStartingUp,
  alertFor,
  stored = { startAtLogin: false },
  onboarding,
  access,
  answersPrompt,
  calendars,
  apiKey,
  keychainRefuses,
  openSettingsStore,
}: {
  captured: Array<{ at: string; body: string }>
  /** The Tasks the journal already holds, in the order they were created. */
  tasks?: string[]
  /** The section the Entry Point that opened the window named, if it named one. */
  section?: MainSection
  /**
   * An Entry Point reached in the moment between the window being built and
   * its webview coming up — the window exists, and nothing in it is listening.
   */
  whileStartingUp?: (desktop: FakeDesktop) => void
  /** The Task a clicked Alert was about, as its position in `tasks`. */
  alertFor?: number
  /** Values in the settings store. */
  stored?: Record<string, unknown>
  /**
   * Where automatic Onboarding stands, as the marker the Rust side leaves:
   * `unfinished` is a fresh installation still due the introduction.
   */
  onboarding?: 'unfinished' | 'suppressed'
  /** What the OS allows of the calendars before anybody asks. */
  access?: CalendarAccess
  /** What answering the calendar prompt comes to. */
  answersPrompt?: CalendarAccess
  /** What the calendars hold, for the Meeting Import step to tick. */
  calendars?: CalendarInfo[]
  /** What the Keychain already holds, as an earlier run would have left it. */
  apiKey?: string
  /** Whether the Keychain refuses to answer, as it does when locked. */
  keychainRefuses?: boolean
  /** Overridden by the tests about a settings file that cannot be written. */
  openSettingsStore?: () => Promise<SettingsStore>
}) {
  const { driver, core, clock } = await journalHolding(captured)

  const created: Task[] = []
  for (const description of tasks) {
    created.push(await core.createTask(description))
  }

  const desktop = fakeDesktop({
    driver,
    stored,
    ...(access !== undefined ? { access } : {}),
    ...(answersPrompt !== undefined ? { answersPrompt } : {}),
    ...(calendars !== undefined ? { calendars } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(keychainRefuses !== undefined ? { keychainRefuses } : {}),
    ...(openSettingsStore !== undefined ? { openSettingsStore } : {}),
  })
  if (onboarding !== undefined) desktop.onboarding = onboarding
  const settings = createAppSettings(desktop)
  if (section !== undefined) desktop.requestSection(section)
  if (alertFor !== undefined) {
    desktop.pendingTaskAlert = `task:${created[alertFor].id}`
  }

  render(
    <ThemeProvider settings={settings}>
      <MainWindow
        desktop={desktop}
        settings={settings}
        journal={Promise.resolve(core)}
        clock={clock}
      />
    </ThemeProvider>,
  )
  whileStartingUp?.(desktop)
  // Where a window still starting up lands is what those tests are about, so
  // they wait for the section themselves rather than for one of them here.
  if (whileStartingUp !== undefined) {
    await screen.findByRole('navigation', { name: 'Sections' })
  } else if (section === 'settings') {
    await screen.findByText('Note Hotkey')
  } else if (section === 'work-summary') {
    await screen.findByRole('heading', { name: 'Work Summary' })
  } else if (onboarding === 'unfinished') {
    // A fresh installation opens on the introduction, not on a section.
    await screen.findByRole('heading', { name: 'Welcome to Work Journal' })
  } else {
    await firstListShown(captured.length)
  }

  return { desktop, core, created, clock }
}

/** The sidebar, as the only thing on screen that lists the sections. */
function sidebar(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Sections' })
}

/** History's days control — on screen only while History is the section. */
function days(): HTMLElement {
  return within(screen.getByRole('banner')).getByRole('button', {
    name: /^Days/,
  })
}

/** Work Summary's days control — on screen only while it is the section. */
function workSummaryDays(): HTMLElement | null {
  return screen.queryByRole('button', { name: /^Days / })
}

/** Until the section's own control reads the expected range. */
async function waitForWorkSummaryDays(range: string): Promise<void> {
  await expect.poll(() => workSummaryDays()?.textContent).toContain(range)
}

/** The Nudge, if History is showing one; undefined when nothing is waiting. */
function nudge(): HTMLElement | undefined {
  return screen
    .queryAllByRole('status')
    .find((element) => element.textContent?.includes('A new Note on'))
}

/** Tasks View is the section on screen, once whatever asked for it lands. */
async function showsTasks(): Promise<void> {
  await expect.poll(sectionOnScreen).toBe('tasks')
}

/** History is the section on screen. */
async function showsHistory(): Promise<void> {
  await expect.poll(sectionOnScreen).toBe('history')
}

/** Settings is the section on screen, once whatever asked for it lands. */
async function showsSettings(): Promise<void> {
  await screen.findByText('Note Hotkey')
  await expect.poll(sectionOnScreen).toBe('settings')
}

/** Work Summary is ready once its date header is on screen. */
async function showsWorkSummary(): Promise<void> {
  await screen.findByRole('heading', { name: 'Work Summary' })
  await expect.poll(sectionOnScreen).toBe('work-summary')
}

/**
 * Which section is on screen, read the way a screen reader would: the section
 * that is not showing is hidden rather than unmounted, so exactly one of the
 * two headers is in the accessibility tree — and asking for the banner at all
 * fails if that is ever untrue.
 */
function sectionOnScreen(): MainSection {
  const visible = [...document.querySelectorAll<HTMLElement>('[data-main-section]')].find(
    (section) => !section.hidden,
  )
  if (visible !== undefined) return visible.dataset.mainSection as MainSection

  const header = screen.queryByRole('banner')
  if (header === null) return 'settings'

  return within(header).queryByLabelText('Search') === null
    ? 'tasks'
    : 'history'
}

/**
 * Whether every section is hidden — the state while the Onboarding flow is
 * up in their place. Read from the DOM because the sections stay mounted.
 */
function allSectionsHidden(): boolean {
  const sections = [...document.querySelectorAll('[data-main-section]')]
  return (
    sections.length > 0 &&
    sections.every((section) => (section as HTMLElement).hidden)
  )
}

/** The row for one Task, as the click on its Alert leaves it. */
async function singlesOut(task: Task): Promise<void> {
  await expect
    .poll(() =>
      screen
        .queryByText(task.description)
        ?.closest('li')
        ?.getAttribute('aria-current'),
    )
    .toBe('true')
}

/**
 * What the toasts on screen say. A toast is rendered where its Toaster is
 * mounted, so one raised inside a hidden section is in the document without
 * being on screen — and one raised while the section that mounts the showing
 * Toaster is not the section that raised it is on screen all the same.
 */
function toastsOnScreen(): string[] {
  return [...document.querySelectorAll('[data-sonner-toast]')]
    .filter((toast) => onScreen(toast))
    .map((toast) => toast.textContent ?? '')
}

/** Whether an element is drawn: nothing between it and the document is hidden. */
function onScreen(node: Element): boolean {
  for (let at: Element | null = node; at !== null; at = at.parentElement) {
    if (at instanceof HTMLElement && at.hidden) return false
  }
  return true
}
