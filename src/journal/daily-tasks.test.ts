import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createJournal, TransactionGuardMiss, type SqlDriver } from './journal'
import { fixedClock, migrationSql, occurrencesOf, openTestDatabase } from './testing/database'

const closers: Array<() => void> = []
afterEach(() => { for (const close of closers.splice(0)) close() })
const clock = fixedClock('2026-03-09T09:00:00')

async function setup() {
  const { driver, close } = await openTestDatabase()
  closers.push(close)
  return { driver, journal: createJournal({ driver, clock }) }
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
    close()
    const restarted = await openTestDatabase({ filename, migrations: [] })
    close = restarted.close
    expect(await createJournal({ driver: restarted.driver, clock }).dailyTasks()).toEqual([second, first])
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
