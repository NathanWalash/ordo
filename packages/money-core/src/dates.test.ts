import { describe, expect, it } from 'vitest'
import {
  addCadence,
  addMonths,
  cyclesBetween,
  daysBetween,
  guessDateOrder,
  isISODate,
  lastOnOrBefore,
  nextOnOrAfter,
  parseStatementDate,
} from './dates'

describe('parseStatementDate', () => {
  it('reads UK, ISO and named-month formats', () => {
    expect(parseStatementDate('17/11/2026')).toBe('2026-11-17')
    expect(parseStatementDate('17-11-26')).toBe('2026-11-17')
    expect(parseStatementDate('17.11.2026')).toBe('2026-11-17')
    expect(parseStatementDate('2026-11-17')).toBe('2026-11-17')
    expect(parseStatementDate('2026-11-17 10:02:11')).toBe('2026-11-17')
    expect(parseStatementDate('17 Nov 2026')).toBe('2026-11-17')
    expect(parseStatementDate('17-Nov-2026')).toBe('2026-11-17')
    expect(parseStatementDate('7 September 2026')).toBe('2026-09-07')
  })

  it('is day-first unless told otherwise', () => {
    expect(parseStatementDate('03/04/2026')).toBe('2026-04-03')
    expect(parseStatementDate('03/04/2026', 'mdy')).toBe('2026-03-04')
  })

  it('rejects things that are not dates', () => {
    expect(parseStatementDate('31/02/2026')).toBeNull()
    expect(parseStatementDate('Date')).toBeNull()
    expect(parseStatementDate('')).toBeNull()
    expect(parseStatementDate('12.99')).toBeNull()
  })
})

describe('guessDateOrder', () => {
  it('is day-first unless only month-first fits', () => {
    expect(guessDateOrder(['01/02/2026', '03/04/2026'])).toBe('dmy')
    expect(guessDateOrder(['01/02/2026', '25/04/2026'])).toBe('dmy')
    expect(guessDateOrder(['01/02/2026', '04/25/2026'])).toBe('mdy')
  })
})

describe('date arithmetic', () => {
  it('clamps months to their last day', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29')
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15')
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15')
  })

  it('keeps anchoring to the original day across short months', () => {
    expect(addCadence('2026-01-31', 'monthly', 2)).toBe('2026-03-31')
    expect(addCadence('2026-01-31', 'yearly', 1)).toBe('2027-01-31')
    expect(addCadence('2026-01-01', 'weekly', -1)).toBe('2025-12-25')
  })

  it('counts days between dates', () => {
    expect(daysBetween('2026-11-01', '2026-12-01')).toBe(30)
    expect(daysBetween('2026-12-01', '2026-11-01')).toBe(-30)
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2) // across the clocks changing
  })

  it('finds the next and last cycle around a date', () => {
    expect(nextOnOrAfter('2026-01-15', 'monthly', '2026-11-17')).toBe('2026-12-15')
    expect(nextOnOrAfter('2026-01-15', 'monthly', '2026-11-15')).toBe('2026-11-15')
    expect(nextOnOrAfter('2027-06-01', 'monthly', '2026-11-17')).toBe('2026-12-01')
    expect(lastOnOrBefore('2026-01-15', 'monthly', '2026-11-17')).toBe('2026-11-15')
    expect(lastOnOrBefore('2026-11-20', 'weekly', '2026-11-17')).toBe('2026-11-13')
  })

  it('lists cycles in a range', () => {
    expect(cyclesBetween('2026-01-31', 'monthly', '2026-02-01', '2026-04-30')).toEqual([
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
    ])
    expect(cyclesBetween('2026-01-01', 'yearly', '2026-02-01', '2026-12-31')).toEqual([])
  })

  it('validates ISO dates', () => {
    expect(isISODate('2026-11-17')).toBe(true)
    expect(isISODate('2026-02-30')).toBe(false)
    expect(isISODate('17/11/2026')).toBe(false)
  })
})
