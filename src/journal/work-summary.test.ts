import { afterEach, describe, expect, it } from 'vitest'
import {
  createJournal,
  formatDayRange,
  formatSlot,
  isOpen,
  slotOf,
  type CalendarEvent,
  type Journal,
} from './journal'
import { fixedClock, openTestDatabase } from './testing/database'
import {
  buildWorkSummaryMaterial,
  selectWorkSummary,
  workSummaryRefuses,
} from './work-summary'

// Work Summary Material is tested at the Journal boundary like Standup and
// Review Material were: real SQL proves the section selects the records the
// user sees, while the clock makes the This-week range deterministic.
//
// The week under test runs Monday 2026-03-09 through Thursday 2026-03-12.
// The range arrives settled — the view fixes it when the Main Window opens —
// so these tests pass it explicitly rather than through the clock.
const WEEK = { from: '2026-03-09', to: '2026-03-12' }
const MONDAY = { from: '2026-03-09', to: '2026-03-09' }
const JULY_WEEK = { from: '2026-06-29', to: '2026-07-03' }

const openJournals: Array<() => void> = []

afterEach(() => {
  for (const close of openJournals.splice(0)) close()
})

async function journalAt(instant: string): Promise<{
  journal: Journal
  clock: ReturnType<typeof fixedClock>
}> {
  const { driver, close } = await openTestDatabase()
  openJournals.push(close)
  const clock = fixedClock(instant)
  return { journal: createJournal({ clock, driver }), clock }
}

function local(wallClock: string): Date {
  return new Date(wallClock)
}

function event(
  overrides: Omit<Partial<CalendarEvent>, 'startsAt' | 'endsAt'> & {
    startsAt: string
    endsAt: string
  },
): CalendarEvent {
  return {
    id: 'event-1',
    calendarId: 'work',
    title: 'Weekly sync',
    isAllDay: false,
    isDeclined: false,
    ...overrides,
    startsAt: local(overrides.startsAt).getTime(),
    endsAt: local(overrides.endsAt).getTime(),
  }
}

describe('selectWorkSummary', () => {
  it('selects the settled range inclusively, leaving out older days', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:00:00')

    clock.set(new Date('2026-03-08T10:00:00'))
    await journal.capture('last week’s note')
    clock.set(new Date('2026-03-09T00:10:00'))
    await journal.capture('monday’s note')
    clock.set(new Date('2026-03-12T08:55:00'))
    await journal.capture('today’s note')
    clock.set(new Date('2026-03-12T09:00:00'))

    const selected = await selectWorkSummary({ journal, range: WEEK })

    expect(selected.from).toBe('2026-03-09')
    expect(selected.to).toBe('2026-03-12')
    expect(selected.digest.noteCount).toBe(2)
    expect(selected.digest.markdown).toContain('monday’s note')
    expect(selected.digest.markdown).toContain('today’s note')
    expect(selected.digest.markdown).not.toContain('last week’s note')
  })

  it('selects a Monday alone as a single-day range', async () => {
    const { journal } = await journalAt('2026-03-09T09:00:00')

    await journal.capture('monday’s note')

    const selected = await selectWorkSummary({ journal, range: MONDAY })

    expect(selected.from).toBe('2026-03-09')
    expect(selected.to).toBe('2026-03-09')
    expect(selected.digest.noteCount).toBe(1)
    expect(selected.digest.markdown).toContain('monday’s note')
  })

  it('includes Imported Notes filed in the range', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:00:00')

    clock.set(new Date('2026-03-10T18:40:00'))
    await journal.capture('a captured note')
    await journal.importMeeting(
      event({
        title: 'Weekly sync',
        startsAt: '2026-03-10T09:30',
        endsAt: '2026-03-10T10:00',
      }),
    )
    clock.set(new Date('2026-03-12T09:00:00'))

    const selected = await selectWorkSummary({ journal, range: WEEK })

    expect(selected.digest.noteCount).toBe(2)
    expect(selected.digest.markdown).toContain('a captured note')
    expect(selected.digest.markdown).toContain('Weekly sync')
  })

  it('leaves out a Note refiled out of the range', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:00:00')

    clock.set(new Date('2026-03-10T09:00:00'))
    const note = await journal.capture('moved away')
    await journal.refile(note!.id, '2026-03-08')
    clock.set(new Date('2026-03-12T09:00:00'))

    const selected = await selectWorkSummary({ journal, range: WEEK })

    expect(selected.digest.noteCount).toBe(0)
    expect(selected.digest.markdown).toBe('')
  })

  it('selects ordinary Tasks by Task Completed At, not Scheduled For or Task Created At', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:00:00')

    // Scheduled long ago, kept this week: this week's accomplishment.
    clock.set(new Date('2026-03-10T09:00:00'))
    const keptLate = await journal.createTask('kept late', {
      date: '2026-02-01',
      time: null,
    })
    await journal.completeTask(keptLate.id)

    // Scheduled this week, kept last week: last week's accomplishment.
    clock.set(new Date('2026-03-08T10:00:00'))
    const keptEarly = await journal.createTask('kept early', {
      date: '2026-03-11',
      time: null,
    })
    await journal.completeTask(keptEarly.id)
    clock.set(new Date('2026-03-12T09:00:00'))

    const selected = await selectWorkSummary({ journal, range: WEEK })

    expect(selected.completedTasks.map((task) => task.description)).toEqual([
      'kept late',
    ])
  })

  it('keeps completions on both inclusive boundaries', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:00:00')

    clock.set(new Date('2026-03-09T00:10:00'))
    const first = await journal.createTask('first boundary')
    await journal.completeTask(first.id)

    clock.set(new Date('2026-03-12T08:50:00'))
    const last = await journal.createTask('last boundary')
    await journal.completeTask(last.id)

    clock.set(new Date('2026-03-08T10:00:00'))
    const before = await journal.createTask('before')
    await journal.completeTask(before.id)
    clock.set(new Date('2026-03-12T09:00:00'))

    const selected = await selectWorkSummary({ journal, range: WEEK })

    expect(
      selected.completedTasks.map((task) => task.description).sort(),
    ).toEqual(['first boundary', 'last boundary'])
  })

  it('files a completion just after local midnight under the same day for both record types', async () => {
    // July: Europe/Lisbon is at UTC+1, so 00:30 local on the 2nd is stored
    // 2026-07-01T23:30Z. The two records completed at that one instant must
    // land in the same week — the local Journal Day both were kept on —
    // whichever query read them. 2026-07-03 is a Friday, so the week runs
    // Monday 2026-06-29 through Friday 2026-07-03.
    const { journal, clock } = await journalAt('2026-07-01T23:05:00')
    const daily = await journal.createTask(
      'water the plants',
      { date: '2026-07-01', time: '23:00' },
      { unit: 'day', interval: 1, weekdays: [] },
    )
    const ordinary = await journal.createTask('the ordinary one')

    clock.set(new Date('2026-07-02T00:30:00'))
    await journal.completeTask(daily.id)
    await journal.completeTask(ordinary.id)
    clock.set(new Date('2026-07-03T09:00:00'))

    const selected = await selectWorkSummary({ journal, range: JULY_WEEK })
    expect(selected.completedTasks.map((task) => task.description)).toEqual([
      'the ordinary one',
    ])
    expect(selected.completedOccurrences).toHaveLength(1)
    expect(
      formatSlot(slotOf(selected.completedOccurrences[0].occurrence)),
    ).toBe('2026-07-01 23:00')
  })

  it('selects every currently Open Task, whatever its schedule', async () => {
    const { journal } = await journalAt('2026-03-12T09:00:00')

    await journal.createTask('overdue', { date: '2026-03-10', time: null })
    await journal.createTask('today', { date: '2026-03-12', time: '17:00' })
    await journal.createTask('upcoming', { date: '2026-03-13', time: null })
    await journal.createTask('unscheduled')

    const selected = await selectWorkSummary({ journal, range: WEEK })

    expect(
      selected.openTasks.map((task) => task.description).sort(),
    ).toEqual(['overdue', 'today', 'unscheduled', 'upcoming'])
  })

  it('returns both halves empty when there is nothing to say', async () => {
    const { journal } = await journalAt('2026-03-12T09:00:00')

    const selected = await selectWorkSummary({ journal, range: WEEK })

    expect(selected).toEqual({
      from: '2026-03-09',
      to: '2026-03-12',
      digest: { markdown: '', noteCount: 0 },
      completedTasks: [],
      completedOccurrences: [],
      openTasks: [],
    })
  })

  it('selects occurrences completed in the range with their parent Tasks, and never the parent as completed', async () => {
    const { journal, clock } = await journalAt('2026-03-09T08:00:00')
    const daily = await journal.createTask(
      'water the plants',
      { date: '2026-03-09', time: '09:00' },
      { unit: 'day', interval: 1, weekdays: [] },
    )

    clock.set(new Date('2026-03-09T10:00:00'))
    await journal.completeTask(daily.id) // Monday's slot kept…

    clock.set(new Date('2026-03-12T09:00:00'))
    const selected = await selectWorkSummary({ journal, range: WEEK })

    // …and the parent continues among the current commitments.
    expect(selected.completedOccurrences).toHaveLength(1)
    expect(selected.completedOccurrences[0].occurrence.taskId).toBe(daily.id)
    expect(
      formatSlot(slotOf(selected.completedOccurrences[0].occurrence)),
    ).toBe('2026-03-09 09:00')
    expect(isOpen(selected.completedOccurrences[0].task)).toBe(true)
    expect(selected.completedOccurrences[0].task.completedAt).toBeNull()
    expect(
      selected.openTasks.some((task) => task.id === daily.id),
    ).toBe(true)
    // The parent Task riding along reads whole — still Open, never completed.
    expect(
      selected.completedTasks.some((task) => task.id === daily.id),
    ).toBe(false)
  })

  it('works with Tasks but no Notes', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:00:00')

    const kept = await journal.createTask('kept tuesday')
    clock.set(new Date('2026-03-10T10:00:00'))
    await journal.completeTask(kept.id)
    clock.set(new Date('2026-03-12T09:00:00'))
    await journal.createTask('still open')

    const selected = await selectWorkSummary({ journal, range: WEEK })

    expect(selected.digest.noteCount).toBe(0)
    expect(selected.completedTasks.map((task) => task.description)).toEqual([
      'kept tuesday',
    ])
    expect(workSummaryRefuses(selected)).toBe(false)
  })
})

describe('buildWorkSummaryMaterial', () => {
  it('builds the range Digest verbatim, then the completions and the current commitments', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:00:00')

    clock.set(new Date('2026-03-09T09:00:00'))
    await journal.capture('#ops shipped the migration')
    const keptMonday = await journal.createTask('kept monday')
    await journal.completeTask(keptMonday.id)
    clock.set(new Date('2026-03-11T09:00:00'))
    await journal.capture('plain note')
    clock.set(new Date('2026-03-12T09:00:00'))
    await journal.createTask('overdue', { date: '2026-03-10', time: null })
    await journal.createTask('unscheduled')

    const selection = await selectWorkSummary({ journal, range: WEEK })
    const userContent = buildWorkSummaryMaterial(selection)

    // The Notes half is exactly what the journal's Digest renders — the same
    // Markdown History would copy — and the Tasks are one bullet each, with
    // the current commitments explicitly identified as current.
    expect(userContent).toBe(
      `# ${formatDayRange('2026-03-09', '2026-03-12')}\n` +
        `\n## Mon 9 Mar\n- #ops shipped the migration\n\n## Wed 11 Mar\n- plain note\n` +
        `\n## Completed\n### Mon 9 Mar\n- [x] kept monday\n` +
        `\n## Currently open\n- [ ] overdue (scheduled 2026-03-10)\n- [ ] unscheduled`,
    )
  })

  it('names the year of each completion day when the range crosses a year', async () => {
    const { journal, clock } = await journalAt('2025-12-31T09:00:00')
    const last = await journal.createTask('closed last year')
    await journal.completeTask(last.id)
    clock.set(new Date('2026-01-02T09:00:00'))
    const next = await journal.createTask('closed this year')
    await journal.completeTask(next.id)

    const selection = await selectWorkSummary({
      journal,
      range: { from: '2025-12-31', to: '2026-01-02' },
    })
    const userContent = buildWorkSummaryMaterial(selection)

    expect(userContent).toContain(
      '## Completed\n### Wed 31 Dec 2025\n- [x] closed last year\n### Fri 2 Jan 2026\n- [x] closed this year',
    )
  })

  it('builds commitments alone when the range holds no accomplishments', async () => {
    const { journal } = await journalAt('2026-03-12T09:00:00')

    await journal.createTask('today', { date: '2026-03-12', time: '17:00' })

    const selection = await selectWorkSummary({ journal, range: WEEK })
    const userContent = buildWorkSummaryMaterial(selection)

    expect(userContent).toBe(
      `# ${formatDayRange('2026-03-09', '2026-03-12')}\n` +
        `\n## Currently open\n- [ ] today (scheduled 2026-03-12 17:00)`,
    )
  })

  it('builds accomplishments alone when nothing is currently open', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:00:00')

    clock.set(new Date('2026-03-11T09:00:00'))
    await journal.capture('a note')
    clock.set(new Date('2026-03-12T09:00:00'))

    const selection = await selectWorkSummary({ journal, range: WEEK })
    const userContent = buildWorkSummaryMaterial(selection)

    expect(userContent).toBe(
      `# ${formatDayRange('2026-03-09', '2026-03-12')}\n` +
        `\n## Wed 11 Mar\n- a note`,
    )
  })

  it('reads completions oldest-first across both record types, day-grouped', async () => {
    const { journal, clock } = await journalAt('2026-03-09T08:00:00')
    const daily = await journal.createTask(
      'water the plants',
      { date: '2026-03-09', time: '09:00' },
      { unit: 'day', interval: 1, weekdays: [] },
    )

    clock.set(new Date('2026-03-09T09:15:00'))
    await journal.completeTask(daily.id)
    clock.set(new Date('2026-03-11T18:00:00'))
    const ordinary = await journal.createTask('chase the invoice')
    await journal.completeTask(ordinary.id)

    clock.set(new Date('2026-03-12T09:00:00'))
    await journal.editTask(daily.id, {
      description: 'water the plants',
      schedule: { date: '2026-03-16', time: '09:00' },
    })

    const selection = await selectWorkSummary({ journal, range: WEEK })
    const userContent = buildWorkSummaryMaterial(selection)

    expect(userContent).toContain(
      `## Completed\n### Mon 9 Mar\n- [x] water the plants (occurrence 2026-03-09 09:00)\n### Wed 11 Mar\n- [x] chase the invoice`,
    )
  })

  it('renders a recurring Task kept in the range in both halves, deliberately', async () => {
    const { journal, clock } = await journalAt('2026-03-09T08:00:00')
    const daily = await journal.createTask(
      'water the plants',
      { date: '2026-03-09', time: '09:00' },
      { unit: 'day', interval: 1, weekdays: [] },
    )

    clock.set(new Date('2026-03-09T10:00:00'))
    await journal.completeTask(daily.id) // Monday's slot kept…
    clock.set(new Date('2026-03-12T09:00:00')) // …and the parent now stands overdue on Tuesday's.

    const selection = await selectWorkSummary({ journal, range: WEEK })
    const userContent = buildWorkSummaryMaterial(selection)

    // The same Task Description twice is correct and deliberate: the kept
    // occurrence is work done, while the Task itself carries on.
    expect(userContent).toContain(
      `- [x] water the plants (occurrence 2026-03-09 09:00)`,
    )
    expect(userContent).toContain(
      `## Currently open\n- [ ] water the plants (scheduled 2026-03-10 09:00)`,
    )
  })

  it('reads a Monday alone without day groupings', async () => {
    const { journal, clock } = await journalAt('2026-03-09T09:00:00')

    clock.set(new Date('2026-03-09T09:00:00'))
    await journal.capture('monday’s note')
    const kept = await journal.createTask('kept monday')
    await journal.completeTask(kept.id)
    await journal.createTask('unscheduled')

    const selection = await selectWorkSummary({ journal, range: MONDAY })
    const userContent = buildWorkSummaryMaterial(selection)

    expect(userContent).toBe(
      `# ${formatDayRange('2026-03-09', '2026-03-09')}\n` +
        `\n- monday’s note\n` +
        `\n## Completed\n- [x] kept monday\n` +
        `\n## Currently open\n- [ ] unscheduled`,
    )
  })

  it('describes the captured selection when Notes change afterwards', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:00:00')

    clock.set(new Date('2026-03-10T09:00:00'))
    const note = await journal.capture('doomed note')
    const kept = await journal.createTask('kept')
    await journal.completeTask(kept.id)
    clock.set(new Date('2026-03-12T09:00:00'))

    const selected = await selectWorkSummary({ journal, range: WEEK })
    // Deleted straight from the journal, with no change announced: the
    // captured selection still describes what was on screen.
    await journal.delete(note!.id)

    expect(workSummaryRefuses(selected)).toBe(false)
    expect(buildWorkSummaryMaterial(selected)).toContain('doomed note')

    // A fresh selection describes the journal as it stands now.
    const refreshed = await selectWorkSummary({ journal, range: WEEK })
    expect(buildWorkSummaryMaterial(refreshed)).not.toContain('doomed note')
    expect(buildWorkSummaryMaterial(refreshed)).toContain('- [x] kept')
  })

  it('reads an empty selection as empty', async () => {
    const { journal } = await journalAt('2026-03-12T09:00:00')

    const selected = await selectWorkSummary({ journal, range: WEEK })

    expect(workSummaryRefuses(selected)).toBe(true)
    expect(buildWorkSummaryMaterial(selected)).toBe('')
  })
})

describe('workSummaryRefuses', () => {
  it('refuses only a week with neither half', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:00:00')

    const empty = await selectWorkSummary({ journal, range: WEEK })
    expect(workSummaryRefuses(empty)).toBe(true)

    // Accomplishments alone: a Note and a Task completed in the range.
    clock.set(new Date('2026-03-11T09:00:00'))
    await journal.capture('a note')
    const completed = await journal.createTask('kept')
    await journal.completeTask(completed.id)
    clock.set(new Date('2026-03-12T09:00:00'))

    const onlyAccomplishments = await selectWorkSummary({ journal, range: WEEK })
    expect(workSummaryRefuses(onlyAccomplishments)).toBe(false)

    // Current commitments stand on their own.
    await journal.createTask('unscheduled')
    const bothHalves = await selectWorkSummary({ journal, range: WEEK })
    expect(workSummaryRefuses(bothHalves)).toBe(false)
  })

  it('does not refuse a week whose only content is a completed occurrence', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:00:00')
    const daily = await journal.createTask(
      'water the plants',
      { date: '2026-03-10', time: '09:00' },
      { unit: 'day', interval: 1, weekdays: [] },
    )

    clock.set(new Date('2026-03-10T09:15:00'))
    await journal.completeTask(daily.id)
    clock.set(new Date('2026-03-12T09:00:00'))
    await journal.editTask(daily.id, {
      description: 'water the plants',
      schedule: { date: '2026-03-16', time: '09:00' },
    })

    const onlyAnOccurrence = await selectWorkSummary({ journal, range: WEEK })
    expect(onlyAnOccurrence.completedOccurrences).toHaveLength(1)

    // A kept recurring commitment is real work: the accomplishments half
    // holds it on its own, so a Generate is unblocked even with no other
    // content there. (The continuing parent stands in the commitments half
    // regardless; emptied here to prove the occurrence counts by itself.)
    expect(
      workSummaryRefuses({ ...onlyAnOccurrence, openTasks: [] }),
    ).toBe(false)
    expect(
      workSummaryRefuses({
        ...onlyAnOccurrence,
        completedOccurrences: [],
        openTasks: [],
      }),
    ).toBe(true)
  })
})
