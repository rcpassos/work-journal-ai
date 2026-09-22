import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  advancedSlot,
  canUndoCompletion,
  completedOccurrences,
  createJournal,
  formatRecurrence,
  openOccurrence,
  openingSlot,
  resumedSlot,
  sameRecurrence,
  type Journal,
  type Recurrence,
  type SqlDriver,
  type SqlStatement,
  type Task,
  type TaskOccurrence,
} from './journal'
import { fixedClock, migrationAt, openTestDatabase } from './testing/database'

// Every test drives the core through its public operations, against the same
// SQL the app ships — including the index that permits exactly one Open
// occurrence per Recurring Task.

const openJournals: Array<() => void> = []

afterEach(() => {
  for (const close of openJournals.splice(0)) close()
})

async function journalAt(instant: string): Promise<{
  journal: Journal
  clock: ReturnType<typeof fixedClock>
  driver: SqlDriver
}> {
  const { driver, close } = await openTestDatabase()
  openJournals.push(close)
  const clock = fixedClock(instant)
  return { journal: createJournal({ clock, driver }), clock, driver }
}

/** A cadence written the way a control hands one over. */
function every(
  interval: number,
  unit: Recurrence['unit'],
  weekdays: number[] = [],
): Recurrence {
  return { unit, interval, weekdays }
}

/** How many Open occurrences the database holds for a Task, asked of SQL. */
async function openCount(driver: SqlDriver, taskId: string): Promise<number> {
  const rows = await driver.select<{ count: number }>(
    'SELECT COUNT(*) AS count FROM task_occurrences WHERE task_id = ? AND completed_at IS NULL',
    [taskId],
  )
  return rows[0].count
}

describe('creating a Recurring Task', () => {
  it('opens on the starting date when that is still ahead', async () => {
    const { journal } = await journalAt('2026-03-16T10:00:00')

    const task = await journal.createTask(
      'water the plants',
      { date: '2026-03-20', time: '09:00' },
      every(1, 'day'),
    )

    expect(task.scheduledDate).toBe('2026-03-20')
    expect(task.recurrenceAnchor).toBe('2026-03-20')
    expect(task.recurrence).toEqual(every(1, 'day'))
  })

  it('opens on the latest elapsed slot when the start is in the past', async () => {
    const { journal } = await journalAt('2026-03-16T10:00:00')

    const task = await journal.createTask(
      'stand-up notes',
      { date: '2026-03-01', time: '09:00' },
      every(1, 'day'),
    )

    // Today's 09:00 is gone, so today is the latest elapsed slot.
    expect(task.scheduledDate).toBe('2026-03-16')
    expect(task.recurrenceAnchor).toBe('2026-03-01')
  })

  it('does not open on today when today has not reached its own minute', async () => {
    const { journal } = await journalAt('2026-03-16T08:00:00')

    const task = await journal.createTask(
      'stand-up notes',
      { date: '2026-03-01', time: '09:00' },
      every(1, 'day'),
    )

    expect(task.scheduledDate).toBe('2026-03-15')
  })

  it('never materializes the slots a past start missed', async () => {
    const { journal, driver } = await journalAt('2026-03-16T10:00:00')

    const task = await journal.createTask(
      'stand-up notes',
      { date: '2026-01-01', time: '09:00' },
      every(1, 'day'),
    )

    const occurrences = await journal.occurrencesOf(task.id)
    expect(occurrences).toHaveLength(1)
    expect(await openCount(driver, task.id)).toBe(1)
  })

  it('refuses a cadence with no date to be counted from', async () => {
    const { journal } = await journalAt('2026-03-16T10:00:00')

    await expect(
      journal.createTask('someday', null, every(1, 'week', [1])),
    ).rejects.toThrow(/Scheduled For date/)
  })

  it('refuses a weekly cadence with no weekday selected', async () => {
    const { journal } = await journalAt('2026-03-16T10:00:00')

    await expect(
      journal.createTask('weekly', { date: '2026-03-16', time: null }, every(1, 'week')),
    ).rejects.toThrow(/at least one weekday/)
  })

  it('refuses a cadence of less than one unit', async () => {
    const { journal } = await journalAt('2026-03-16T10:00:00')

    await expect(
      journal.createTask('weekly', { date: '2026-03-16', time: null }, every(0, 'day')),
    ).rejects.toThrow(/whole unit/)
  })

  it('keeps a Recurring Task out of the Completed list entirely', async () => {
    const { journal } = await journalAt('2026-03-16T10:00:00')

    const task = await journal.createTask(
      'water the plants',
      { date: '2026-03-16', time: null },
      every(1, 'day'),
    )
    await journal.completeTask(task.id)

    expect(await journal.completedTasks()).toEqual([])
    expect((await journal.openTasks()).map((one) => one.id)).toEqual([task.id])
  })
})

describe('every cadence', () => {
  async function advancing(
    schedule: { date: string; time: string | null },
    recurrence: Recurrence,
    now: string,
    times: number,
  ): Promise<string[]> {
    const { journal, clock } = await journalAt(now)
    const task = await journal.createTask('repeat', schedule, recurrence)

    const slots = [task.scheduledDate!]
    let current: Task = task
    for (let round = 0; round < times; round += 1) {
      // Completing on the day of the slot, so nothing is ever skipped for
      // having been missed.
      clock.set(new Date(`${current.scheduledDate}T23:00:00`))
      current = await journal.completeTask(current.id)
      slots.push(current.scheduledDate!)
    }

    return slots
  }

  it('steps whole days', async () => {
    expect(
      await advancing(
        { date: '2026-03-16', time: null },
        every(1, 'day'),
        '2026-03-16T08:00:00',
        3,
      ),
    ).toEqual(['2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19'])
  })

  it('steps every N days', async () => {
    expect(
      await advancing(
        { date: '2026-03-16', time: null },
        every(3, 'day'),
        '2026-03-16T08:00:00',
        3,
      ),
    ).toEqual(['2026-03-16', '2026-03-19', '2026-03-22', '2026-03-25'])
  })

  it('steps whole weeks on the starting weekday', async () => {
    expect(
      await advancing(
        { date: '2026-03-16', time: null },
        every(1, 'week', [1]),
        '2026-03-16T08:00:00',
        2,
      ),
    ).toEqual(['2026-03-16', '2026-03-23', '2026-03-30'])
  })

  it('steps whole months', async () => {
    expect(
      await advancing(
        { date: '2026-03-16', time: null },
        every(1, 'month'),
        '2026-03-16T08:00:00',
        2,
      ),
    ).toEqual(['2026-03-16', '2026-04-16', '2026-05-16'])
  })

  it('steps every N months', async () => {
    expect(
      await advancing(
        { date: '2026-03-16', time: null },
        every(4, 'month'),
        '2026-03-16T08:00:00',
        2,
      ),
    ).toEqual(['2026-03-16', '2026-07-16', '2026-11-16'])
  })

  it('steps whole years', async () => {
    expect(
      await advancing(
        { date: '2026-03-16', time: null },
        every(1, 'year'),
        '2026-03-16T08:00:00',
        2,
      ),
    ).toEqual(['2026-03-16', '2027-03-16', '2028-03-16'])
  })

  it('steps every N years', async () => {
    expect(
      await advancing(
        { date: '2026-03-16', time: null },
        every(2, 'year'),
        '2026-03-16T08:00:00',
        1,
      ),
    ).toEqual(['2026-03-16', '2028-03-16'])
  })
})

describe('a weekly cadence with several weekdays', () => {
  const monWedFri = every(1, 'week', [1, 3, 5])

  it('advances through the selected days in order, one Open at a time', async () => {
    // Monday 16 March 2026.
    const { journal, clock } = await journalAt('2026-03-16T08:00:00')
    const task = await journal.createTask(
      'gym',
      { date: '2026-03-16', time: null },
      monWedFri,
    )

    expect(task.scheduledDate).toBe('2026-03-16')

    clock.set(new Date('2026-03-16T20:00:00'))
    const wednesday = await journal.completeTask(task.id)
    expect(wednesday.scheduledDate).toBe('2026-03-18')

    clock.set(new Date('2026-03-18T20:00:00'))
    const friday = await journal.completeTask(task.id)
    expect(friday.scheduledDate).toBe('2026-03-20')

    clock.set(new Date('2026-03-20T20:00:00'))
    const nextMonday = await journal.completeTask(task.id)
    expect(nextMonday.scheduledDate).toBe('2026-03-23')

    expect(openOccurrence(await journal.occurrencesOf(task.id))).not.toBeNull()
    expect(completedOccurrences(await journal.occurrencesOf(task.id))).toHaveLength(3)
  })

  it('ignores selected weekdays that fall before the starting date', async () => {
    // Wednesday 18 March 2026: the Monday of that week is not a slot.
    const { journal } = await journalAt('2026-03-18T08:00:00')

    const task = await journal.createTask(
      'gym',
      { date: '2026-03-18', time: null },
      monWedFri,
    )

    expect(task.scheduledDate).toBe('2026-03-18')
  })

  it('counts every-N weeks from the Monday-based week containing the start', async () => {
    // Friday 20 March 2026 starts a fortnightly series on Mondays.
    const { journal, clock } = await journalAt('2026-03-20T08:00:00')

    const task = await journal.createTask(
      'retro',
      { date: '2026-03-20', time: null },
      every(2, 'week', [1]),
    )

    // The week containing 20 March is the first active week, and its Monday is
    // before the start, so the first slot is the Monday of the week after next.
    expect(task.scheduledDate).toBe('2026-03-30')

    clock.set(new Date('2026-03-30T20:00:00'))
    expect((await journal.completeTask(task.id)).scheduledDate).toBe('2026-04-13')
  })

  it('takes its weekdays in ascending order however they are given', async () => {
    const { journal } = await journalAt('2026-03-16T08:00:00')

    const task = await journal.createTask(
      'gym',
      { date: '2026-03-16', time: null },
      every(1, 'week', [5, 1, 3, 1]),
    )

    expect(task.recurrence?.weekdays).toEqual([1, 3, 5])
  })
})

describe('month-end and leap-year recovery', () => {
  it('falls back to the last day of a shorter month and returns after it', async () => {
    const { journal, clock } = await journalAt('2026-01-31T08:00:00')

    const task = await journal.createTask(
      'invoice',
      { date: '2026-01-31', time: null },
      every(1, 'month'),
    )
    expect(task.scheduledDate).toBe('2026-01-31')

    clock.set(new Date('2026-01-31T20:00:00'))
    expect((await journal.completeTask(task.id)).scheduledDate).toBe('2026-02-28')

    clock.set(new Date('2026-02-28T20:00:00'))
    expect((await journal.completeTask(task.id)).scheduledDate).toBe('2026-03-31')

    clock.set(new Date('2026-03-31T20:00:00'))
    expect((await journal.completeTask(task.id)).scheduledDate).toBe('2026-04-30')

    clock.set(new Date('2026-04-30T20:00:00'))
    expect((await journal.completeTask(task.id)).scheduledDate).toBe('2026-05-31')
  })

  it('falls back to 28 February and returns on the next leap year', async () => {
    const { journal, clock } = await journalAt('2024-02-29T08:00:00')

    const task = await journal.createTask(
      'leap day',
      { date: '2024-02-29', time: null },
      every(1, 'year'),
    )
    expect(task.scheduledDate).toBe('2024-02-29')

    for (const [completedOn, next] of [
      ['2024-02-29', '2025-02-28'],
      ['2025-02-28', '2026-02-28'],
      ['2026-02-28', '2027-02-28'],
      ['2027-02-28', '2028-02-29'],
    ]) {
      clock.set(new Date(`${completedOn}T20:00:00`))
      expect((await journal.completeTask(task.id)).scheduledDate).toBe(next)
    }
  })
})

describe('completing an overdue occurrence', () => {
  it('skips the slots that were missed rather than opening every one', async () => {
    const { journal, clock } = await journalAt('2026-03-01T08:00:00')

    const task = await journal.createTask(
      'stand-up notes',
      { date: '2026-03-01', time: '09:00' },
      every(1, 'day'),
    )

    // A fortnight away. The occurrence is still 1 March; completing it lands
    // on the next slot that is still ahead, not on 2 March.
    clock.set(new Date('2026-03-15T10:00:00'))
    const advanced = await journal.completeTask(task.id)

    expect(advanced.scheduledDate).toBe('2026-03-16')
    expect(await journal.occurrencesOf(task.id)).toHaveLength(2)
  })

  it('lands on today when today has not reached its own minute yet', async () => {
    const { journal, clock } = await journalAt('2026-03-01T08:00:00')

    const task = await journal.createTask(
      'stand-up notes',
      { date: '2026-03-01', time: '09:00' },
      every(1, 'day'),
    )

    clock.set(new Date('2026-03-15T08:00:00'))
    expect((await journal.completeTask(task.id)).scheduledDate).toBe('2026-03-15')
  })

  it('keeps the completed occurrence in the history of its own Task', async () => {
    const { journal, clock } = await journalAt('2026-03-16T08:00:00')

    const task = await journal.createTask(
      'water the plants',
      { date: '2026-03-16', time: null },
      every(1, 'day'),
    )

    clock.set(new Date('2026-03-16T20:00:00'))
    await journal.completeTask(task.id)

    const history = completedOccurrences(await journal.occurrencesOf(task.id))
    expect(history).toHaveLength(1)
    expect(history[0].scheduledDate).toBe('2026-03-16')
    expect(history[0].completedAt).toBe(new Date('2026-03-16T20:00:00').toISOString())
    expect(await journal.completedTasks()).toEqual([])
  })
})

describe('editing a Recurring Task', () => {
  it('reanchors the series when the starting date changes', async () => {
    const { journal } = await journalAt('2026-03-16T08:00:00')

    const task = await journal.createTask(
      'gym',
      { date: '2026-03-16', time: null },
      every(1, 'week', [1]),
    )

    const moved = await journal.editTask(task.id, {
      description: 'gym',
      schedule: { date: '2026-03-19', time: null },
      recurrence: every(1, 'week', [4]),
    })

    expect(moved.scheduledDate).toBe('2026-03-19')
    expect(moved.recurrenceAnchor).toBe('2026-03-19')
    // Replaced, not completed: nothing went into the history.
    expect(completedOccurrences(await journal.occurrencesOf(task.id))).toEqual([])
    expect(await journal.occurrencesOf(task.id)).toHaveLength(1)
  })

  it('reanchors when only the time changes', async () => {
    const { journal } = await journalAt('2026-03-16T08:00:00')

    const task = await journal.createTask(
      'stand-up',
      { date: '2026-03-16', time: '09:00' },
      every(1, 'day'),
    )
    const before = openOccurrence(await journal.occurrencesOf(task.id))!

    const retimed = await journal.editTask(task.id, {
      description: 'stand-up',
      schedule: { date: '2026-03-16', time: '07:00' },
      recurrence: every(1, 'day'),
    })

    expect(retimed.scheduledTime).toBe('07:00')
    const after = openOccurrence(await journal.occurrencesOf(task.id))!
    expect(after.id).not.toBe(before.id)
    expect(after.advancedFrom).toBeNull()
  })

  it('keeps the intended day of the month when only the time changes', async () => {
    const { journal, clock } = await journalAt('2026-01-31T08:00:00')

    const task = await journal.createTask(
      'invoice',
      { date: '2026-01-31', time: '09:00' },
      every(1, 'month'),
    )
    clock.set(new Date('2026-01-31T20:00:00'))
    const february = await journal.completeTask(task.id)
    expect(february.scheduledDate).toBe('2026-02-28')

    // Retimed while the series stands on February's fallback day. The day the
    // user actually chose is the 31st, and it has to survive the edit.
    clock.set(new Date('2026-02-28T08:00:00'))
    const retimed = await journal.editTask(task.id, {
      description: 'invoice',
      schedule: { date: '2026-02-28', time: '07:00' },
      recurrence: every(1, 'month'),
    })

    expect(retimed.recurrenceAnchor).toBe('2026-01-31')
    expect(retimed.scheduledDate).toBe('2026-02-28')

    clock.set(new Date('2026-02-28T20:00:00'))
    expect((await journal.completeTask(task.id)).scheduledDate).toBe('2026-03-31')
  })

  it('counts from the date on screen once that date itself is changed', async () => {
    const { journal, clock } = await journalAt('2026-01-31T08:00:00')

    const task = await journal.createTask(
      'invoice',
      { date: '2026-01-31', time: null },
      every(1, 'month'),
    )
    clock.set(new Date('2026-01-31T20:00:00'))
    await journal.completeTask(task.id)

    clock.set(new Date('2026-02-01T08:00:00'))
    const moved = await journal.editTask(task.id, {
      description: 'invoice',
      schedule: { date: '2026-02-15', time: null },
      recurrence: every(1, 'month'),
    })

    expect(moved.recurrenceAnchor).toBe('2026-02-15')
    expect(moved.scheduledDate).toBe('2026-02-15')
  })

  it('counts from the date on screen once the cadence itself is changed', async () => {
    const { journal } = await journalAt('2026-01-31T08:00:00')

    const task = await journal.createTask(
      'invoice',
      { date: '2026-01-31', time: null },
      every(1, 'month'),
    )

    const yearly = await journal.editTask(task.id, {
      description: 'invoice',
      schedule: { date: '2026-01-31', time: null },
      recurrence: every(1, 'year'),
    })

    expect(yearly.recurrenceAnchor).toBe('2026-01-31')
  })

  it('reanchors onto the latest elapsed slot, which is Overdue', async () => {
    const { journal } = await journalAt('2026-03-16T10:00:00')

    const task = await journal.createTask(
      'gym',
      { date: '2026-03-16', time: null },
      every(1, 'day'),
    )

    const moved = await journal.editTask(task.id, {
      description: 'gym',
      schedule: { date: '2026-03-01', time: '09:00' },
      recurrence: every(1, 'day'),
    })

    expect(moved.scheduledDate).toBe('2026-03-16')
    expect(moved.scheduledTime).toBe('09:00')
  })

  it('never reopens a kept slot when only the time changes', async () => {
    const { journal, clock } = await journalAt('2026-06-01T08:00:00')

    const task = await journal.createTask(
      'stand-up',
      { date: '2026-06-01', time: '09:00' },
      every(1, 'day'),
    )

    for (let day = 1; day <= 15; day += 1) {
      const label = `2026-06-${String(day).padStart(2, '0')}`
      clock.set(new Date(`${label}T10:00:00`))
      await journal.completeTask(task.id)
    }
    expect(openOccurrence(await journal.occurrencesOf(task.id))!.scheduledDate).toBe(
      '2026-06-16',
    )

    clock.set(new Date('2026-06-15T14:00:00'))
    const retimed = await journal.editTask(task.id, {
      description: 'stand-up',
      schedule: { date: '2026-06-16', time: '10:00' },
      recurrence: every(1, 'day'),
    })

    expect(retimed.scheduledDate).toBe('2026-06-16')
    const kept = completedOccurrences(await journal.occurrencesOf(task.id))
    expect(kept).toHaveLength(15)
    expect(kept.map((one) => one.scheduledDate)).not.toContain('2026-06-16')

    clock.set(new Date('2026-06-16T10:00:00'))
    await journal.completeTask(task.id)
    const dates = completedOccurrences(await journal.occurrencesOf(task.id)).map(
      (one) => one.scheduledDate,
    )
    expect(dates.filter((date) => date === '2026-06-15')).toHaveLength(1)
    expect(dates.filter((date) => date === '2026-06-16')).toHaveLength(1)
  })

  it('prefers today when a series with no history is retimed to later today', async () => {
    const { journal, clock } = await journalAt('2026-06-01T08:00:00')

    const task = await journal.createTask(
      'stand-up',
      { date: '2026-06-01', time: '09:00' },
      every(1, 'day'),
    )

    clock.set(new Date('2026-06-15T14:00:00'))
    const retimed = await journal.editTask(task.id, {
      description: 'stand-up',
      schedule: { date: '2026-06-01', time: '23:00' },
      recurrence: every(1, 'day'),
    })

    expect(retimed.scheduledDate).toBe('2026-06-15')
  })

  it('floors a cadence change past the kept history too', async () => {
    const { journal, clock } = await journalAt('2026-06-01T08:00:00')

    const task = await journal.createTask(
      'stand-up',
      { date: '2026-06-01', time: '09:00' },
      every(1, 'day'),
    )

    for (let day = 1; day <= 15; day += 1) {
      const label = `2026-06-${String(day).padStart(2, '0')}`
      clock.set(new Date(`${label}T10:00:00`))
      await journal.completeTask(task.id)
    }

    clock.set(new Date('2026-06-15T14:00:00'))
    const changed = await journal.editTask(task.id, {
      description: 'stand-up',
      schedule: { date: '2026-06-01', time: '09:00' },
      recurrence: every(1, 'week', [1]),
    })

    expect(changed.scheduledDate).toBe('2026-06-22')
  })

  it('leaves the series exactly where it stands when only the wording changes', async () => {
    const { journal } = await journalAt('2026-03-16T08:00:00')

    const task = await journal.createTask(
      'gym',
      { date: '2026-03-16', time: null },
      every(1, 'day'),
    )
    const before = openOccurrence(await journal.occurrencesOf(task.id))!

    const reworded = await journal.editTask(task.id, {
      description: 'the gym',
      schedule: { date: '2026-03-16', time: null },
      recurrence: every(1, 'day'),
    })

    expect(reworded.description).toBe('the gym')
    expect(openOccurrence(await journal.occurrencesOf(task.id))!.id).toBe(before.id)
  })

  it('turns an ordinary Task into a Recurring one', async () => {
    const { journal } = await journalAt('2026-03-16T08:00:00')

    const task = await journal.createTask('gym', { date: '2026-03-16', time: null })
    expect(await journal.occurrencesOf(task.id)).toEqual([])

    const repeating = await journal.editTask(task.id, {
      description: 'gym',
      schedule: { date: '2026-03-16', time: null },
      recurrence: every(1, 'week', [1]),
    })

    expect(repeating.recurrence).toEqual(every(1, 'week', [1]))
    expect(await journal.occurrencesOf(task.id)).toHaveLength(1)
  })

  it('leaves the cadence alone when an edit does not mention it', async () => {
    const { journal } = await journalAt('2026-03-16T08:00:00')

    const task = await journal.createTask(
      'gym',
      { date: '2026-03-16', time: null },
      every(1, 'day'),
    )

    const reworded = await journal.editTask(task.id, {
      description: 'the gym',
      schedule: { date: '2026-03-16', time: null },
    })

    expect(reworded.recurrence).toEqual(every(1, 'day'))
  })

  it('stops the recurrence when the date is cleared', async () => {
    const { journal } = await journalAt('2026-03-16T08:00:00')

    const task = await journal.createTask(
      'gym',
      { date: '2026-03-16', time: null },
      every(1, 'day'),
    )
    await journal.completeTask(task.id)

    const unscheduled = await journal.editTask(task.id, {
      description: 'gym',
      schedule: null,
    })

    expect(unscheduled.recurrence).toBeNull()
    expect(unscheduled.recurrenceAnchor).toBeNull()
    expect(unscheduled.scheduledDate).toBeNull()
    // The history is retained; only the Open occurrence goes.
    expect(completedOccurrences(await journal.occurrencesOf(task.id))).toHaveLength(1)
    expect(openOccurrence(await journal.occurrencesOf(task.id))).toBeNull()
  })
})

describe('Stop Recurrence', () => {
  it('keeps the Task where it stands and its history under it', async () => {
    const { journal, clock } = await journalAt('2026-03-16T08:00:00')

    const task = await journal.createTask(
      'gym',
      { date: '2026-03-16', time: '09:00' },
      every(1, 'day'),
    )
    clock.set(new Date('2026-03-16T20:00:00'))
    const advanced = await journal.completeTask(task.id)

    const stopped = await journal.stopRecurrence(task.id)

    expect(stopped.recurrence).toBeNull()
    expect(stopped.scheduledDate).toBe(advanced.scheduledDate)
    expect(stopped.scheduledTime).toBe('09:00')
    expect(completedOccurrences(await journal.occurrencesOf(task.id))).toHaveLength(1)
    expect(openOccurrence(await journal.occurrencesOf(task.id))).toBeNull()
  })

  it('leaves an ordinary Task untouched', async () => {
    const { journal } = await journalAt('2026-03-16T08:00:00')

    const task = await journal.createTask('gym', { date: '2026-03-16', time: null })

    expect(await journal.stopRecurrence(task.id)).toEqual(task)
  })

  it('lets the Task be completed like any other afterwards', async () => {
    const { journal, clock } = await journalAt('2026-03-16T08:00:00')

    const task = await journal.createTask(
      'gym',
      { date: '2026-03-16', time: null },
      every(1, 'day'),
    )
    await journal.stopRecurrence(task.id)

    clock.set(new Date('2026-03-16T20:00:00'))
    const completed = await journal.completeTask(task.id)

    expect(completed.completedAt).not.toBeNull()
    expect((await journal.completedTasks()).map((one) => one.id)).toEqual([task.id])
  })
})

describe('Undo Completion', () => {
  async function completedOnce() {
    const { journal, clock, driver } = await journalAt('2026-03-16T08:00:00')
    const task = await journal.createTask(
      'water the plants',
      { date: '2026-03-16', time: null },
      every(1, 'day'),
    )
    clock.set(new Date('2026-03-16T20:00:00'))
    await journal.completeTask(task.id)
    return { journal, clock, driver, task }
  }

  it('restores the completed occurrence and removes what it advanced to', async () => {
    const { journal, driver, task } = await completedOnce()

    const restored = await journal.undoCompletion(task.id)

    expect(restored.scheduledDate).toBe('2026-03-16')
    expect(await journal.occurrencesOf(task.id)).toHaveLength(1)
    expect(await openCount(driver, task.id)).toBe(1)
    expect(completedOccurrences(await journal.occurrencesOf(task.id))).toEqual([])
  })

  it('is offered exactly while it is safe', async () => {
    const { journal, task } = await completedOnce()

    expect(canUndoCompletion(await journal.occurrencesOf(task.id))).toBe(true)

    await journal.undoCompletion(task.id)
    expect(canUndoCompletion(await journal.occurrencesOf(task.id))).toBe(false)
  })

  it('reaches only the latest completion, one at a time', async () => {
    const { journal, clock, task } = await completedOnce()

    clock.set(new Date('2026-03-17T20:00:00'))
    await journal.completeTask(task.id)

    // The latest completion is 17 March, so this is the one that comes back —
    // 16 March stays historical while its successor is completed.
    const restored = await journal.undoCompletion(task.id)
    expect(restored.scheduledDate).toBe('2026-03-17')
    expect(
      (await journal.occurrencesOf(task.id)).map((one) => one.scheduledDate),
    ).toEqual(['2026-03-17', '2026-03-16'])
  })

  it('is refused for an older completion while a later one stands', async () => {
    const { journal, clock, task } = await completedOnce()

    clock.set(new Date('2026-03-17T20:00:00'))
    await journal.completeTask(task.id)

    // 18 March is Open and points back at 17 March, so 16 March is out of
    // reach: undoing it would open two occurrences at once.
    const occurrences = await journal.occurrencesOf(task.id)
    const open = openOccurrence(occurrences)!
    expect(open.scheduledDate).toBe('2026-03-18')
    expect(open.advancedFrom).toBe(
      completedOccurrences(occurrences)[0].id,
    )
    expect(completedOccurrences(occurrences)[1].scheduledDate).toBe('2026-03-16')
  })

  it('is refused once an edit has replaced the successor', async () => {
    const { journal, task } = await completedOnce()

    await journal.editTask(task.id, {
      description: 'water the plants',
      schedule: { date: '2026-03-19', time: null },
      recurrence: every(1, 'day'),
    })

    expect(canUndoCompletion(await journal.occurrencesOf(task.id))).toBe(false)
    await expect(journal.undoCompletion(task.id)).rejects.toThrow(/latest completion/)
  })

  it('is refused on a Task that never repeated', async () => {
    const { journal } = await journalAt('2026-03-16T08:00:00')
    const task = await journal.createTask('gym', { date: '2026-03-16', time: null })
    await journal.completeTask(task.id)

    await expect(journal.undoCompletion(task.id)).rejects.toThrow(/latest completion/)
  })
})

describe('the one-Open-occurrence invariant', () => {
  /**
   * A driver that fails partway through every transaction, exactly as an
   * interruption would: the statements before the failure have already run
   * inside SQLite's own transaction, so what survives is what a crash there
   * would leave behind.
   */
  function interrupted(driver: SqlDriver, after: number): SqlDriver {
    return {
      ...driver,
      transaction(statements: SqlStatement[]) {
        return driver.transaction([
          ...statements.slice(0, after),
          // A statement no schema will take: the transaction is refused from
          // inside, rather than never being started.
          { sql: 'INSERT INTO task_occurrences (id) VALUES (NULL)', params: [] },
          ...statements.slice(after),
        ])
      },
    }
  }

  it('the schema itself refuses a second Open occurrence', async () => {
    const { journal, driver } = await journalAt('2026-03-16T08:00:00')
    const task = await journal.createTask(
      'gym',
      { date: '2026-03-16', time: null },
      every(1, 'day'),
    )

    await expect(
      driver.execute(
        `INSERT INTO task_occurrences
           (id, task_id, scheduled_date, scheduled_time, completed_at, created_at, advanced_from)
         VALUES (?, ?, ?, NULL, NULL, ?, NULL)`,
        ['second', task.id, '2026-03-17', new Date().toISOString()],
      ),
    ).rejects.toThrow()

    expect(await openCount(driver, task.id)).toBe(1)
  })

  it('leaves exactly one Open occurrence when completing is interrupted', async () => {
    const { driver, clock } = await journalAt('2026-03-16T08:00:00')
    const journal = createJournal({ clock, driver })
    const task = await journal.createTask(
      'gym',
      { date: '2026-03-16', time: null },
      every(1, 'day'),
    )

    for (const after of [1, 2]) {
      const brittle = createJournal({ clock, driver: interrupted(driver, after) })
      await expect(brittle.completeTask(task.id)).rejects.toThrow()

      expect(await openCount(driver, task.id)).toBe(1)
      const occurrences = await journal.occurrencesOf(task.id)
      expect(occurrences).toHaveLength(1)
      expect(occurrences[0].scheduledDate).toBe('2026-03-16')
    }

    // And the ordinary path still works afterwards.
    expect((await journal.completeTask(task.id)).scheduledDate).toBe('2026-03-17')
  })

  it('leaves exactly one Open occurrence when undoing is interrupted', async () => {
    const { driver, clock } = await journalAt('2026-03-16T08:00:00')
    const journal = createJournal({ clock, driver })
    const task = await journal.createTask(
      'gym',
      { date: '2026-03-16', time: null },
      every(1, 'day'),
    )
    clock.set(new Date('2026-03-16T20:00:00'))
    await journal.completeTask(task.id)

    for (const after of [1, 2]) {
      const brittle = createJournal({ clock, driver: interrupted(driver, after) })
      await expect(brittle.undoCompletion(task.id)).rejects.toThrow()

      expect(await openCount(driver, task.id)).toBe(1)
      expect(canUndoCompletion(await journal.occurrencesOf(task.id))).toBe(true)
    }

    expect((await journal.undoCompletion(task.id)).scheduledDate).toBe('2026-03-16')
  })

  it('leaves exactly one Open occurrence when reanchoring is interrupted', async () => {
    const { driver, clock } = await journalAt('2026-03-16T08:00:00')
    const journal = createJournal({ clock, driver })
    const task = await journal.createTask(
      'gym',
      { date: '2026-03-16', time: null },
      every(1, 'day'),
    )
    clock.set(new Date('2026-03-16T20:00:00'))
    await journal.completeTask(task.id)

    // An edit replaces the Open occurrence: the rule, the head and the
    // occurrence move together or not at all.
    for (const after of [1, 2]) {
      const brittle = createJournal({ clock, driver: interrupted(driver, after) })
      await expect(
        brittle.editTask(task.id, {
          description: 'gym',
          schedule: { date: '2026-03-20', time: null },
          recurrence: every(1, 'day'),
        }),
      ).rejects.toThrow()

      expect(await openCount(driver, task.id)).toBe(1)
      const [standing] = await journal.openTasks()
      expect(standing.scheduledDate).toBe('2026-03-17')
      expect(standing.recurrenceAnchor).toBe('2026-03-16')
      expect(openOccurrence(await journal.occurrencesOf(task.id))?.scheduledDate).toBe(
        '2026-03-17',
      )
      expect(completedOccurrences(await journal.occurrencesOf(task.id))).toHaveLength(1)
    }

    // And the ordinary path still works afterwards.
    const reanchored = await journal.editTask(task.id, {
      description: 'gym',
      schedule: { date: '2026-03-20', time: null },
      recurrence: every(1, 'day'),
    })
    expect(reanchored.scheduledDate).toBe('2026-03-20')
    expect(await openCount(driver, task.id)).toBe(1)
    expect(completedOccurrences(await journal.occurrencesOf(task.id))).toHaveLength(1)
  })

  it('leaves the series intact when Stop Recurrence is interrupted', async () => {
    const { driver, clock } = await journalAt('2026-03-16T08:00:00')
    const journal = createJournal({ clock, driver })
    const task = await journal.createTask(
      'gym',
      { date: '2026-03-16', time: null },
      every(1, 'day'),
    )
    clock.set(new Date('2026-03-16T20:00:00'))
    await journal.completeTask(task.id)

    // Stopping drops the rule and the Open occurrence together: a Task that
    // kept its rule and lost its occurrence would be a series asking for
    // nothing.
    const brittle = createJournal({ clock, driver: interrupted(driver, 1) })
    await expect(brittle.stopRecurrence(task.id)).rejects.toThrow()

    expect(await openCount(driver, task.id)).toBe(1)
    const [standing] = await journal.openTasks()
    expect(standing.recurrence).toEqual(every(1, 'day'))
    expect(standing.scheduledDate).toBe('2026-03-17')
    expect(await journal.occurrencesOf(task.id)).toHaveLength(2)

    const stopped = await journal.stopRecurrence(task.id)
    expect(stopped.recurrence).toBeNull()
    expect(stopped.scheduledDate).toBe('2026-03-17')
    expect(await openCount(driver, task.id)).toBe(0)
    expect(completedOccurrences(await journal.occurrencesOf(task.id))).toHaveLength(1)
  })

  it('leaves the whole Task behind when deleting is interrupted', async () => {
    const { driver, clock } = await journalAt('2026-03-16T08:00:00')
    const journal = createJournal({ clock, driver })
    const task = await journal.createTask(
      'gym',
      { date: '2026-03-16', time: null },
      every(1, 'day'),
    )
    clock.set(new Date('2026-03-16T20:00:00'))
    await journal.completeTask(task.id)

    const brittle = createJournal({ clock, driver: interrupted(driver, 1) })
    await expect(brittle.deleteTask(task.id)).rejects.toThrow()

    expect((await journal.openTasks()).map((one) => one.id)).toEqual([task.id])
    expect(await journal.occurrencesOf(task.id)).toHaveLength(2)
  })
})

describe('the occurrences of a whole list', () => {
  it('gathers them under their Tasks in one read, and omits the Tasks with none', async () => {
    const { journal, clock } = await journalAt('2026-03-16T08:00:00')
    const repeating = await journal.createTask(
      'gym',
      { date: '2026-03-16', time: null },
      every(1, 'day'),
    )
    const ordinary = await journal.createTask('post the letter', null)
    clock.set(new Date('2026-03-16T20:00:00'))
    await journal.completeTask(repeating.id)

    const each = await journal.occurrencesOfEach([repeating.id, ordinary.id])

    // The same answer the one-Task read gives, in the same order.
    expect(each[repeating.id]).toEqual(await journal.occurrencesOf(repeating.id))
    expect(each[repeating.id]).toHaveLength(2)
    expect(ordinary.id in each).toBe(false)
  })

  it('asks nothing at all for an empty list', async () => {
    const { journal } = await journalAt('2026-03-16T08:00:00')

    expect(await journal.occurrencesOfEach([])).toEqual({})
  })
})

describe('deleting a Recurring Task', () => {
  it('takes its whole occurrence history with it', async () => {
    const { journal, clock, driver } = await journalAt('2026-03-16T08:00:00')
    const task = await journal.createTask(
      'gym',
      { date: '2026-03-16', time: null },
      every(1, 'day'),
    )
    clock.set(new Date('2026-03-16T20:00:00'))
    await journal.completeTask(task.id)

    await journal.deleteTask(task.id)

    expect(await journal.openTasks()).toEqual([])
    const rows = await driver.select<{ id: string }>(
      'SELECT id FROM task_occurrences',
      [],
    )
    expect(rows).toEqual([])
  })
})

describe('cadence across timezones and DST', () => {
  it('keeps the wall-clock time whatever the offset does', async () => {
    // 25 October 2026 is the day Lisbon's clocks go back.
    const { journal, clock } = await journalAt('2026-10-23T08:00:00')

    const task = await journal.createTask(
      'stand-up',
      { date: '2026-10-23', time: '09:00' },
      every(1, 'day'),
    )

    clock.set(new Date('2026-10-23T20:00:00'))
    const saturday = await journal.completeTask(task.id)
    expect(saturday.scheduledDate).toBe('2026-10-24')
    expect(saturday.scheduledTime).toBe('09:00')

    clock.set(new Date('2026-10-24T20:00:00'))
    const sunday = await journal.completeTask(task.id)
    // The day the clocks change is still one day later at the same wall clock.
    expect(sunday.scheduledDate).toBe('2026-10-25')
    expect(sunday.scheduledTime).toBe('09:00')
  })

  it('advances over a spring transition without losing a day', async () => {
    // 29 March 2026 is the day Lisbon's clocks go forward at 01:00.
    const { journal, clock } = await journalAt('2026-03-28T08:00:00')

    const task = await journal.createTask(
      'early start',
      { date: '2026-03-28', time: '01:30' },
      every(1, 'day'),
    )

    clock.set(new Date('2026-03-28T20:00:00'))
    const skipped = await journal.completeTask(task.id)

    expect(skipped.scheduledDate).toBe('2026-03-29')
    expect(skipped.scheduledTime).toBe('01:30')
  })

  it('follows the traveller: the same instant, a different civil day', () => {
    const daily = every(1, 'day')
    // 01:00 UTC on 17 March is 01:00 in Lisbon and 10:00 in Tokyo.
    const now = new Date('2026-03-17T01:00:00Z')

    expect(
      advancedSlot('2026-03-16', daily, '09:00', '2026-03-16', now, 'Europe/Lisbon'),
      // 09:00 on 17 March is still ahead of a traveller in Lisbon.
    ).toBe('2026-03-17')
    expect(
      advancedSlot('2026-03-16', daily, '09:00', '2026-03-16', now, 'Asia/Tokyo'),
      // The same instant in Tokyo is already past 09:00, so the next slot is.
    ).toBe('2026-03-18')
  })
})

describe('openingSlot and advancedSlot as pure calendar arithmetic', () => {
  const now = new Date('2026-03-16T10:00:00Z')

  it('opens a future series on its first slot', () => {
    expect(
      openingSlot('2026-04-01', every(1, 'month'), null, now, 'Europe/Lisbon'),
    ).toBe('2026-04-01')
  })

  it('opens a past series on its latest elapsed slot', () => {
    expect(
      openingSlot('2025-04-01', every(1, 'month'), null, now, 'Europe/Lisbon'),
    ).toBe('2026-03-01')
  })

  it('never goes backwards from the occurrence being completed', () => {
    expect(
      advancedSlot(
        '2026-01-01',
        every(1, 'day'),
        null,
        '2026-06-01',
        now,
        'Europe/Lisbon',
      ),
    ).toBe('2026-06-02')
  })

  it('resumes on today when today is still ahead, where opening steps back', () => {
    // 10:00 UTC on 16 March is 10:00 in Lisbon, so 23:00 today is ahead.
    expect(
      openingSlot('2026-03-01', every(1, 'day'), '23:00', now, 'Europe/Lisbon'),
    ).toBe('2026-03-15')
    expect(
      resumedSlot('2026-03-01', every(1, 'day'), '23:00', now, 'Europe/Lisbon'),
    ).toBe('2026-03-16')
  })
})

describe('sameRecurrence', () => {
  it('reads two identical cadences as one', () => {
    expect(sameRecurrence(every(2, 'week', [1, 3]), every(2, 'week', [1, 3]))).toBe(true)
    expect(sameRecurrence(null, null)).toBe(true)
  })

  it('tells apart the unit, the interval and the weekdays', () => {
    expect(sameRecurrence(every(1, 'week', [1]), every(1, 'day'))).toBe(false)
    expect(sameRecurrence(every(1, 'week', [1]), every(2, 'week', [1]))).toBe(false)
    expect(sameRecurrence(every(1, 'week', [1]), every(1, 'week', [1, 3]))).toBe(false)
    expect(sameRecurrence(every(1, 'day'), null)).toBe(false)
  })
})

describe('formatRecurrence', () => {
  it('says a cadence the way both the app and an export write it', () => {
    expect(formatRecurrence(every(1, 'day'))).toBe('every day')
    expect(formatRecurrence(every(3, 'day'))).toBe('every 3 days')
    expect(formatRecurrence(every(1, 'month'))).toBe('every month')
    expect(formatRecurrence(every(2, 'year'))).toBe('every 2 years')
    expect(formatRecurrence(every(1, 'week', [1]))).toBe('every week on Monday')
    expect(formatRecurrence(every(1, 'week', [1, 3]))).toBe(
      'every week on Monday and Wednesday',
    )
    expect(formatRecurrence(every(2, 'week', [1, 3, 5]))).toBe(
      'every 2 weeks on Monday, Wednesday and Friday',
    )
  })
})

describe('exporting a Recurring Task', () => {
  it('writes the cadence under the Task and its occurrences beneath it', async () => {
    const { journal, clock } = await journalAt('2026-03-16T08:00:00')

    const task = await journal.createTask(
      'water the plants',
      { date: '2026-03-16', time: '09:00' },
      every(1, 'day'),
    )
    clock.set(new Date('2026-03-16T20:00:00'))
    await journal.completeTask(task.id)

    const exported = await journal.exportJournal()

    expect(exported.markdown).toBe(
      [
        '# Tasks',
        '',
        '## Open',
        '- [ ] water the plants (scheduled 2026-03-17 09:00; repeats every day)',
        '  - occurrence 2026-03-16 09:00 (completed Mon 16 Mar, 20:00)',
      ].join('\n'),
    )
    // One Task, however many occurrences are under it.
    expect(exported.taskCount).toBe(1)
  })

  it('writes a date-only cadence without inventing a time', async () => {
    const { journal } = await journalAt('2026-03-16T08:00:00')

    await journal.createTask(
      'gym',
      { date: '2026-03-16', time: null },
      every(1, 'week', [1, 4]),
    )

    expect((await journal.exportJournal()).markdown).toContain(
      '- [ ] gym (scheduled 2026-03-16; repeats every week on Monday and Thursday)',
    )
  })

  it('writes an unscheduled Task that once repeated without a cadence', async () => {
    const { journal } = await journalAt('2026-03-16T08:00:00')

    const task = await journal.createTask(
      'gym',
      { date: '2026-03-16', time: null },
      every(1, 'day'),
    )
    await journal.editTask(task.id, { description: 'gym', schedule: null })

    expect((await journal.exportJournal()).markdown).toContain('## Open\n- [ ] gym')
  })
})

describe('the schema keeps one occurrence per slot', () => {
  /**
   * An in-memory database built by migrations 1–6 alone — the shape a journal
   * carried before migration 7 — so the de-duplication runs against what the
   * bug actually left behind, not against a hand-shaped copy. Six files, by
   * position: the seventh is the one under test, applied by hand below.
   */
  async function journalAtVersion6() {
    const database = new DatabaseSync(':memory:')
    // Production is sqlx, which enables foreign keys by default. The harness
    // must match, or these tests run against a laxer database than ships.
    database.exec('PRAGMA foreign_keys = ON')
    const migrations = Array.from({ length: 6 }, (_, position) =>
      migrationAt(position),
    )
    for (const sql of migrations) database.exec(sql)

    // The whole of a script at once, the way sqlx runs a migration — one
    // transaction, every statement. The per-statement driver below is the app's
    // ordinary writes; the migration under test is a script.
    const execScript = (sql: string) => database.exec(sql)

    /** Direct SQL, as the de-duplication itself is written. */
    const driver: SqlDriver = {
      async execute(sql, params) {
        database.prepare(sql).run(...(params as never[]))
      },
      async select<Row>(sql: string, params: unknown[]) {
        return database.prepare(sql).all(...(params as never[])) as Row[]
      },
      async transaction(statements) {
        database.exec('BEGIN')
        try {
          for (const { sql, params } of statements) {
            database.prepare(sql).run(...(params as never[]))
          }
          database.exec('COMMIT')
        } catch (error) {
          database.exec('ROLLBACK')
          throw error
        }
      },
    }
    return { driver, execScript, close: () => database.close() }
  }

  /**
   * Migration 7 by position — the seventh file is the one under test here,
   * applied by hand onto the version 6 shape. Never the last file: later
   * migrations exist, and the last file is no longer this one.
   */
  function migration7(): string {
    return migrationAt(6)
  }

  /**
   * A series that has kept through June 15th: one row per day, the newest kept
   * pointing back at the one whose completion advanced to it — the chain
   * `canUndoCompletion` reads. Seeded by hand, exactly as the app's own writes
   * left it before migration 7.
   */
  async function seedSeriesThroughJune15th(driver: SqlDriver): Promise<void> {
    await driver.execute(
      `INSERT INTO tasks (id, description, created_at, scheduled_date, scheduled_time,
                          recurrence_unit, recurrence_interval, recurrence_anchor_date)
       VALUES ('t1', 'stand-up', '2026-05-20T09:00:00.000Z', '2026-06-16', '09:00',
               'day', 1, '2026-06-01')`,
      [],
    )

    let previous = ''
    for (let day = 1; day <= 15; day += 1) {
      const date = `2026-06-${String(day).padStart(2, '0')}`
      const id = `occ-${date}`
      await driver.execute(
        `INSERT INTO task_occurrences (id, task_id, scheduled_date, scheduled_time,
                                       completed_at, created_at, advanced_from)
         VALUES (?, 't1', ?, '09:00', ?, ?, ?)`,
        [id, date, `2026-06-${String(day).padStart(2, '0')}T10:00:00.000Z`,
         `2026-06-${String(day).padStart(2, '0')}T10:00:00.000Z`, day === 1 ? null : previous],
      )
      previous = id
    }

    // The Open occurrence the completion on the 15th advanced to.
    await driver.execute(
      `INSERT INTO task_occurrences (id, task_id, scheduled_date, scheduled_time,
                                     completed_at, created_at, advanced_from)
       VALUES ('occ-open', 't1', '2026-06-16', '09:00', NULL,
               '2026-06-15T10:00:00.000Z', 'occ-2026-06-15')`,
      [],
    )
  }

  /**
   * The history-corruption route behind #186 and ADR 0037: a retimed edit
   * landed the Open occurrence on a slot the series had already kept, and
   * completing it wrote a second completion for the same day. Reproduced by
   * hand against the version 6 schema, which cannot refuse it.
   */
  async function seedDuplicatedSlot(driver: SqlDriver): Promise<void> {
    await seedSeriesThroughJune15th(driver)
    await driver.execute(
      `INSERT INTO task_occurrences (id, task_id, scheduled_date, scheduled_time,
                                     completed_at, created_at, advanced_from)
       VALUES ('occ-2026-06-15-later', 't1', '2026-06-15', '14:00',
               '2026-06-15T14:30:00.000Z', '2026-06-15T14:30:00.000Z', NULL)`,
      [],
    )
  }

  it('de-duplicates a kept slot to the earliest completion and leaves Undo safe', async () => {
    const { driver, execScript, close } = await journalAtVersion6()
    openJournals.push(close)
    await seedDuplicatedSlot(driver)

    execScript(migration7())

    const rows = await driver.select<{ id: string; completed_at: string }>(
      `SELECT id, completed_at FROM task_occurrences
       WHERE task_id = 't1' AND scheduled_date = '2026-06-15'`,
      [],
    )
    expect(rows.map((row) => row.id)).toEqual(['occ-2026-06-15'])
    expect(rows[0].completed_at).toBe('2026-06-15T10:00:00.000Z')

    // The chain the de-duplication must not break: the Open occurrence still
    // points at the surviving completion, so Undo Completion stays on offer.
    const open = await driver.select<{ advanced_from: string }>(
      `SELECT advanced_from FROM task_occurrences WHERE id = 'occ-open'`,
      [],
    )
    expect(open[0].advanced_from).toBe('occ-2026-06-15')
  })

  it('re-points advanced_from when the pointer names the occurrence that goes', async () => {
    const { driver, execScript, close } = await journalAtVersion6()
    openJournals.push(close)
    // This time the Open occurrence points at the later completion, so the
    // de-duplication has to move the pointer to what survives.
    await seedSeriesThroughJune15th(driver)
    await driver.execute(
      `INSERT INTO task_occurrences (id, task_id, scheduled_date, scheduled_time,
                                     completed_at, created_at, advanced_from)
       VALUES ('occ-2026-06-15-later', 't1', '2026-06-15', '14:00',
               '2026-06-15T14:30:00.000Z', '2026-06-15T14:30:00.000Z', NULL)`,
      [],
    )
    await driver.execute(
      `UPDATE task_occurrences SET advanced_from = 'occ-2026-06-15-later'
       WHERE id = 'occ-open'`,
      [],
    )

    execScript(migration7())

    const open = await driver.select<{ advanced_from: string }>(
      `SELECT advanced_from FROM task_occurrences WHERE id = 'occ-open'`,
      [],
    )
    expect(open[0].advanced_from).toBe('occ-2026-06-15')
  })

  it('still reads Undo Completion as safe after de-duplication', async () => {
    const { driver, execScript, close } = await journalAtVersion6()
    openJournals.push(close)
    await seedDuplicatedSlot(driver)
    execScript(migration7())

    const occurrences = await driver.select<{
      id: string
      completed_at: string | null
      advanced_from: string | null
    }>('SELECT id, completed_at, advanced_from FROM task_occurrences WHERE task_id = \'t1\'', [])
    const mapped: TaskOccurrence[] = occurrences.map((row) => ({
      id: row.id,
      taskId: 't1',
      scheduledDate: '',
      scheduledTime: null,
      completedAt: row.completed_at,
      createdAt: '',
      advancedFrom: row.advanced_from,
    }))

    expect(canUndoCompletion(mapped)).toBe(true)
  })

  it('the schema refuses a second kept occurrence on a slot the series kept', async () => {
    const { journal, driver } = await journalAt('2026-03-16T08:00:00')
    const task = await journal.createTask(
      'gym',
      { date: '2026-03-16', time: null },
      every(1, 'day'),
    )
    await journal.completeTask(task.id)

    // The route ADR 0037 closed in the application, now closed in the schema:
    // no route may write a second completion for the same day again.
    await expect(
      driver.execute(
        `INSERT INTO task_occurrences
           (id, task_id, scheduled_date, scheduled_time, completed_at, created_at, advanced_from)
         VALUES ('second', ?, '2026-03-16', '14:00', '2026-03-16T14:00:00.000Z',
                 '2026-03-16T14:00:00.000Z', NULL)`,
        [task.id],
      ),
    ).rejects.toThrow()
  })

  it('migrates a journal whose Open occurrence stands on a kept date', async () => {
    const { driver, execScript, close } = await journalAtVersion6()
    openJournals.push(close)
    await seedSeriesThroughJune15th(driver)
    // Pre-0037: the head was retimed onto the day just kept. Nothing is
    // duplicated yet, but the kept 15th and the Open 15th are both there — a
    // naive index over all rows would refuse the migrated state and fail the
    // launch that runs migration 7.
    await driver.execute(
      `UPDATE task_occurrences
       SET scheduled_date = '2026-06-15', scheduled_time = '14:00', advanced_from = NULL
       WHERE id = 'occ-open'`,
      [],
    )

    expect(() => execScript(migration7())).not.toThrow()

    const rows = await driver.select<{ id: string; completed_at: string | null }>(
      `SELECT id, completed_at FROM task_occurrences
       WHERE task_id = 't1' AND scheduled_date = '2026-06-15'`,
      [],
    )
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === 'occ-open')!.completed_at).toBeNull()
    expect(rows.find((row) => row.id === 'occ-2026-06-15')!.completed_at).not.toBeNull()
  })

  it('does not constrain the Open occurrence, which may stand on a kept date', async () => {
    const { journal, driver } = await journalAt('2026-03-16T08:00:00')
    const task = await journal.createTask(
      'gym',
      { date: '2026-03-16', time: null },
      every(1, 'day'),
    )
    await journal.completeTask(task.id)

    // The undo middle state: the successor is gone, the series' one Open
    // occurrence reopening on the date it kept. The one-Open index governs
    // how many Open rows there are; the slot index governs only kept ones —
    // which is what makes it partial.
    await driver.execute(
      'DELETE FROM task_occurrences WHERE task_id = ? AND completed_at IS NULL',
      [task.id],
    )
    await expect(
      driver.execute(
        `INSERT INTO task_occurrences
           (id, task_id, scheduled_date, scheduled_time, completed_at, created_at, advanced_from)
         VALUES ('open-on-kept-date', ?, '2026-03-16', NULL, NULL,
                 '2026-03-16T12:00:00.000Z', NULL)`,
        [task.id],
      ),
    ).resolves.toBeUndefined()
  })
})
