import { afterEach, expect, it } from 'vitest'
import {
  createJournal, TransactionGuardMiss, type SqlDriver, type TaskOccurrence,
} from './journal'
import { fixedClock, occurrencesOf, openTestDatabase } from './testing/database'

const closeDatabases: Array<() => void> = []
afterEach(() => {
  for (const close of closeDatabases.splice(0)) close()
})

it('refuses a schedule edit when an ordinary Task completes after the read', async () => {
  const { driver, close } = await openTestDatabase()
  closeDatabases.push(close)
  const clock = fixedClock('2026-03-10T10:00:00')
  const journal = createJournal({ driver, clock })
  const task = await journal.createTask('certificate', { date: '2026-03-10', time: '09:00' })
  let completed = false
  const racing: SqlDriver = {
    ...driver,
    async select<Row>(sql: string, params: unknown[]) {
      const rows = await driver.select<Row>(sql, params)
      if (!completed && sql.includes('FROM tasks') && sql.includes('WHERE id =')) {
        completed = true
        await journal.completeTask(task.id)
      }
      return rows
    },
  }
  const editor = createJournal({ driver: racing, clock })

  await expect(editor.editTask(task.id, {
    description: 'changed', details: 'changed context',
    schedule: { date: '2026-03-12', time: '12:00' },
  })).rejects.toThrow(TransactionGuardMiss)
  expect(await journal.completedTasks()).toEqual([
    { ...task, completedAt: clock.now().toISOString() },
  ])
  expect(await journal.openTasks()).toEqual([])
})

it('saves wording while completion advances the series, returning the stored head', async () => {
  const { driver, close } = await openTestDatabase()
  closeDatabases.push(close)
  const clock = fixedClock('2026-03-10T10:00:00')
  const journal = createJournal({ driver, clock })
  const schedule = { date: '2026-03-10', time: '09:00' }
  const task = await journal.createTask('certificate', schedule, {
    unit: 'day', interval: 1, weekdays: [],
  })
  let completed = false
  const racing: SqlDriver = {
    ...driver,
    async select<Row>(sql: string, params: unknown[]) {
      const rows = await driver.select<Row>(sql, params)
      if (!completed && sql.includes('FROM tasks') && sql.includes('WHERE id =')) {
        completed = true
        await journal.completeTask(task.id)
      }
      return rows
    },
  }
  const editor = createJournal({ driver: racing, clock })

  const saved = await editor.editTask(task.id, {
    description: 'new certificate description', details: 'new context', schedule,
  })

  expect(saved).toEqual({
    ...task, description: 'new certificate description', details: 'new context',
    scheduledDate: '2026-03-11',
  })
  expect(await journal.openTasks()).toEqual([saved])
  const occurrences = await occurrencesOf(journal, task.id)
  expect(occurrences.filter(one => one.completedAt === null)).toMatchObject([
    { scheduledDate: '2026-03-11', scheduledTime: '09:00' },
  ])
  expect((await journal.undoCompletion(task.id)).scheduledDate).toBe('2026-03-10')
})

it.each(['reanchor', 'stop'] as const)(
  'refuses to %s a series whose Open occurrence was replaced at the same slot',
  async (action) => {
    const { driver, close } = await openTestDatabase()
    closeDatabases.push(close)
    const clock = fixedClock('2026-03-10T10:00:00')
    const journal = createJournal({ driver, clock })
    const schedule = { date: '2026-03-10', time: '09:00' }
    const task = await journal.createTask('certificate', schedule, {
      unit: 'day', interval: 1, weekdays: [],
    })
    let replaced = false
    let afterReplacement: TaskOccurrence[] = []
    const editor = createJournal({ clock, driver: {
      ...driver,
      async transaction(statements) {
        if (!replaced) {
          replaced = true
          await journal.editTask(task.id, {
            description: task.description,
            schedule: { ...schedule, time: '10:00' },
          })
          await journal.editTask(task.id, { description: task.description, schedule })
          afterReplacement = await occurrencesOf(journal, task.id)
        }
        await driver.transaction(statements)
      },
    } })

    await expect(editor.editTask(task.id, {
      description: 'changed', details: 'changed context',
      schedule: { ...schedule, time: '11:00' },
      recurrence: action === 'stop' ? null : task.recurrence,
    })).rejects.toThrow(TransactionGuardMiss)
    expect(await journal.openTasks()).toEqual([task])
    expect(await occurrencesOf(journal, task.id)).toEqual(afterReplacement)
  },
)

type RacePoint = 'task read' | 'occurrence read' | 'write'

/** Two Journals over real SQL, with the other window acting at one boundary. */
function during(
  driver: SqlDriver, point: RacePoint, act: () => Promise<void>,
): SqlDriver {
  let acted = false
  async function once() {
    if (acted) return
    acted = true
    await act()
  }
  return {
    async select<Row>(sql: string, params: unknown[]) {
      const rows = await driver.select<Row>(sql, params)
      if (
        (point === 'task read' && sql.includes('FROM tasks') && sql.includes('WHERE id =')) ||
        (point === 'occurrence read' && sql.includes('FROM task_occurrences'))
      ) await once()
      return rows
    },
    async execute(sql, params) {
      if (point === 'write') await once()
      return driver.execute(sql, params)
    },
    async transaction(statements) {
      if (point === 'write') await once()
      return driver.transaction(statements)
    },
  }
}

it.each([
  { recurring: false, point: 'task read' },
  { recurring: false, point: 'write' },
  { recurring: true, point: 'write' },
] satisfies Array<{ recurring: boolean; point: RacePoint }>)(
  'saves details across completion at the $point (recurring: $recurring)',
  async ({ recurring, point }) => {
    const { driver, close } = await openTestDatabase()
    closeDatabases.push(close)
    const clock = fixedClock('2026-03-10T10:00:00')
    const journal = createJournal({ driver, clock })
    const schedule = { date: '2026-03-10', time: '09:00' }
    const task = await journal.createTask('certificate', schedule,
      recurring ? { unit: 'day', interval: 1, weekdays: [] } : null,
    )
    const editor = createJournal({ clock, driver: during(driver, point, async () => {
      await journal.completeTask(task.id)
    }) })

    const saved = await editor.editTask(task.id, {
      description: task.description, details: 'new context', schedule,
    })

    expect(saved).toEqual({
      ...task, details: 'new context',
      scheduledDate: recurring ? '2026-03-11' : '2026-03-10',
      completedAt: recurring ? null : clock.now().toISOString(),
    })
    expect(await (recurring ? journal.openTasks() : journal.completedTasks())).toEqual([saved])
    if (recurring) {
      expect((await occurrencesOf(journal, task.id)).filter(one => one.completedAt === null))
        .toMatchObject([{ scheduledDate: '2026-03-11', scheduledTime: '09:00' }])
    }
  },
)

it.each([
  { action: 'reschedule', recurring: false, point: 'write' },
  { action: 'start', recurring: false, point: 'task read' },
  { action: 'reanchor', recurring: true, point: 'task read' },
  { action: 'reanchor', recurring: true, point: 'occurrence read' },
  { action: 'reanchor', recurring: true, point: 'write' },
  { action: 'rule', recurring: true, point: 'write' },
  { action: 'stop', recurring: true, point: 'task read' },
  { action: 'stop', recurring: true, point: 'write' },
  { action: 'clear', recurring: true, point: 'write' },
] satisfies Array<{ action: string; recurring: boolean; point: RacePoint }>)(
  'refuses to $action across completion at the $point',
  async ({ action, recurring, point }) => {
    const { driver, close } = await openTestDatabase()
    closeDatabases.push(close)
    const clock = fixedClock('2026-03-10T10:00:00')
    const journal = createJournal({ driver, clock })
    const schedule = { date: '2026-03-10', time: '09:00' }
    const daily = { unit: 'day', interval: 1, weekdays: [] } as const
    const task = await journal.createTask('certificate', schedule,
      recurring ? { ...daily, weekdays: [] } : null,
    )
    let afterCompletion = task
    let occurrences: TaskOccurrence[] = []
    const editor = createJournal({ clock, driver: during(driver, point, async () => {
      afterCompletion = await journal.completeTask(task.id)
      occurrences = await occurrencesOf(journal, task.id)
    }) })

    await expect(editor.editTask(task.id, {
      description: 'changed', details: 'changed context',
      schedule: action === 'clear' ? null :
        action === 'stop' || action === 'rule' || action === 'start' ? schedule :
          { date: '2026-03-12', time: '12:00' },
      recurrence: action === 'stop' ? null :
        action === 'start' || action === 'rule' ? { unit: 'day', interval: 2, weekdays: [] } :
          undefined,
    })).rejects.toThrow(TransactionGuardMiss)
    expect(await (recurring ? journal.openTasks() : journal.completedTasks()))
      .toEqual([afterCompletion])
    expect(await occurrencesOf(journal, task.id)).toEqual(occurrences)
    if (recurring) {
      expect(occurrences.filter(one => one.completedAt === null)).toHaveLength(1)
      expect(await journal.undoCompletion(task.id)).toEqual(task)
    }
  },
)
