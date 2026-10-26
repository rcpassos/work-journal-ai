import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createJournal, TransactionGuardMiss, type Journal, type SqlDriver, type Task } from './journal'
import { fixedClock, migrationSql, occurrencesOf, openTestDatabase } from './testing/database'

const closers: Array<() => void> = []
afterEach(() => { for (const close of closers.splice(0)) close() })
const clock = fixedClock('2026-03-09T09:00:00')

async function setup() {
  const { driver, close } = await openTestDatabase()
  closers.push(close)
  return { driver, journal: createJournal({ driver, clock }) }
}

async function selectAll(journal: Journal, ...tasks: Task[]) {
  for (const task of tasks) await journal.addDailyTask(task.id)
}

it('upgrades existing Tasks without selecting them and retains selection across database restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'daily-tasks-'))
  const filename = join(directory, 'journal.sqlite')
  const migrations = migrationSql()
  let close = () => {}
  try {
    const old = await openTestDatabase({ filename, migrations: migrations.slice(0, 10) })
    close = old.close
    const before = createJournal({ driver: old.driver, clock })
    const first = await before.createTask('first', { date: '2026-04-01', time: '12:00' }, null, 'context')
    const second = await before.createTask('second')
    close()
    const upgraded = await openTestDatabase({ filename, migrations: migrations.slice(10) })
    close = upgraded.close
    const journal = createJournal({ driver: upgraded.driver, clock })
    expect(await journal.dailyTasks()).toEqual([])
    expect(await journal.openTasks()).toEqual([first, second])
    await journal.addDailyTask(second.id)
    await journal.addDailyTask(first.id)
    await journal.reorderDailyTasks([first.id, second.id], [second.id, first.id])
    close()
    const restarted = await openTestDatabase({ filename, migrations: [] })
    close = restarted.close
    expect(await createJournal({ driver: restarted.driver, clock }).dailyTasks()).toEqual([first, second])
  } finally { close(); rmSync(directory, { recursive: true, force: true }) }
})

it('accepts each Open Task once, excludes completed work and rejects missing Tasks', async () => {
  const { journal } = await setup()
  const task = await journal.createTask('first')
  const outcomes = await Promise.allSettled([journal.addDailyTask(task.id), journal.addDailyTask(task.id)])
  expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1)
  expect(await journal.dailyTasks()).toEqual([task])
  expect(await journal.dailyTaskCandidates()).toEqual([])
  await journal.completeTask(task.id)
  await expect(journal.addDailyTask(task.id)).rejects.toThrow()
  await expect(journal.addDailyTask('missing')).rejects.toThrow()
  await journal.reopenTask(task.id)
  expect(await journal.dailyTasks()).toEqual([])
  expect(await journal.dailyTaskCandidates()).toEqual([task])
})

it('answers where navigation should take the reader from the Task as it is now', async () => {
  const { journal } = await setup()
  const selected = await journal.createTask('selected')
  const open = await journal.createTask('open')
  const kept = await journal.createTask('kept')
  await journal.addDailyTask(selected.id)
  await journal.completeTask(kept.id)

  expect(await journal.taskPlacement(selected.id)).toBe('daily')
  expect(await journal.taskPlacement(open.id)).toBe('open')
  expect(await journal.taskPlacement(kept.id)).toBe('completed')
  // A clicked Alert may name work that has since been deleted.
  expect(await journal.taskPlacement('missing')).toBe('open')

  await journal.completeTask(selected.id)
  expect(await journal.taskPlacement(selected.id)).toBe('completed')
})

it.each([false, true])('rolls back completion and selection together (recurring: %s)', async recurring => {
  const { driver, journal } = await setup()
  const task = await journal.createTask('work', { date: '2026-03-09', time: '12:00' },
    recurring ? { unit: 'day', interval: 1, weekdays: [] } : null)
  await journal.addDailyTask(task.id)
  const history = await occurrencesOf(journal, task.id)
  const broken = createJournal({ clock, driver: {
    ...driver,
    transaction: statements => driver.transaction([
      ...statements, { sql: 'INSERT INTO missing_table VALUES (1)', params: [] },
    ]),
  } })
  await expect(broken.completeTask(task.id)).rejects.toThrow()
  expect(await journal.dailyTasks()).toEqual([task])
  expect(await journal.openTasks()).toEqual([task])
  expect(await occurrencesOf(journal, task.id)).toEqual(history)
})

it('restores an ordinary Task to its previous position through Undo and leaves a later reopening outside the selection', async () => {
  const { journal } = await setup()
  const first = await journal.createTask('first')
  const second = await journal.createTask('second', { date: '2026-04-01', time: '12:00' }, null, 'context')
  const third = await journal.createTask('third')
  await selectAll(journal, first, second, third)

  await journal.completeTask(second.id)
  expect(await journal.dailyTasks()).toEqual([first, third])
  expect(await journal.completedTasks()).toEqual([expect.objectContaining({
    id: second.id, scheduledDate: '2026-04-01', scheduledTime: '12:00', details: 'context',
  })])

  await journal.undoCompletion(second.id)
  expect(await journal.dailyTasks()).toEqual([first, second, third])
  expect(await journal.completedTasks()).toEqual([])
  expect((await journal.openTasks()).map(task => task.id).sort()).toEqual([first, second, third].map(task => task.id).sort())

  // The immediate Undo is consumed. Reopening later restores only the
  // broader list, and another completion is needed to select it again.
  await journal.completeTask(second.id)
  expect(await journal.dailyTasks()).toEqual([first, third])
  await journal.reopenTask(second.id)
  expect(await journal.dailyTasks()).toEqual([first, third])
  expect((await journal.openTasks()).map(task => task.id)).toContain(second.id)
  await expect(journal.undoCompletion(second.id)).rejects.toThrow()
})

it('restores a completion to its earlier slot after the remaining work is reordered', async () => {
  const { journal } = await setup()
  const first = await journal.createTask('first')
  const second = await journal.createTask('second')
  const third = await journal.createTask('third')
  await selectAll(journal, first, second, third)

  await journal.completeTask(second.id)
  expect((await journal.dailyTasks()).map(task => task.id)).toEqual([first.id, third.id])

  await journal.reorderDailyTasks([third.id, first.id], [first.id, third.id])
  expect((await journal.dailyTasks()).map(task => task.id)).toEqual([third.id, first.id])

  await journal.undoCompletion(second.id)
  expect((await journal.dailyTasks()).map(task => task.id)).toEqual([third.id, second.id, first.id])
})

it('rolls back an Undo that cannot restore the position, leaving the completion intact', async () => {
  const { driver, journal } = await setup()
  const first = await journal.createTask('first')
  const second = await journal.createTask('second')
  const third = await journal.createTask('third')
  await selectAll(journal, first, second, third)
  await journal.completeTask(second.id)

  const broken = createJournal({ clock, driver: {
    ...driver,
    transaction: statements => driver.transaction([
      ...statements, { sql: 'INSERT INTO missing_table VALUES (1)', params: [] },
    ]),
  } })
  await expect(broken.undoCompletion(second.id)).rejects.toThrow()
  expect(await journal.dailyTasks()).toEqual([first, third])
  expect((await journal.completedTasks()).map(task => task.id)).toEqual([second.id])

  await journal.undoCompletion(second.id)
  expect(await journal.dailyTasks()).toEqual([first, second, third])
})

it('lets only one of two competing Undos restore an ordinary completion', async () => {
  const { driver, journal } = await setup()
  const first = await journal.createTask('first')
  const second = await journal.createTask('second')
  const third = await journal.createTask('third')
  await selectAll(journal, first, second, third)
  await journal.completeTask(second.id)

  const stale = createJournal({ clock, driver: racing(driver, () => journal.undoCompletion(second.id)) })
  await expect(stale.undoCompletion(second.id)).rejects.toThrow(TransactionGuardMiss)
  expect(await journal.dailyTasks()).toEqual([first, second, third])
  expect(await journal.completedTasks()).toEqual([])
})

it('lets only one of two competing Undos restore a recurring completion', async () => {
  const { driver, journal } = await setup()
  const recurring = await journal.createTask('daily report', { date: '2026-03-09', time: '12:00' }, {
    unit: 'day', interval: 1, weekdays: [],
  })
  await journal.addDailyTask(recurring.id)
  await journal.completeTask(recurring.id)

  const stale = createJournal({ clock, driver: racing(driver, () => journal.undoCompletion(recurring.id)) })
  await expect(stale.undoCompletion(recurring.id)).rejects.toThrow(TransactionGuardMiss)
  expect(await journal.dailyTasks()).toEqual([recurring])
  expect((await occurrencesOf(journal, recurring.id)).filter(one => one.completedAt === null)).toHaveLength(1)
})

it('refuses an Undo whose work was deleted, restoring nothing', async () => {
  const { journal } = await setup()
  const first = await journal.createTask('first')
  const second = await journal.createTask('second')
  await journal.addDailyTask(first.id)
  await journal.addDailyTask(second.id)
  await journal.completeTask(second.id)
  await journal.deleteTask(second.id)

  await expect(journal.undoCompletion(second.id)).rejects.toThrow(/No such Task/)
  expect(await journal.dailyTasks()).toEqual([first])
})

it('offers no Undo for a completion that never removed work from Daily Tasks', async () => {
  const { journal } = await setup()
  const task = await journal.createTask('not selected')
  await journal.completeTask(task.id)

  await expect(journal.undoCompletion(task.id)).rejects.toThrow()
  expect(await journal.dailyTasks()).toEqual([])
})

it('restores a recurring completion and its previous position on a safe Undo', async () => {
  const { journal } = await setup()
  const first = await journal.createTask('first')
  const recurring = await journal.createTask('daily report', { date: '2026-03-09', time: '12:00' }, {
    unit: 'day', interval: 1, weekdays: [],
  })
  const last = await journal.createTask('last')
  await selectAll(journal, first, recurring, last)

  await journal.completeTask(recurring.id)
  expect(await journal.dailyTasks()).toEqual([first, last])

  await journal.undoCompletion(recurring.id)
  expect(await journal.dailyTasks()).toEqual([first, recurring, last])
  expect((await journal.openTasks()).find(task => task.id === recurring.id)?.scheduledDate).toBe('2026-03-09')
  expect((await occurrencesOf(journal, recurring.id)).filter(one => one.completedAt === null)).toHaveLength(1)
})

it('keeps a newer selection when undoing a recurring completion', async () => {
  const { journal } = await setup()
  const first = await journal.createTask('first')
  const recurring = await journal.createTask('daily report', { date: '2026-03-09', time: '12:00' }, {
    unit: 'day', interval: 1, weekdays: [],
  })
  const last = await journal.createTask('last')
  await selectAll(journal, first, recurring, last)

  await journal.completeTask(recurring.id)
  await journal.addDailyTask(recurring.id)
  expect((await journal.dailyTasks()).map(task => task.id)).toEqual([first.id, last.id, recurring.id])

  await journal.undoCompletion(recurring.id)
  expect((await journal.dailyTasks()).map(task => task.id)).toEqual([first.id, last.id, recurring.id])
  expect((await journal.openTasks()).find(task => task.id === recurring.id)?.scheduledDate).toBe('2026-03-09')
  expect((await occurrencesOf(journal, recurring.id)).filter(one => one.completedAt === null)).toHaveLength(1)
})

it('refuses an immediate Undo of an ordinary completion that was superseded', async () => {
  const { journal } = await setup()
  const first = await journal.createTask('first')
  const second = await journal.createTask('second')
  await selectAll(journal, first, second)

  const receipt = await journal.completeTaskWithReceipt(second.id)
  expect(receipt).toMatchObject({ kind: 'task' })

  await journal.reopenTask(second.id)
  await journal.addDailyTask(second.id)
  await journal.completeTask(second.id)

  await expect(journal.undoCompletion(second.id, receipt!)).rejects.toThrow(TransactionGuardMiss)
  expect((await journal.completedTasks()).map(task => task.id)).toEqual([second.id])
  expect((await journal.dailyTasks()).map(task => task.id)).toEqual([first.id])
})

it('refuses an immediate Undo of a recurring completion that was superseded', async () => {
  const { driver } = await setup()
  const local = fixedClock('2026-03-09T09:00:00')
  const journal = createJournal({ driver, clock: local })
  const recurring = await journal.createTask('daily report', { date: '2026-03-09', time: '12:00' }, {
    unit: 'day', interval: 1, weekdays: [],
  })
  await journal.addDailyTask(recurring.id)

  const receipt = await journal.completeTaskWithReceipt(recurring.id)
  expect(receipt).toMatchObject({ kind: 'occurrence' })

  local.set(new Date('2026-03-10T09:00:00'))
  await journal.completeTask(recurring.id)

  await expect(journal.undoCompletion(recurring.id, receipt!)).rejects.toThrow(TransactionGuardMiss)
  expect((await occurrencesOf(journal, recurring.id)).filter(one => one.completedAt !== null)).toHaveLength(2)
  expect((await occurrencesOf(journal, recurring.id)).filter(one => one.completedAt === null)).toHaveLength(1)
  expect(await journal.dailyTasks()).toEqual([])
})

it('retains a later explicit removal when undoing a recurring completion', async () => {
  const { journal } = await setup()
  const first = await journal.createTask('first')
  const recurring = await journal.createTask('daily report', { date: '2026-03-09', time: '12:00' }, {
    unit: 'day', interval: 1, weekdays: [],
  })
  await selectAll(journal, first, recurring)

  await journal.completeTask(recurring.id)
  await journal.addDailyTask(recurring.id)
  await journal.removeDailyTask(recurring.id)
  expect((await journal.dailyTasks()).map(task => task.id)).toEqual([first.id])

  await journal.undoCompletion(recurring.id)
  expect((await journal.dailyTasks()).map(task => task.id)).toEqual([first.id])
  expect((await journal.openTasks()).find(task => task.id === recurring.id)?.scheduledDate).toBe('2026-03-09')
  expect((await occurrencesOf(journal, recurring.id)).filter(one => one.completedAt === null)).toHaveLength(1)
})

it('refuses a recurring Undo overtaken by a later membership decision', async () => {
  const { driver, journal } = await setup()
  const recurring = await journal.createTask('daily report', { date: '2026-03-09', time: '12:00' }, {
    unit: 'day', interval: 1, weekdays: [],
  })
  await journal.addDailyTask(recurring.id)
  await journal.completeTask(recurring.id)

  const stale = createJournal({ clock, driver: racing(driver, async () => {
    await journal.addDailyTask(recurring.id)
    await journal.removeDailyTask(recurring.id)
  }) })
  await expect(stale.undoCompletion(recurring.id)).rejects.toThrow(TransactionGuardMiss)
  expect(await journal.dailyTasks()).toEqual([])
  expect((await occurrencesOf(journal, recurring.id)).filter(one => one.completedAt !== null)).toHaveLength(1)
})

it('refuses an unsafe recurring Undo without restoring the selection or discarding the edit', async () => {
  const { journal } = await setup()
  const recurring = await journal.createTask('daily report', { date: '2026-03-09', time: '12:00' }, {
    unit: 'day', interval: 1, weekdays: [],
  })
  await journal.addDailyTask(recurring.id)
  await journal.completeTask(recurring.id)
  expect(await journal.dailyTasks()).toEqual([])

  await journal.editTask(recurring.id, {
    description: 'daily report',
    schedule: { date: '2026-03-20', time: '12:00' },
    recurrence: { unit: 'day', interval: 1, weekdays: [] },
  })
  await expect(journal.undoCompletion(recurring.id)).rejects.toThrow()

  expect(await journal.dailyTasks()).toEqual([])
  expect((await journal.openTasks()).find(task => task.id === recurring.id)?.scheduledDate).toBe('2026-03-20')
  expect(await occurrencesOf(journal, recurring.id)).toHaveLength(2)
})

it('leaves membership intact when removal fails and leaves no partial selection when addition fails', async () => {
  const { driver, journal } = await setup()
  const first = await journal.createTask('first')
  const second = await journal.createTask('second')
  await journal.addDailyTask(first.id)
  const broken = createJournal({ clock, driver: {
    ...driver,
    execute: async () => { throw new Error('storage unavailable') },
    transaction: statements => driver.transaction([
      ...statements, { sql: 'INSERT INTO missing_table VALUES (1)', params: [] },
    ]),
  } })
  await expect(broken.removeDailyTask(first.id)).rejects.toThrow()
  await expect(broken.addDailyTask(second.id)).rejects.toThrow()
  expect(await journal.dailyTasks()).toEqual([first])
})

/** Another window commits just before this operation's transaction starts. */
function racing(driver: SqlDriver, action: () => Promise<unknown>): SqlDriver {
  return { ...driver, async transaction(statements) {
    await action()
    await driver.transaction(statements)
  } }
}

it.each(['remove', 'complete', 'delete', 'append', 'reorder', 'reselect'] as const)(
  'refuses a reorder overtaken by a competing %s and preserves that decision', async action => {
    const { driver, journal } = await setup()
    const first = await journal.createTask('first', { date: '2026-03-09', time: '12:00' }, { unit: 'day', interval: 1, weekdays: [] }, 'details')
    const second = await journal.createTask('second')
    const third = await journal.createTask('third')
    await journal.addDailyTask(first.id)
    await journal.addDailyTask(second.id)
    const expected = [first.id, second.id]
    let winner: Awaited<ReturnType<typeof journal.dailyTasks>> = []
    const stale = createJournal({ clock, driver: racing(driver, async () => {
      switch (action) {
        case 'remove': await journal.removeDailyTask(first.id); break
        case 'complete': await journal.completeTask(first.id); break
        case 'delete': await journal.deleteTask(first.id); break
        case 'append': await journal.addDailyTask(third.id); break
        case 'reorder': await journal.reorderDailyTasks([second.id, first.id], expected); break
        case 'reselect':
          await journal.removeDailyTask(second.id)
          await journal.addDailyTask(second.id)
      }
      winner = await journal.dailyTasks()
    }) })
    await expect(stale.reorderDailyTasks([second.id, first.id], expected)).rejects.toThrow(TransactionGuardMiss)
    expect(await journal.dailyTasks()).toEqual(winner)
    if (action === 'complete') {
      expect((await journal.openTasks()).find(task => task.id === first.id)).toEqual(expect.objectContaining({ scheduledDate: '2026-03-10', details: 'details' }))
      expect((await occurrencesOf(journal, first.id)).filter(one => one.completedAt !== null)).toHaveLength(1)
    }
  },
)

it('rejects stale and invalid permutations without changing membership or priorities', async () => {
  const { journal } = await setup()
  await journal.reorderDailyTasks([], [])
  const first = await journal.createTask('first')
  const second = await journal.createTask('second')
  await journal.addDailyTask(first.id)
  await journal.addDailyTask(second.id)
  const expected = [first.id, second.id]
  await expect(journal.reorderDailyTasks([first.id, first.id], expected)).rejects.toThrow()
  await expect(journal.reorderDailyTasks([first.id], expected)).rejects.toThrow()
  await expect(journal.reorderDailyTasks(['missing', second.id], expected)).rejects.toThrow()
  await expect(journal.reorderDailyTasks(expected, [second.id, first.id])).rejects.toThrow(TransactionGuardMiss)
  expect(await journal.dailyTasks()).toEqual([first, second])
  await journal.reorderDailyTasks(expected, expected)
  expect(await journal.dailyTasks()).toEqual([first, second])
})

it.each(['complete', 'edit', 'delete', 'select'] as const)(
  'guards a selection against a competing %s without overwriting that decision', async action => {
    const { driver, journal } = await setup()
    const task = await journal.createTask('work', { date: '2026-03-09', time: '12:00' }, { unit: 'day', interval: 1, weekdays: [] })
    const other = () => {
      switch (action) {
        case 'complete': return journal.completeTask(task.id)
        case 'edit': return journal.editTask(task.id, { description: 'changed', schedule: { date: '2026-04-01', time: null } })
        case 'delete': return journal.deleteTask(task.id)
        case 'select': return journal.addDailyTask(task.id)
      }
    }
    const stale = createJournal({ clock, driver: racing(driver, other) })
    await expect(stale.addDailyTask(task.id)).rejects.toThrow(TransactionGuardMiss)
    expect((await journal.dailyTasks()).map(task => task.id)).toEqual(action === 'select' ? [task.id] : [])
    if (action === 'complete') {
      expect((await journal.openTasks())[0].scheduledDate).toBe('2026-03-10')
      expect((await occurrencesOf(journal, task.id)).filter(one => one.completedAt !== null)).toHaveLength(1)
    }
    if (action === 'edit') expect((await journal.openTasks())[0].description).toBe('changed')
    if (action === 'delete') expect(await journal.openTasks()).toEqual([])
  },
)

it('refuses selection after a recurring occurrence is replaced at the same schedule', async () => {
  const { driver, journal } = await setup()
  const schedule = { date: '2026-03-09', time: '12:00' }
  const task = await journal.createTask('work', schedule, { unit: 'day', interval: 1, weekdays: [] })
  const stale = createJournal({ clock, driver: racing(driver, async () => {
    await journal.editTask(task.id, { description: 'work', schedule: { ...schedule, time: '13:00' } })
    await journal.editTask(task.id, { description: 'work', schedule })
  }) })
  await expect(stale.addDailyTask(task.id)).rejects.toThrow(TransactionGuardMiss)
  expect(await journal.dailyTasks()).toEqual([])
  expect(await journal.openTasks()).toEqual([task])
})

it('preserves append order when different windows add, remove and complete work concurrently', async () => {
  const { driver, journal } = await setup()
  const first = await journal.createTask('first')
  const second = await journal.createTask('second')
  const other = createJournal({ driver, clock })
  await Promise.all([journal.addDailyTask(first.id), other.addDailyTask(second.id)])
  expect(await journal.dailyTasks()).toEqual([first, second])
  await Promise.all([journal.removeDailyTask(first.id), other.completeTask(second.id)])
  expect(await journal.dailyTasks()).toEqual([])
  expect(await journal.openTasks()).toEqual([first])
  await other.addDailyTask(first.id)
  await journal.deleteTask(first.id)
  expect(await journal.dailyTasks()).toEqual([])
  expect(await journal.dailyTaskCandidates()).toEqual([])
})
