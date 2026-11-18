import { describe, expect, it } from 'vitest'
import {
  addWallMinutes,
  checkDraft,
  dateToWall,
  draftSpan,
  parseDay,
  parseDayTime,
  sameRepeat,
  shiftDays,
  wallMinutes,
  wallToDate,
  type EventDraft,
} from './draft'

const draft = (o: Partial<EventDraft> = {}): EventDraft => ({
  title: 'Dentist',
  allDay: false,
  start: '2026-11-20T09:00',
  end: '2026-11-20T10:00',
  timeZone: 'Europe/London',
  location: '',
  notes: '',
  repeat: null,
  alert: null,
  ...o,
})

describe('parsing wall-clock dates', () => {
  it('accepts real days and times only', () => {
    expect(parseDay('2026-02-28')).toMatchObject({ year: 2026, month: 2, day: 28, hour: 0 })
    expect(parseDay('2026-02-29')).toBeNull()
    expect(parseDay('2028-02-29')).not.toBeNull()
    expect(parseDay('26-1-1')).toBeNull()
    expect(parseDayTime('2026-11-20T09:30')).toMatchObject({ day: 20, hour: 9, minute: 30 })
    expect(parseDayTime('2026-11-20T24:00')).toBeNull()
    expect(parseDayTime('2026-11-20 09:30')).toBeNull()
    expect(parseDayTime('2026-11-20')).toBeNull()
  })

  it('does whole-day and clock-face arithmetic without time zones', () => {
    const w = parseDayTime('2026-12-31T23:30')!
    expect(shiftDays(w, 1)).toMatchObject({ year: 2027, month: 1, day: 1, hour: 23, minute: 30 })
    expect(addWallMinutes(w, 45)).toMatchObject({ year: 2027, month: 1, day: 1, hour: 0, minute: 15 })
    expect(wallMinutes(w, parseDayTime('2027-01-01T01:00')!)).toBe(90)
  })
})

describe('time zones', () => {
  it('converts wall clocks in a zone to instants, across DST', () => {
    expect(wallToDate(parseDayTime('2026-07-01T09:00')!, 'Europe/London').toISOString()).toBe(
      '2026-07-01T08:00:00.000Z',
    )
    expect(wallToDate(parseDayTime('2026-12-01T09:00')!, 'Europe/London').toISOString()).toBe(
      '2026-12-01T09:00:00.000Z',
    )
    expect(wallToDate(parseDayTime('2026-12-01T09:00')!, 'UTC').toISOString()).toBe(
      '2026-12-01T09:00:00.000Z',
    )
    expect(wallToDate(parseDayTime('2026-12-01T09:00')!, null)).toEqual(new Date(2026, 11, 1, 9))
  })

  it('reads the wall clock back in any zone', () => {
    const at = new Date('2026-07-01T08:00:00Z')
    expect(dateToWall(at, 'Europe/London')).toMatchObject({ day: 1, hour: 9, minute: 0 })
    expect(dateToWall(at, 'America/New_York')).toMatchObject({ day: 1, hour: 4 })
    expect(dateToWall(at, 'Asia/Tokyo')).toMatchObject({ day: 1, hour: 17 })
    expect(dateToWall(at, null)).toMatchObject({ hour: at.getHours() })
  })

  it('gives a draft’s span as instants, all-day ending the morning after the last day', () => {
    expect(draftSpan(draft())).toEqual({
      start: new Date('2026-11-20T09:00:00Z'),
      end: new Date('2026-11-20T10:00:00Z'),
    })
    expect(
      draftSpan(draft({ allDay: true, start: '2026-11-20', end: '2026-11-22', timeZone: null })),
    ).toEqual({
      start: new Date(2026, 10, 20),
      end: new Date(2026, 10, 23),
    })
  })
})

describe('checkDraft', () => {
  it('accepts a normal event', () => {
    expect(checkDraft(draft())).toBeNull()
    expect(
      checkDraft(draft({ allDay: true, start: '2026-11-20', end: '2026-11-20', timeZone: null })),
    ).toBeNull()
    expect(checkDraft(draft({ repeat: { frequency: 'weekly', until: '2027-01-01' }, alert: 15 }))).toBeNull()
  })

  it('explains what’s wrong in plain words', () => {
    expect(checkDraft(draft({ end: '2026-11-20T08:00' }))).toBe('The event ends before it starts.')
    expect(checkDraft(draft({ start: 'tomorrow' }))).toBe('Enter a start date and time.')
    expect(checkDraft(draft({ allDay: true, start: '2026-11-20', end: 'x' }))).toBe('Enter an end date.')
    expect(checkDraft(draft({ timeZone: 'Mars/Olympus' }))).toBe('Choose a time zone from the list.')
    expect(checkDraft(draft({ title: 'x'.repeat(501) }))).toBe('The title is too long.')
    expect(checkDraft(draft({ repeat: { frequency: 'weekly', until: '2026-11-01' } }))).toBe(
      'The repeat ends before the event starts.',
    )
    expect(checkDraft(draft({ repeat: { frequency: 'weekly', until: '2027-01-01', count: 3 } }))).toMatch(
      /not both/,
    )
    expect(checkDraft(draft({ repeat: { frequency: 'weekly', count: 0 } }))).toMatch(/between 1 and 1000/)
    expect(checkDraft(draft({ alert: 1.5 }))).toBe('Choose an alert from the list.')
    expect(checkDraft(draft({ alert: 999_999 }))).toBe('Choose an alert from the list.')
  })

  it('allows an event that ends when it starts', () => {
    expect(checkDraft(draft({ end: '2026-11-20T09:00' }))).toBeNull()
  })
})

describe('sameRepeat', () => {
  it('compares rules field by field', () => {
    expect(sameRepeat(null, null)).toBe(true)
    expect(sameRepeat(null, { frequency: 'daily' })).toBe(false)
    expect(sameRepeat({ frequency: 'daily', count: 3 }, { frequency: 'daily', count: 3 })).toBe(true)
    expect(sameRepeat({ frequency: 'daily', custom: true }, { frequency: 'daily' })).toBe(false)
  })
})
