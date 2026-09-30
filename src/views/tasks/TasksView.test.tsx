// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { fakeDesktop } from '@/platform/testing/desktop'
import { createJournal, type Task } from '@/journal/journal'
import { fixedClock, openTestDatabase } from '@/journal/testing/database'
import TasksView from './TasksView'

// Tasks View as the user meets it: the two lists, the checkbox that completes
// without asking, the Editor that discards on Cancel, and the confirmation on
// the one thing that cannot be undone.

afterEach(cleanup)

const openDatabases: Array<() => void> = []

afterEach(() => {
  for (const close of openDatabases.splice(0)) close()
})

/** Tasks View over a real journal, already showing its first list. */
async function showTasks(
  descriptions: string[] = [],
  /** The Alert that opened the window, as a click that built it would leave. */
  { pendingTaskAlert = null as string | null } = {},
) {
  const { driver, close } = await openTestDatabase()
  openDatabases.push(close)

  const clock = fixedClock('2026-03-09T09:00:00')
  const core = createJournal({ clock, driver })

  const created: Task[] = []
  for (const [index, description] of descriptions.entries()) {
    clock.set(new Date(`2026-03-09T${String(9 + index).padStart(2, '0')}:00:00`))
    created.push(await core.createTask(description))
  }

  const desktop = fakeDesktop({ driver })
  desktop.pendingTaskAlert = pendingTaskAlert
  render(
    <TasksView desktop={desktop} journal={Promise.resolve(core)} clock={clock} />,
  )

  return { desktop, core, clock, created }
}

/**
 * A Task changed behind the view's back, then the row for it once the view has
 * caught up — the Editor is opened from the row, and a row read before the
 * change would carry the schedule it used to have.
 */
async function openEditorFor(
  desktop: { announceTasksChanged: () => Promise<void> },
  description: string,
  group: string,
) {
  await desktop.announceTasksChanged()
  await expect.poll(() => rowsUnder(group)).toContain(description)
  fireEvent.click(screen.getByText(description))
  return screen.findByRole('dialog', { name: 'Edit Task' })
}

/** Which group heading each row sits under, in the order they are on screen. */
function groupHeadings(): string[] {
  return [...document.querySelectorAll('main section h2')].map(
    (heading) => heading.textContent ?? '',
  )
}

/** The rows under one group heading. */
function rowsUnder(heading: string): string[] {
  const section = [...document.querySelectorAll('main section')].find(
    (each) => each.querySelector('h2')?.textContent === heading,
  )
  return [...(section?.querySelectorAll('li button[type="button"]') ?? [])]
    .filter((button) => button.getAttribute('aria-label') === null)
    .map((button) => button.textContent ?? '')
}

/** The list as it reads on screen, in the order the rows are in. */
function rows(): string[] {
  return [...document.querySelectorAll('li button[type="button"]')]
    .filter((button) => button.getAttribute('aria-label') === null)
    .map((button) => button.textContent ?? '')
}

function tab(name: 'Open' | 'Completed'): HTMLElement {
  return screen.getByRole('button', { name })
}

/** What the reader is looking for, anywhere in the journal. */
function searchBox(): HTMLInputElement {
  return screen.getByPlaceholderText('Search') as HTMLInputElement
}

/**
 * A Task scheduled without a time offers an action rather than an empty time
 * field, so setting one is asking for it first — see ScheduleFields.
 */
function setTime(time: string) {
  const add = screen.queryByRole('button', { name: 'Add a time' })
  if (add !== null) fireEvent.click(add)
  fireEvent.change(screen.getByLabelText('Time'), { target: { value: time } })
}

describe('opening Tasks View', () => {
  it('opens on the Open Tasks, newest first', async () => {
    await showTasks(['first', 'second', 'third'])

    await screen.findByText('third')
    expect(rows()).toEqual(['third', 'second', 'first'])
  })

  it('teaches the Task Hotkey when there is nothing owed yet', async () => {
    await showTasks()

    const empty = await screen.findByRole('heading', { name: 'No Open Tasks' })
    const section = empty.closest('section')!
    expect(
      [...section.querySelectorAll('kbd[data-slot="kbd"]')].map(
        (key) => key.textContent,
      ),
    ).toEqual(['Ctrl', 'Shift', 'Cmd', 'T'])
  })

  it('says the Completed list is empty in its own words', async () => {
    await showTasks()
    await screen.findByRole('heading', { name: 'No Open Tasks' })

    fireEvent.click(tab('Completed'))

    await screen.findByRole('heading', { name: 'No Completed Tasks yet' })
  })
})

describe('completing and reopening', () => {
  it('completes from the checkbox with no confirmation at all', async () => {
    const { core } = await showTasks(['renew the certificate'])
    await screen.findByText('renew the certificate')

    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Complete “renew the certificate”' }),
    )

    await expect.poll(() => rows()).toEqual([])
    expect(await core.completedTasks()).toHaveLength(1)
    // Nothing was asked: no dialog stood between the press and the change.
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('reopens a Completed Task from the Completed list', async () => {
    const { core } = await showTasks(['renew the certificate'])
    fireEvent.click(
      await screen.findByRole('checkbox', {
        name: 'Complete “renew the certificate”',
      }),
    )
    await expect.poll(() => rows()).toEqual([])

    fireEvent.click(tab('Completed'))
    const checkbox = await screen.findByRole('checkbox', {
      name: 'Reopen “renew the certificate”',
    })
    fireEvent.click(checkbox)

    await expect.poll(() => rows()).toEqual([])
    expect(await core.openTasks()).toHaveLength(1)
  })
})

describe('the Task Editor', () => {
  it('saves a reworded Task', async () => {
    const { core } = await showTasks(['renew the cert'])
    fireEvent.click(await screen.findByText('renew the cert'))

    const editor = await screen.findByRole('dialog', { name: 'Edit Task' })
    const input = screen.getByLabelText('Task Description') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'renew the TLS certificate' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await expect.poll(() => rows()).toEqual(['renew the TLS certificate'])
    expect(editor.isConnected).toBe(false)
    expect(
      (await core.openTasks()).map((task) => task.description),
    ).toEqual(['renew the TLS certificate'])
  })

  it('discards on Cancel', async () => {
    const { core } = await showTasks(['renew the cert'])
    fireEvent.click(await screen.findByText('renew the cert'))

    const input = screen.getByLabelText('Task Description') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'something else entirely' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(rows()).toEqual(['renew the cert'])
    expect((await core.openTasks())[0].description).toBe('renew the cert')
  })

  it('discards on Escape, and does not close the window with it', async () => {
    const { desktop, core } = await showTasks(['renew the cert'])
    let closed = 0
    desktop.closeWindow = async () => {
      closed += 1
    }
    fireEvent.click(await screen.findByText('renew the cert'))

    const input = screen.getByLabelText('Task Description') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'something else entirely' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(closed).toBe(0)
    expect((await core.openTasks())[0].description).toBe('renew the cert')
  })

  it('never reuses the Task Creation window', async () => {
    const { desktop } = await showTasks(['renew the cert'])
    fireEvent.click(await screen.findByText('renew the cert'))

    await screen.findByRole('dialog', { name: 'Edit Task' })
    expect(desktop.taskCreationsBegun).toBe(0)
  })
})

describe('deleting a Task', () => {
  it('always asks first, and removes it once confirmed', async () => {
    const { core } = await showTasks(['renew the cert'])
    await screen.findByText('renew the cert')

    fireEvent.click(
      screen.getByRole('button', { name: 'Delete “renew the cert”' }),
    )

    const confirm = await screen.findByRole('button', { name: 'Delete' })
    expect(await core.openTasks()).toHaveLength(1)

    fireEvent.click(confirm)

    await expect.poll(() => rows()).toEqual([])
    expect(await core.openTasks()).toEqual([])
  })
})

describe('New Task', () => {
  it('reaches the same resident Task Creation window every Entry Point does', async () => {
    const { desktop } = await showTasks()
    await screen.findByRole('heading', { name: 'No Open Tasks' })

    fireEvent.click(screen.getByRole('button', { name: 'New Task' }))

    expect(desktop.taskCreationsBegun).toBe(1)
  })
})

describe('a Task changed elsewhere', () => {
  it('shows up with no manual refresh', async () => {
    const { desktop, core, clock } = await showTasks(['already here'])
    await screen.findByText('already here')

    clock.set(new Date('2026-03-09T14:00:00'))
    await core.createTask('typed in the Task Creation window')
    await desktop.announceTasksChanged()

    await expect
      .poll(() => rows())
      .toEqual(['typed in the Task Creation window', 'already here'])
  })
})

describe('Escape', () => {
  it('closes the window when nothing has taken the screen over', async () => {
    const { desktop } = await showTasks(['renew the cert'])
    let closed = 0
    desktop.closeWindow = async () => {
      closed += 1
    }
    await screen.findByText('renew the cert')

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
    })

    expect(closed).toBe(1)
  })
})

/** Tasks View is one of the windows with an overlay title bar. */
describe('the window chrome', () => {
  it('keeps a strip above everything for the traffic lights to sit in', async () => {
    await showTasks()
    await screen.findByRole('heading', { name: 'No Open Tasks' })

    const strip = document.querySelector<HTMLElement>(
      '[data-slot="window-title-bar"]',
    )
    expect(strip).not.toBeNull()
    expect(strip!.parentElement?.firstElementChild).toBe(strip)
  })
})

describe('the four groups', () => {
  /** One Task in each group, seen from a fixed morning. */
  async function grouped() {
    const built = await showTasks()
    const { core } = built

    await core.createTask('last week', { date: '2026-03-02', time: null })
    await core.createTask('this evening', { date: '2026-03-09', time: '17:00' })
    await core.createTask('next week', { date: '2026-03-16', time: '09:00' })
    await core.createTask('someday')
    await built.desktop.announceTasksChanged()
    await screen.findByText('someday')

    return built
  }

  it('shows Overdue, Today, Upcoming and Unscheduled, in that order', async () => {
    await grouped()

    await expect
      .poll(groupHeadings)
      .toEqual(['Overdue', 'Today', 'Upcoming', 'Unscheduled'])
    expect(rowsUnder('Overdue')).toEqual(['last week'])
    expect(rowsUnder('Today')).toEqual(['this evening'])
    expect(rowsUnder('Upcoming')).toEqual(['next week'])
    expect(rowsUnder('Unscheduled')).toEqual(['someday'])
  })

  it('leaves out a group with nothing in it', async () => {
    await showTasks(['someday'])

    await expect.poll(groupHeadings).toEqual(['Unscheduled'])
  })

  it('moves a Task between groups when the day is looked at again', async () => {
    const { clock, desktop } = await grouped()
    await expect.poll(() => rowsUnder('Today')).toEqual(['this evening'])

    clock.set(new Date('2026-03-10T09:00:00'))
    desktop.focus()

    await expect
      .poll(() => rowsUnder('Overdue'))
      .toEqual(['last week', 'this evening'])
    expect(groupHeadings()).not.toContain('Today')
  })

  it('shows the Completed Tasks as one ungrouped list', async () => {
    const { core, created } = await showTasks(['renew the cert'])
    await core.completeTask(created[0].id)
    fireEvent.click(tab('Completed'))

    await screen.findByText('renew the cert')
    expect(groupHeadings()).toEqual([])
  })

  it('shows the year in a scheduled Task row', async () => {
    const { core, desktop } = await showTasks()
    await core.createTask('plan next year', {
      date: '2027-03-16',
      time: null,
    })
    await desktop.announceTasksChanged()

    const task = await screen.findByText('plan next year')
    expect(task.closest('li')?.textContent).toContain('2027')
  })

  it('puts schedule metadata below the larger Task description', async () => {
    const { core, desktop } = await showTasks(['renew the cert'])
    const [task] = await core.openTasks()
    await core.editTask(task.id, {
      description: 'renew the cert',
      schedule: { date: '2027-03-16', time: '14:00' },
      recurrence: { unit: 'day', interval: 1, weekdays: [] },
    })
    await desktop.announceTasksChanged()

    const description = await screen.findByText('renew the cert')
    const metadata = description.nextElementSibling

    expect(description.className).toContain('type-title')
    expect(metadata?.textContent).toContain('every day')
    expect(metadata?.textContent).toContain('2027')
    expect(description.parentElement?.firstElementChild).toBe(description)
  })
})

describe('the schedule controls', () => {
  it('has no time until there is a date for it to be a minute of', async () => {
    await showTasks(['renew the cert'])
    fireEvent.click(await screen.findByText('renew the cert'))

    // No date-shaped field either: WebKit fills an empty one with today's
    // date, which would read as a schedule nobody chose — see ScheduleFields.
    expect(screen.queryByLabelText('Time')).toBeNull()
    expect(screen.queryByLabelText('Scheduled For')).toBeNull()
    expect(screen.getByRole('button', { name: 'Add a date' })).toBeTruthy()
  })

  it('saves the date and the time chosen', async () => {
    const { core, created, desktop } = await showTasks(['renew the cert'])
    await core.editTask(created[0].id, {
      description: 'renew the cert',
      schedule: { date: '2026-03-16', time: null },
    })
    await openEditorFor(desktop, 'renew the cert', 'Upcoming')

    setTime('14:30')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await expect
      .poll(async () => (await core.openTasks())[0].scheduledTime)
      .toBe('14:30')
    expect((await core.openTasks())[0].scheduledDate).toBe('2026-03-16')
  })

  it('clears the time along with the date', async () => {
    const { core, created, desktop } = await showTasks(['renew the cert'])
    await core.editTask(created[0].id, {
      description: 'renew the cert',
      schedule: { date: '2026-03-16', time: '14:00' },
    })
    await openEditorFor(desktop, 'renew the cert', 'Upcoming')

    fireEvent.click(screen.getByRole('button', { name: 'Clear the schedule' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await expect
      .poll(async () => (await core.openTasks())[0].scheduledDate)
      .toBeNull()
    expect((await core.openTasks())[0].scheduledTime).toBeNull()
  })

  it('leaves the Task Description exactly as typed, schedule words and all', async () => {
    const { core, created } = await showTasks(['ship it'])
    fireEvent.click(await screen.findByText('ship it'))

    const input = screen.getByLabelText('Task Description') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'ship it tomorrow at 9am' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await expect
      .poll(async () => (await core.openTasks())[0].description)
      .toBe('ship it tomorrow at 9am')
    expect((await core.openTasks())[0].scheduledDate).toBeNull()
    expect(created).toHaveLength(1)
  })

  it('offers no schedule controls at all while a Task is Completed', async () => {
    const { core, created } = await showTasks(['renew the cert'])
    await core.completeTask(created[0].id)
    fireEvent.click(tab('Completed'))
    fireEvent.click(await screen.findByText('renew the cert'))

    expect(screen.queryByLabelText('Time')).toBeNull()
    expect(screen.queryByLabelText('Scheduled For')).toBeNull()
    expect(
      screen.getByText(/Reopen it to change when it is meant to be done/),
    ).toBeTruthy()
  })
})

describe('asking about Task Alerts', () => {
  it('asks the first time a Task with a time is saved, and never before', async () => {
    const { core, created, desktop } = await showTasks(['renew the cert'])
    desktop.alertPermission = 'undetermined'
    await core.editTask(created[0].id, {
      description: 'renew the cert',
      schedule: { date: '2026-03-16', time: null },
    })
    await openEditorFor(desktop, 'renew the cert', 'Upcoming')
    expect(desktop.alertPrompted).toBe(false)

    setTime('14:30')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await expect.poll(() => desktop.alertPrompted).toBe(true)
  })

  it('keeps the Task when macOS refuses, and says the Task is unaffected', async () => {
    const { core, created, desktop } = await showTasks(['renew the cert'])
    desktop.alertPermission = 'denied'
    await core.editTask(created[0].id, {
      description: 'renew the cert',
      schedule: { date: '2026-03-16', time: null },
    })
    await openEditorFor(desktop, 'renew the cert', 'Upcoming')

    setTime('14:30')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await screen.findByText(/macOS is not allowing Work Journal to alert you/)
    expect((await core.openTasks())[0].scheduledTime).toBe('14:30')
  })
})

describe('a reconciliation the OS refused', () => {
  it('says so, since the window that reconciles has no screen', async () => {
    const { desktop } = await showTasks(['renew the cert'])
    await screen.findByText('renew the cert')

    await desktop.announceTaskAlertsReconciled(false)

    expect(
      await screen.findByText(/macOS is not holding the alerts/),
    ).not.toBeNull()
  })

  it('stops saying so once the OS takes them after all', async () => {
    const { desktop } = await showTasks(['renew the cert'])
    await screen.findByText('renew the cert')
    await desktop.announceTaskAlertsReconciled(false)
    await screen.findByText(/macOS is not holding the alerts/)

    await desktop.announceTaskAlertsReconciled(true)

    await expect
      .poll(() => screen.queryByText(/macOS is not holding the alerts/))
      .toBeNull()
  })

  it('leaves every Task exactly where it was', async () => {
    const { desktop } = await showTasks(['renew the cert'])
    await screen.findByText('renew the cert')

    await desktop.announceTaskAlertsReconciled(false)
    await screen.findByText(/macOS is not holding the alerts/)

    expect(screen.getByText('renew the cert')).not.toBeNull()
  })
})

describe('searching the Tasks', () => {
  it('searches both lists at once, each result labelled with the state it is in', async () => {
    const { core, created } = await showTasks(['planned the migration'])
    await core.completeTask(created[0].id)
    await core.createTask('ran the migration')
    await screen.findByText('planned the migration')

    fireEvent.change(searchBox(), { target: { value: 'migration' } })

    await screen.findByText('ran the migration')
    expect(
      screen.getByText('ran the migration').closest('li')?.textContent,
    ).toContain('Open')
    expect(
      screen.getByText('planned the migration').closest('li')?.textContent,
    ).toContain('Completed')
    // The groups are a shape for the whole of the Open list, not for this.
    expect(groupHeadings()).toEqual([])
  })

  it('answers a Completed result in the Completed list, with that Task singled out', async () => {
    const { core, created } = await showTasks([
      'renew the cert',
      'chase the invoice',
    ])
    await core.completeTask(created[0].id)
    await screen.findByText('renew the cert')

    fireEvent.change(searchBox(), { target: { value: 'renew' } })
    fireEvent.click(
      await screen.findByRole('button', { name: /renew the cert/ }),
    )

    await expect
      .poll(() =>
        screen
          .queryByText('renew the cert')
          ?.closest('li')
          ?.getAttribute('aria-current'),
      )
      .toBe('true')
    await screen.findByRole('checkbox', {
      name: 'Reopen “renew the cert”',
    })
    // The term stays in the field, so asking again costs no retyping.
    expect(searchBox().value).toBe('renew')
  })

  it('answers an Open result without leaving the Open list', async () => {
    await showTasks(['renew the cert', 'chase the invoice'])
    await screen.findByText('renew the cert')

    fireEvent.change(searchBox(), { target: { value: 'chase' } })
    fireEvent.click(
      await screen.findByRole('button', { name: /chase the invoice/ }),
    )

    await expect
      .poll(() =>
        screen
          .queryByText('chase the invoice')
          ?.closest('li')
          ?.getAttribute('aria-current'),
      )
      .toBe('true')
    await screen.findByRole('checkbox', {
      name: 'Complete “chase the invoice”',
    })
  })

  it('says so when no Task says the term', async () => {
    await showTasks(['renew the cert'])
    await screen.findByText('renew the cert')

    fireEvent.change(searchBox(), { target: { value: 'migration' } })

    await screen.findByRole('heading', { name: 'No Tasks say “migration”.' })
  })

  it('leaves the Search on Escape and shows the list again, without closing the window', async () => {
    const { desktop } = await showTasks(['renew the cert'])
    let closed = 0
    desktop.closeWindow = async () => {
      closed += 1
    }
    await screen.findByText('renew the cert')

    fireEvent.change(searchBox(), { target: { value: 'renew' } })
    await expect.poll(groupHeadings).toEqual([])

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
    })

    await expect.poll(groupHeadings).toEqual(['Unscheduled'])
    expect(closed).toBe(0)
    expect(searchBox().value).toBe('')
  })
})

describe('a clicked Task Alert', () => {  it('singles out the Task even when the click built the window', async () => {
    const { driver, close } = await openTestDatabase()
    openDatabases.push(close)
    const core = createJournal({
      clock: fixedClock('2026-03-09T09:00:00'),
      driver,
    })
    const task = await core.createTask('renew the cert', {
      date: '2026-03-16',
      time: '14:00',
    })
    // Nothing is listening when a cold-launched window is built, so the Alert
    // is waiting to be claimed rather than announced.
    const desktop = fakeDesktop({ driver })
    desktop.pendingTaskAlert = `task:${task.id}`
    render(
      <TasksView
        desktop={desktop}
        journal={Promise.resolve(core)}
        clock={fixedClock('2026-03-09T09:00:00')}
      />,
    )

    await expect
      .poll(() =>
        screen
          .queryByText('renew the cert')
          ?.closest('li')
          ?.getAttribute('aria-current'),
      )
      .toBe('true')
    // Claimed once: a window opened any other way must not inherit the click.
    expect(await desktop.openedTaskAlert()).toBeNull()
  })

  it('stops singling it out once the user moves on', async () => {
    const { desktop, created } = await showTasks(['renew the cert'])
    await screen.findByText('renew the cert')
    desktop.openTaskAlert(`task:${created[0].id}`)
    await expect
      .poll(() =>
        screen
          .queryByText('renew the cert')
          ?.closest('li')
          ?.getAttribute('aria-current'),
      )
      .toBe('true')

    fireEvent.click(tab('Completed'))
    fireEvent.click(tab('Open'))

    await expect
      .poll(() =>
        screen
          .queryByText('renew the cert')
          ?.closest('li')
          ?.getAttribute('aria-current'),
      )
      .toBeNull()
  })

  it('leaves nothing behind for the next window when it was announced', async () => {
    const { desktop, created } = await showTasks(['renew the cert'])
    await screen.findByText('renew the cert')

    // The click is written down as well as announced — the Rust side cannot
    // know a window is listening. This one was, so nothing may be left sitting
    // there for the next Tasks View to inherit.
    desktop.openTaskAlert(`task:${created[0].id}`)

    await expect
      .poll(() =>
        screen
          .queryByText('renew the cert')
          ?.closest('li')
          ?.getAttribute('aria-current'),
      )
      .toBe('true')
    // Read rather than claimed: asking would empty it and prove nothing.
    await expect.poll(() => desktop.pendingTaskAlert).toBeNull()
  })

  it('shows the Open list with that Task singled out', async () => {
    const { desktop, core, created } = await showTasks([
      'renew the cert',
      'chase the invoice',
    ])
    await core.editTask(created[0].id, {
      description: 'renew the cert',
      schedule: { date: '2026-03-16', time: '14:00' },
    })
    await screen.findByText('renew the cert')
    fireEvent.click(tab('Completed'))

    desktop.openTaskAlert(`task:${created[0].id}`)

    await expect
      .poll(() =>
        screen
          .queryByText('renew the cert')
          ?.closest('li')
          ?.getAttribute('aria-current'),
      )
      .toBe('true')
    expect(
      screen
        .getByText('chase the invoice')
        .closest('li')
        ?.getAttribute('aria-current'),
    ).toBeNull()
  })
})

describe('the recurrence controls', () => {
  const daily = { unit: 'day' as const, interval: 1, weekdays: [] }

  /** The cadence picker inside whichever sheet is open. */
  function cadence(): HTMLSelectElement {
    return screen.getByLabelText('Repeats') as HTMLSelectElement
  }

  it('cannot be used until there is a date to count from', async () => {
    await showTasks(['renew the cert'])
    fireEvent.click(await screen.findByText('renew the cert'))

    expect(cadence().disabled).toBe(true)
    expect(cadence().value).toBe('none')
  })

  it('saves a cadence chosen beside the date', async () => {
    const { core, created, desktop } = await showTasks(['renew the cert'])
    await core.editTask(created[0].id, {
      description: 'renew the cert',
      schedule: { date: '2026-03-16', time: null },
    })
    await openEditorFor(desktop, 'renew the cert', 'Upcoming')

    fireEvent.change(cadence(), { target: { value: 'month' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await expect
      .poll(async () => (await core.openTasks())[0].recurrence?.unit)
      .toBe('month')
    expect((await core.openTasks())[0].recurrence?.interval).toBe(1)
  })

  it('offers the weekdays only for a weekly cadence, and keeps several', async () => {
    const { core, created, desktop } = await showTasks(['gym'])
    await core.editTask(created[0].id, {
      description: 'gym',
      schedule: { date: '2026-03-16', time: null },
    })
    await openEditorFor(desktop, 'gym', 'Upcoming')

    expect(screen.queryByRole('button', { name: 'Wednesday' })).toBeNull()

    fireEvent.change(cadence(), { target: { value: 'week' } })
    // 16 March 2026 is a Monday, so that is where a weekly cadence starts.
    expect(
      screen.getByRole('button', { name: 'Monday' }).getAttribute('aria-pressed'),
    ).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: 'Wednesday' }))
    fireEvent.click(screen.getByRole('button', { name: 'Friday' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await expect
      .poll(async () => (await core.openTasks())[0].recurrence?.weekdays)
      .toEqual([1, 3, 5])
  })

  it('asks before clearing a date that would stop an existing recurrence', async () => {
    const { core, created, desktop } = await showTasks(['water the plants'])
    await core.editTask(created[0].id, {
      description: 'water the plants',
      schedule: { date: '2026-03-16', time: null },
      recurrence: daily,
    })
    await openEditorFor(desktop, 'water the plants', 'Upcoming')

    fireEvent.click(screen.getByRole('button', { name: 'Clear the schedule' }))

    const asked = await screen.findByRole('alertdialog')
    expect(asked.textContent).toContain('clearing the date also')
    // Cancelling leaves the cadence exactly where it was.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await expect.poll(() => screen.queryByRole('alertdialog')).toBeNull()
    expect(cadence().value).toBe('day')
  })

  it('does not ask when the cadence itself is turned off', async () => {
    const { core, created, desktop } = await showTasks(['water the plants'])
    await core.editTask(created[0].id, {
      description: 'water the plants',
      schedule: { date: '2026-03-16', time: null },
      recurrence: daily,
    })
    await openEditorFor(desktop, 'water the plants', 'Upcoming')

    // Choosing it outright is the user saying it: nothing stands in the way,
    // and the date they chose stays exactly where it is.
    fireEvent.change(cadence(), { target: { value: 'none' } })

    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect((screen.getByLabelText('Scheduled For') as HTMLInputElement).value).toBe(
      '2026-03-16',
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await expect
      .poll(async () => (await core.openTasks())[0].recurrence)
      .toBeNull()
    expect((await core.openTasks())[0].scheduledDate).toBe('2026-03-16')
  })

  it('stops the recurrence once that clearing is confirmed', async () => {
    const { core, created, desktop } = await showTasks(['water the plants'])
    await core.editTask(created[0].id, {
      description: 'water the plants',
      schedule: { date: '2026-03-16', time: null },
      recurrence: daily,
    })
    await openEditorFor(desktop, 'water the plants', 'Upcoming')

    fireEvent.click(screen.getByRole('button', { name: 'Clear the schedule' }))
    fireEvent.click(
      await screen.findByRole('button', { name: 'Stop repeating' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await expect
      .poll(async () => (await core.openTasks())[0].recurrence)
      .toBeNull()
    expect((await core.openTasks())[0].scheduledDate).toBeNull()
  })
})

describe('a Recurring Task in the list', () => {
  const daily = { unit: 'day' as const, interval: 1, weekdays: [] }

  /** A Recurring Task, already on screen. */
  async function showRecurring(
    { completions = 0 } = {},
  ) {
    const { core, clock, desktop, created } = await showTasks(['water the plants'])
    const task = await core.editTask(created[0].id, {
      description: 'water the plants',
      schedule: { date: '2026-03-09', time: null },
      recurrence: daily,
    })
    for (let round = 0; round < completions; round += 1) {
      clock.set(new Date(`2026-03-${String(9 + round).padStart(2, '0')}T20:00:00`))
      await core.completeTask(task.id)
    }
    await desktop.announceTasksChanged()
    await screen.findByText('water the plants')

    return { core, clock, desktop, task }
  }

  it('says what it repeats on, in the same words an export writes', async () => {
    await showRecurring()

    await expect.poll(() => screen.queryByText('every day')).not.toBeNull()
  })

  it('advances into another group when it is completed', async () => {
    const { core, clock } = await showRecurring()
    await expect.poll(() => rowsUnder('Today')).toEqual(['water the plants'])

    clock.set(new Date('2026-03-09T20:00:00'))
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Complete “water the plants”' }),
    )

    await expect.poll(() => rowsUnder('Upcoming')).toEqual(['water the plants'])
    // It never joins the ordinary Completed Tasks.
    expect(await core.completedTasks()).toEqual([])
  })

  it('shows the completed occurrences in an expandable history', async () => {
    await showRecurring({ completions: 2 })

    const history = await screen.findByRole('button', {
      name: 'Completed occurrences of “water the plants”',
    })
    expect(history.textContent).toContain('2 completed occurrences')
    expect(screen.queryByText('2026-03-09')).toBeNull()

    fireEvent.click(history)

    await screen.findByText('2026-03-09')
    expect(screen.getByText('2026-03-10')).not.toBeNull()
  })

  it('offers Undo Completion while it is safe and not once it is not', async () => {
    const { core, task } = await showRecurring({ completions: 1 })

    const undo = await screen.findByRole('button', {
      name: 'Undo the last completion of “water the plants”',
    })

    fireEvent.click(undo)

    await expect
      .poll(async () => (await core.openTasks())[0].scheduledDate)
      .toBe('2026-03-09')
    await expect
      .poll(() =>
        screen.queryByRole('button', {
          name: 'Undo the last completion of “water the plants”',
        }),
      )
      .toBeNull()
    expect(await core.occurrencesOf(task.id)).toHaveLength(1)
  })

  it('does not offer Undo Completion once an edit has replaced the successor', async () => {
    const { core, task, desktop } = await showRecurring({ completions: 1 })
    await screen.findByRole('button', {
      name: 'Undo the last completion of “water the plants”',
    })

    await core.editTask(task.id, {
      description: 'water the plants',
      schedule: { date: '2026-03-20', time: null },
      recurrence: daily,
    })
    await desktop.announceTasksChanged()

    await expect
      .poll(() =>
        screen.queryByRole('button', {
          name: 'Undo the last completion of “water the plants”',
        }),
      )
      .toBeNull()
  })

  it('stops the recurrence from the row, immediately and without asking', async () => {
    const { core, task } = await showRecurring({ completions: 1 })

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Stop repeating “water the plants”',
      }),
    )

    // Nothing stood between the press and the change: the user said it
    // outright, and nothing is destroyed by it.
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await expect
      .poll(async () => (await core.openTasks())[0].recurrence)
      .toBeNull()
    // The history survives; only the rule and the Open occurrence go.
    expect(await core.occurrencesOf(task.id)).toHaveLength(1)
  })

  it('warns that deleting takes the occurrence history with it', async () => {
    const { core, task } = await showRecurring({ completions: 1 })

    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete “water the plants”' }),
    )

    const asked = await screen.findByRole('alertdialog')
    expect(asked.textContent).toContain('every occurrence it has completed')

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await expect.poll(async () => await core.openTasks()).toEqual([])
    expect(await core.occurrencesOf(task.id)).toEqual([])
  })

  it('still warns about the history once the recurrence has been stopped', async () => {
    const { core, task, desktop } = await showRecurring({ completions: 1 })
    await core.stopRecurrence(task.id)
    await desktop.announceTasksChanged()
    await expect
      .poll(() =>
        screen.queryByRole('button', {
          name: 'Stop repeating “water the plants”',
        }),
      )
      .toBeNull()

    fireEvent.click(
      screen.getByRole('button', { name: 'Delete “water the plants”' }),
    )

    const asked = await screen.findByRole('alertdialog')
    expect(asked.textContent).toContain('every occurrence it has completed')
  })

  it('hears a completion made in another window', async () => {
    const { core, clock, desktop, task } = await showRecurring()
    await expect.poll(() => rowsUnder('Today')).toEqual(['water the plants'])

    clock.set(new Date('2026-03-09T20:00:00'))
    await core.completeTask(task.id)
    await desktop.announceTasksChanged()

    await expect.poll(() => rowsUnder('Upcoming')).toEqual(['water the plants'])
  })
})

it('edits, cancels and clears Task Details on Open and Completed Tasks', async () => {
  const { core, created } = await showTasks(['proposal'])
  fireEvent.click(await screen.findByText('proposal'))
  const details = () => screen.getByLabelText('Task Details (optional)') as HTMLTextAreaElement
  fireEvent.change(details(), { target: { value: '  context\n\n  instructions  ' } })
  fireEvent.keyDown(details(), { key: 'Enter' })
  expect((await core.openTasks())[0].details).toBeNull()
  fireEvent.keyDown(screen.getByLabelText('Task Description'), { key: 'Enter' })
  await expect.poll(() => screen.queryByRole('dialog')).toBeNull()
  expect((await core.openTasks())[0].details).toBe('  context\n\n  instructions  ')
  expect(screen.getByRole('img', { name: 'Has Task Details' })).toBeTruthy()
  fireEvent.click(screen.getByText('proposal'))
  fireEvent.change(details(), { target: { value: 'discarded' } })
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  fireEvent.click(screen.getByText('proposal'))
  expect(details().value).toBe('  context\n\n  instructions  ')
  fireEvent.keyDown(details(), { key: 'Escape' })
  fireEvent.click(screen.getByLabelText('Complete “proposal”'))
  await expect.poll(async () => (await core.completedTasks()).length).toBe(1)
  fireEvent.click(tab('Completed'))
  fireEvent.click(await screen.findByText('proposal'))
  fireEvent.change(details(), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await expect.poll(() => screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('img', { name: 'Has Task Details' })).toBeNull()
  const completed = (await core.completedTasks())[0]
  expect(completed.details).toBeNull()
  expect(completed.createdAt).toBe(created[0].createdAt)
})

it('retains both edited fields after a failed save for correction and retry', async () => {
  const { core } = await showTasks(['proposal'])
  fireEvent.click(await screen.findByText('proposal'))
  const save = core.editTask
  core.editTask = async () => { throw new Error('disk unavailable') }
  fireEvent.change(screen.getByLabelText('Task Description'), { target: { value: 'edited' } })
  fireEvent.change(screen.getByLabelText('Task Details (optional)'), { target: { value: 'retained\ncontext' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText('That Task could not be saved.')
  expect(screen.getByRole('dialog', { name: 'Edit Task' })).toBeTruthy()
  expect((screen.getByLabelText('Task Details (optional)') as HTMLTextAreaElement).value).toBe('retained\ncontext')
  expect((await core.openTasks())[0].details).toBeNull()
  core.editTask = save
  fireEvent.change(screen.getByLabelText('Task Description'), { target: { value: 'corrected' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await expect.poll(() => screen.queryByRole('dialog')).toBeNull()
  expect((await core.openTasks())[0]).toMatchObject({ description: 'corrected', details: 'retained\ncontext' })
})

it.each([false, true])('locks editor fields during a pending save (failure: %s)', async (fails) => {
  const user = userEvent.setup()
  const { core } = await showTasks(['proposal'])
  fireEvent.click(await screen.findByText('proposal'))
  const description = screen.getByLabelText('Task Description') as HTMLInputElement
  const details = screen.getByLabelText('Task Details (optional)') as HTMLTextAreaElement
  await user.clear(description)
  await user.type(description, 'submitted proposal')
  await user.type(details, 'submitted context')
  const editTask = core.editTask
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  core.editTask = async (...args) => {
    await pending
    if (fails) throw new Error('disk unavailable')
    return editTask(...args)
  }
  await user.click(screen.getByRole('button', { name: 'Save' }))
  expect(description.disabled).toBe(true)
  expect(details.disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'Add a date' }) as HTMLButtonElement).disabled).toBe(true)
  await user.type(description, ' discarded text')
  await user.type(details, ' discarded context')
  expect(description.value).toBe('submitted proposal')
  expect(details.value).toBe('submitted context')
  await act(async () => release())
  if (fails) {
    await screen.findByText('That Task could not be saved.')
    expect(description.disabled).toBe(false)
    expect(details.disabled).toBe(false)
    expect((screen.getByRole('button', { name: 'Add a date' }) as HTMLButtonElement).disabled).toBe(false)
    await user.type(details, ' corrected')
    expect(details.value).toBe('submitted context corrected')
    expect((await core.openTasks())[0].details).toBeNull()
  } else {
    await expect.poll(() => screen.queryByRole('dialog')).toBeNull()
    expect((await core.openTasks())[0]).toMatchObject({ description: 'submitted proposal', details: 'submitted context' })
  }
})
