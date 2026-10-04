import { describe, expect, it } from 'vitest'
import { formatDayRange } from '@/journal/journal'

// The label is the whole of what the day axis says on screen now, so what it
// says is asserted in the reader's own locale rather than in one pinned here:
// the tests are about what the range is, not about how a language writes it.

/** The month a Journal Day falls in, as the reader's locale writes it. */
function monthOf(journalDay: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(journalDay))
}

function occurrences(label: string, part: string): number {
  return label.split(part).length - 1
}

describe("the Filter's days in words", () => {
  it('says one day once when both ends are the same', () => {
    const label = formatDayRange('2026-03-13', '2026-03-13')

    expect(occurrences(label, monthOf('2026-03-13'))).toBe(1)
    expect(occurrences(label, '2026')).toBe(1)
    expect(label).toContain('13')
  })

  it('says both ends of a range', () => {
    const label = formatDayRange('2026-03-09', '2026-03-13')

    expect(label).toContain('9')
    expect(label).toContain('13')
  })

  it('says what the two ends share only once', () => {
    const label = formatDayRange('2026-03-09', '2026-03-13')

    expect(occurrences(label, monthOf('2026-03-09'))).toBe(1)
    expect(occurrences(label, '2026')).toBe(1)
  })

  it('says both months when the range crosses one', () => {
    const label = formatDayRange('2026-07-28', '2026-08-03')

    expect(label).toContain(monthOf('2026-07-28'))
    expect(label).toContain(monthOf('2026-08-03'))
  })

  it('says both years when the range crosses one', () => {
    const label = formatDayRange('2025-12-28', '2026-01-03')

    expect(label).toContain('2025')
    expect(label).toContain('2026')
  })

  it('reads a Journal Day as the day it is labelled, not the evening before', () => {
    // The suite runs in Europe/Lisbon, which is UTC+1 in July: a label parsed
    // as a local instant would be right here and wrong in New York, so the
    // formatter reads the label as the calendar day it names.
    expect(formatDayRange('2026-07-01', '2026-07-01')).toContain('1')
    expect(formatDayRange('2026-07-01', '2026-07-01')).toContain(
      monthOf('2026-07-01'),
    )
  })
})
