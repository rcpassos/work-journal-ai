// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { fakeDesktop } from '@/platform/testing/desktop'
import { createJournal, type Journal, type Task } from '@/journal/journal'
import { fixedClock, occurrencesOf, openTestDatabase } from '@/journal/testing/database'
import TasksView from './TasksView'
import TaskCreationView from './TaskCreationView'

// Tasks View as the user meets it: the two lists, the checkbox that completes
// without asking, the Editor that discards on Cancel, and the confirmation on
// the one thing that cannot be undone.

afterEach(cleanup)
afterEach(() => {
  vi.unstubAllGlobals()
  Reflect.deleteProperty(document, 'getAnimations')
  Reflect.deleteProperty(document, 'elementFromPoint')
  Reflect.deleteProperty(Element.prototype, 'getAnimations')
  Reflect.deleteProperty(Element.prototype, 'setPointerCapture')
  Reflect.deleteProperty(Element.prototype, 'releasePointerCapture')
})

const openDatabases: Array<() => void> = []

afterEach(() => {
  for (const close of openDatabases.splice(0)) close()
})

/** Tasks View over a real journal, already showing its first list. */
async function showTasks(
  descriptions: string[] = [],
  {
    /** The Alert that opened the window, by position in `descriptions`. */
    pendingAlertFor = null as number | null,
    /** Tasks selected for Daily Tasks before the view opens, by position. */
    selected = [] as number[],
    /** Wraps the journal the view asks, to hold a read open. */
    journal = (core: Journal) => core,
  } = {},
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
  for (const index of selected) await core.addDailyTask(created[index].id)

  const desktop = fakeDesktop({ driver })
  desktop.pendingTaskAlert =
    pendingAlertFor === null ? null : `task:${created[pendingAlertFor].id}`
  render(
    <TasksView
      desktop={desktop}
      journal={Promise.resolve(journal(core))}
      clock={clock}
    />,
  )

  return { desktop, core, clock, created, driver }
}

/** Existing broader-list scenarios explicitly navigate away from Daily Tasks. */
async function showOpenTasks(...args: Parameters<typeof showTasks>) {
  const result = await showTasks(...args)
  fireEvent.click(tab('Open'))
  await expect.poll(() => screen.getByRole('button', { name: 'Open' }).getAttribute('aria-pressed')).toBe('true')
  return result
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

function tab(name: 'Daily Tasks' | 'Open' | 'Completed'): HTMLElement {
  return screen.getByRole('button', { name })
}

/** What the reader is looking for, anywhere in the journal. */
function searchBox(): HTMLInputElement {
  return screen.getByPlaceholderText('Search') as HTMLInputElement
}

/** Whether the row for a Task is the one singled out. */
function singledOut(description: string): string | null {
  return (
    screen
      .queryByText(description)
      ?.closest('li')
      ?.getAttribute('aria-current') ?? null
  )
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

describe('Daily Tasks', () => {
  it('keeps automatic due work after saved priorities and can give it a persistent priority', async () => {
    const { core, desktop, created } = await showTasks(['priority'], { selected: [0] })
    const due = await core.createTask('due automatically', { date: '2026-03-09', time: null })
    await desktop.announceTasksChanged()
    await expect.poll(rows).toEqual(['priority', 'due automatically'])
    expect(screen.queryByRole('button', { name: 'Reorder “due automatically”' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove “due automatically” from priorities' })).toBeNull()
    const user = userEvent.setup()
    await user.click(screen.getByText('Add existing'))
    await user.click(await screen.findByRole('option', { name: 'due automatically' }))
    await expect.poll(() => screen.queryByRole('button', { name: 'Reorder “due automatically”' })).not.toBeNull()
    expect(rows()).toEqual(['priority', 'due automatically'])
    expect(await core.dailyTasks()).toEqual([created[0], due])

    await user.click(screen.getByRole('button', { name: 'Move “due automatically” to top' }))
    await expect.poll(rows).toEqual(['due automatically', 'priority'])
    await user.click(screen.getByRole('button', { name: 'Remove “due automatically” from priorities' }))
    await expect.poll(rows).toEqual(['priority', 'due automatically'])
    expect(await core.dailyTasks()).toEqual([created[0]])
    await user.click(screen.getByRole('checkbox', { name: 'Complete “due automatically”' }))
    await expect.poll(rows).toEqual(['priority'])
  })

  it('cancels a pointer drag on Escape without closing the window when the inline input retains focus', async () => {
    // jsdom has no layout observers. This scenario checks event ownership,
    // not drag geometry; actual layout remains a desktop verification.
    class LayoutObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', LayoutObserver)
    vi.stubGlobal('ResizeObserver', LayoutObserver)
    vi.stubGlobal('matchMedia', (media: string) => ({
      media, matches: media === '(prefers-reduced-motion: reduce)',
      addEventListener() {}, removeEventListener() {},
    }))
    Object.defineProperty(document, 'getAnimations', { configurable: true, value: () => [] })
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null })
    Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] })
    Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value() {} })
    Object.defineProperty(Element.prototype, 'releasePointerCapture', { configurable: true, value() {} })
    const { core, created, desktop } = await showTasks(['first', 'second'])
    for (const task of created) await core.addDailyTask(task.id)
    await desktop.announceTasksChanged()
    await expect.poll(rows).toEqual(['first', 'second'])
    let closed = false
    desktop.closeWindow = async () => { closed = true }
    const user = userEvent.setup()
    const input = screen.getByRole('textbox', { name: 'New Task Description' })
    await user.type(input, 'unfinished')
    const handle = screen.getByRole('button', { name: 'Reorder “first”' })
    await user.pointer({ target: handle, keys: '[MouseLeft>]' })
    expect(document.activeElement).toBe(input)
    await user.keyboard('{Escape}')
    expect(closed).toBe(false)
    expect(rows()).toEqual(['first', 'second'])
    expect(await core.dailyTasks()).toEqual(created)
    expect((input as HTMLInputElement).value).toBe('unfinished')
    await user.keyboard('{Escape}')
    expect(closed).toBe(true)
    await user.pointer({ target: document.body, keys: '[/MouseLeft]' })
  })

  it('reorders with the keyboard while retaining focus, respects boundaries, and keeps additions at the bottom', async () => {
    const { core, created, desktop } = await showTasks(['first', 'second', 'third'])
    for (const task of created) await core.addDailyTask(task.id)
    await desktop.announceTasksChanged()
    await expect.poll(rows).toEqual(['first', 'second', 'third'])
    const user = userEvent.setup()
    const handle = screen.getByRole('button', { name: 'Reorder “second”' })
    handle.focus()
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    await expect.poll(rows).toEqual(['second', 'first', 'third'])
    expect(document.activeElement).toBe(handle)
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}')
    expect(await core.dailyTasks()).toEqual([created[1], created[0], created[2]])
    await user.keyboard('{Alt>}{ArrowDown}{/Alt}')
    await expect.poll(rows).toEqual(['first', 'second', 'third'])
    expect(document.activeElement).toBe(handle)
    await user.click(screen.getByRole('button', { name: 'Move “second” to bottom' }))
    await expect.poll(rows).toEqual(['first', 'third', 'second'])
    // A boundary action keeps a reachable focused control and does no write.
    const bottom = screen.getByRole('button', { name: 'Move “second” to bottom' })
    expect(document.activeElement).toBe(bottom)
    await user.keyboard('{Enter}')
    expect(await core.dailyTasks()).toEqual([created[0], created[2], created[1]])
    await user.type(screen.getByRole('textbox', { name: 'New Task Description' }), 'addition{Enter}')
    await expect.poll(rows).toEqual(['first', 'third', 'second', 'addition'])
    await user.click(screen.getByRole('button', { name: 'Remove “third” from priorities' }))
    await expect.poll(rows).toEqual(['first', 'second', 'addition'])
  })

  it('shows the saved order on a failed reorder and can retry without a false change announcement', async () => {
    const { core, created, desktop, driver } = await showTasks(['first', 'second', 'third'])
    for (const task of created) await core.addDailyTask(task.id)
    await desktop.announceTasksChanged()
    await expect.poll(rows).toEqual(['first', 'second', 'third'])
    const announced: Task[][] = []
    await desktop.onTasksChanged(() => { void core.dailyTasks().then(tasks => announced.push(tasks)) })
    const transaction = driver.transaction
    driver.transaction = statements => transaction([
      ...statements, { sql: 'SELECT * FROM unavailable_storage', params: [] },
    ])
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Move “third” to top' }))
    await screen.findByRole('alert')
    expect(rows()).toEqual(['first', 'second', 'third'])
    expect(await core.dailyTasks()).toEqual(created)
    expect(announced).toEqual([])
    driver.transaction = transaction
    await user.click(screen.getByRole('button', { name: 'Move “third” to top' }))
    await expect.poll(rows).toEqual(['third', 'first', 'second'])
    expect(screen.queryByRole('alert')).toBeNull()
    await expect.poll(() => announced).toEqual([[created[2], created[0], created[1]]])
  })

  it('keeps saved priorities visible while saving and ignores overlapping ordering requests', async () => {
    const { core, created, desktop, driver } = await showTasks(['first', 'second', 'third'])
    for (const task of created) await core.addDailyTask(task.id)
    await desktop.announceTasksChanged()
    await expect.poll(rows).toEqual(['first', 'second', 'third'])
    const transaction = driver.transaction
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    driver.transaction = async statements => { await held; return transaction(statements) }
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Move “third” to top' }))
    await screen.findByText('Saving Daily Tasks order.')
    expect(rows()).toEqual(['first', 'second', 'third'])
    expect(await core.dailyTasks()).toEqual(created)
    await user.click(screen.getByRole('button', { name: 'Move “first” to bottom' }))
    await act(async () => { release() })
    await expect.poll(rows).toEqual(['third', 'first', 'second'])
    expect(await core.dailyTasks()).toEqual([created[2], created[0], created[1]])
  })

  it('refreshes priorities from another surface and refuses an ordering overtaken by completion', async () => {
    const { core, created, desktop, driver } = await showTasks(['first', 'second', 'third'])
    for (const task of created) await core.addDailyTask(task.id)
    await desktop.announceTasksChanged()
    await expect.poll(rows).toEqual(['first', 'second', 'third'])
    await core.reorderDailyTasks([created[2].id, created[0].id, created[1].id], created.map(task => task.id))
    await desktop.announceTasksChanged()
    await expect.poll(rows).toEqual(['third', 'first', 'second'])
    const transaction = driver.transaction
    driver.transaction = async statements => {
      driver.transaction = transaction
      await core.completeTask(created[0].id)
      return transaction(statements)
    }
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Move “second” to top' }))
    await screen.findByRole('alert')
    await expect.poll(rows).toEqual(['third', 'second'])
    expect((await core.dailyTasks()).map(task => task.id)).toEqual([created[2].id, created[1].id])
    expect(await core.completedTasks()).toEqual([expect.objectContaining({ id: created[0].id })])
  })

  it('moves priorities to either end, retains task data and the broader sort, and reopens in the saved order', async () => {
    const { core, created, desktop, clock, driver } = await showTasks(['first', 'second', 'third'])
    for (const task of created) await core.addDailyTask(task.id)
    await desktop.announceTasksChanged()
    await expect.poll(rows).toEqual(['first', 'second', 'third'])
    const broader = await core.openTasks()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Move “third” to top' }))
    await expect.poll(rows).toEqual(['third', 'first', 'second'])
    await user.click(screen.getByRole('button', { name: 'Move “first” to bottom' }))
    await expect.poll(rows).toEqual(['third', 'second', 'first'])
    expect(await core.dailyTasks()).toEqual([created[2], created[1], created[0]])
    expect(await core.openTasks()).toEqual(broader)
    cleanup()
    render(<TasksView desktop={desktop} journal={Promise.resolve(createJournal({ driver, clock }))} clock={clock} />)
    await expect.poll(rows).toEqual(['third', 'second', 'first'])
  })

  it('offers inline creation above the rows, appends consecutive tasks, and persists their identities', async () => {
    const { core, created, desktop, driver, clock } = await showTasks(['priority'])
    await core.addDailyTask(created[0].id)
    await desktop.announceTasksChanged()
    await expect.poll(rows).toEqual(['priority'])
    const user = userEvent.setup()
    const input = screen.getByRole('textbox', { name: 'New Task Description' }) as HTMLInputElement
    expect(input.compareDocumentPosition(screen.getByText('priority')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await user.type(input, 'first addition{Enter}')
    await expect.poll(rows).toEqual(['priority', 'first addition'])
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
    await user.type(input, 'tomorrow at noon{Enter}')
    await expect.poll(rows).toEqual(['priority', 'first addition', 'tomorrow at noon'])
    expect(input.value).toBe('')
    expect(document.activeElement).toBe(input)
    const selected = await core.dailyTasks()
    expect(selected.slice(1).map(task => [task.scheduledDate, task.scheduledTime, task.recurrence])).toEqual([
      [null, null, null], [null, null, null],
    ])
    expect(await core.openTasks()).toEqual(expect.arrayContaining(selected))
    expect(await core.openTasks()).toHaveLength(3)
    cleanup()
    const restarted = createJournal({ driver, clock })
    render(<TasksView desktop={desktop} journal={Promise.resolve(restarted)} clock={clock} />)
    await expect.poll(rows).toEqual(['priority', 'first addition', 'tomorrow at noon'])
    expect(await restarted.dailyTasks()).toEqual(selected)
  })

  it('rejects blank inline descriptions and preserves Unicode and internal whitespace without parsing schedule words', async () => {
    const { core } = await showTasks()
    const user = userEvent.setup()
    const input = await screen.findByRole('textbox', { name: 'New Task Description' }) as HTMLInputElement
    await user.type(input, '   {Enter}')
    expect(await core.openTasks()).toEqual([])
    expect(await core.dailyTasks()).toEqual([])
    expect(input.value).toBe('   ')
    await user.clear(input)
    fireEvent.change(input, { target: { value: '\u00a0  amanhã  明日\t👩🏽‍💻 tomorrow at noon  \u00a0' } })
    await user.keyboard('{Enter}')
    await expect.poll(rows).toEqual(['amanhã  明日\t👩🏽‍💻 tomorrow at noon'])
    expect(await core.dailyTasks()).toEqual([expect.objectContaining({
      description: 'amanhã  明日\t👩🏽‍💻 tomorrow at noon', scheduledDate: null, scheduledTime: null,
    })])
    expect(input.value).toBe('')
  })

  it('rolls back failed inline creation, retains the description, and announces only a successful retry', async () => {
    const { core, driver, desktop, created } = await showTasks(['priority'])
    await core.addDailyTask(created[0].id)
    await desktop.announceTasksChanged()
    await expect.poll(rows).toEqual(['priority'])
    const announced: Task[][] = []
    await desktop.onTasksChanged(() => { void core.dailyTasks().then(tasks => announced.push(tasks)) })
    const transaction = driver.transaction
    // Fail inside SQLite after the requested writes, exercising real rollback.
    driver.transaction = statements => transaction([
      ...statements, { sql: 'SELECT * FROM unavailable_storage', params: [] },
    ])
    const user = userEvent.setup()
    const input = screen.getByRole('textbox', { name: 'New Task Description' }) as HTMLInputElement
    await user.type(input, '  retry me  {Enter}')
    await screen.findByText('That Task could not be stored. Press Enter to retry.')
    expect(input.value).toBe('  retry me  ')
    expect(document.activeElement).toBe(input)
    expect(await core.openTasks()).toEqual(created)
    expect(await core.dailyTasks()).toEqual(created)
    expect(announced).toEqual([])
    driver.transaction = transaction
    await user.keyboard('{Enter}')
    await expect.poll(rows).toEqual(['priority', 'retry me'])
    expect(await core.openTasks()).toHaveLength(2)
    await expect.poll(() => announced.map(tasks => tasks.map(task => task.description))).toEqual([['priority', 'retry me']])
    expect(screen.queryByRole('alert')).toBeNull()
    expect(input.value).toBe('')
  })

  it('prevents repeated submissions and edits while inline storage is pending', async () => {
    const { core, driver } = await showTasks()
    const transaction = driver.transaction
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    driver.transaction = async statements => { await pending; await transaction(statements) }
    const user = userEvent.setup()
    const input = screen.getByRole('textbox', { name: 'New Task Description' }) as HTMLInputElement
    await user.type(input, 'one commitment{Enter}')
    expect(input.readOnly).toBe(true)
    await user.keyboard('{Enter}{Enter}discarded')
    fireEvent.submit(screen.getByRole('form', { name: 'Create a Daily Task' }))
    expect(input.value).toBe('one commitment')
    expect(await core.openTasks()).toEqual([])
    await act(async () => release())
    await expect.poll(rows).toEqual(['one commitment'])
    expect(await core.openTasks()).toHaveLength(1)
    expect(await core.dailyTasks()).toHaveLength(1)
    expect(input.readOnly).toBe(false)
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('')
  })

  it('keeps unfinished inline and resident descriptions independent', async () => {
    const { core, desktop } = await showTasks()
    const user = userEvent.setup()
    const inline = screen.getByRole('textbox', { name: 'New Task Description' }) as HTMLInputElement
    await user.type(inline, 'unfinished inline')
    const resident = render(<TaskCreationView desktop={desktop} journal={Promise.resolve(core)} />)
    const residentInput = within(resident.container).getByRole('textbox', { name: 'What do you need to do?' }) as HTMLInputElement
    await user.type(residentInput, 'unfinished resident')
    await user.click(inline)
    await user.keyboard('{Enter}')
    await expect.poll(rows).toEqual(['unfinished inline'])
    expect(residentInput.value).toBe('unfinished resident')
    await user.type(inline, 'next inline draft')
    await user.click(residentInput)
    await user.keyboard('{Enter}')
    await expect.poll(async () => (await core.openTasks()).length).toBe(2)
    expect(inline.value).toBe('next inline draft')
    expect(residentInput.value).toBe('')
    expect((await core.dailyTasks()).map(task => task.description)).toEqual(['unfinished inline'])
  })

  it('edits details, scheduling and recurrence after inline creation while keeping its identity and position', async () => {
    const { core } = await showTasks()
    const user = userEvent.setup()
    const input = screen.getByRole('textbox', { name: 'New Task Description' })
    await user.type(input, 'quick commitment{Enter}')
    await expect.poll(rows).toEqual(['quick commitment'])
    const [created] = await core.dailyTasks()
    await user.type(input, 'second commitment{Enter}')
    await expect.poll(rows).toEqual(['quick commitment', 'second commitment'])
    await user.click(screen.getByText('quick commitment'))
    const editor = await screen.findByRole('dialog', { name: 'Edit Task' })
    await user.type(within(editor).getByLabelText('Task Details (optional)'), 'supporting context')
    await user.click(screen.getByRole('button', { name: 'Add a date' }))
    fireEvent.change(screen.getByLabelText('Scheduled For'), { target: { value: '2026-04-01' } })
    setTime('12:00')
    fireEvent.change(screen.getByLabelText('Repeats'), { target: { value: 'day' } })
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await expect.poll(() => screen.queryByRole('dialog')).toBeNull()
    await expect.poll(rows).toEqual(['quick commitment', 'second commitment'])
    expect((await core.dailyTasks())[0]).toMatchObject({
      id: created.id, details: 'supporting context', scheduledDate: '2026-04-01', scheduledTime: '12:00',
      recurrence: { unit: 'day', interval: 1, weekdays: [] },
    })
  })

  it('searches eligible work and appends each choice once without leaving Daily Tasks', async () => {
    const { core, created, desktop } = await showTasks(['first', 'second', 'finished'])
    await core.completeTask(created[2].id)
    await desktop.announceTasksChanged()
    await screen.findByRole('heading', { name: 'No Daily Tasks yet' })
    const user = userEvent.setup()
    await user.click(screen.getByText('Add existing'))
    const search = await screen.findByPlaceholderText('Search Open Tasks')
    await user.type(search, 'second')
    expect(screen.queryByRole('option', { name: 'first' })).toBeNull()
    expect(screen.queryByRole('option', { name: 'finished' })).toBeNull()
    await user.click(await screen.findByRole('option', { name: 'second' }))
    await expect.poll(rows).toEqual(['second'])
    await user.click(screen.getByText('Add existing'))
    expect(screen.queryByRole('option', { name: 'second' })).toBeNull()
    await user.click(await screen.findByRole('option', { name: 'first' }))
    await expect.poll(rows).toEqual(['second', 'first'])
    expect((await core.dailyTasks()).map(task => task.id)).toEqual([created[1].id, created[0].id])
  })

  it('removes selection without deleting or rescheduling the task, then appends a reselection', async () => {
    const { core, created, desktop } = await showTasks(['first', 'second'])
    const scheduled = await core.editTask(created[0].id, {
      description: 'first', schedule: { date: '2026-04-01', time: '12:00' },
    })
    await core.addDailyTask(created[0].id)
    await core.addDailyTask(created[1].id)
    await desktop.announceTasksChanged()
    await expect.poll(rows).toEqual(['first', 'second'])
    fireEvent.click(screen.getByRole('button', { name: 'Remove “first” from priorities' }))
    await expect.poll(rows).toEqual(['second'])
    expect(await core.openTasks()).toContainEqual(scheduled)
    expect(screen.queryByRole('alertdialog')).toBeNull()
    await core.addDailyTask(created[0].id)
    await desktop.announceTasksChanged()
    await expect.poll(rows).toEqual(['second', 'first'])
  })

  it('completes selected work and keeps later reopening outside Daily Tasks', async () => {
    const { core, created, desktop } = await showTasks(['first', 'second', 'third'])
    for (const task of created) await core.addDailyTask(task.id)
    await desktop.announceTasksChanged()
    await expect.poll(rows).toEqual(['first', 'second', 'third'])
    fireEvent.click(screen.getByRole('checkbox', { name: 'Complete “second”' }))
    await expect.poll(rows).toEqual(['first', 'third'])
    expect(screen.queryByRole('alertdialog')).toBeNull()
    fireEvent.click(tab('Completed'))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Reopen “second”' }))
    await expect.poll(rows).toEqual([])
    fireEvent.click(tab('Daily Tasks'))
    await expect.poll(rows).toEqual(['first', 'third'])
    expect((await core.dailyTasks()).map(task => task.description)).toEqual(['first', 'third'])
    expect((await core.openTasks()).map(task => task.description)).toContain('second')
  })

  it('restores a completed Task to its previous position through immediate Undo, while a later reopening stays outside', async () => {
    const { core, created, desktop } = await showTasks(['first', 'second', 'third'])
    for (const task of created) await core.addDailyTask(task.id)
    await desktop.announceTasksChanged()
    await expect.poll(rows).toEqual(['first', 'second', 'third'])

    fireEvent.click(screen.getByRole('checkbox', { name: 'Complete “second”' }))
    await expect.poll(rows).toEqual(['first', 'third'])
    expect((await core.dailyTasks()).map(task => task.id)).toEqual([created[0].id, created[2].id])

    fireEvent.click(await screen.findByRole('button', { name: 'Undo completing “second”' }))
    await expect.poll(rows).toEqual(['first', 'second', 'third'])
    expect(await core.dailyTasks()).toEqual(created)
    expect(await core.completedTasks()).toEqual([])
    expect(screen.queryByRole('button', { name: 'Undo completing “second”' })).toBeNull()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Complete “second”' }))
    await expect.poll(rows).toEqual(['first', 'third'])
    fireEvent.click(tab('Completed'))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Reopen “second”' }))
    await expect.poll(rows).toEqual([])
    fireEvent.click(tab('Daily Tasks'))
    await expect.poll(rows).toEqual(['first', 'third'])
    expect((await core.dailyTasks()).map(task => task.description)).toEqual(['first', 'third'])
    expect((await core.openTasks()).map(task => task.description)).toContain('second')
  })

  it('reports an immediate Undo the record refuses instead of restoring the Task', async () => {
    const { core, created, desktop } = await showTasks(['first', 'second', 'third'])
    for (const task of created) await core.addDailyTask(task.id)
    await desktop.announceTasksChanged()
    await expect.poll(rows).toEqual(['first', 'second', 'third'])

    fireEvent.click(screen.getByRole('checkbox', { name: 'Complete “second”' }))
    await expect.poll(rows).toEqual(['first', 'third'])

    await core.reopenTask(created[1].id)
    await desktop.announceTasksChanged()
    fireEvent.click(await screen.findByRole('button', { name: 'Undo completing “second”' }))

    await screen.findByText(/That completion could not be undone/)
    expect((await core.dailyTasks()).map(task => task.id)).toEqual([created[0].id, created[2].id])
    expect((await core.openTasks()).map(task => task.description)).toContain('second')
    expect(screen.queryByRole('button', { name: 'Undo completing “second”' })).toBeNull()
  })

  it('keeps selection and its order through editing, clock changes and reopening the view', async () => {
    const { core, created, desktop, clock, driver } = await showTasks(['first', 'second', 'backlog'])
    await core.addDailyTask(created[0].id)
    await core.addDailyTask(created[1].id)
    await desktop.announceTasksChanged()
    await expect.poll(rows).toEqual(['first', 'second'])
    fireEvent.click(screen.getByText('first'))
    await screen.findByRole('dialog', { name: 'Edit Task' })
    fireEvent.change(screen.getByLabelText('Task Description'), { target: { value: 'edited first' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await expect.poll(rows).toEqual(['edited first', 'second'])
    await core.editTask(created[0].id, {
      description: 'edited first', details: 'keep this context',
      schedule: { date: '2026-04-01', time: '12:00' },
    })
    await core.editTask(created[2].id, {
      description: 'backlog', schedule: { date: '2026-03-10', time: null },
    })
    await desktop.announceTasksChanged()
    await screen.findByText(/Apr 1, 2026/)
    clock.set(new Date('2026-03-11T09:00:00'))
    act(() => { desktop.wake(); desktop.focus() })
    await expect.poll(rows).toEqual(['edited first', 'second', 'backlog'])
    cleanup()
    const reconstructed = createJournal({ driver, clock })
    render(<TasksView desktop={desktop} journal={Promise.resolve(reconstructed)} clock={clock} />)
    await expect.poll(rows).toEqual(['edited first', 'second', 'backlog'])
    expect((await reconstructed.dailyTasks())[0].details).toBe('keep this context')
  })

  it('removes recurring work completed through the checkbox and restores it to its previous position', async () => {
    const { core, desktop, clock } = await showTasks()
    const task = await core.createTask('daily report', { date: '2026-03-09', time: '12:00' }, {
      unit: 'day', interval: 1, weekdays: [],
    })
    await core.addDailyTask(task.id)
    await desktop.announceTasksChanged()
    await screen.findByText('daily report')

    fireEvent.click(screen.getByRole('checkbox', { name: 'Complete “daily report”' }))
    await expect.poll(rows).toEqual([])
    expect((await occurrencesOf(core, task.id)).filter(occurrence => occurrence.completedAt !== null)).toHaveLength(1)
    clock.set(new Date('2026-03-10T13:00:00'))
    act(() => { desktop.wake(); desktop.focus() })
    expect(await core.dailyTasks()).toEqual([])

    fireEvent.click(await screen.findByRole('button', { name: 'Undo completing “daily report”' }))

    await expect.poll(rows).toEqual(['daily report'])
    await expect.poll(async () => (await core.openTasks()).find(open => open.id === task.id)?.scheduledDate).toBe('2026-03-09')
    expect((await core.dailyTasks()).map(open => open.id)).toEqual([task.id])
    expect((await occurrencesOf(core, task.id)).filter(occurrence => occurrence.completedAt === null)).toHaveLength(1)
  })

  it('refuses a stale immediate Undo after a later completion of the successor', async () => {
    const { core, desktop, clock } = await showTasks()
    const task = await core.createTask('daily report', { date: '2026-03-09', time: '12:00' }, {
      unit: 'day', interval: 1, weekdays: [],
    })
    await core.addDailyTask(task.id)
    await desktop.announceTasksChanged()
    await screen.findByText('daily report')

    fireEvent.click(screen.getByRole('checkbox', { name: 'Complete “daily report”' }))
    await expect.poll(rows).toEqual([])
    clock.set(new Date('2026-03-10T09:00:00'))
    fireEvent.click(tab('Open'))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Complete “daily report”' }))
    await desktop.announceTasksChanged()
    fireEvent.click(tab('Daily Tasks'))
    fireEvent.click(await screen.findByRole('button', { name: 'Undo completing “daily report”' }))

    await screen.findByText(/That completion could not be undone/)
    expect((await occurrencesOf(core, task.id)).filter(occurrence => occurrence.completedAt !== null)).toHaveLength(2)
    expect((await occurrencesOf(core, task.id)).filter(occurrence => occurrence.completedAt === null)).toHaveLength(1)
    expect(await core.dailyTasks()).toEqual([])
  })

  it('removes recurring work completed through a Task Alert and safe Undo restores it to its previous position', async () => {
    const { core, desktop, clock } = await showTasks()
    const task = await core.createTask('daily report', { date: '2026-03-09', time: '12:00' }, {
      unit: 'day', interval: 1, weekdays: [],
    })
    await core.addDailyTask(task.id)
    await desktop.announceTasksChanged()
    await screen.findByText('daily report')

    await core.completeTaskAt(task.id, { date: '2026-03-09', time: '12:00' })
    await desktop.announceTasksChanged()
    await expect.poll(rows).toEqual([])
    expect((await occurrencesOf(core, task.id)).filter(occurrence => occurrence.completedAt !== null)).toHaveLength(1)
    clock.set(new Date('2026-03-10T13:00:00'))
    act(() => { desktop.wake(); desktop.focus() })
    expect(await core.dailyTasks()).toEqual([])
    // The Alert completed it, not this list, so the immediate Undo is not offered here.
    expect(screen.queryByRole('button', { name: 'Undo completing “daily report”' })).toBeNull()

    fireEvent.click(tab('Open'))
    fireEvent.click(await screen.findByRole('button', { name: 'Undo the last completion of “daily report”' }))

    await expect.poll(async () => (await core.openTasks()).find(open => open.id === task.id)?.scheduledDate).toBe('2026-03-09')
    expect((await core.dailyTasks()).map(open => open.id)).toEqual([task.id])
    expect((await occurrencesOf(core, task.id)).filter(occurrence => occurrence.completedAt === null)).toHaveLength(1)
  })

  it('confirms deletion of selected work and refreshes membership changes from other surfaces', async () => {
    const { core, created, desktop } = await showTasks(['first', 'second'])
    await core.addDailyTask(created[0].id)
    await desktop.announceTasksChanged()
    await screen.findByText('first')
    await core.removeDailyTask(created[0].id)
    await core.addDailyTask(created[1].id)
    await desktop.announceTasksChanged()
    await expect.poll(rows).toEqual(['second'])
    fireEvent.click(screen.getByRole('button', { name: 'Delete “second”' }))
    await screen.findByRole('alertdialog')
    expect(await core.dailyTasks()).toEqual([created[1]])
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await expect.poll(rows).toEqual([])
    expect(await core.dailyTasks()).toEqual([])
    expect(await core.openTasks()).toEqual([created[0]])
  })

  it('keeps a failed picker choice available to retry and Escape dismisses only the picker', async () => {
    const { core, desktop, driver } = await showTasks(['first'])
    await screen.findByRole('heading', { name: 'No Daily Tasks yet' })
    const transaction = driver.transaction
    driver.transaction = async () => { throw new Error('storage unavailable') }
    const user = userEvent.setup()
    await user.click(screen.getByText('Add existing'))
    const input = await screen.findByPlaceholderText('Search Open Tasks')
    await user.type(input, 'first')
    await user.click(await screen.findByRole('option', { name: 'first' }))
    await screen.findByRole('alert')
    expect(await core.dailyTasks()).toEqual([])
    expect((input as HTMLInputElement).value).toBe('first')
    driver.transaction = transaction
    await user.click(await screen.findByRole('option', { name: 'first' }))
    await expect.poll(rows).toEqual(['first'])
    await expect.poll(() => screen.queryByPlaceholderText('Search Open Tasks')).toBeNull()
    let closed = false
    desktop.closeWindow = async () => { closed = true }
    await user.click(screen.getByText('Add existing'))
    const reopenedInput = await screen.findByPlaceholderText('Search Open Tasks')
    await expect.poll(() => document.activeElement).toBe(reopenedInput)
    await user.keyboard('{Escape}')
    expect(closed).toBe(false)
    await expect.poll(() => screen.queryByPlaceholderText('Search Open Tasks')).toBeNull()
  })

  it('starts empty with an existing backlog and keeps the broader list available', async () => {
    await showTasks(['first', 'second'])
    const empty = await screen.findByRole('heading', { name: 'No Daily Tasks yet' })
    const input = screen.getByRole('textbox', { name: 'New Task Description' })
    expect(input.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(rows()).toEqual([])
    fireEvent.click(tab('Open'))
    await screen.findByText('second')
    expect(rows()).toEqual(['second', 'first'])
  })
})

describe('opening Tasks View', () => {
  it('shows Open Tasks newest first when chosen', async () => {
    await showOpenTasks(['first', 'second', 'third'])

    await screen.findByText('third')
    expect(rows()).toEqual(['third', 'second', 'first'])
  })

  it('teaches the Task Hotkey when there is nothing owed yet', async () => {
    await showOpenTasks()

    const empty = await screen.findByRole('heading', { name: 'No Open Tasks' })
    const section = empty.closest('section')!
    expect(
      [...section.querySelectorAll('kbd[data-slot="kbd"]')].map(
        (key) => key.textContent,
      ),
    ).toEqual(['Ctrl', 'Shift', 'Cmd', 'T'])
  })

  it('says the Completed list is empty in its own words', async () => {
    await showOpenTasks()
    await screen.findByRole('heading', { name: 'No Open Tasks' })

    fireEvent.click(tab('Completed'))

    await screen.findByRole('heading', { name: 'No Completed Tasks yet' })
  })
})

describe('completing and reopening', () => {
  it('completes from the checkbox with no confirmation at all', async () => {
    const { core } = await showOpenTasks(['renew the certificate'])
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
    const { core } = await showOpenTasks(['renew the certificate'])
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
    const { core } = await showOpenTasks(['renew the cert'])
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
    const { core } = await showOpenTasks(['renew the cert'])
    fireEvent.click(await screen.findByText('renew the cert'))

    const input = screen.getByLabelText('Task Description') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'something else entirely' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(rows()).toEqual(['renew the cert'])
    expect((await core.openTasks())[0].description).toBe('renew the cert')
  })

  it('discards on Escape, and does not close the window with it', async () => {
    const { desktop, core } = await showOpenTasks(['renew the cert'])
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
    const { desktop } = await showOpenTasks(['renew the cert'])
    fireEvent.click(await screen.findByText('renew the cert'))

    await screen.findByRole('dialog', { name: 'Edit Task' })
    expect(desktop.taskCreationsBegun).toBe(0)
  })
})

describe('deleting a Task', () => {
  it('always asks first, and removes it once confirmed', async () => {
    const { core } = await showOpenTasks(['renew the cert'])
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
    const { desktop } = await showOpenTasks()
    await screen.findByRole('heading', { name: 'No Open Tasks' })

    fireEvent.click(screen.getByRole('button', { name: 'New Task' }))

    expect(desktop.taskCreationsBegun).toBe(1)
  })
})

describe('a Task changed elsewhere', () => {
  it('shows up with no manual refresh', async () => {
    const { desktop, core, clock } = await showOpenTasks(['already here'])
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
    const { desktop } = await showOpenTasks(['renew the cert'])
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
    await showOpenTasks()
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
    const built = await showOpenTasks()
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
    await showOpenTasks(['someday'])

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
    const { core, created } = await showOpenTasks(['renew the cert'])
    await core.completeTask(created[0].id)
    fireEvent.click(tab('Completed'))

    await screen.findByText('renew the cert')
    expect(groupHeadings()).toEqual([])
  })

  it('shows the year in a scheduled Task row', async () => {
    const { core, desktop } = await showOpenTasks()
    await core.createTask('plan next year', {
      date: '2027-03-16',
      time: null,
    })
    await desktop.announceTasksChanged()

    const task = await screen.findByText('plan next year')
    expect(task.closest('li')?.textContent).toContain('2027')
  })

  it('puts schedule metadata below the larger Task description', async () => {
    const { core, desktop } = await showOpenTasks(['renew the cert'])
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
    await showOpenTasks(['renew the cert'])
    fireEvent.click(await screen.findByText('renew the cert'))

    // No date-shaped field either: WebKit fills an empty one with today's
    // date, which would read as a schedule nobody chose — see ScheduleFields.
    expect(screen.queryByLabelText('Time')).toBeNull()
    expect(screen.queryByLabelText('Scheduled For')).toBeNull()
    expect(screen.getByRole('button', { name: 'Add a date' })).toBeTruthy()
  })

  it('saves the date and the time chosen', async () => {
    const { core, created, desktop } = await showOpenTasks(['renew the cert'])
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
    const { core, created, desktop } = await showOpenTasks(['renew the cert'])
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
    const { core, created } = await showOpenTasks(['ship it'])
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
    const { core, created } = await showOpenTasks(['renew the cert'])
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
    const { core, created, desktop } = await showOpenTasks(['renew the cert'])
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
    const { core, created, desktop } = await showOpenTasks(['renew the cert'])
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
    const { desktop } = await showOpenTasks(['renew the cert'])
    await screen.findByText('renew the cert')

    await desktop.announceTaskAlertsReconciled(false)

    expect(
      await screen.findByText(/macOS is not holding the alerts/),
    ).not.toBeNull()
  })

  it('stops saying so once the OS takes them after all', async () => {
    const { desktop } = await showOpenTasks(['renew the cert'])
    await screen.findByText('renew the cert')
    await desktop.announceTaskAlertsReconciled(false)
    await screen.findByText(/macOS is not holding the alerts/)

    await desktop.announceTaskAlertsReconciled(true)

    await expect
      .poll(() => screen.queryByText(/macOS is not holding the alerts/))
      .toBeNull()
  })

  it('leaves every Task exactly where it was', async () => {
    const { desktop } = await showOpenTasks(['renew the cert'])
    await screen.findByText('renew the cert')

    await desktop.announceTaskAlertsReconciled(false)
    await screen.findByText(/macOS is not holding the alerts/)

    expect(screen.getByText('renew the cert')).not.toBeNull()
  })
})

describe('searching the Tasks', () => {
  it('searches both lists at once, each result labelled with the state it is in', async () => {
    const { core, created } = await showOpenTasks(['planned the migration'])
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
    const { core, created } = await showOpenTasks([
      'renew the cert',
      'chase the invoice',
    ])
    await core.completeTask(created[0].id)
    await screen.findByText('renew the cert')

    fireEvent.change(searchBox(), { target: { value: 'renew' } })
    fireEvent.click(
      await screen.findByRole('button', { name: /renew the cert/ }),
    )

    await expect.poll(() => singledOut('renew the cert')).toBe('true')
    await screen.findByRole('checkbox', {
      name: 'Reopen “renew the cert”',
    })
    // The term stays in the field, so asking again costs no retyping.
    expect(searchBox().value).toBe('renew')
  })

  it('answers an Open result without leaving the Open list', async () => {
    await showOpenTasks(['renew the cert', 'chase the invoice'])
    await screen.findByText('renew the cert')

    fireEvent.change(searchBox(), { target: { value: 'chase' } })
    fireEvent.click(
      await screen.findByRole('button', { name: /chase the invoice/ }),
    )

    await expect.poll(() => singledOut('chase the invoice')).toBe('true')
    await screen.findByRole('checkbox', {
      name: 'Complete “chase the invoice”',
    })
  })

  it('says so when no Task says the term', async () => {
    await showOpenTasks(['renew the cert'])
    await screen.findByText('renew the cert')

    fireEvent.change(searchBox(), { target: { value: 'migration' } })

    await screen.findByRole('heading', { name: 'No Tasks say “migration”.' })
  })

  it('leaves the Search on Escape and shows the list again, without closing the window', async () => {
    const { desktop } = await showOpenTasks(['renew the cert'])
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

  it('answers a selected result in Daily Tasks, with that Task singled out', async () => {
    const { core, created, desktop } = await showTasks(['renew the cert'])
    await core.addDailyTask(created[0].id)
    await desktop.announceTasksChanged()
    await expect.poll(rows).toEqual(['renew the cert'])

    fireEvent.change(searchBox(), { target: { value: 'renew' } })
    fireEvent.click(
      await screen.findByRole('button', { name: /renew the cert/ }),
    )

    await expect.poll(() => tab('Daily Tasks').getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => singledOut('renew the cert')).toBe('true')
    // Asking where a Task is never changes the working list.
    expect((await core.dailyTasks()).map((task) => task.id)).toEqual([
      created[0].id,
    ])
  })

  it('answers an unselected Open result in the broader Open list', async () => {
    const { core } = await showTasks(['renew the cert'])
    await screen.findByRole('heading', { name: 'No Daily Tasks yet' })

    fireEvent.change(searchBox(), { target: { value: 'renew' } })
    fireEvent.click(
      await screen.findByRole('button', { name: /renew the cert/ }),
    )

    await expect.poll(() => tab('Open').getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => singledOut('renew the cert')).toBe('true')
    expect(await core.dailyTasks()).toEqual([])
  })

  it('follows a Task that changed after its result was read', async () => {
    const { core, created } = await showTasks(['renew the cert'])

    fireEvent.change(searchBox(), { target: { value: 'renew' } })
    const result = await screen.findByRole('button', { name: /renew the cert/ })
    // The result was read while the Task was Open; it is chosen after it was kept.
    await core.completeTask(created[0].id)
    fireEvent.click(result)

    await expect.poll(() => tab('Completed').getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => singledOut('renew the cert')).toBe('true')
    expect(searchBox().value).toBe('renew')
  })

  it('follows a Task selected after its result was read', async () => {
    const { core, created } = await showTasks(['renew the cert'])

    fireEvent.change(searchBox(), { target: { value: 'renew' } })
    const result = await screen.findByRole('button', { name: /renew the cert/ })
    await core.addDailyTask(created[0].id)
    fireEvent.click(result)

    await expect.poll(() => tab('Daily Tasks').getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => singledOut('renew the cert')).toBe('true')
    expect((await core.dailyTasks()).map((task) => task.id)).toEqual([
      created[0].id,
    ])
  })

  it('leaves the newer result singled out when an older navigation finishes last', async () => {
    let holdNextRead = false
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let reading!: () => void
    const reached = new Promise<void>((resolve) => {
      reading = resolve
    })

    await showTasks(['first task', 'second task'], {
      journal: (core) => ({
        ...core,
        async occurrencesOfEach(ids) {
          const occurrences = await core.occurrencesOfEach(ids)
          if (holdNextRead) {
            holdNextRead = false
            reading()
            await held
          }
          return occurrences
        },
      }),
    })
    await screen.findByRole('heading', { name: 'No Daily Tasks yet' })

    fireEvent.change(searchBox(), { target: { value: 'task' } })
    const first = await screen.findByRole('button', { name: /first task/ })
    await screen.findByRole('button', { name: /second task/ })
    holdNextRead = true
    fireEvent.click(first)
    // The first navigation is now holding its Open list read.
    await reached
    fireEvent.click(screen.getByRole('button', { name: /second task/ }))
    await expect.poll(() => singledOut('second task')).toBe('true')

    await act(async () => {
      release()
    })

    expect(singledOut('second task')).toBe('true')
    expect(singledOut('first task')).toBeNull()
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

    await expect.poll(() => singledOut('renew the cert')).toBe('true')
    // Claimed once: a window opened any other way must not inherit the click.
    expect(await desktop.openedTaskAlert()).toBeNull()
  })

  it('stops singling it out once the user moves on', async () => {
    const { desktop, created } = await showOpenTasks(['renew the cert'])
    await screen.findByText('renew the cert')
    desktop.openTaskAlert(`task:${created[0].id}`)
    await expect.poll(() => singledOut('renew the cert')).toBe('true')

    fireEvent.click(tab('Completed'))
    fireEvent.click(tab('Open'))

    await expect.poll(() => singledOut('renew the cert')).toBeNull()
  })

  it('leaves nothing behind for the next window when it was announced', async () => {
    const { desktop, created } = await showOpenTasks(['renew the cert'])
    await screen.findByText('renew the cert')

    // The click is written down as well as announced — the Rust side cannot
    // know a window is listening. This one was, so nothing may be left sitting
    // there for the next Tasks View to inherit.
    desktop.openTaskAlert(`task:${created[0].id}`)

    await expect.poll(() => singledOut('renew the cert')).toBe('true')
    // Read rather than claimed: asking would empty it and prove nothing.
    await expect.poll(() => desktop.pendingTaskAlert).toBeNull()
  })

  it('shows the Open list with that Task singled out', async () => {
    const { desktop, core, created } = await showOpenTasks([
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

    await expect.poll(() => singledOut('renew the cert')).toBe('true')
    expect(singledOut('chase the invoice')).toBeNull()
  })

  it('shows Daily Tasks when the Alert names selected work', async () => {
    const { core, created, desktop } = await showTasks(['renew the cert'])
    await core.addDailyTask(created[0].id)
    await desktop.announceTasksChanged()
    await expect.poll(rows).toEqual(['renew the cert'])
    // Somewhere the Task is not, so the destination the Alert chooses is visible.
    fireEvent.click(tab('Completed'))
    await expect.poll(() => tab('Completed').getAttribute('aria-pressed')).toBe('true')

    desktop.openTaskAlert(`task:${created[0].id}`)

    await expect.poll(() => tab('Daily Tasks').getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => singledOut('renew the cert')).toBe('true')
    // Opening an Alert never selects the work it is about.
    expect((await core.dailyTasks()).map((task) => task.id)).toEqual([
      created[0].id,
    ])
  })

  it('lands on Daily Tasks when the click built the window', async () => {
    const { desktop } = await showTasks(['renew the cert'], {
      selected: [0],
      pendingAlertFor: 0,
    })

    // Claiming the written-down click is what sets the destination, so the
    // Task has been singled out exactly once the claim has happened.
    await expect.poll(() => desktop.pendingTaskAlert).toBeNull()
    await expect.poll(() => tab('Daily Tasks').getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => singledOut('renew the cert')).toBe('true')
  })

  it('follows a Task completed before the Alert was opened', async () => {
    const { core, created, desktop } = await showTasks(['renew the cert'])
    await core.addDailyTask(created[0].id)
    await desktop.announceTasksChanged()
    await expect.poll(rows).toEqual(['renew the cert'])
    // The banner named work that has since been kept, not a Task still owed.
    await core.completeTask(created[0].id)

    desktop.openTaskAlert(`task:${created[0].id}`)

    await expect.poll(() => tab('Completed').getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => singledOut('renew the cert')).toBe('true')
  })

  it('shows the Open list when the Alert names a Task that is gone', async () => {
    const { core, created, desktop } = await showTasks(['renew the cert'])
    await core.deleteTask(created[0].id)
    await desktop.announceTasksChanged()
    await expect.poll(rows).toEqual([])
    fireEvent.click(tab('Completed'))
    await expect.poll(() => tab('Completed').getAttribute('aria-pressed')).toBe('true')

    desktop.openTaskAlert(`task:${created[0].id}`)

    await expect.poll(() => tab('Open').getAttribute('aria-pressed')).toBe('true')
    expect(rows()).toEqual([])
    expect(singledOut('renew the cert')).toBeNull()
  })
})

describe('the recurrence controls', () => {
  const daily = { unit: 'day' as const, interval: 1, weekdays: [] }

  /** The cadence picker inside whichever sheet is open. */
  function cadence(): HTMLSelectElement {
    return screen.getByLabelText('Repeats') as HTMLSelectElement
  }

  it('cannot be used until there is a date to count from', async () => {
    await showOpenTasks(['renew the cert'])
    fireEvent.click(await screen.findByText('renew the cert'))

    expect(cadence().disabled).toBe(true)
    expect(cadence().value).toBe('none')
  })

  it('saves a cadence chosen beside the date', async () => {
    const { core, created, desktop } = await showOpenTasks(['renew the cert'])
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
    const { core, created, desktop } = await showOpenTasks(['gym'])
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
    const { core, created, desktop } = await showOpenTasks(['water the plants'])
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
    const { core, created, desktop } = await showOpenTasks(['water the plants'])
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
    const { core, created, desktop } = await showOpenTasks(['water the plants'])
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
    const { core, clock, desktop, created } = await showOpenTasks(['water the plants'])
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
    expect(await occurrencesOf(core, task.id)).toHaveLength(1)
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
    expect(await occurrencesOf(core, task.id)).toHaveLength(1)
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
    expect(await occurrencesOf(core, task.id)).toEqual([])
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
  const { core, created } = await showOpenTasks(['proposal'])
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
  const { core } = await showOpenTasks(['proposal'])
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

it('keeps the whole draft when completion conflicts with a schedule save, then permits retry', async () => {
  const { core, clock, created, driver, desktop } = await showOpenTasks(['proposal'])
  const task = await core.editTask(created[0].id, {
    description: 'proposal', schedule: { date: '2026-03-09', time: '09:00' },
    recurrence: { unit: 'day', interval: 1, weekdays: [] },
  })
  await openEditorFor(desktop, 'proposal', 'Overdue')
  fireEvent.change(screen.getByLabelText('Task Description'), { target: { value: 'edited proposal' } })
  fireEvent.change(screen.getByLabelText('Task Details (optional)'), { target: { value: 'retained\ncontext' } })
  setTime('12:00')

  let completed = false
  core.editTask = createJournal({ clock, driver: {
    ...driver,
    async transaction(statements) {
      if (!completed) {
        completed = true
        await core.completeTask(task.id)
      }
      await driver.transaction(statements)
    },
  } }).editTask
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))

  await screen.findByText('That Task could not be saved.')
  expect(screen.getByRole('dialog', { name: 'Edit Task' })).toBeTruthy()
  expect((screen.getByLabelText('Task Description') as HTMLInputElement).value).toBe('edited proposal')
  expect((screen.getByLabelText('Task Details (optional)') as HTMLTextAreaElement).value).toBe('retained\ncontext')
  expect((screen.getByLabelText('Time') as HTMLInputElement).value).toBe('12:00')
  expect((await core.openTasks())[0]).toMatchObject({
    description: 'proposal', details: null, scheduledDate: '2026-03-10', scheduledTime: '09:00',
  })
  expect((await occurrencesOf(core, task.id)).filter(one => one.completedAt === null)).toHaveLength(1)

  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await expect.poll(() => screen.queryByRole('dialog')).toBeNull()
  expect((await core.openTasks())[0]).toMatchObject({
    description: 'edited proposal', details: 'retained\ncontext',
    scheduledDate: '2026-03-10', scheduledTime: '12:00',
  })
})

it.each([false, true])('locks editor fields during a pending save (failure: %s)', async (fails) => {
  const user = userEvent.setup()
  const { core } = await showOpenTasks(['proposal'])
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
