import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import {
  createJournal,
  journalDayFor,
  type SqlDriver,
} from './journal'
import { fixedClock, migrationSql, openTestDatabase } from './testing/database'

describe('the Observe migration', () => {
  it('keeps the old Notes and handled meetings while adding provenance', () => {
    const migrations = migrationSql()
    expect(migrations).toHaveLength(8)

    const database = new DatabaseSync(':memory:')
    try {
      database.exec(migrations.slice(0, 7).join('\n'))
      database.prepare(
        `INSERT INTO notes (id, body, captured_at, journal_day, edited_at, project, origin)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'imported-note',
        'Weekly sync',
        '2026-09-21T09:30:00.000Z',
        '2026-09-21',
        null,
        null,
        'import',
      )
      database.prepare(
        'INSERT INTO imported_meetings (event_key, handled_at) VALUES (?, ?)',
      ).run('calendar-event@2026-09-21T09:30:00.000Z', '2026-09-21T18:40:00.000Z')

      database.exec(migrations[7])

      const columns = database
        .prepare('PRAGMA table_info(notes)')
        .all() as Array<{ name: string }>
      expect(columns.map(({ name }) => name)).toEqual([
        'id',
        'body',
        'captured_at',
        'journal_day',
        'edited_at',
        'project',
        'origin',
        'source',
        'source_key',
      ])

      expect(
        database
          .prepare('SELECT id, origin, source, source_key FROM notes')
          .get(),
      ).toEqual({
        id: 'imported-note',
        origin: 'import',
        source: null,
        source_key: null,
      })
      expect(
        database
          .prepare('SELECT source, event_key, handled_at FROM handled_events')
          .get(),
      ).toEqual({
        source: 'calendar',
        event_key: 'calendar-event@2026-09-21T09:30:00.000Z',
        handled_at: '2026-09-21T18:40:00.000Z',
      })
      expect(
        database
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'imported_meetings'")
          .get(),
      ).toBeUndefined()
      expect(
        database
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'index' AND tbl_name = 'notes'
               AND name IN ('notes_journal_day', 'notes_project')
             ORDER BY name`,
          )
          .all(),
      ).toEqual([{ name: 'notes_journal_day' }, { name: 'notes_project' }])

      const insertNote = database.prepare(
        `INSERT INTO notes (
           id, body, captured_at, journal_day, edited_at, project, origin, source, source_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      expect(() =>
        insertNote.run(
          'observed-note',
          'shipped the migration',
          '2026-09-22T09:30:00.000Z',
          '2026-09-22',
          null,
          null,
          'observe',
          'work-journal-ai',
          '6f47772',
        ),
      ).not.toThrow()
      expect(() =>
        insertNote.run(
          'captured-with-source',
          'typed the migration',
          '2026-09-22T09:30:00.000Z',
          '2026-09-22',
          null,
          null,
          'capture',
          'work-journal-ai',
          '6f47772',
        ),
      ).toThrow()
      expect(() =>
        insertNote.run(
          'observed-without-source',
          'shipped the migration',
          '2026-09-22T09:30:00.000Z',
          '2026-09-22',
          null,
          null,
          'observe',
          null,
          null,
        ),
      ).toThrow()
    } finally {
      database.close()
    }
  })
})

describe('Observe', () => {
  it('files an event on the day the work happened and keeps its source', async () => {
    const { driver, close } = await openTestDatabase()
    try {
      const happenedAt = new Date(2026, 8, 22, 23, 40)
      const journal = createJournal({
        clock: fixedClock(new Date(2026, 8, 23, 0, 30)),
        driver,
      })

      const note = await journal.observe({
        source: 'work-journal-ai',
        eventKey: '6f47772',
        body: 'shipped the migration',
        happenedAt,
        project: 'Operations',
      })

      expect(note).toMatchObject({
        body: 'shipped the migration',
        project: 'operations',
        capturedAt: happenedAt.toISOString(),
        journalDay: '2026-09-22',
        editedAt: null,
        origin: 'observe',
        source: 'work-journal-ai',
        sourceKey: '6f47772',
      })
      expect(note!.journalDay).toBe(journalDayFor(happenedAt))
      expect(await journal.notesForFilter({ from: '2026-09-22', to: '2026-09-22' })).toMatchObject([
        { id: note!.id, source: 'work-journal-ai', sourceKey: '6f47772' },
      ])
      expect(await journal.capturedNoteCount('2026-09-22')).toBe(0)
    } finally {
      close()
    }
  })

  it('refuses a handled event after deletion, while another source may reuse its key', async () => {
    const { driver, close } = await openTestDatabase()
    try {
      const journal = createJournal({
        clock: fixedClock('2026-09-22T10:00:00.000Z'),
        driver,
      })
      const event = {
        source: 'repo-one',
        eventKey: 'same-key',
        body: 'first source event',
        happenedAt: '2026-09-22T09:00:00.000Z',
      }

      const first = await journal.observe(event)
      await journal.delete(first!.id)

      expect(
        await journal.observe({ ...event, happenedAt: '2026-09-23T09:00:00.000Z' }),
      ).toBeNull()
      expect(
        await journal.observe({ ...event, source: 'repo-two', body: 'second source event' }),
      ).toMatchObject({ source: 'repo-two', sourceKey: 'same-key' })
      expect(await journal.notesForFilter({ from: '2026-09-22', to: '2026-09-22' })).toMatchObject([
        { body: 'second source event', source: 'repo-two' },
      ])
    } finally {
      close()
    }
  })

  it('writes the handled row first and rolls both writes back together', async () => {
    const { driver, close } = await openTestDatabase()
    try {
      let failNoteWrite = true
      let writeOrder: string[] = []
      const observedDriver: SqlDriver = {
        execute: (sql, params) => driver.execute(sql, params),
        select: (sql, params) => driver.select(sql, params),
        transaction: (statements) => {
          writeOrder = statements.map(({ sql }) => sql.trim().split(/\s+/).slice(0, 3).join(' '))
          if (!failNoteWrite) return driver.transaction(statements)
          failNoteWrite = false
          return driver.transaction([
            statements[0],
            { sql: 'INSERT INTO missing_table VALUES (?)', params: ['fail'] },
          ])
        },
      }
      const journal = createJournal({
        clock: fixedClock('2026-09-22T10:00:00.000Z'),
        driver: observedDriver,
      })
      const event = {
        source: 'repo-one',
        eventKey: 'transaction-key',
        body: 'transactional source event',
        happenedAt: '2026-09-22T09:00:00.000Z',
      }

      await expect(journal.observe(event)).rejects.toThrow()
      expect(writeOrder).toEqual([
        'INSERT INTO handled_events',
        'INSERT INTO notes',
      ])

      const retry = await journal.observe(event)
      expect(retry).toMatchObject({ body: 'transactional source event', origin: 'observe' })
    } finally {
      close()
    }
  })

  it('keeps provenance through edits and leaves it out of the Digest and Export', async () => {
    const { driver, close } = await openTestDatabase()
    try {
      const journal = createJournal({
        clock: fixedClock('2026-09-22T10:00:00.000Z'),
        driver,
      })
      const note = await journal.observe({
        source: 'work-journal-ai',
        eventKey: '6f47772',
        body: 'shipped the migration',
        happenedAt: '2026-09-22T09:00:00.000Z',
      })

      const edited = await journal.editBody(note!.id, 'released the migration')
      const refiled = await journal.refile(edited.id, '2026-09-23')
      const filed = await journal.editProject(refiled.id, 'operations')

      expect(filed).toMatchObject({
        origin: 'observe',
        source: 'work-journal-ai',
        sourceKey: '6f47772',
      })
      const digest = await journal.digest({ from: '2026-09-23', to: '2026-09-23' })
      const exported = await journal.exportJournal()
      expect(digest.markdown).toBe('- #operations released the migration')
      expect(exported.markdown).not.toContain('work-journal-ai')
      expect(exported.markdown).not.toContain('6f47772')
    } finally {
      close()
    }
  })
})
