import { afterEach, describe, expect, it } from 'vitest'
import {
  ANY_PROJECT,
  createJournal,
  applyPrediction,
  decideArrival,
  decideKeystroke,
  describeCopiedDigest,
  describeExport,
  rangeForJournalDay,
  rangeForPreset,
  rangeForDays,
  formatJournalDay,
  formatProject,
  formatTimeOfDay,
  formatSlot,
  slotOf,
  isProjectName,
  formatTrayCount,
  exportFileName,
  groupOpenTasks,
  isOpen,
  scheduledInstant,
  scheduleOf,
  taskAlertId,
  taskAlerts,
  taskIdOfAlert,
  msUntilNextJournalDay,
  groupByJournalDay,
  journalDayFor,
  markerPrefix,
  meetingBody,
  meetingKey,
  meetingsToImport,
  projectChoice,
  projectConstraintFor,
  UNFILED,
  type CalendarEvent,
  type Journal,
  type ProjectConstraint,
  type Task,
  type TaskGroup,
  type TaskGroupName,
  type TaskOccurrence,
} from './journal'
import { fixedClock, migrationSql, openTestDatabase } from './testing/database'

// Every test drives the core through its public operations and asserts on what
// comes back out. Nothing here asserts that a particular query ran.

const openJournals: Array<() => void> = []

afterEach(() => {
  for (const close of openJournals.splice(0)) {
    close()
  }
})

async function journalAt(instant: string) {
  const { driver, close } = await openTestDatabase()
  openJournals.push(close)
  const clock = fixedClock(instant)
  return { journal: createJournal({ clock, driver }), clock }
}

/**
 * What one day holds, for tests that want to see what a Capture stored rather
 * than to exercise a read. A single day is a Filter whose ends are equal, so
 * this is `notesForFilter` and nothing more: newest first, like the list.
 */
function notesOn(journal: Journal, journalDay: string) {
  return journal.notesForFilter(rangeForJournalDay(journalDay))
}

describe('journalDayFor', () => {
  it('is the local calendar day of the instant', () => {
    expect(journalDayFor(local('2026-03-12T00:45:00'))).toBe('2026-03-12')
    expect(journalDayFor(local('2026-03-12T09:30:00'))).toBe('2026-03-12')
    expect(journalDayFor(local('2026-03-12T23:59:59'))).toBe('2026-03-12')
  })

  it('puts either side of midnight on different days', () => {
    expect(journalDayFor(local('2026-03-11T23:59:59'))).toBe('2026-03-11')
    expect(journalDayFor(local('2026-03-12T00:00:00'))).toBe('2026-03-12')
  })

  it('resolves a day spanning a DST transition to exactly one day', () => {
    // Europe/Lisbon springs forward at 01:00 on 2026-03-29 — see vite.config.ts
    // for why the suite pins the timezone.
    const acrossTheTransition = [
      '2026-03-29T00:00:00',
      '2026-03-29T12:00:00',
      '2026-03-29T23:59:59',
    ].map((wallClock) => journalDayFor(local(wallClock)))

    expect(new Set(acrossTheTransition)).toEqual(new Set(['2026-03-29']))
  })
})

describe('decideKeystroke', () => {
  it('commits on Enter with text', () => {
    expect(decideKeystroke('Enter', 'shipped the tray menu')).toBe('commit')
  })

  it('ignores Enter on empty or whitespace-only text', () => {
    expect(decideKeystroke('Enter', '')).toBe('ignore')
    expect(decideKeystroke('Enter', '   \t ')).toBe('ignore')
  })

  it('ignores Enter on a bare Project Marker', () => {
    expect(decideKeystroke('Enter', '#habic')).toBe('ignore')
    expect(decideKeystroke('Enter', '#habic   ')).toBe('ignore')
  })

  it('discards on Escape, whatever has been typed', () => {
    expect(decideKeystroke('Escape', 'half a thought')).toBe('discard')
    expect(decideKeystroke('Escape', '')).toBe('discard')
  })

  it('neither commits nor discards on an ordinary key', () => {
    expect(decideKeystroke('a', 'a')).toBe('ignore')
    expect(decideKeystroke('Tab', 'something')).toBe('ignore')
  })
})

describe('capture', () => {
  it('reads a committed Note back with its Body intact', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    const captured = await journal.capture('rewrote the digest grouping')

    expect(captured).toMatchObject({
      body: 'rewrote the digest grouping',
      source: null,
      sourceKey: null,
    })
    const stored = await notesOn(journal, '2026-03-12')
    expect(stored.map((note) => note.body)).toEqual([
      'rewrote the digest grouping',
    ])
  })

  it('trims surrounding whitespace from the Body', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    const captured = await journal.capture('  paired on the migration  ')

    expect(captured?.body).toBe('paired on the migration')
  })

  it('commits nothing for empty or whitespace-only input', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    expect(await journal.capture('')).toBeNull()
    expect(await journal.capture('   \t ')).toBeNull()
    expect(await notesOn(journal, '2026-03-12')).toEqual([])
  })

  it('refuses a Body containing a line break', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    await expect(journal.capture('one line\nand another')).rejects.toThrow(
      /line break/i,
    )
  })

  it('records Captured At as UTC', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    const captured = await journal.capture('checked the clock')

    // 09:30 in Europe/Lisbon on that date is 09:30 UTC — see vite.config.ts.
    expect(captured?.capturedAt).toBe('2026-03-12T09:30:00.000Z')
  })

  it('files a Note captured after midnight under the local calendar day', async () => {
    const { journal } = await journalAt('2026-03-12T00:45:00')

    const captured = await journal.capture('still debugging the tray')

    expect(captured?.journalDay).toBe('2026-03-12')
    expect((await notesOn(journal, '2026-03-12')).length).toBe(1)
    expect(await notesOn(journal, '2026-03-11')).toEqual([])
  })

  it('gives a fresh Note no Edited At', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    const captured = await journal.capture('untouched since capture')

    expect(captured?.editedAt).toBeNull()
  })

  it('gives each Note its own identity', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    const first = await journal.capture('the same words')
    const second = await journal.capture('the same words')

    expect(first?.id).not.toBe(second?.id)
  })

  it('files a leading Project Marker under that Project and keeps only what follows as Body', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    const captured = await journal.capture('#habic shipped auth')

    expect(captured).toMatchObject({
      project: 'habic',
      body: 'shipped auth',
      editedAt: null,
    })
    const [stored] = await notesOn(journal, '2026-03-12')
    expect(stored).toMatchObject({ project: 'habic', body: 'shipped auth' })
  })

  it('stores Project identity lowercase', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    const captured = await journal.capture('#HaBiC shipped auth')

    expect(captured?.project).toBe('habic')
  })

  it('leaves a Capture without a leading marker Unfiled', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    const captured = await journal.capture('shipped auth')

    expect(captured?.project).toBeNull()
    expect(captured?.body).toBe('shipped auth')
  })

  it('commits nothing for a bare Project Marker', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    expect(await journal.capture('#habic')).toBeNull()
    expect(await journal.capture('#habic   ')).toBeNull()
    expect(await notesOn(journal, '2026-03-12')).toEqual([])
  })

  it('treats mid-line or malformed # as plain Body, not a Project', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    for (const text of ['shipped #habic', '##x', '# habic', '#habic! no']) {
      const captured = await journal.capture(text)
      expect(captured).toMatchObject({ project: null, body: text })
    }
  })

  it('accepts letters, digits, underscore and hyphen in a Project name', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    const captured = await journal.capture('#work_journal-ai2 done')

    expect(captured).toMatchObject({
      project: 'work_journal-ai2',
      body: 'done',
    })
  })

  it('reads a Note stored without a Project as Unfiled', async () => {
    // Rows that predate the project column (or were captured without a marker)
    // carry NULL — the Unfiled state, not a missing field.
    const { driver, close } = await openTestDatabase()
    openJournals.push(close)
    await driver.execute(
      `INSERT INTO notes (id, body, project, captured_at, journal_day, edited_at)
       VALUES (?, ?, NULL, ?, ?, NULL)`,
      ['legacy', 'from before projects', '2026-03-12T09:30:00.000Z', '2026-03-12'],
    )
    const journal = createJournal({
      clock: fixedClock('2026-03-12T09:30:00'),
      driver,
    })

    const [stored] = await notesOn(journal, '2026-03-12')

    expect(stored.project).toBeNull()
  })
})

describe('markerPrefix', () => {
  it('is empty after a lone #', () => {
    expect(markerPrefix('#')).toBe('')
  })

  it('is the characters typed after # while the marker is still open', () => {
    expect(markerPrefix('#h')).toBe('h')
    expect(markerPrefix('#HaBi')).toBe('HaBi')
    expect(markerPrefix('#work_journal-ai2')).toBe('work_journal-ai2')
  })

  it('is nothing once a Body has begun, or when there is no leading marker', () => {
    expect(markerPrefix('#habic ')).toBeNull()
    expect(markerPrefix('#habic shipped')).toBeNull()
    expect(markerPrefix('shipped')).toBeNull()
    expect(markerPrefix('')).toBeNull()
    expect(markerPrefix(' #habic')).toBeNull()
    expect(markerPrefix('##x')).toBeNull()
    expect(markerPrefix('# habic')).toBeNull()
  })
})

describe('applyPrediction', () => {
  it('fills the open marker with the chosen name and a trailing space', () => {
    expect(applyPrediction('habic')).toBe('#habic ')
  })
})

describe('isProjectName', () => {
  it('is the same rule filing a Note under a name enforces', () => {
    expect(isProjectName('alpha')).toBe(true)
    expect(isProjectName('Alpha-2_b')).toBe(true)
    // Trimmed like a stored name, so a stray space is not a different answer.
    expect(isProjectName('  alpha  ')).toBe(true)

    expect(isProjectName('')).toBe(false)
    expect(isProjectName('not a name')).toBe(false)
    expect(isProjectName('#alpha')).toBe(false)
  })
})

describe('projectPredictions', () => {
  it('returns nothing when no Projects exist yet', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    await journal.capture('unfiled thought')

    expect(await journal.projectPredictions('')).toEqual([])
    expect(await journal.projectPredictions('h')).toEqual([])
  })

  it('offers distinct Projects currently on Notes', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    await journal.capture('#habic shipped auth')
    await journal.capture('#work done')
    await journal.capture('#habic again')

    expect(await journal.projectPredictions('')).toEqual(['habic', 'work'])
  })

  it('narrows by case-insensitive prefix', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    await journal.capture('#habic shipped')
    await journal.capture('#help docs')
    await journal.capture('#work done')

    expect(await journal.projectPredictions('h')).toEqual(['habic', 'help'])
    expect(await journal.projectPredictions('Ha')).toEqual(['habic'])
    expect(await journal.projectPredictions('z')).toEqual([])
  })

  it('drops a Project once no Notes remain under it', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    const only = await journal.capture('#habic shipped')
    await journal.capture('#work done')
    await journal.delete(only!.id)

    expect(await journal.projectPredictions('')).toEqual(['work'])
  })
})

describe('projectsInUse', () => {
  it('is empty while every Note is Unfiled', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    await journal.capture('unfiled thought')

    expect(await journal.projectsInUse()).toEqual([])
  })

  it('names each Project once, sorted, whatever day its Notes are on', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:30:00')

    await journal.capture('#work done')
    await journal.capture('#habic shipped auth')
    clock.set(local('2026-03-16T09:30:00'))
    await journal.capture('#habic again')
    await journal.capture('unfiled thought')

    expect(await journal.projectsInUse()).toEqual(['habic', 'work'])
  })

  it('drops a Project once no Notes remain under it', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    const only = await journal.capture('#habic shipped')
    await journal.capture('#work done')
    await journal.delete(only!.id)

    expect(await journal.projectsInUse()).toEqual(['work'])
  })
})

describe('editBody', () => {
  it('reads the new Body back from the journal', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')
    const captured = await journal.capture('shpped the tray menu')

    await journal.editBody(captured!.id, 'shipped the tray menu')

    const [stored] = await notesOn(journal, '2026-03-12')
    expect(stored.body).toBe('shipped the tray menu')
  })

  it('leaves Captured At untouched and records Edited At', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:30:00')
    const captured = await journal.capture('a typo goes here')
    clock.set(local('2026-03-12T17:00:00'))

    const edited = await journal.editBody(captured!.id, 'a typo went here')

    expect(edited.capturedAt).toBe(captured!.capturedAt)
    expect(edited.editedAt).toBe('2026-03-12T17:00:00.000Z')
  })

  it('leaves the Journal Day alone, whatever the clock says now', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:30:00')
    const captured = await journal.capture('filed under thursday')
    clock.set(local('2026-03-16T09:00:00'))

    const edited = await journal.editBody(captured!.id, 'still under thursday')

    expect(edited.journalDay).toBe('2026-03-12')
  })

  it('trims surrounding whitespace from the new Body', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')
    const captured = await journal.capture('untrimmed')

    const edited = await journal.editBody(captured!.id, '  trimmed  ')

    expect(edited.body).toBe('trimmed')
  })

  it('refuses to empty a Body', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')
    const captured = await journal.capture('something worth keeping')

    await expect(journal.editBody(captured!.id, '   ')).rejects.toThrow(
      /empty/i,
    )
    const [stored] = await notesOn(journal, '2026-03-12')
    expect(stored.body).toBe('something worth keeping')
  })

  it('refuses a Body containing a line break', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')
    const captured = await journal.capture('one line')

    await expect(
      journal.editBody(captured!.id, 'one line\nand another'),
    ).rejects.toThrow(/line break/i)
  })

  it('does not mark a Note edited when the Body has not changed', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:30:00')
    const captured = await journal.capture('the very same words')
    clock.set(local('2026-03-12T17:00:00'))

    const edited = await journal.editBody(captured!.id, 'the very same words')

    expect(edited.editedAt).toBeNull()
  })

  it('refuses to edit a Note that is not there', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    await expect(journal.editBody('nobody', 'anything')).rejects.toThrow(
      /no such note/i,
    )
  })
})

describe('refile', () => {
  it('moves the Note between Filters and keeps Captured At', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:30:00')
    const captured = await journal.capture('meant for wednesday')
    clock.set(local('2026-03-12T17:00:00'))

    const refiled = await journal.refile(captured!.id, '2026-03-11')

    expect(refiled.journalDay).toBe('2026-03-11')
    expect(refiled.capturedAt).toBe(captured!.capturedAt)
    expect(refiled.editedAt).toBe('2026-03-12T17:00:00.000Z')
    const thursday = { from: '2026-03-12', to: '2026-03-12' }
    const wednesday = { from: '2026-03-11', to: '2026-03-11' }
    expect(await journal.notesForFilter(thursday)).toEqual([])
    expect(
      (await journal.notesForFilter(wednesday)).map((note) => note.body),
    ).toEqual(['meant for wednesday'])
  })

  it('leaves the Body alone', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')
    const captured = await journal.capture('the same remark, another day')

    const refiled = await journal.refile(captured!.id, '2026-03-11')

    expect(refiled.body).toBe('the same remark, another day')
  })

  it('does not mark a Note edited when the Journal Day has not changed', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:30:00')
    const captured = await journal.capture('already where it belongs')
    clock.set(local('2026-03-12T17:00:00'))

    const refiled = await journal.refile(captured!.id, '2026-03-12')

    expect(refiled.editedAt).toBeNull()
  })

  it('refuses a Journal Day that is not a day', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')
    const captured = await journal.capture('somewhere')

    await expect(journal.refile(captured!.id, '12/03/2026')).rejects.toThrow(
      /journal day/i,
    )
  })

  it('refuses a year the journal cannot have been written in', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')
    const captured = await journal.capture('still where it was')

    // What a date input emits while a year is being typed: `2026` arrives as
    // `0002`, `0020`, `0202` first, each of them a shaped, valid-looking day.
    await expect(journal.refile(captured!.id, '0002-03-12')).rejects.toThrow(
      /journal day/i,
    )

    const march = { from: '2026-03-12', to: '2026-03-12' }
    expect((await journal.notesForFilter(march)).map((note) => note.body)).toEqual([
      'still where it was',
    ])
  })

  it('refuses a Journal Day that never existed on the calendar', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')
    const captured = await journal.capture('still where it was')

    // Shaped like a day but impossible: month 13, February 31st, and Feb 29th
    // outside a leap year. Each would later throw RangeError in the formatters.
    for (const impossible of ['2026-13-99', '2026-02-31', '2026-02-29']) {
      await expect(journal.refile(captured!.id, impossible)).rejects.toThrow(
        /journal day/i,
      )
    }

    const march = { from: '2026-03-12', to: '2026-03-12' }
    expect((await journal.notesForFilter(march)).map((note) => note.body)).toEqual([
      'still where it was',
    ])
  })

  it('refuses to refile a Note that is not there', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    await expect(journal.refile('nobody', '2026-03-11')).rejects.toThrow(
      /no such note/i,
    )
  })
})

describe('editProject', () => {
  it('assigns a Project to an Unfiled Note without touching Body or Journal Day', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:30:00')
    const captured = await journal.capture('shipped auth')
    clock.set(local('2026-03-12T17:00:00'))

    const edited = await journal.editProject(captured!.id, 'habic')

    expect(edited).toMatchObject({
      project: 'habic',
      body: 'shipped auth',
      journalDay: '2026-03-12',
      capturedAt: captured!.capturedAt,
      editedAt: '2026-03-12T17:00:00.000Z',
    })
    const [stored] = await notesOn(journal, '2026-03-12')
    expect(stored).toMatchObject({ project: 'habic', body: 'shipped auth' })
  })

  it('moves a Note from one Project to another', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')
    const captured = await journal.capture('#habic shipped auth')

    const edited = await journal.editProject(captured!.id, 'work')

    expect(edited.project).toBe('work')
  })

  it('clears Project back to Unfiled', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:30:00')
    const captured = await journal.capture('#habic shipped auth')
    clock.set(local('2026-03-12T17:00:00'))

    const edited = await journal.editProject(captured!.id, null)

    expect(edited.project).toBeNull()
    expect(edited.editedAt).toBe('2026-03-12T17:00:00.000Z')
  })

  it('stores Project identity lowercase', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')
    const captured = await journal.capture('unfiled')

    const edited = await journal.editProject(captured!.id, 'HaBiC')

    expect(edited.project).toBe('habic')
  })

  it('accepts letters, digits, underscore and hyphen', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')
    const captured = await journal.capture('unfiled')

    const edited = await journal.editProject(captured!.id, 'work_journal-ai2')

    expect(edited.project).toBe('work_journal-ai2')
  })

  it('does not mark a Note edited when the Project has not changed', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:30:00')
    const captured = await journal.capture('#habic already filed')
    clock.set(local('2026-03-12T17:00:00'))

    const same = await journal.editProject(captured!.id, 'habic')
    const sameCase = await journal.editProject(captured!.id, 'HaBiC')
    const stillUnfiled = await journal.editProject(
      (await journal.capture('still unfiled'))!.id,
      null,
    )

    expect(same.editedAt).toBeNull()
    expect(sameCase.editedAt).toBeNull()
    expect(stillUnfiled.editedAt).toBeNull()
  })

  it('refuses a Project name the journal cannot store', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')
    const captured = await journal.capture('somewhere')

    for (const name of ['habic!', 'ha bic', '#habic', '', '  ']) {
      await expect(journal.editProject(captured!.id, name)).rejects.toThrow(
        /project/i,
      )
    }

    const [stored] = await notesOn(journal, '2026-03-12')
    expect(stored.project).toBeNull()
  })

  it('refuses to edit a Note that is not there', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    await expect(journal.editProject('nobody', 'habic')).rejects.toThrow(
      /no such note/i,
    )
  })

  it('drops a Project from Predictions once no Notes remain under it', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')
    const only = await journal.capture('#habic shipped')
    await journal.capture('#work done')

    await journal.editProject(only!.id, 'work')

    expect(await journal.projectPredictions('')).toEqual(['work'])
  })
})

describe('renameProject', () => {
  it('moves every Note under the source in one operation, keeping everything but the Project', async () => {
    const { journal, clock } = await journalAt('2026-03-11T09:00:00')
    const first = await journal.capture('#habic shipped auth')
    clock.set(local('2026-03-12T09:30:00'))
    const second = await journal.capture('#habic reviewed the tray')
    clock.set(local('2026-03-12T11:00:00'))
    await journal.capture('#work done')
    clock.set(local('2026-03-12T12:00:00'))
    await journal.capture('unfiled thought')
    clock.set(local('2026-03-12T17:00:00'))

    await journal.renameProject('habic', 'work_journal-ai2')

    const notes = await journal.notesForFilter({
      from: '2026-03-11',
      to: '2026-03-12',
    })
    expect(
      notes.map((note) => ({ body: note.body, project: note.project })),
    ).toEqual([
      { body: 'unfiled thought', project: null },
      { body: 'done', project: 'work' },
      { body: 'reviewed the tray', project: 'work_journal-ai2' },
      { body: 'shipped auth', project: 'work_journal-ai2' },
    ])
    // Provenance and filing hold still: Captured At, Body and Journal Day are
    // not the rename's to move.
    expect(notes.find((note) => note.id === first!.id)).toMatchObject({
      body: 'shipped auth',
      capturedAt: first!.capturedAt,
      journalDay: first!.journalDay,
    })
    expect(notes.find((note) => note.id === second!.id)).toMatchObject({
      body: 'reviewed the tray',
      capturedAt: second!.capturedAt,
      journalDay: second!.journalDay,
    })
  })

  it('marks every moved Note edited at the same instant', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:30:00')
    const first = await journal.capture('#habic shipped')
    clock.set(local('2026-03-12T11:00:00'))
    const second = await journal.capture('#habic again')
    clock.set(local('2026-03-12T17:00:00'))

    await journal.renameProject('habic', 'work')

    // One instant, not one per Note: the rename is one decision about the
    // stream, and the source of truth for that is the clock, read once.
    const editedAt = '2026-03-12T17:00:00.000Z'
    expect((await journal.notesForFilter({ from: '2026-03-12', to: '2026-03-12' }))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first!.id, editedAt }),
        expect.objectContaining({ id: second!.id, editedAt }),
      ]),
    )
  })

  it('normalizes both names, so the source is found and the target is stored lowercase', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')
    await journal.capture('#HaBiC shipped')

    await journal.renameProject('  HaBiC  ', 'Work')

    expect(await journal.projectsInUse()).toEqual(['work'])
  })

  it('merges into a target that already exists, with one Project left on the Notes', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')
    await journal.capture('#habic shipped auth')
    await journal.capture('#work done')
    await journal.capture('#work invoiced')

    await journal.renameProject('habic', 'work')

    expect(await journal.projectsInUse()).toEqual(['work'])
    const everything = await journal.notesForFilter({
      from: '2026-03-12',
      to: '2026-03-12',
    })
    expect(everything.map((note) => note.project)).toEqual([
      'work',
      'work',
      'work',
    ])
  })

  it('does nothing, and marks nothing edited, when the target is the source', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:30:00')
    const captured = await journal.capture('#habic shipped')
    clock.set(local('2026-03-12T17:00:00'))

    await journal.renameProject('habic', 'HaBiC')

    const [stored] = await notesOn(journal, '2026-03-12')
    expect(stored).toMatchObject({ project: 'habic', editedAt: null })
    expect(stored.id).toBe(captured!.id)
  })

  it('refuses a target that is not a Project name, and moves nothing', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')
    await journal.capture('#habic shipped')

    for (const target of ['not a name', '#habic', '', '  ', 'ha bic']) {
      await expect(journal.renameProject('habic', target)).rejects.toThrow(
        /project/i,
      )
    }

    expect(await journal.projectsInUse()).toEqual(['habic'])
  })

  it('refuses a source that is not a Project name, however many Notes it would move', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')
    await journal.capture('#habic shipped')

    // Both names are asked of the same rule, whatever the target: a source
    // that cannot be a Project is not a stream the record holds, and a
    // message that said so per target would be the rule speaking twice.
    for (const source of ['ha bic', '#habic', '']) {
      await expect(journal.renameProject(source, 'work')).rejects.toThrow(
        /project/i,
      )
    }

    expect(await journal.projectsInUse()).toEqual(['habic'])
  })

  it('refuses a source that is not in use, rather than renaming nothing', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')
    await journal.capture('#habic shipped')

    await expect(journal.renameProject('no-such-project', 'work')).rejects.toThrow(
      /no Notes|in use/i,
    )
    expect(await journal.projectsInUse()).toEqual(['habic'])
  })

  it('refuses a source that has just been renamed away, even though its name is a name', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')
    await journal.capture('#habic shipped')

    await journal.renameProject('habic', 'work')

    await expect(journal.renameProject('habic', 'other')).rejects.toThrow(
      /no Notes|in use/i,
    )
  })

  it('leaves the renamed stream where Predictions can find it, and the old name nowhere', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')
    await journal.capture('#habic shipped')

    await journal.renameProject('habic', 'work_journal-ai2')

    expect(await journal.projectPredictions('')).toEqual(['work_journal-ai2'])
    expect(await journal.projectPredictions('hab')).toEqual([])
    expect(await journal.projectPredictions('wor')).toEqual(['work_journal-ai2'])
  })
})

describe('editBody leaves Project alone', () => {
  it('does not re-parse a Project Marker from the Body', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')
    const captured = await journal.capture('plain body')

    const edited = await journal.editBody(captured!.id, '#habic looks like a marker')

    expect(edited).toMatchObject({
      project: null,
      body: '#habic looks like a marker',
    })
  })
})

describe('delete', () => {
  it('leaves no trace in any Filter, nor in what a Digest reads', async () => {
    const { journal, clock } = await journalAt('2026-03-12T09:30:00')
    const doomed = await journal.capture('said in error')
    clock.set(local('2026-03-12T11:00:00'))
    await journal.capture('said in earnest')

    await journal.delete(doomed!.id)

    const everything = { from: '0000-01-01', to: '9999-12-31' }
    expect(
      (await journal.notesForFilter(everything)).map((note) => note.body),
    ).toEqual(['said in earnest'])
    expect(
      (await notesOn(journal, '2026-03-12')).map((note) => note.body),
    ).toEqual(['said in earnest'])
  })

  it('has nowhere to leave a soft-deleted row: the schema has no such column', () => {
    // The other half of "genuinely gone": a Note cannot be hidden rather than
    // removed, because there is nothing in the schema to hide it with.
    expect(migrationSql().join('\n')).not.toMatch(/deleted/i)
  })

  it('stops being the most recent Occupied Day once its day is empty', async () => {
    const { journal, clock } = await journalAt('2026-03-11T09:00:00')
    await journal.capture('wednesday')
    clock.set(local('2026-03-13T09:00:00'))
    const friday = await journal.capture('friday')

    await journal.delete(friday!.id)

    expect(await journal.defaultRange()).toEqual({
      from: '2026-03-11',
      to: '2026-03-11',
    })
  })

  it('refuses to delete a Note that is not there', async () => {
    const { journal } = await journalAt('2026-03-12T09:30:00')

    await expect(journal.delete('nobody')).rejects.toThrow(/no such note/i)
  })
})

describe('groupByJournalDay', () => {
  it('gathers Notes under their day, keeping the order they arrive in', async () => {
    const { journal, clock } = await journalAt('2026-03-11T09:00:00')

    await journal.capture('wednesday morning')
    clock.set(local('2026-03-11T15:00:00'))
    await journal.capture('wednesday afternoon')
    clock.set(local('2026-03-13T09:00:00'))
    await journal.capture('friday')

    const groups = groupByJournalDay(
      await journal.notesForFilter({ from: '2026-03-11', to: '2026-03-13' }),
    )

    expect(
      groups.map((group) => [
        group.journalDay,
        group.notes.map((note) => note.body),
      ]),
    ).toEqual([
      ['2026-03-13', ['friday']],
      ['2026-03-11', ['wednesday afternoon', 'wednesday morning']],
    ])
  })

  it('groups nothing into nothing', () => {
    expect(groupByJournalDay([])).toEqual([])
  })
})

// Both on-screen formatters follow the reader's locale, so these tests say
// which day and which time is shown rather than which words it is shown in.
// The one format that must not move is the Digest heading, pinned in the
// Digest tests.
describe('formatJournalDay', () => {
  it('reads a Journal Day as the day it names, not the day it parses as', () => {
    // 'YYYY-MM-DD' parses as UTC midnight, which is the previous evening in
    // half the world's timezones; the heading must still say the 13th.
    const heading = formatJournalDay('2026-03-13')

    expect(heading).toContain('13')
    expect(heading).not.toContain('12')
  })
})

describe('formatTimeOfDay', () => {
  it('reads Captured At as a local time of day', () => {
    // 09:05 UTC is 09:05 in Europe/Lisbon on that date — see vite.config.ts.
    // Written 09:05 or 09:05 AM depending on the reader's locale.
    expect(formatTimeOfDay('2026-03-13T09:05:00.000Z')).toMatch(/\b09.05\b/)
  })
})

describe('formatProject', () => {
  it('reads a named Project as a #name prefix', () => {
    expect(formatProject('habic')).toBe('#habic')
  })

  it('reads the absence of a Project as Unfiled', () => {
    expect(formatProject(null)).toBe('Unfiled')
  })
})

describe('defaultRange', () => {
  it('opens on the most recent Occupied Day', async () => {
    const { journal, clock } = await journalAt('2026-03-11T09:00:00')

    await journal.capture('wednesday')
    clock.set(local('2026-03-13T09:00:00'))
    await journal.capture('friday')

    expect(await journal.defaultRange()).toEqual({
      from: '2026-03-13',
      to: '2026-03-13',
    })
  })

  it('skips unoccupied days entirely: a Monday resolves to the previous Friday', async () => {
    const { journal, clock } = await journalAt('2026-03-13T17:00:00')

    await journal.capture('friday, before the weekend')
    // The weekend is empty, and it is now Monday morning.
    clock.set(local('2026-03-16T09:00:00'))

    expect(await journal.defaultRange()).toEqual({
      from: '2026-03-13',
      to: '2026-03-13',
    })
  })

  it('reaches back however long the gap', async () => {
    const { journal, clock } = await journalAt('2026-02-27T17:00:00')

    await journal.capture('last day before leave')
    clock.set(local('2026-03-16T09:00:00'))

    expect(await journal.defaultRange()).toEqual({
      from: '2026-02-27',
      to: '2026-02-27',
    })
  })

  it('resolves to nothing on an empty database rather than an arbitrary date', async () => {
    const { journal } = await journalAt('2026-03-16T09:00:00')

    expect(await journal.defaultRange()).toBeNull()
  })
})

describe('notesForFilter', () => {
  it('returns the newest Note first', async () => {
    const { journal, clock } = await journalAt('2026-03-13T09:00:00')

    await journal.capture('first')
    clock.set(local('2026-03-13T11:00:00'))
    await journal.capture('second')

    const notes = await journal.notesForFilter({
      from: '2026-03-13',
      to: '2026-03-13',
    })

    expect(notes.map((note) => note.body)).toEqual(['second', 'first'])
  })

  it('orders a Filter spanning several days by Journal Day, newest first', async () => {
    const { journal, clock } = await journalAt('2026-03-11T09:00:00')

    await journal.capture('wednesday')
    clock.set(local('2026-03-13T09:00:00'))
    await journal.capture('friday')

    const notes = await journal.notesForFilter({
      from: '2026-03-11',
      to: '2026-03-13',
    })

    expect(notes.map((note) => note.body)).toEqual(['friday', 'wednesday'])
  })

  it('returns nothing for a Filter no Note falls under', async () => {
    const { journal } = await journalAt('2026-03-13T09:00:00')

    await journal.capture('friday')

    expect(
      await journal.notesForFilter({ from: '2026-03-14', to: '2026-03-15' }),
    ).toEqual([])
  })

  it('includes both ends of a range and excludes the days either side', async () => {
    const { journal, clock } = await journalAt('2026-03-09T09:00:00')

    for (const day of ['09', '10', '11', '12', '13']) {
      clock.set(local(`2026-03-${day}T09:00:00`))
      await journal.capture(`the ${day}th`)
    }

    const notes = await journal.notesForFilter({
      from: '2026-03-10',
      to: '2026-03-12',
    })

    expect(notes.map((note) => note.body)).toEqual([
      'the 12th',
      'the 11th',
      'the 10th',
    ])
  })

  it('returns a single day when both ends of the range are the same', async () => {
    const { journal, clock } = await journalAt('2026-03-11T09:00:00')

    await journal.capture('wednesday')
    clock.set(local('2026-03-12T09:00:00'))
    await journal.capture('thursday')

    const notes = await journal.notesForFilter({
      from: '2026-03-11',
      to: '2026-03-11',
    })

    expect(notes.map((note) => note.body)).toEqual(['wednesday'])
  })
})

describe('notesForFilter narrowed to a Project', () => {
  /** A day with one Note under each of two Projects, and one Unfiled. */
  async function mixedDay() {
    const { journal, clock } = await journalAt('2026-03-13T09:00:00')
    await journal.capture('#api rate limits')
    clock.set(local('2026-03-13T10:00:00'))
    await journal.capture('#billing invoices')
    clock.set(local('2026-03-13T11:00:00'))
    await journal.capture('read the postmortem')
    return { journal, clock }
  }

  const friday = { from: '2026-03-13', to: '2026-03-13' }

  it('shows every Note whatever its Project when the constraint is Any', async () => {
    const { journal } = await mixedDay()

    for (const filter of [friday, { ...friday, project: ANY_PROJECT }]) {
      expect(
        (await journal.notesForFilter(filter)).map((note) => note.body),
      ).toEqual(['read the postmortem', 'invoices', 'rate limits'])
    }
  })

  it('shows only the named Project', async () => {
    const { journal } = await mixedDay()

    const notes = await journal.notesForFilter({
      ...friday,
      project: { kind: 'named', name: 'api' },
    })

    expect(notes.map((note) => note.body)).toEqual(['rate limits'])
  })

  it('names a Project case-insensitively, as identity is', async () => {
    const { journal } = await mixedDay()

    const notes = await journal.notesForFilter({
      ...friday,
      project: { kind: 'named', name: 'API' },
    })

    expect(notes.map((note) => note.body)).toEqual(['rate limits'])
  })

  it('shows only Notes with no Project at all under Unfiled', async () => {
    const { journal } = await mixedDay()

    const notes = await journal.notesForFilter({ ...friday, project: UNFILED })

    expect(notes.map((note) => note.body)).toEqual(['read the postmortem'])
  })

  it('needs both axes: a Project outside the day range is not in the Filter', async () => {
    const { journal, clock } = await mixedDay()
    clock.set(local('2026-03-16T09:00:00'))
    await journal.capture('#api the retry storm')

    const notes = await journal.notesForFilter({
      ...friday,
      project: { kind: 'named', name: 'api' },
    })

    expect(notes.map((note) => note.body)).toEqual(['rate limits'])
  })

  it('is empty rather than unnarrowed when the Project has nothing in range', async () => {
    const { journal } = await mixedDay()

    expect(
      await journal.notesForFilter({
        ...friday,
        project: { kind: 'named', name: 'infra' },
      }),
    ).toEqual([])
  })
})

describe('notesMatching', () => {
  it('finds a Note whose Body contains the term, whatever the case', async () => {
    const { journal } = await journalAt('2026-03-13T09:00:00')

    await journal.capture('the MIGRATION went wrong')

    expect(
      (await journal.notesMatching('migration')).map((note) => note.body),
    ).toEqual(['the MIGRATION went wrong'])
  })

  it('reads the whole journal, newest first, whatever days the matches are on', async () => {
    const { journal, clock } = await journalAt('2026-03-09T09:00:00')

    await journal.capture('planned the migration')
    clock.set(local('2026-03-11T09:00:00'))
    await journal.capture('nothing to do with it')
    clock.set(local('2026-03-13T09:00:00'))
    await journal.capture('ran the migration')

    expect(
      (await journal.notesMatching('migration')).map((note) => note.body),
    ).toEqual(['ran the migration', 'planned the migration'])
  })

  it('returns nothing when no Body contains the term', async () => {
    const { journal } = await journalAt('2026-03-13T09:00:00')

    await journal.capture('shipped the tray menu')

    expect(await journal.notesMatching('migration')).toEqual([])
  })

  it('matches a term in the middle of a word, as a substring does', async () => {
    const { journal } = await journalAt('2026-03-13T09:00:00')

    await journal.capture('rewrote the digest grouping')

    expect(
      (await journal.notesMatching('grat')).map((note) => note.body),
    ).toEqual([])
    expect(
      (await journal.notesMatching('roup')).map((note) => note.body),
    ).toEqual(['rewrote the digest grouping'])
  })

  it('reads a wildcard as the character it is, not as a pattern', async () => {
    const { journal, clock } = await journalAt('2026-03-13T09:00:00')

    await journal.capture('cut the queue by 50%')
    clock.set(local('2026-03-13T11:00:00'))
    await journal.capture('nothing to do with it')

    expect(
      (await journal.notesMatching('50%')).map((note) => note.body),
    ).toEqual(['cut the queue by 50%'])
    // A bare wildcard would otherwise match every Note in the journal.
    expect((await journal.notesMatching('%')).map((note) => note.body)).toEqual(
      ['cut the queue by 50%'],
    )
  })
})

describe('tasksMatching', () => {
  it('finds a Task whose Task Description contains the term, whatever the case', async () => {
    const { journal } = await journalAt('2026-03-13T09:00:00')

    await journal.createTask('the MIGRATION went wrong')

    expect(
      (await journal.tasksMatching('migration')).map((task) => task.description),
    ).toEqual(['the MIGRATION went wrong'])
  })

  it('reads across the Open and Completed lists together, newest created first', async () => {
    const { journal, clock } = await journalAt('2026-03-09T09:00:00')

    const kept = await journal.createTask('planned the migration')
    clock.set(local('2026-03-13T09:00:00'))
    await journal.createTask('ran the migration')
    await journal.completeTask(kept.id)

    // One search spans both lists: not knowing whether the Task is still open
    // is most of the reason for looking.
    expect(
      (await journal.tasksMatching('migration')).map((task) => task.description),
    ).toEqual(['ran the migration', 'planned the migration'])
  })

  it('returns nothing when no Task Description contains the term', async () => {
    const { journal } = await journalAt('2026-03-13T09:00:00')

    await journal.createTask('shipped the tray menu')

    expect(await journal.tasksMatching('migration')).toEqual([])
  })

  it('matches a term in the middle of a word, as a substring does', async () => {
    const { journal } = await journalAt('2026-03-13T09:00:00')

    await journal.createTask('rewrote the digest grouping')

    expect(
      (await journal.tasksMatching('grat')).map((task) => task.description),
    ).toEqual([])
    expect(
      (await journal.tasksMatching('roup')).map((task) => task.description),
    ).toEqual(['rewrote the digest grouping'])
  })

  it('reads a wildcard as the character it is, not as a pattern', async () => {
    const { journal, clock } = await journalAt('2026-03-13T09:00:00')

    await journal.createTask('cut the queue by 50%')
    clock.set(local('2026-03-13T11:00:00'))
    await journal.createTask('nothing to do with it')

    expect(
      (await journal.tasksMatching('50%')).map((task) => task.description),
    ).toEqual(['cut the queue by 50%'])
    // A bare wildcard would otherwise match every Task in the journal.
    expect((await journal.tasksMatching('%')).map((task) => task.description)).toEqual(
      ['cut the queue by 50%'],
    )
  })
})

describe('digest', () => {
  it('renders one bullet per Note, oldest first and without timestamps', async () => {
    const { journal, clock } = await journalAt('2026-03-13T09:00:00')

    await journal.capture('first')
    clock.set(local('2026-03-13T11:00:00'))
    await journal.capture('second')

    const digest = await journal.digest({
      from: '2026-03-13',
      to: '2026-03-13',
    })

    expect(digest.markdown).toBe('- first\n- second')
  })

  it('reads in the reverse order of the list on screen', async () => {
    const { journal, clock } = await journalAt('2026-03-11T09:00:00')

    await journal.capture('wednesday')
    clock.set(local('2026-03-13T09:00:00'))
    await journal.capture('friday')

    const filter = { from: '2026-03-11', to: '2026-03-13' }
    const onScreen = await journal.notesForFilter(filter)
    const digest = await journal.digest(filter)

    expect(onScreen.map((note) => note.body)).toEqual(['friday', 'wednesday'])
    expect(digest.markdown.indexOf('wednesday')).toBeLessThan(
      digest.markdown.indexOf('friday'),
    )
  })

  it('gives a single-day Filter no heading at all', async () => {
    const { journal } = await journalAt('2026-03-13T09:00:00')

    await journal.capture('took the on-call handover')

    const digest = await journal.digest({
      from: '2026-03-13',
      to: '2026-03-13',
    })

    expect(digest.markdown).toBe('- took the on-call handover')
  })

  it('heads each Occupied Day of a multi-day Filter, and no empty day', async () => {
    const { journal, clock } = await journalAt('2026-03-11T09:00:00')

    await journal.capture('the migration landed')
    clock.set(local('2026-03-11T15:00:00'))
    await journal.capture('pairing with Ana')
    // Nothing on the 12th: an empty day produces no heading.
    clock.set(local('2026-03-13T09:00:00'))
    await journal.capture('took the on-call handover')

    const digest = await journal.digest({
      from: '2026-03-11',
      to: '2026-03-13',
    })

    expect(digest.markdown).toBe(
      [
        '## Wed 11 Mar',
        '- the migration landed',
        '- pairing with Ana',
        '',
        '## Fri 13 Mar',
        '- took the on-call handover',
      ].join('\n'),
    )
  })

  it('heads the one Occupied Day of a multi-day Filter', async () => {
    const { journal } = await journalAt('2026-03-13T09:00:00')

    await journal.capture('the only day with anything on it')

    const digest = await journal.digest({
      from: '2026-03-09',
      to: '2026-03-13',
    })

    expect(digest.markdown).toBe(
      '## Fri 13 Mar\n- the only day with anything on it',
    )
  })

  it('counts exactly as many Notes as it renders bullets', async () => {
    const { journal, clock } = await journalAt('2026-03-11T09:00:00')

    for (const day of ['11', '12', '13']) {
      clock.set(local(`2026-03-${day}T09:00:00`))
      await journal.capture(`the ${day}th`)
      await journal.capture(`the ${day}th again`)
    }

    const digest = await journal.digest({
      from: '2026-03-11',
      to: '2026-03-13',
    })

    const bullets = digest.markdown
      .split('\n')
      .filter((line) => line.startsWith('- '))

    expect(digest.noteCount).toBe(6)
    expect(bullets).toHaveLength(digest.noteCount)
  })

  it('renders nothing at all for a Filter no Note falls under', async () => {
    const { journal } = await journalAt('2026-03-13T09:00:00')

    await journal.capture('friday')

    const digest = await journal.digest({
      from: '2026-03-14',
      to: '2026-03-15',
    })

    expect(digest).toEqual({ markdown: '', noteCount: 0 })
  })
})

describe('digest of a Filter narrowed by Project', () => {
  async function mixedDay() {
    const { journal, clock } = await journalAt('2026-03-13T09:00:00')
    await journal.capture('#api rate limits')
    clock.set(local('2026-03-13T10:00:00'))
    await journal.capture('read the postmortem')
    clock.set(local('2026-03-13T11:00:00'))
    await journal.capture('#api the retry storm')
    return journal
  }

  const friday = { from: '2026-03-13', to: '2026-03-13' }

  it('is Body only under a single named Project, which every bullet shares', async () => {
    const journal = await mixedDay()

    const digest = await journal.digest({
      ...friday,
      project: { kind: 'named', name: 'api' },
    })

    expect(digest.markdown).toBe('- rate limits\n- the retry storm')
  })

  it('prefixes a filed Note with its Project under Any, and leaves Unfiled bare', async () => {
    const journal = await mixedDay()

    const digest = await journal.digest(friday)

    expect(digest.markdown).toBe(
      [
        '- #api rate limits',
        '- read the postmortem',
        '- #api the retry storm',
      ].join('\n'),
    )
  })

  it('renders Unfiled Notes with no prefix under Unfiled', async () => {
    const journal = await mixedDay()

    const digest = await journal.digest({ ...friday, project: UNFILED })

    expect(digest.markdown).toBe('- read the postmortem')
  })

  it('keeps the prefix under the day headings of a wider Filter', async () => {
    const { journal, clock } = await journalAt('2026-03-11T09:00:00')
    await journal.capture('#api rate limits')
    clock.set(local('2026-03-13T09:00:00'))
    await journal.capture('read the postmortem')

    const digest = await journal.digest({ from: '2026-03-11', to: '2026-03-13' })

    expect(digest.markdown).toBe(
      [
        '## Wed 11 Mar',
        '- #api rate limits',
        '',
        '## Fri 13 Mar',
        '- read the postmortem',
      ].join('\n'),
    )
  })
})

describe('exportJournal', () => {
  it('includes every Note in the database exactly once', async () => {
    const { journal, clock } = await journalAt('2026-03-11T09:00:00')
    const bodies = []
    for (const day of ['09', '11', '12', '16']) {
      for (const hour of ['09', '15']) {
        clock.set(local(`2026-03-${day}T${hour}:00:00`))
        bodies.push(`the ${day}th at ${hour}`)
        await journal.capture(`the ${day}th at ${hour}`)
      }
    }

    const exported = await journal.exportJournal()

    const bullets = exported.markdown
      .split('\n')
      .filter((line) => line.startsWith('- '))
    expect(exported.noteCount).toBe(bodies.length)
    expect(bullets).toHaveLength(bodies.length)
    for (const body of bodies) {
      expect(bullets.filter((bullet) => bullet === `- ${body}`)).toHaveLength(1)
    }
  })

  it('reaches Notes no Filter the reader has opened would show', async () => {
    const { journal, clock } = await journalAt('2024-01-02T09:00:00')
    await journal.capture('two years ago')
    clock.set(local('2026-03-13T09:00:00'))
    await journal.capture('today')

    const exported = await journal.exportJournal()

    expect(exported.markdown).toContain('- two years ago')
    expect(exported.markdown).toContain('- today')
    expect(exported.noteCount).toBe(2)
  })

  it('reads oldest first, under a heading for every day', async () => {
    const { journal, clock } = await journalAt('2026-03-11T09:00:00')
    await journal.capture('the migration landed')
    clock.set(local('2026-03-13T09:00:00'))
    await journal.capture('took the on-call handover')

    const exported = await journal.exportJournal()

    expect(exported.markdown).toBe(
      [
        '# Notes',
        '',
        '## Wed 11 Mar',
        '- the migration landed',
        '',
        '## Fri 13 Mar',
        '- took the on-call handover',
      ].join('\n'),
    )
  })

  it('heads the single day of a journal holding only one', async () => {
    const { journal } = await journalAt('2026-03-13T09:00:00')
    await journal.capture('the only day with anything on it')

    const exported = await journal.exportJournal()

    expect(exported.markdown).toBe(
      '# Notes\n\n## Fri 13 Mar\n- the only day with anything on it',
    )
  })

  it('renders nothing at all for a journal with no Notes', async () => {
    const { journal } = await journalAt('2026-03-13T09:00:00')

    expect(await journal.exportJournal()).toEqual({
      markdown: '',
      noteCount: 0,
      taskCount: 0,
    })
  })
})

describe('exportJournal and Projects', () => {
  it('writes a Project on the bullet, and groups by day rather than by Project', async () => {
    const { journal, clock } = await journalAt('2026-03-11T09:00:00')
    await journal.capture('#api rate limits')
    clock.set(local('2026-03-11T15:00:00'))
    await journal.capture('read the postmortem')
    clock.set(local('2026-03-13T09:00:00'))
    await journal.capture('#billing invoices')

    const exported = await journal.exportJournal()

    expect(exported.markdown).toBe(
      [
        '# Notes',
        '',
        '## Wed 11 Mar',
        '- #api rate limits',
        '- read the postmortem',
        '',
        '## Fri 13 Mar',
        '- #billing invoices',
      ].join('\n'),
    )
  })
})

describe('projectChoice and projectConstraintFor', () => {
  it('round-trips each constraint through the value of a picker', () => {
    const constraints: ProjectConstraint[] = [
      ANY_PROJECT,
      UNFILED,
      { kind: 'named', name: 'api' },
    ]

    for (const constraint of constraints) {
      expect(projectConstraintFor(projectChoice(constraint))).toEqual(constraint)
    }
  })

  it('keeps a Project named after one of the constants distinct from it', () => {
    expect(projectChoice({ kind: 'named', name: 'unfiled' })).toBe('#unfiled')
    expect(projectConstraintFor('#unfiled')).toEqual({
      kind: 'named',
      name: 'unfiled',
    })
    expect(projectConstraintFor('#any')).toEqual({ kind: 'named', name: 'any' })
  })

  it('reads a named choice as the Project it identifies', () => {
    expect(projectConstraintFor('#API')).toEqual({ kind: 'named', name: 'api' })
  })

  it('refuses a choice that names nothing a Project could be called', () => {
    expect(() => projectConstraintFor('#not a project')).toThrow(
      'Not a Project',
    )
  })
})

describe('exportFileName', () => {
  it('names the file after the journal and the day it was taken', () => {
    expect(exportFileName(local('2026-03-09T21:15:00'))).toBe(
      'work-journal-2026-03-09.md',
    )
  })

  it('is a plain file name, with nowhere to traverse to', () => {
    expect(exportFileName(local('2026-03-09T21:15:00'))).not.toMatch(/[/\\]/)
  })
})

describe('describeCopiedDigest', () => {
  it('reports as many Notes as the Digest has bullets', async () => {
    const { journal, clock } = await journalAt('2026-03-11T09:00:00')

    await journal.capture('the migration landed')
    clock.set(local('2026-03-13T09:00:00'))
    await journal.capture('took the on-call handover')

    const digest = await journal.digest({
      from: '2026-03-11',
      to: '2026-03-13',
    })
    const bullets = digest.markdown
      .split('\n')
      .filter((line) => line.startsWith('- '))

    expect(describeCopiedDigest(digest)).toBe(`Copied ${bullets.length} notes.`)
  })

  it('says note rather than notes for a single one', () => {
    expect(describeCopiedDigest({ markdown: '- alone', noteCount: 1 })).toBe(
      'Copied 1 note.',
    )
  })

  it('claims no copy at all when the Filter held nothing', () => {
    expect(describeCopiedDigest({ markdown: '', noteCount: 0 })).toBe(
      'No notes to copy.',
    )
  })
})

describe('rangeForDays', () => {
  it('reads a range oldest-end first', () => {
    expect(rangeForDays('2026-03-09', '2026-03-13')).toEqual({
      from: '2026-03-09',
      to: '2026-03-13',
    })
  })

  it('orders the ends whichever way round they were picked', () => {
    expect(rangeForDays('2026-03-13', '2026-03-09')).toEqual({
      from: '2026-03-09',
      to: '2026-03-13',
    })
  })

  it('makes a single day out of two equal ends', () => {
    expect(rangeForDays('2026-03-13', '2026-03-13')).toEqual({
      from: '2026-03-13',
      to: '2026-03-13',
    })
  })
})

describe('rangeForJournalDay', () => {
  it('reads one day as a range whose ends are equal', () => {
    expect(rangeForJournalDay('2026-03-13')).toEqual({
      from: '2026-03-13',
      to: '2026-03-13',
    })
  })
})

describe('rangeForPreset', () => {
  // Anchors are civil calendar days. 2026-08-05 is a Wednesday.
  const wednesday = '2026-08-05'

  it('today is the day itself', () => {
    expect(rangeForPreset('today', wednesday)).toEqual({
      from: '2026-08-05',
      to: '2026-08-05',
    })
  })

  it('yesterday is the calendar day before today', () => {
    expect(rangeForPreset('yesterday', wednesday)).toEqual({
      from: '2026-08-04',
      to: '2026-08-04',
    })
  })

  it('yesterday crosses a month boundary', () => {
    expect(rangeForPreset('yesterday', '2026-08-01')).toEqual({
      from: '2026-07-31',
      to: '2026-07-31',
    })
  })

  it('this week runs Monday through today', () => {
    expect(rangeForPreset('this-week', wednesday)).toEqual({
      from: '2026-08-03',
      to: '2026-08-05',
    })
  })

  it('this week on a Monday is just today', () => {
    expect(rangeForPreset('this-week', '2026-08-03')).toEqual({
      from: '2026-08-03',
      to: '2026-08-03',
    })
  })

  it('this week on a Sunday still starts the prior Monday', () => {
    // 2026-08-09 is a Sunday; the week began 2026-08-03.
    expect(rangeForPreset('this-week', '2026-08-09')).toEqual({
      from: '2026-08-03',
      to: '2026-08-09',
    })
  })

  it('last week is the full prior Monday–Sunday', () => {
    expect(rangeForPreset('last-week', wednesday)).toEqual({
      from: '2026-07-27',
      to: '2026-08-02',
    })
  })

  it('last week from a Monday is the week that just ended', () => {
    expect(rangeForPreset('last-week', '2026-08-03')).toEqual({
      from: '2026-07-27',
      to: '2026-08-02',
    })
  })

  it('this month runs the first of the month through today', () => {
    expect(rangeForPreset('this-month', wednesday)).toEqual({
      from: '2026-08-01',
      to: '2026-08-05',
    })
  })

  it('this month on the first is just today', () => {
    expect(rangeForPreset('this-month', '2026-08-01')).toEqual({
      from: '2026-08-01',
      to: '2026-08-01',
    })
  })

  it('last month is the full prior calendar month', () => {
    expect(rangeForPreset('last-month', wednesday)).toEqual({
      from: '2026-07-01',
      to: '2026-07-31',
    })
  })

  it('last month from January is the prior December', () => {
    expect(rangeForPreset('last-month', '2026-01-15')).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    })
  })

  it('last month handles February in a non-leap year', () => {
    expect(rangeForPreset('last-month', '2026-03-10')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    })
  })

  it('last month handles February in a leap year', () => {
    expect(rangeForPreset('last-month', '2024-03-10')).toEqual({
      from: '2024-02-01',
      to: '2024-02-29',
    })
  })
})

describe('decideArrival', () => {
  const friday = { from: '2026-03-13', to: '2026-03-13' }

  it('shows a Note that falls inside the Filter', () => {
    expect(decideArrival(friday, '2026-03-13')).toEqual({ kind: 'show' })
  })

  it('nudges rather than moving the list when the day is outside the Filter', () => {
    expect(decideArrival(friday, '2026-03-16')).toEqual({
      kind: 'nudge',
      journalDay: '2026-03-16',
    })
    expect(decideArrival(friday, '2026-03-12')).toEqual({
      kind: 'nudge',
      journalDay: '2026-03-12',
    })
  })

  it('counts both ends of a range as inside it', () => {
    const week = { from: '2026-03-09', to: '2026-03-13' }

    expect(decideArrival(week, '2026-03-09')).toEqual({ kind: 'show' })
    expect(decideArrival(week, '2026-03-13')).toEqual({ kind: 'show' })
    expect(decideArrival(week, '2026-03-08')).toEqual({
      kind: 'nudge',
      journalDay: '2026-03-08',
    })
  })
})

/**
 * The instant at which the suite's pinned timezone read this wall-clock time.
 * A date-time literal carrying no offset is parsed as local time, which is the
 * whole point here — these tests are about a local-calendar decision.
 */
function local(wallClock: string): Date {
  return new Date(wallClock)
}

describe('capturedNoteCount', () => {
  it('counts the Captured Notes filed under one Journal Day', async () => {
    const { journal, clock } = await journalAt('2026-03-11T09:00:00')

    await journal.capture('the migration landed')
    await journal.capture('#habic reviewed the tray work')
    clock.set(local('2026-03-12T09:00:00'))
    await journal.capture('took the on-call handover')

    expect(await journal.capturedNoteCount('2026-03-11')).toBe(2)
    expect(await journal.capturedNoteCount('2026-03-12')).toBe(1)
  })

  it('is zero on a day nothing was written on', async () => {
    const { journal } = await journalAt('2026-03-11T09:00:00')

    await journal.capture('the migration landed')

    expect(await journal.capturedNoteCount('2026-03-12')).toBe(0)
  })

  it('is zero on an empty journal', async () => {
    const { journal } = await journalAt('2026-03-11T09:00:00')

    expect(await journal.capturedNoteCount('2026-03-11')).toBe(0)
  })

  it('falls as Notes are deleted', async () => {
    const { journal } = await journalAt('2026-03-11T09:00:00')

    const note = await journal.capture('the migration landed')
    await journal.capture('took the on-call handover')
    await journal.delete(note!.id)

    expect(await journal.capturedNoteCount('2026-03-11')).toBe(1)
  })

  it('follows a Note refiled onto another day', async () => {
    const { journal } = await journalAt('2026-03-11T09:00:00')

    const note = await journal.capture('the migration landed')
    await journal.refile(note!.id, '2026-03-10')

    expect(await journal.capturedNoteCount('2026-03-11')).toBe(0)
    expect(await journal.capturedNoteCount('2026-03-10')).toBe(1)
  })
})

describe('formatTrayCount', () => {
  it('is the count itself once something has been written', () => {
    expect(formatTrayCount(1)).toBe('1')
    expect(formatTrayCount(12)).toBe('12')
  })

  it('is not a number at all on a day nothing was written on', () => {
    expect(formatTrayCount(0)).not.toBe('0')
    expect(formatTrayCount(0)).not.toBe('')
  })

  it('reads as a blank waiting to be filled rather than a total', () => {
    expect(formatTrayCount(0)).toBe('–')
  })
})

describe('msUntilNextJournalDay', () => {
  it('is the time left until the local day turns over', () => {
    expect(msUntilNextJournalDay(local('2026-03-12T23:59:59.000'))).toBe(1_000)
    expect(msUntilNextJournalDay(local('2026-03-12T00:00:00.000'))).toBe(
      24 * 60 * 60 * 1000,
    )
  })

  it('lands on the first instant of the next Journal Day', () => {
    const now = local('2026-03-12T17:04:23.500')
    const next = new Date(now.getTime() + msUntilNextJournalDay(now))

    expect(journalDayFor(next)).toBe('2026-03-13')
    expect(journalDayFor(new Date(next.getTime() - 1))).toBe('2026-03-12')
  })

  it('follows the wall clock across a DST transition', () => {
    // Europe/Lisbon springs forward at 01:00 on 2026-03-29, so that day is 23
    // hours long — a rollover counted as a fixed 24 would land an hour into
    // the day after. See vite.config.ts for why the suite pins the timezone.
    const now = local('2026-03-29T00:00:00.000')

    expect(msUntilNextJournalDay(now)).toBe(23 * 60 * 60 * 1000)
    expect(
      journalDayFor(new Date(now.getTime() + msUntilNextJournalDay(now))),
    ).toBe('2026-03-30')
  })
})

/**
 * One event on the calendar, with the fields an Import reads. Times are wall
 * clock in the machine's own zone, like every other instant in this file.
 */
function event(
  overrides: Omit<Partial<CalendarEvent>, 'startsAt' | 'endsAt'> & {
    startsAt: string
    endsAt: string
  },
): CalendarEvent {
  return {
    id: 'event-1',
    calendarId: 'work',
    title: 'Standup',
    isAllDay: false,
    isDeclined: false,
    ...overrides,
    startsAt: local(overrides.startsAt).getTime(),
    endsAt: local(overrides.endsAt).getTime(),
  }
}

describe('meetingBody', () => {
  it('is the title, verbatim', () => {
    expect(meetingBody('Weekly sync with Habic')).toBe('Weekly sync with Habic')
  })

  it('collapses a title that is not one line into one', () => {
    expect(meetingBody('  Weekly\nsync   with\tHabic  ')).toBe(
      'Weekly sync with Habic',
    )
  })

  it('says so when there is no title at all, because a Body is never empty', () => {
    expect(meetingBody('')).toBe('(untitled meeting)')
    expect(meetingBody('   ')).toBe('(untitled meeting)')
  })
})

describe('meetingKey', () => {
  it('tells two occurrences of the same recurring event apart', () => {
    const monday = event({ startsAt: '2026-03-09T09:30', endsAt: '2026-03-09T09:45' })
    const tuesday = event({ startsAt: '2026-03-10T09:30', endsAt: '2026-03-10T09:45' })

    expect(meetingKey(monday)).not.toBe(meetingKey(tuesday))
  })

  it('is the same key for the same occurrence read twice', () => {
    const swept = event({ startsAt: '2026-03-09T09:30', endsAt: '2026-03-09T09:45' })
    const sweptAgain = event({ startsAt: '2026-03-09T09:30', endsAt: '2026-03-09T09:45' })

    expect(meetingKey(swept)).toBe(meetingKey(sweptAgain))
  })
})

describe('meetingsToImport', () => {
  const now = local('2026-03-09T18:40:00')

  function swept(
    events: CalendarEvent[],
    calendarIds = ['work'],
    instant = now,
  ) {
    return meetingsToImport({ events, calendarIds, now: instant }).map(
      (event) => event.id,
    )
  }

  it('takes a meeting that has ended on a ticked calendar', () => {
    expect(
      swept([event({ startsAt: '2026-03-09T09:30', endsAt: '2026-03-09T10:00' })]),
    ).toEqual(['event-1'])
  })

  it('ignores a calendar the user has not ticked', () => {
    expect(
      swept([
        event({
          id: 'personal-lunch',
          calendarId: 'personal',
          startsAt: '2026-03-09T12:00',
          endsAt: '2026-03-09T13:00',
        }),
      ]),
    ).toEqual([])
  })

  it('sweeps nothing at all when no calendar is ticked', () => {
    expect(
      swept(
        [event({ startsAt: '2026-03-09T09:30', endsAt: '2026-03-09T10:00' })],
        [],
      ),
    ).toEqual([])
  })

  it('leaves a meeting alone until it has ended', () => {
    expect(
      swept([event({ startsAt: '2026-03-09T18:30', endsAt: '2026-03-09T19:00' })]),
    ).toEqual([])
  })

  it('takes a meeting the moment it ends', () => {
    expect(
      swept([event({ startsAt: '2026-03-09T18:00', endsAt: '2026-03-09T18:40' })]),
    ).toEqual(['event-1'])
  })

  it('never takes one the user declined', () => {
    expect(
      swept([
        event({
          isDeclined: true,
          startsAt: '2026-03-09T09:30',
          endsAt: '2026-03-09T10:00',
        }),
      ]),
    ).toEqual([])
  })

  it('never takes an event the calendar marks all-day', () => {
    expect(
      swept([
        event({
          isAllDay: true,
          startsAt: '2026-03-09T00:00',
          endsAt: '2026-03-10T00:00',
        }),
      ]),
    ).toEqual([])
  })

  it('never takes one that covers the whole local day without saying it is all-day', () => {
    // The out-of-office block #61 found: local midnight to local midnight,
    // reporting isAllDay: false. On the flag alone it would arrive as a
    // meeting that began at 00:00.
    expect(
      swept([
        event({
          title: 'Out of office',
          startsAt: '2026-03-09T00:00',
          endsAt: '2026-03-10T00:00',
        }),
      ]),
    ).toEqual([])
  })

  it('never takes one that spans several days', () => {
    expect(
      swept([
        event({ title: 'Offsite', startsAt: '2026-03-08T00:00', endsAt: '2026-03-11T00:00' }),
      ]),
    ).toEqual([])
  })

  it('takes one that merely runs long', () => {
    expect(
      swept([
        event({ title: 'Workshop', startsAt: '2026-03-09T00:00', endsAt: '2026-03-09T17:00' }),
      ]),
    ).toEqual(['event-1'])
  })

  it('still takes a straddler on a later sweep the same day', () => {
    // It ended today, so today's sweep is the only one that will ever see it.
    // The Note lands on the day it began — see
    // docs/adr/0011-imported-meetings-are-today-only.md.
    expect(
      swept([
        event({ title: 'Late release', startsAt: '2026-03-08T22:00', endsAt: '2026-03-09T01:00' }),
      ]),
    ).toEqual(['event-1'])
  })

  it('never takes one that ended before today began', () => {
    expect(
      swept([
        event({ title: 'Retro', startsAt: '2026-03-08T15:00', endsAt: '2026-03-08T16:00' }),
      ]),
    ).toEqual([])
  })

  it('never backfills a meeting from before yesterday', () => {
    expect(
      swept([
        event({ title: 'Long haul', startsAt: '2026-03-02T09:00', endsAt: '2026-03-09T10:00' }),
      ]),
    ).toEqual([])
  })

  it('takes one that began last night and ran past midnight', () => {
    // The only meeting the old start-of-day rule could never sweep: still
    // running at midnight, so on the next sweep it no longer began today.
    expect(
      swept(
        [
          event({
            title: 'Late release',
            startsAt: '2026-03-08T23:00',
            endsAt: '2026-03-09T00:30',
          }),
        ],
        ['work'],
        local('2026-03-09T00:35:00'),
      ),
    ).toEqual(['event-1'])
  })

  it('has no duration floor: a five-minute meeting is a meeting', () => {
    expect(
      swept([event({ startsAt: '2026-03-09T09:30', endsAt: '2026-03-09T09:35' })]),
    ).toEqual(['event-1'])
  })
})

describe('importMeeting', () => {
  it('files the meeting under the morning it happened in, not the evening it was swept in', async () => {
    const { journal } = await journalAt('2026-03-09T18:40:00')
    const meeting = event({
      title: 'Weekly sync',
      startsAt: '2026-03-09T09:30',
      endsAt: '2026-03-09T10:00',
    })
    const note = await journal.importMeeting(meeting)

    expect(note).toMatchObject({
      body: 'Weekly sync',
      project: null,
      journalDay: '2026-03-09',
      editedAt: null,
      origin: 'import',
      source: 'calendar',
      sourceKey: meetingKey(meeting),
    })
    expect(note!.capturedAt).toBe(local('2026-03-09T09:30').toISOString())
  })

  it("puts the Note in the day's list like any other", async () => {
    const { journal } = await journalAt('2026-03-09T18:40:00')

    await journal.capture('the migration landed')
    await journal.importMeeting(
      event({ title: 'Weekly sync', startsAt: '2026-03-09T09:30', endsAt: '2026-03-09T10:00' }),
    )

    expect((await notesOn(journal, '2026-03-09')).map((note) => note.body)).toEqual([
      'the migration landed',
      'Weekly sync',
    ])
  })

  it('imports the same meeting exactly once, however often it is swept', async () => {
    const { journal } = await journalAt('2026-03-09T18:40:00')
    const meeting = event({ startsAt: '2026-03-09T09:30', endsAt: '2026-03-09T10:00' })

    expect(await journal.importMeeting(meeting)).not.toBeNull()
    expect(await journal.importMeeting(meeting)).toBeNull()
    expect(await notesOn(journal, '2026-03-09')).toHaveLength(1)
  })

  it('never brings back a meeting whose Note was deleted: refusal is permanent', async () => {
    const { journal } = await journalAt('2026-03-09T18:40:00')
    const meeting = event({ startsAt: '2026-03-09T09:30', endsAt: '2026-03-09T10:00' })

    const note = await journal.importMeeting(meeting)
    await journal.delete(note!.id)

    expect(await journal.importMeeting(meeting)).toBeNull()
    expect(await notesOn(journal, '2026-03-09')).toEqual([])
  })

  it('imports each occurrence of a recurring meeting', async () => {
    const { journal } = await journalAt('2026-03-10T18:40:00')

    await journal.importMeeting(
      event({ startsAt: '2026-03-09T09:30', endsAt: '2026-03-09T09:45' }),
    )
    await journal.importMeeting(
      event({ startsAt: '2026-03-10T09:30', endsAt: '2026-03-10T09:45' }),
    )

    expect(await notesOn(journal, '2026-03-09')).toHaveLength(1)
    expect(await notesOn(journal, '2026-03-10')).toHaveLength(1)
  })

  it('gives an untitled meeting a Body anyway', async () => {
    const { journal } = await journalAt('2026-03-09T18:40:00')

    const note = await journal.importMeeting(
      event({ title: '', startsAt: '2026-03-09T09:30', endsAt: '2026-03-09T10:00' }),
    )

    expect(note!.body).toBe('(untitled meeting)')
  })

  it('is edited, refiled and filed like any other Note', async () => {
    const { journal } = await journalAt('2026-03-09T18:40:00')
    const note = await journal.importMeeting(
      event({ startsAt: '2026-03-09T09:30', endsAt: '2026-03-09T10:00' }),
    )

    const reworded = await journal.editBody(note!.id, 'Standup: agreed the cutover')
    const refiled = await journal.refile(reworded.id, '2026-03-10')
    const filed = await journal.editProject(refiled.id, 'habic')

    expect(filed).toMatchObject({
      body: 'Standup: agreed the cutover',
      journalDay: '2026-03-10',
      project: 'habic',
      origin: 'import',
      source: 'calendar',
      sourceKey: meetingKey(
        event({ startsAt: '2026-03-09T09:30', endsAt: '2026-03-09T10:00' }),
      ),
    })
    // Provenance survives every correction, exactly as it does for a Capture.
    expect(filed.capturedAt).toBe(note!.capturedAt)
  })

  it('does not count towards the day the tray reports', async () => {
    const { journal } = await journalAt('2026-03-09T18:40:00')

    await journal.capture('the migration landed')
    await journal.importMeeting(
      event({ startsAt: '2026-03-09T09:30', endsAt: '2026-03-09T10:00' }),
    )

    expect(await journal.capturedNoteCount('2026-03-09')).toBe(1)
  })

  it('reads in a Digest exactly like a Note that was typed', async () => {
    const { journal } = await journalAt('2026-03-09T18:40:00')

    await journal.importMeeting(
      event({ title: 'Weekly sync', startsAt: '2026-03-09T09:30', endsAt: '2026-03-09T10:00' }),
    )
    await journal.capture('the migration landed')

    const digest = await journal.digest(rangeForJournalDay('2026-03-09'))
    expect(digest.markdown).toBe('- Weekly sync\n- the migration landed')
    expect(digest.noteCount).toBe(2)
  })
})

describe('createTask', () => {
  it('commits one Open Task with the description as written', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')

    const task = await journal.createTask('renew the TLS certificate')

    expect(task.description).toBe('renew the TLS certificate')
    expect(task.completedAt).toBeNull()
    expect(task.createdAt).toBe(local('2026-03-09T10:00:00').toISOString())
    expect(await journal.openTasks()).toEqual([task])
  })

  it('trims the ends and preserves internal whitespace and Unicode', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')

    const task = await journal.createTask('  migração  do   índice → ✅  ')

    expect(task.description).toBe('migração  do   índice → ✅')
  })

  it('refuses a description that says nothing', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')

    await expect(journal.createTask('')).rejects.toThrow()
    await expect(journal.createTask('   ')).rejects.toThrow()
    expect(await journal.openTasks()).toEqual([])
  })

  it('refuses a description holding a line break', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')

    await expect(journal.createTask('two\nlines')).rejects.toThrow()
    expect(await journal.openTasks()).toEqual([])
  })

  it('has no domain length limit', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')
    const long = 'x'.repeat(5000)

    const task = await journal.createTask(long)

    expect(task.description).toBe(long)
  })

  it('allows two Tasks to say exactly the same thing', async () => {
    const { journal, clock } = await journalAt('2026-03-09T10:00:00')

    const first = await journal.createTask('chase the invoice')
    clock.set(local('2026-03-09T11:00:00'))
    const second = await journal.createTask('chase the invoice')

    expect(first.id).not.toBe(second.id)
    expect(await journal.openTasks()).toHaveLength(2)
  })
})

describe('openTasks', () => {
  it('reads newest Task Created At first', async () => {
    const { journal, clock } = await journalAt('2026-03-09T09:00:00')
    await journal.createTask('first')
    clock.set(local('2026-03-09T10:00:00'))
    await journal.createTask('second')
    clock.set(local('2026-03-09T11:00:00'))
    await journal.createTask('third')

    expect((await journal.openTasks()).map((task) => task.description)).toEqual([
      'third',
      'second',
      'first',
    ])
  })

  it('leaves out the Tasks that were completed', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')
    const done = await journal.createTask('already handled')
    await journal.createTask('still owed')

    await journal.completeTask(done.id)

    expect((await journal.openTasks()).map((task) => task.description)).toEqual([
      'still owed',
    ])
  })
})

describe('completedTasks', () => {
  it('reads newest Task Completed At first, whatever order they were made in', async () => {
    const { journal, clock } = await journalAt('2026-03-09T09:00:00')
    const first = await journal.createTask('first made')
    clock.set(local('2026-03-09T10:00:00'))
    const second = await journal.createTask('second made')

    clock.set(local('2026-03-09T11:00:00'))
    await journal.completeTask(second.id)
    clock.set(local('2026-03-09T12:00:00'))
    await journal.completeTask(first.id)

    expect(
      (await journal.completedTasks()).map((task) => task.description),
    ).toEqual(['first made', 'second made'])
  })
})

describe('occurrencesKeptIn', () => {
  /** The kept occurrences, as plain `description (slot)` lines, newest first. */
  function kept(
    pairs: Array<{ task: Task; occurrence: TaskOccurrence }>,
  ): string[] {
    return pairs.map(
      ({ task, occurrence }) =>
        `${task.description} (${formatSlot(slotOf(occurrence))})`,
    )
  }

  it('returns every occurrence completed on a Journal Day in the range, newest completion first', async () => {
    const { journal, clock } = await journalAt('2026-03-11T08:00:00')
    const daily = await journal.createTask(
      'water the plants',
      { date: '2026-03-10', time: '09:00' },
      { unit: 'day', interval: 1, weekdays: [] },
    )

    // Two slots kept on the 11th, in a deliberate order: the earlier slot
    // completed later, so reading back newest first is a real reorder.
    clock.set(local('2026-03-11T09:15:00'))
    await journal.completeTask(daily.id)
    clock.set(local('2026-03-11T10:00:00'))
    await journal.completeTask(daily.id)
    clock.set(local('2026-03-11T17:00:00'))
    await journal.capture('a note on the day')

    const selected = await journal.occurrencesKeptIn({
      from: '2026-03-11',
      to: '2026-03-11',
    })

    expect(kept(selected)).toEqual([
      'water the plants (2026-03-12 09:00)',
      'water the plants (2026-03-10 09:00)',
    ])
    // The parent Task reads whole, as it stands now — advanced, still Open,
    // never itself completed — so a renderer can say what was done.
    const parent = (await journal.openTasks()).find((one) => one.id === daily.id)
    expect(selected[0].task).toEqual(parent)
    expect(isOpen(selected[0].task)).toBe(true)
    expect(selected[0].occurrence.completedAt).not.toBeNull()
  })

  it('leaves out occurrences completed outside the range', async () => {
    const { journal, clock } = await journalAt('2026-03-10T08:00:00')
    const daily = await journal.createTask(
      'water the plants',
      { date: '2026-03-10', time: '09:00' },
      { unit: 'day', interval: 1, weekdays: [] },
    )

    clock.set(local('2026-03-10T09:15:00'))
    await journal.completeTask(daily.id) // kept 03-10 09:00, advances to the 11th
    clock.set(local('2026-03-11T09:15:00'))
    await journal.completeTask(daily.id) // kept 03-11 09:00, advances to the 12th
    clock.set(local('2026-03-12T09:15:00'))
    await journal.completeTask(daily.id) // kept 03-12 09:00, advances to the 13th

    expect(
      kept(
        await journal.occurrencesKeptIn({
          from: '2026-03-11',
          to: '2026-03-11',
        }),
      ),
    ).toEqual(['water the plants (2026-03-11 09:00)'])
    expect(
      kept(
        await journal.occurrencesKeptIn({
          from: '2026-03-10',
          to: '2026-03-11',
        }),
      ),
    ).toEqual([
      'water the plants (2026-03-11 09:00)',
      'water the plants (2026-03-10 09:00)',
    ])
  })

  it('returns a stopped recurrence\u2019s retained history', async () => {
    const { journal, clock } = await journalAt('2026-03-11T08:00:00')
    const daily = await journal.createTask(
      'water the plants',
      { date: '2026-03-10', time: '09:00' },
      { unit: 'day', interval: 1, weekdays: [] },
    )

    clock.set(local('2026-03-11T09:15:00'))
    await journal.completeTask(daily.id)
    await journal.stopRecurrence(daily.id)
    expect((await journal.openTasks())[0].recurrence).toBeNull()

    expect(
      kept(
        await journal.occurrencesKeptIn({
          from: '2026-03-10',
          to: '2026-03-11',
        }),
      ),
    ).toEqual(['water the plants (2026-03-10 09:00)'])
  })

  it('is empty when the range holds no completed occurrence', async () => {
    const { journal } = await journalAt('2026-03-11T08:00:00')
    await journal.createTask(
      'water the plants',
      { date: '2026-03-10', time: '09:00' },
      { unit: 'day', interval: 1, weekdays: [] },
    )

    expect(
      await journal.occurrencesKeptIn({
        from: '2026-03-11',
        to: '2026-03-11',
      }),
    ).toEqual([])
  })

  it('bounds the range at local midnight, not UTC midnight', async () => {
    // July: the suite's pinned Europe/Lisbon is at UTC+1, so an occurrence
    // completed at 00:30 local on the 2nd is stored 2026-07-01T23:30Z — a
    // string comparison against UTC day bounds would file it under the 1st.
    const { journal, clock } = await journalAt('2026-07-01T22:00:00')
    const daily = await journal.createTask(
      'water the plants',
      { date: '2026-07-01', time: '23:00' },
      { unit: 'day', interval: 1, weekdays: [] },
    )

    clock.set(local('2026-07-02T00:30:00'))
    await journal.completeTask(daily.id)

    const onTheSecond = await journal.occurrencesKeptIn({
      from: '2026-07-02',
      to: '2026-07-02',
    })
    expect(kept(onTheSecond)).toEqual(['water the plants (2026-07-01 23:00)'])

    const onTheFirst = await journal.occurrencesKeptIn({
      from: '2026-07-01',
      to: '2026-07-01',
    })
    expect(onTheFirst).toEqual([])
  })

  it('bounds the range at local midnight across the DST fallback', async () => {
    // Late October: Europe/Lisbon falls back on the 25th, so the night
    // before is still UTC+1 and a completion at 00:30 local on the 25th is
    // stored 2026-10-24T23:30Z — a different UTC day from the local one it
    // belongs to, on the very weekend the offset moves.
    const { journal, clock } = await journalAt('2026-10-24T22:00:00')
    const daily = await journal.createTask(
      'water the plants',
      { date: '2026-10-24', time: '23:00' },
      { unit: 'day', interval: 1, weekdays: [] },
    )

    clock.set(local('2026-10-25T00:30:00'))
    await journal.completeTask(daily.id)

    expect(
      kept(
        await journal.occurrencesKeptIn({
          from: '2026-10-25',
          to: '2026-10-25',
        }),
      ),
    ).toEqual(['water the plants (2026-10-24 23:00)'])
    expect(
      await journal.occurrencesKeptIn({
        from: '2026-10-24',
        to: '2026-10-24',
      }),
    ).toEqual([])
  })
})

describe('completeTask and reopenTask', () => {
  it('records when the commitment was kept', async () => {
    const { journal, clock } = await journalAt('2026-03-09T10:00:00')
    const task = await journal.createTask('renew the certificate')
    clock.set(local('2026-03-09T16:30:00'))

    const completed = await journal.completeTask(task.id)

    expect(completed.completedAt).toBe(local('2026-03-09T16:30:00').toISOString())
    expect(completed.createdAt).toBe(task.createdAt)
    expect(await journal.completedTasks()).toEqual([completed])
  })

  it('does not move the instant of a Task already completed', async () => {
    const { journal, clock } = await journalAt('2026-03-09T10:00:00')
    const task = await journal.createTask('renew the certificate')
    clock.set(local('2026-03-09T16:30:00'))
    const completed = await journal.completeTask(task.id)

    clock.set(local('2026-03-09T18:00:00'))
    expect(await journal.completeTask(task.id)).toEqual(completed)
  })

  it('removes Task Completed At when the Task is reopened', async () => {
    const { journal, clock } = await journalAt('2026-03-09T10:00:00')
    const task = await journal.createTask('renew the certificate')
    clock.set(local('2026-03-09T16:30:00'))
    await journal.completeTask(task.id)

    const reopened = await journal.reopenTask(task.id)

    expect(reopened.completedAt).toBeNull()
    expect(await journal.completedTasks()).toEqual([])
    expect(await journal.openTasks()).toEqual([reopened])
  })

  it('leaves an Open Task alone when it is reopened', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')
    const task = await journal.createTask('renew the certificate')

    expect(await journal.reopenTask(task.id)).toEqual(task)
  })

  it('fails loudly for a Task that is not there', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')

    await expect(journal.completeTask('missing')).rejects.toThrow(/No such Task/)
    await expect(journal.reopenTask('missing')).rejects.toThrow(/No such Task/)
  })
})

describe('completeTaskAt', () => {
  it('completes an ordinary Task delivered for the slot it still holds', async () => {
    const { journal, clock } = await journalAt('2026-03-09T08:00:00')
    const task = await journal.createTask('renew the certificate', {
      date: '2026-03-09',
      time: '09:00',
    })
    clock.set(local('2026-03-09T09:00:30'))

    const outcome = await journal.completeTaskAt(task.id, {
      date: '2026-03-09',
      time: '09:00',
    })

    expect(outcome).toEqual({
      outcome: 'completed',
      task: expect.objectContaining({
        id: task.id,
        completedAt: local('2026-03-09T09:00:30').toISOString(),
      }),
    })
    expect(await journal.openTasks()).toEqual([])
  })

  it('refuses a slot whose date has moved since the caller was told', async () => {
    const { journal, clock } = await journalAt('2026-03-09T08:00:00')
    const task = await journal.createTask('renew the certificate', {
      date: '2026-03-09',
      time: '09:00',
    })
    const rescheduled = await journal.editTask(task.id, {
      description: 'renew the certificate',
      schedule: { date: '2026-03-16', time: '09:00' },
    })
    clock.set(local('2026-03-09T09:00:30'))

    const outcome = await journal.completeTaskAt(task.id, {
      date: '2026-03-09',
      time: '09:00',
    })

    expect(outcome).toEqual({ outcome: 'stale', task: rescheduled })
    expect(await journal.openTasks()).toEqual([rescheduled])
    expect(await journal.completedTasks()).toEqual([])
  })

  it('refuses a slot whose time has moved, on the same day', async () => {
    const { journal, clock } = await journalAt('2026-03-09T08:00:00')
    const task = await journal.createTask('renew the certificate', {
      date: '2026-03-09',
      time: '09:00',
    })
    const rescheduled = await journal.editTask(task.id, {
      description: 'renew the certificate',
      schedule: { date: '2026-03-09', time: '17:00' },
    })
    clock.set(local('2026-03-09T09:00:30'))

    const outcome = await journal.completeTaskAt(task.id, {
      date: '2026-03-09',
      time: '09:00',
    })

    expect(outcome).toEqual({ outcome: 'stale', task: rescheduled })
    expect(await journal.openTasks()).toEqual([rescheduled])
  })

  it('never moves the instant a Task already Completed was kept at', async () => {
    const { journal, clock } = await journalAt('2026-03-09T08:00:00')
    const task = await journal.createTask('renew the certificate', {
      date: '2026-03-09',
      time: '09:00',
    })
    clock.set(local('2026-03-09T08:45:00'))
    const completed = await journal.completeTask(task.id)

    clock.set(local('2026-03-09T09:00:30'))
    const outcome = await journal.completeTaskAt(task.id, {
      date: '2026-03-09',
      time: '09:00',
    })

    expect(outcome).toEqual({ outcome: 'stale', task: completed })
    expect(await journal.completedTasks()).toEqual([completed])
  })

  it('refuses a Task that has since been deleted, without failing', async () => {
    const { journal } = await journalAt('2026-03-09T08:00:00')
    const task = await journal.createTask('renew the certificate', {
      date: '2026-03-09',
      time: '09:00',
    })
    await journal.deleteTask(task.id)

    const outcome = await journal.completeTaskAt(task.id, {
      date: '2026-03-09',
      time: '09:00',
    })

    expect(outcome).toEqual({ outcome: 'stale', task: null })
  })

  it('keeps the occurrence and advances the series when the slot still stands', async () => {
    const { journal, clock } = await journalAt('2026-03-10T08:00:00')
    const daily = await journal.createTask(
      'water the plants',
      { date: '2026-03-10', time: '09:00' },
      { unit: 'day', interval: 1, weekdays: [] },
    )
    clock.set(local('2026-03-10T09:00:30'))

    const outcome = await journal.completeTaskAt(daily.id, {
      date: '2026-03-10',
      time: '09:00',
    })

    expect(outcome).toEqual({
      outcome: 'completed',
      task: expect.objectContaining({
        scheduledDate: '2026-03-11',
        scheduledTime: '09:00',
        completedAt: null,
      }),
    })
    expect(
      (await journal.occurrencesOf(daily.id)).map(
        (one) => `${formatSlot(slotOf(one))} ${one.completedAt === null ? 'open' : 'kept'}`,
      ),
    ).toEqual(['2026-03-11 09:00 open', '2026-03-10 09:00 kept'])
  })

  it('refuses a slot the series has already advanced past', async () => {
    const { journal, clock } = await journalAt('2026-03-10T08:00:00')
    const daily = await journal.createTask(
      'water the plants',
      { date: '2026-03-10', time: '09:00' },
      { unit: 'day', interval: 1, weekdays: [] },
    )
    clock.set(local('2026-03-10T09:00:30'))
    await journal.completeTask(daily.id)

    // The banner delivered for the 10th, clicked after the series moved on.
    clock.set(local('2026-03-10T22:00:00'))
    const outcome = await journal.completeTaskAt(daily.id, {
      date: '2026-03-10',
      time: '09:00',
    })

    expect(outcome.outcome).toBe('stale')
    expect(
      (await journal.occurrencesOf(daily.id)).map(
        (one) => `${formatSlot(slotOf(one))} ${one.completedAt === null ? 'open' : 'kept'}`,
      ),
    ).toEqual(['2026-03-11 09:00 open', '2026-03-10 09:00 kept'])
  })
})

describe('editTask', () => {
  it('rewords a Task without touching Task Created At', async () => {
    const { journal, clock } = await journalAt('2026-03-09T10:00:00')
    const task = await journal.createTask('renew the cert')
    clock.set(local('2026-03-09T12:00:00'))

    const reworded = await journal.editTask(task.id, {
      description: '  renew the TLS certificate  ',
      schedule: null,
    })

    expect(reworded.description).toBe('renew the TLS certificate')
    expect(reworded.createdAt).toBe(task.createdAt)
    expect(await journal.openTasks()).toEqual([reworded])
  })

  it('rewords a Completed Task and leaves it completed', async () => {
    const { journal, clock } = await journalAt('2026-03-09T10:00:00')
    const task = await journal.createTask('renew the cert')
    clock.set(local('2026-03-09T16:00:00'))
    const completed = await journal.completeTask(task.id)

    const reworded = await journal.editTask(task.id, {
      description: 'renewed it',
      schedule: null,
    })

    expect(reworded.completedAt).toBe(completed.completedAt)
    expect(await journal.completedTasks()).toEqual([reworded])
  })

  it('refuses an empty description rather than emptying the Task', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')
    const task = await journal.createTask('renew the cert')

    await expect(
      journal.editTask(task.id, { description: '  ', schedule: null }),
    ).rejects.toThrow()
    expect(await journal.openTasks()).toEqual([task])
  })

  it('fails loudly for a Task that is not there', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')

    await expect(
      journal.editTask('missing', { description: 'anything', schedule: null }),
    ).rejects.toThrow(/No such Task/)
  })

  it('writes the wording and the schedule in one go', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')
    const task = await journal.createTask('renew the cert')

    const saved = await journal.editTask(task.id, {
      description: 'renew the TLS certificate',
      schedule: { date: '2026-03-16', time: '14:00' },
    })

    expect(saved.description).toBe('renew the TLS certificate')
    expect(scheduleOf(saved)).toEqual({ date: '2026-03-16', time: '14:00' })
    expect(await journal.openTasks()).toEqual([saved])
  })

  it('refuses a description holding a line break', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')
    const task = await journal.createTask('renew the cert')

    await expect(
      journal.editTask(task.id, { description: 'two\nlines', schedule: null }),
    ).rejects.toThrow()
  })
})

describe('deleteTask', () => {
  it('removes the Task permanently, in either state', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')
    const open = await journal.createTask('still owed')
    const done = await journal.createTask('already handled')
    await journal.completeTask(done.id)

    await journal.deleteTask(open.id)
    await journal.deleteTask(done.id)

    expect(await journal.openTasks()).toEqual([])
    expect(await journal.completedTasks()).toEqual([])
  })

  it('leaves the Notes exactly as they were', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')
    await journal.capture('the migration landed')
    const task = await journal.createTask('renew the certificate')

    await journal.deleteTask(task.id)

    expect((await notesOn(journal, '2026-03-09')).map((note) => note.body)).toEqual(
      ['the migration landed'],
    )
  })

  it('fails loudly for a Task that is not there', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')

    await expect(journal.deleteTask('missing')).rejects.toThrow(/No such Task/)
  })
})

describe('Tasks and Notes are separate records', () => {
  it('a Capture never becomes a Task, and a Task never becomes a Note', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')

    await journal.capture('the migration landed')
    const task = await journal.createTask('renew the certificate')
    await journal.completeTask(task.id)

    expect(await journal.openTasks()).toEqual([])
    expect(await journal.completedTasks()).toHaveLength(1)
    expect(await notesOn(journal, '2026-03-09')).toHaveLength(1)
  })
})

describe('exportJournal with Tasks', () => {
  it('writes Notes and Tasks as separate top-level sections', async () => {
    const { journal, clock } = await journalAt('2026-03-11T09:00:00')
    await journal.capture('the migration landed')
    const done = await journal.createTask('renew the certificate')
    clock.set(local('2026-03-11T10:00:00'))
    await journal.createTask('chase the invoice')
    clock.set(local('2026-03-11T16:30:00'))
    await journal.completeTask(done.id)

    const exported = await journal.exportJournal()

    expect(exported.markdown).toBe(
      [
        '# Notes',
        '',
        '## Wed 11 Mar',
        '- the migration landed',
        '',
        '# Tasks',
        '',
        '## Open',
        '- [ ] chase the invoice',
        '',
        '## Completed',
        '- [x] renew the certificate (completed Wed 11 Mar, 16:30)',
      ].join('\n'),
    )
    expect(exported.noteCount).toBe(1)
    expect(exported.taskCount).toBe(2)
  })

  it('exports a journal holding only Tasks', async () => {
    const { journal } = await journalAt('2026-03-11T09:00:00')
    await journal.createTask('chase the invoice')

    const exported = await journal.exportJournal()

    expect(exported.markdown).toBe(
      '# Tasks\n\n## Open\n- [ ] chase the invoice',
    )
    expect(exported.noteCount).toBe(0)
    expect(exported.taskCount).toBe(1)
  })

  it('exports a journal holding only Notes with no Tasks section', async () => {
    const { journal } = await journalAt('2026-03-11T09:00:00')
    await journal.capture('the migration landed')

    const exported = await journal.exportJournal()

    expect(exported.markdown).toBe('# Notes\n\n## Wed 11 Mar\n- the migration landed')
    expect(exported.taskCount).toBe(0)
  })

  it('renders nothing at all for an empty journal', async () => {
    const { journal } = await journalAt('2026-03-11T09:00:00')

    expect(await journal.exportJournal()).toEqual({
      markdown: '',
      noteCount: 0,
      taskCount: 0,
    })
  })
})

describe('describeExport', () => {
  it('reports both counts', () => {
    expect(
      describeExport({ markdown: '', noteCount: 3, taskCount: 2 }, '/tmp/a.md'),
    ).toBe('Exported 3 Notes and 2 Tasks to /tmp/a.md.')
  })

  it('says only what the journal held', () => {
    expect(
      describeExport({ markdown: '', noteCount: 0, taskCount: 1 }, '/tmp/a.md'),
    ).toBe('Exported 1 Task to /tmp/a.md.')
    expect(
      describeExport({ markdown: '', noteCount: 1, taskCount: 0 }, '/tmp/a.md'),
    ).toBe('Exported 1 Note to /tmp/a.md.')
  })

  it('says an empty journal is empty rather than claiming a count', () => {
    expect(
      describeExport({ markdown: '', noteCount: 0, taskCount: 0 }, '/tmp/a.md'),
    ).toBe('Exported an empty journal to /tmp/a.md.')
  })
})

describe('Scheduled For', () => {
  it('stores the civil date and time as written, not an instant', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')

    const task = await journal.createTask('renew the certificate', {
      date: '2026-03-16',
      time: '14:00',
    })

    expect(task.scheduledDate).toBe('2026-03-16')
    expect(task.scheduledTime).toBe('14:00')
    expect(scheduleOf(task)).toEqual({ date: '2026-03-16', time: '14:00' })
    expect(await journal.openTasks()).toEqual([task])
  })

  it('leaves a Task Unscheduled when nothing is said about a schedule', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')

    const task = await journal.createTask('renew the certificate')

    expect(task.scheduledDate).toBeNull()
    expect(task.scheduledTime).toBeNull()
    expect(scheduleOf(task)).toBeNull()
  })

  it('keeps a date without a time as date-only', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')

    const task = await journal.createTask('renew the certificate', {
      date: '2026-03-16',
      time: null,
    })

    expect(scheduleOf(task)).toEqual({ date: '2026-03-16', time: null })
  })

  it('accepts a date already in the past', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')

    const task = await journal.createTask('chase the invoice', {
      date: '2026-02-01',
      time: '09:00',
    })

    expect(task.scheduledDate).toBe('2026-02-01')
  })

  it('refuses a date the calendar does not have', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')

    await expect(
      journal.createTask('x', { date: '2026-02-31', time: null }),
    ).rejects.toThrow()
    await expect(
      journal.createTask('x', { date: '0002-07-31', time: null }),
    ).rejects.toThrow()
    expect(await journal.openTasks()).toEqual([])
  })

  it('refuses a time that is not a minute of the day', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')

    await expect(
      journal.createTask('x', { date: '2026-03-16', time: '24:00' }),
    ).rejects.toThrow()
    await expect(
      journal.createTask('x', { date: '2026-03-16', time: '9:00' }),
    ).rejects.toThrow()
  })
})

describe('editTask and Scheduled For', () => {
  it('gives an Unscheduled Task a schedule', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')
    const task = await journal.createTask('renew the certificate')

    const scheduled = await journal.editTask(task.id, {
      description: task.description,
      schedule: { date: '2026-03-16', time: '14:00' },
    })

    expect(scheduleOf(scheduled)).toEqual({ date: '2026-03-16', time: '14:00' })
    expect(await journal.openTasks()).toEqual([scheduled])
  })

  it('clears the time with the date', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')
    const task = await journal.createTask('renew the certificate', {
      date: '2026-03-16',
      time: '14:00',
    })

    const cleared = await journal.editTask(task.id, {
      description: task.description,
      schedule: null,
    })

    expect(cleared.scheduledDate).toBeNull()
    expect(cleared.scheduledTime).toBeNull()
  })

  it('leaves Task Created At alone', async () => {
    const { journal, clock } = await journalAt('2026-03-09T10:00:00')
    const task = await journal.createTask('renew the certificate')

    clock.set(local('2026-03-10T10:00:00'))
    const scheduled = await journal.editTask(task.id, {
      description: task.description,
      schedule: { date: '2026-03-16', time: null },
    })

    expect(scheduled.createdAt).toBe(task.createdAt)
    expect(scheduled.description).toBe(task.description)
  })

  it('refuses to move the schedule of a Completed Task', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')
    const task = await journal.createTask('renew the certificate', {
      date: '2026-03-16',
      time: '14:00',
    })
    await journal.completeTask(task.id)

    await expect(
      journal.editTask(task.id, {
        description: task.description,
        schedule: { date: '2026-03-17', time: null },
      }),
    ).rejects.toThrow()
    expect(scheduleOf((await journal.completedTasks())[0])).toEqual({
      date: '2026-03-16',
      time: '14:00',
    })
  })

  it('preserves the schedule across completing and reopening', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')
    const task = await journal.createTask('renew the certificate', {
      date: '2026-03-16',
      time: '14:00',
    })

    await journal.completeTask(task.id)
    const reopened = await journal.reopenTask(task.id)

    expect(scheduleOf(reopened)).toEqual({ date: '2026-03-16', time: '14:00' })
  })

  it('still rewords a Completed Task, so long as its schedule stays put', async () => {
    const { journal } = await journalAt('2026-03-09T10:00:00')
    const task = await journal.createTask('renew the certificate', {
      date: '2026-03-16',
      time: '14:00',
    })
    await journal.completeTask(task.id)

    const reworded = await journal.editTask(task.id, {
      description: 'renewed it',
      schedule: { date: '2026-03-16', time: '14:00' },
    })

    expect(reworded.description).toBe('renewed it')
  })
})

describe('openTasks in Scheduled For order', () => {
  it('reads the scheduled ones earliest first and the Unscheduled after them', async () => {
    const { journal, clock } = await journalAt('2026-03-09T10:00:00')

    await journal.createTask('first written', null)
    clock.set(local('2026-03-09T11:00:00'))
    await journal.createTask('second written', null)
    await journal.createTask('later', { date: '2026-03-20', time: '09:00' })
    await journal.createTask('sooner', { date: '2026-03-16', time: '17:00' })
    await journal.createTask('all that day', { date: '2026-03-16', time: null })

    expect((await journal.openTasks()).map((task) => task.description)).toEqual([
      'all that day',
      'sooner',
      'later',
      'second written',
      'first written',
    ])
  })
})

describe('scheduledInstant', () => {
  it('resolves a wall-clock time in the timezone the user is in now', () => {
    expect(
      scheduledInstant({ date: '2026-06-01', time: '14:00' }, 'Europe/Lisbon'),
    ).toEqual(new Date('2026-06-01T13:00:00.000Z'))
  })

  it('keeps the same wall clock after the user travels', () => {
    const schedule = { date: '2026-06-01', time: '14:00' }

    expect(scheduledInstant(schedule, 'America/New_York')).toEqual(
      new Date('2026-06-01T18:00:00.000Z'),
    )
    expect(scheduledInstant(schedule, 'Asia/Tokyo')).toEqual(
      new Date('2026-06-01T05:00:00.000Z'),
    )
  })

  it('resolves a date-only schedule to the start of its day', () => {
    expect(
      scheduledInstant({ date: '2026-06-01', time: null }, 'Europe/Lisbon'),
    ).toEqual(new Date('2026-05-31T23:00:00.000Z'))
  })

  it('fires a time the clocks skipped at the first valid instant after it', () => {
    // Lisbon jumps 01:00 → 02:00 on 2026-03-29: 01:30 never happens.
    expect(
      scheduledInstant({ date: '2026-03-29', time: '01:30' }, 'Europe/Lisbon'),
    ).toEqual(new Date('2026-03-29T01:00:00.000Z'))
  })

  it('fires a repeated time once, at its first occurrence', () => {
    // Lisbon falls 02:00 → 01:00 on 2026-10-25: 01:30 happens twice.
    expect(
      scheduledInstant({ date: '2026-10-25', time: '01:30' }, 'Europe/Lisbon'),
    ).toEqual(new Date('2026-10-25T00:30:00.000Z'))
  })
})

describe('groupOpenTasks', () => {
  async function scheduledTasks() {
    const { journal } = await journalAt('2026-03-16T10:00:00')

    await journal.createTask('last week', { date: '2026-03-09', time: null })
    await journal.createTask('this morning', { date: '2026-03-16', time: '08:00' })
    await journal.createTask('this afternoon', { date: '2026-03-16', time: '17:00' })
    await journal.createTask('all day today', { date: '2026-03-16', time: null })
    await journal.createTask('next week', { date: '2026-03-23', time: '09:00' })
    await journal.createTask('someday')

    return journal.openTasks()
  }

  function named(groups: TaskGroup[], name: TaskGroupName): string[] {
    return (
      groups
        .find((group) => group.name === name)
        ?.tasks.map((task) => task.description) ?? []
    )
  }

  it('puts every Open Task in exactly one of the four groups', async () => {
    const groups = groupOpenTasks(
      await scheduledTasks(),
      local('2026-03-16T10:00:00'),
      'Europe/Lisbon',
    )

    expect(groups.map((group) => group.name)).toEqual([
      'overdue',
      'today',
      'upcoming',
      'unscheduled',
    ])
    expect(named(groups, 'overdue')).toEqual(['last week', 'this morning'])
    expect(named(groups, 'today')).toEqual(['all day today', 'this afternoon'])
    expect(named(groups, 'upcoming')).toEqual(['next week'])
    expect(named(groups, 'unscheduled')).toEqual(['someday'])
  })

  it('leaves a date-only Task in Today until its whole day is behind', async () => {
    const tasks = await scheduledTasks()

    expect(
      named(
        groupOpenTasks(tasks, local('2026-03-16T23:59:00'), 'Europe/Lisbon'),
        'today',
      ),
    ).toContain('all day today')
    expect(
      named(
        groupOpenTasks(tasks, local('2026-03-17T00:01:00'), 'Europe/Lisbon'),
        'overdue',
      ),
    ).toContain('all day today')
  })

  it('re-groups at local midnight without re-reading the Tasks', async () => {
    const tasks = await scheduledTasks()

    const tomorrow = groupOpenTasks(
      tasks,
      local('2026-03-17T09:00:00'),
      'Europe/Lisbon',
    )

    expect(named(tomorrow, 'today')).toEqual([])
    expect(named(tomorrow, 'overdue')).toEqual([
      'last week',
      'all day today',
      'this morning',
      'this afternoon',
    ])
  })
})

describe('taskAlerts', () => {
  async function tasks() {
    const { journal } = await journalAt('2026-03-16T10:00:00')

    await journal.createTask('timed and ahead', { date: '2026-03-16', time: '17:00' })
    await journal.createTask('date only', { date: '2026-03-16', time: null })
    await journal.createTask('timed and gone', { date: '2026-03-16', time: '08:00' })
    await journal.createTask('unscheduled')

    return journal
  }

  it('registers only future Open Tasks that have a time', async () => {
    const journal = await tasks()

    const alerts = taskAlerts(
      await journal.openTasks(),
      local('2026-03-16T10:00:00'),
      'Europe/Lisbon',
    )

    expect(alerts.map((alert) => alert.description)).toEqual(['timed and ahead'])
    expect(alerts[0]).toMatchObject({
      year: 2026,
      month: 3,
      day: 16,
      hour: 17,
      minute: 0,
    })
  })

  it('gives every Task the same identifier every time', async () => {
    const journal = await tasks()
    const [task] = await journal.openTasks()

    expect(taskAlertId(task.id)).toBe(`task:${task.id}`)
    expect(taskIdOfAlert(taskAlertId(task.id))).toBe(task.id)
    expect(taskIdOfAlert('something-else')).toBeNull()
  })

  it('gives up the Alert of a Task once it is completed', async () => {
    const journal = await tasks()
    const [ahead] = (await journal.openTasks()).filter(
      (task) => task.description === 'timed and ahead',
    )

    await journal.completeTask(ahead.id)

    expect(
      taskAlerts(
        await journal.openTasks(),
        local('2026-03-16T10:00:00'),
        'Europe/Lisbon',
      ),
    ).toEqual([])
  })

  it('shows the whole Task Description', async () => {
    const { journal } = await journalAt('2026-03-16T10:00:00')
    const long = 'renew the certificate '.repeat(20).trim()
    await journal.createTask(long, { date: '2026-03-16', time: '17:00' })

    const [alert] = taskAlerts(
      await journal.openTasks(),
      local('2026-03-16T10:00:00'),
      'Europe/Lisbon',
    )

    expect(alert.description).toBe(long)
  })
})

describe('exportJournal with Scheduled For', () => {
  it('writes the schedule on Open and Completed bullets, and omits it when absent', async () => {
    const { journal, clock } = await journalAt('2026-03-16T09:00:00')

    // Export order is oldest created first, whatever each one is scheduled
    // for, so the clock moves between them.
    await journal.createTask('renew the certificate', {
      date: '2026-03-20',
      time: '14:00',
    })
    clock.set(local('2026-03-16T09:10:00'))
    await journal.createTask('all that day', { date: '2026-03-21', time: null })
    clock.set(local('2026-03-16T09:20:00'))
    await journal.createTask('someday')
    clock.set(local('2026-03-16T09:30:00'))
    const done = await journal.createTask('chase the invoice', {
      date: '2026-03-16',
      time: '08:00',
    })
    clock.set(local('2026-03-16T10:30:00'))
    await journal.completeTask(done.id)

    const exported = await journal.exportJournal()

    expect(exported.markdown).toBe(
      [
        '# Tasks',
        '',
        '## Open',
        '- [ ] renew the certificate (scheduled 2026-03-20 14:00)',
        '- [ ] all that day (scheduled 2026-03-21)',
        '- [ ] someday',
        '',
        '## Completed',
        '- [x] chase the invoice (scheduled 2026-03-16 08:00; completed Mon 16 Mar, 10:30)',
      ].join('\n'),
    )
  })
})
