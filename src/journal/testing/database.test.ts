import { afterEach, describe, expect, it } from 'vitest'
import { openTestDatabase } from './database'

/**
 * The test driver's `transaction` stands in for Rust's `journal_transaction`,
 * which binds null, strings and whole numbers that fit an i64, and refuses
 * everything else. A driver that is laxer passes tests for a statement the app
 * then refuses.
 */
describe('the test driver transaction', () => {
  const closers: (() => void)[] = []
  afterEach(() => {
    for (const close of closers.splice(0)) close()
  })

  async function open() {
    const { driver, close } = await openTestDatabase()
    closers.push(close)
    await driver.execute('CREATE TABLE cell (value)', [])
    return driver
  }

  it('binds null, strings and whole numbers', async () => {
    const driver = await open()

    await driver.transaction([
      { sql: 'INSERT INTO cell VALUES (?)', params: [null] },
      { sql: 'INSERT INTO cell VALUES (?)', params: ['text'] },
      { sql: 'INSERT INTO cell VALUES (?)', params: [42] },
      { sql: 'INSERT INTO cell VALUES (?)', params: [Number.MIN_SAFE_INTEGER] },
    ])

    expect(await driver.select('SELECT count(*) AS n FROM cell', [])).toEqual([
      { n: 4 },
    ])
  })

  it.each([
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['a number past the i64 maximum', 2 ** 63],
    ['a number at the i64 minimum, which JSON writes past it', -(2 ** 63)],
    ['a bigint', 1n],
    ['bytes', new Uint8Array([1])],
    ['a boolean', true],
    ['an object', {}],
  ])('refuses %s, and rolls back what came before it', async (_, value) => {
    const driver = await open()

    await expect(
      driver.transaction([
        { sql: 'INSERT INTO cell VALUES (?)', params: ['kept out'] },
        { sql: 'INSERT INTO cell VALUES (?)', params: [value] },
      ]),
    ).rejects.toThrow()

    expect(await driver.select('SELECT count(*) AS n FROM cell', [])).toEqual([
      { n: 0 },
    ])
  })
})
