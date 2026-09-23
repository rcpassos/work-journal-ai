import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
// Node's built-in SQLite is still behind an experimental warning; it is used
// here only so the suite can exercise real SQL without Tauri running. In
// production the driver is plugin-sql.
import { DatabaseSync } from 'node:sqlite'
import type { Clock, SqlDriver } from '../journal'

const MIGRATIONS_DIR = join(import.meta.dirname, '../../../src-tauri/migrations')

/**
 * An in-memory database with the schema built from the same `.sql` files Rust
 * includes at compile time — the tested schema is the shipped schema, not a
 * copy of it.
 */
export async function openTestDatabase(): Promise<{
  driver: SqlDriver
  close: () => void
}> {
  const database = new DatabaseSync(':memory:')

  // Production is sqlx, which enables foreign keys by default. The harness
  // must match, or the suite tests a laxer database than the one that ships.
  database.exec('PRAGMA foreign_keys = ON')

  for (const sql of migrationSql()) {
    database.exec(sql)
  }

  const driver: SqlDriver = {
    async execute(sql, params) {
      database.prepare(sql).run(...(params as never[]))
    },
    async select<Row>(sql: string, params: unknown[]) {
      return database.prepare(sql).all(...(params as never[])) as Row[]
    },
    // A real transaction, on the one connection this database has: the suite
    // proves the recurrence invariants against SQLite's own atomicity rather
    // than against a fake that always succeeds — see
    // docs/adr/0020-recurring-task-transitions-are-transactional.md.
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

  return { driver, close: () => database.close() }
}

export function migrationSql(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => readFileSync(join(MIGRATIONS_DIR, name), 'utf8'))
}

/**
 * One migration by its position in that order — never by "the last one",
 * which silently becomes a different migration the next time one lands.
 */
export function migrationAt(position: number): string {
  const sql = migrationSql()[position]
  if (sql === undefined) {
    throw new Error(`there is no migration at position ${position}.`)
  }
  return sql
}

/** Time is injected, never mocked globally. */
export function fixedClock(instant: string | Date): Clock & {
  set: (next: Date) => void
} {
  let now = new Date(instant)
  return {
    now: () => now,
    set: (next: Date) => {
      now = next
    },
  }
}
