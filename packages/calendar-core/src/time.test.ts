import { describe, expect, it } from 'vitest'
import { ianaZone, overlaps, syncWindow, zonedTimeToUtc } from './time'

const wall = (year: number, month: number, day: number, hour = 0, minute = 0) => ({
  year,
  month,
  day,
  hour,
  minute,
  second: 0,
})

describe('zonedTimeToUtc', () => {
  it('converts ordinary times on both sides of a DST change', () => {
    expect(zonedTimeToUtc(wall(2026, 1, 15, 9), 'Europe/London').toISOString()).toBe(
      '2026-01-15T09:00:00.000Z',
    )
    expect(zonedTimeToUtc(wall(2026, 7, 15, 9), 'Europe/London').toISOString()).toBe(
      '2026-07-15T08:00:00.000Z',
    )
    expect(zonedTimeToUtc(wall(2026, 7, 15, 9), 'Asia/Kolkata').toISOString()).toBe(
      '2026-07-15T03:30:00.000Z',
    )
  })

  it('moves a time in the skipped hour forward', () => {
    // 02:30 doesn't exist on 8 March 2026 in New York; it becomes 03:30 EDT.
    expect(zonedTimeToUtc(wall(2026, 3, 8, 2, 30), 'America/New_York').toISOString()).toBe(
      '2026-03-08T07:30:00.000Z',
    )
    // Same in Berlin on 29 March 2026: 02:30 becomes 03:30 CEST.
    expect(zonedTimeToUtc(wall(2026, 3, 29, 2, 30), 'Europe/Berlin').toISOString()).toBe(
      '2026-03-29T01:30:00.000Z',
    )
  })

  it('picks the first of a repeated hour', () => {
    expect(zonedTimeToUtc(wall(2026, 11, 1, 1, 30), 'America/New_York').toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    )
    expect(zonedTimeToUtc(wall(2026, 10, 25, 2, 30), 'Europe/Berlin').toISOString()).toBe(
      '2026-10-25T00:30:00.000Z',
    )
  })
})

describe('ianaZone', () => {
  it('accepts IANA names, strips vendor prefixes and rejects unknown zones', () => {
    expect(ianaZone('Europe/London')).toBe('Europe/London')
    expect(ianaZone('/mozilla.org/20050126_1/America/New_York')).toBe('America/New_York')
    expect(ianaZone('Pacific Standard Time')).toBeNull()
    expect(ianaZone(undefined)).toBeNull()
  })
})

describe('overlaps', () => {
  const r = { start: new Date('2026-11-10T00:00:00Z'), end: new Date('2026-11-11T00:00:00Z') }
  it('uses a half-open range', () => {
    expect(overlaps(new Date('2026-11-09T23:00:00Z'), new Date('2026-11-10T00:00:00Z'), r)).toBe(false)
    expect(overlaps(new Date('2026-11-09T23:00:00Z'), new Date('2026-11-10T00:30:00Z'), r)).toBe(true)
    expect(overlaps(new Date('2026-11-11T00:00:00Z'), new Date('2026-11-11T01:00:00Z'), r)).toBe(false)
  })
  it('counts zero-length events that start inside the range', () => {
    const at = new Date('2026-11-10T09:00:00Z')
    expect(overlaps(at, at, r)).toBe(true)
  })
})

describe('syncWindow', () => {
  it('spans from the start of last month to thirteen months ahead', () => {
    const w = syncWindow(new Date(2026, 10, 17, 15))
    expect(w.start).toEqual(new Date(2026, 9, 1))
    expect(w.end).toEqual(new Date(2027, 11, 1))
  })
  it('stays the same all month', () => {
    expect(syncWindow(new Date(2026, 10, 1))).toEqual(syncWindow(new Date(2026, 10, 30, 23)))
  })
})
