import { describe, expect, it } from 'vitest'
import { parseIcs } from './ics'

const cal = (...events: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ordo//Test//EN', ...events, 'END:VCALENDAR'].join('\r\n')

const range = (start: string, end: string) => ({ start: new Date(start), end: new Date(end) })
const parse = (ics: string, r = range('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')) =>
  parseIcs(ics, { calendarId: 'cal-1', range: r })
const iso = (d: Date) => d.toISOString()

const WEEKLY = cal(
  'BEGIN:VEVENT',
  'UID:weekly-1',
  'DTSTART;TZID=Europe/London:20261102T090000',
  'DTEND;TZID=Europe/London:20261102T093000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6',
  'EXDATE;TZID=Europe/London:20261116T090000',
  'SUMMARY:Standup',
  'LOCATION:Room 1',
  'END:VEVENT',
  // The 23 Nov occurrence moved to Tuesday at 10:00.
  'BEGIN:VEVENT',
  'UID:weekly-1',
  'RECURRENCE-ID;TZID=Europe/London:20261123T090000',
  'DTSTART;TZID=Europe/London:20261124T100000',
  'DTEND;TZID=Europe/London:20261124T103000',
  'SUMMARY:Standup (moved)',
  'END:VEVENT',
  // The 30 Nov occurrence was cancelled.
  'BEGIN:VEVENT',
  'UID:weekly-1',
  'RECURRENCE-ID;TZID=Europe/London:20261130T090000',
  'DTSTART;TZID=Europe/London:20261130T090000',
  'DTEND;TZID=Europe/London:20261130T093000',
  'STATUS:CANCELLED',
  'SUMMARY:Standup',
  'END:VEVENT',
)

describe('parseIcs', () => {
  it('expands a weekly event, honouring EXDATE, a moved occurrence and a cancelled one', () => {
    const events = parse(WEEKLY)
    expect(events.map((e) => [e.title, iso(e.start), iso(e.end)])).toEqual([
      ['Standup', '2026-11-02T09:00:00.000Z', '2026-11-02T09:30:00.000Z'],
      ['Standup', '2026-11-09T09:00:00.000Z', '2026-11-09T09:30:00.000Z'],
      ['Standup (moved)', '2026-11-24T10:00:00.000Z', '2026-11-24T10:30:00.000Z'],
      ['Standup', '2026-12-07T09:00:00.000Z', '2026-12-07T09:30:00.000Z'],
    ])
    expect(events.every((e) => e.uid === 'weekly-1' && e.calendarId === 'cal-1' && !e.allDay)).toBe(true)
    expect(events[0]!.location).toBe('Room 1')
    // Each occurrence is identified by its original start, including the moved one.
    expect(events.map((e) => e.recurrenceId)).toEqual([
      '2026-11-02T09:00:00.000Z',
      '2026-11-09T09:00:00.000Z',
      '2026-11-23T09:00:00.000Z',
      '2026-12-07T09:00:00.000Z',
    ])
  })

  it('only returns occurrences overlapping the range', () => {
    const events = parse(WEEKLY, range('2026-11-08T00:00:00Z', '2026-11-20T00:00:00Z'))
    expect(events.map((e) => iso(e.start))).toEqual(['2026-11-09T09:00:00.000Z'])
    // An occurrence moved into the range is found even though its original slot is outside it.
    const moved = parse(WEEKLY, range('2026-11-24T00:00:00Z', '2026-11-25T00:00:00Z'))
    expect(moved.map((e) => e.title)).toEqual(['Standup (moved)'])
  })

  it('treats all-day dates as local days, with an exclusive end', () => {
    const ics = cal(
      'BEGIN:VEVENT',
      'UID:trip',
      'DTSTART;VALUE=DATE:20261120',
      'DTEND;VALUE=DATE:20261123',
      'SUMMARY:Lisbon',
      'END:VEVENT',
    )
    const [trip] = parse(ics)
    expect(trip!.allDay).toBe(true)
    expect(trip!.start).toEqual(new Date(2026, 10, 20))
    expect(trip!.end).toEqual(new Date(2026, 10, 23))
    expect(trip!.recurrenceId).toBeUndefined()

    const local = (y: number, m: number, d: number) => new Date(y, m - 1, d)
    expect(
      parseIcs(ics, { calendarId: 'c', range: { start: local(2026, 11, 22), end: local(2026, 11, 23) } }),
    ).toHaveLength(1)
    expect(
      parseIcs(ics, { calendarId: 'c', range: { start: local(2026, 11, 23), end: local(2026, 11, 24) } }),
    ).toHaveLength(0)
  })

  it('gives a single all-day date with no end one day', () => {
    const [bday] = parse(
      cal(
        'BEGIN:VEVENT',
        'UID:bday',
        'DTSTART;VALUE=DATE:20261205',
        'RRULE:FREQ=YEARLY',
        'SUMMARY:Sam’s birthday',
        'END:VEVENT',
      ),
    )
    expect(bday!.start).toEqual(new Date(2026, 11, 5))
    expect(bday!.end).toEqual(new Date(2026, 11, 6))
    expect(bday!.recurrenceId).toBe('2026-12-05')
  })

  it('converts times in another zone, with or without a VTIMEZONE', () => {
    const events = parse(
      cal(
        'BEGIN:VTIMEZONE',
        'TZID:Ordo Test Zone',
        'BEGIN:STANDARD',
        'DTSTART:19700101T000000',
        'TZOFFSETFROM:+0530',
        'TZOFFSETTO:+0530',
        'END:STANDARD',
        'END:VTIMEZONE',
        'BEGIN:VEVENT',
        'UID:ny',
        'DTSTART;TZID=America/New_York:20261118T150000',
        'DTEND;TZID=America/New_York:20261118T160000',
        'SUMMARY:Call with New York',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:custom',
        'DTSTART;TZID=Ordo Test Zone:20261119T100000',
        'DURATION:PT45M',
        'SUMMARY:Custom zone',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:utc',
        'DTSTART:20261120T120000Z',
        'DTEND:20261120T130000Z',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:mozilla',
        'DTSTART;TZID=/mozilla.org/20050126_1/Asia/Tokyo:20261121T090000',
        'DTEND;TZID=/mozilla.org/20050126_1/Asia/Tokyo:20261121T100000',
        'SUMMARY:Tokyo',
        'END:VEVENT',
      ),
    )
    const byUid = Object.fromEntries(events.map((e) => [e.uid, e]))
    expect(iso(byUid['ny']!.start)).toBe('2026-11-18T20:00:00.000Z')
    expect(iso(byUid['custom']!.start)).toBe('2026-11-19T04:30:00.000Z')
    expect(iso(byUid['custom']!.end)).toBe('2026-11-19T05:15:00.000Z')
    expect(iso(byUid['utc']!.start)).toBe('2026-11-20T12:00:00.000Z')
    expect(byUid['utc']!.title).toBe('Untitled event')
    expect(iso(byUid['mozilla']!.start)).toBe('2026-11-21T00:00:00.000Z')
  })

  it('keeps the wall-clock time of a recurring event across a DST change', () => {
    const events = parse(
      cal(
        'BEGIN:VEVENT',
        'UID:dst',
        'DTSTART;TZID=America/New_York:20260302T090000',
        'DTEND;TZID=America/New_York:20260302T100000',
        'RRULE:FREQ=WEEKLY;UNTIL=20260317T000000Z',
        'SUMMARY:Gym',
        'END:VEVENT',
      ),
    )
    // US clocks went forward on Sunday 8 March 2026: 09:00 EST is 14:00Z, 09:00 EDT is 13:00Z.
    expect(events.map((e) => iso(e.start))).toEqual([
      '2026-03-02T14:00:00.000Z',
      '2026-03-09T13:00:00.000Z',
      '2026-03-16T13:00:00.000Z',
    ])
    expect(events.every((e) => e.end.getTime() - e.start.getTime() === 3_600_000)).toBe(true)
  })

  it('treats times without a zone as floating local time', () => {
    const [e] = parse(
      cal('BEGIN:VEVENT', 'UID:f', 'DTSTART:20261118T083000', 'DTEND:20261118T090000', 'END:VEVENT'),
    )
    expect(e!.start).toEqual(new Date(2026, 10, 18, 8, 30))
  })

  it('skips cancelled events and stops runaway rules', () => {
    const events = parse(
      cal(
        'BEGIN:VEVENT',
        'UID:gone',
        'DTSTART:20261118T083000Z',
        'STATUS:CANCELLED',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:minutely',
        'DTSTART:20200101T000000Z',
        'RRULE:FREQ=MINUTELY',
        'END:VEVENT',
      ),
    )
    expect(events.find((e) => e.uid === 'gone')).toBeUndefined()
    // A minutely rule from 2020 never reaches the 2026 range within the step limit.
    expect(events.filter((e) => e.uid === 'minutely')).toHaveLength(0)
  })

  it('keeps an override whose master is missing (an invitation to one occurrence)', () => {
    const [e] = parse(
      cal(
        'BEGIN:VEVENT',
        'UID:orphan',
        'RECURRENCE-ID:20261118T100000Z',
        'DTSTART:20261118T110000Z',
        'DTEND:20261118T120000Z',
        'SUMMARY:One-off',
        'END:VEVENT',
      ),
    )
    expect(e!.title).toBe('One-off')
    expect(e!.recurrenceId).toBe('2026-11-18T10:00:00.000Z')
  })
})

describe('parseIcs edge cases', () => {
  const event = (...lines: string[]) => cal('BEGIN:VEVENT', ...lines, 'END:VEVENT')
  const starts = (ics: string, r?: ReturnType<typeof range>) => parse(ics, r).map((e) => iso(e.start))

  it('keeps the DTSTART occurrence of an event with RDATEs and no RRULE', () => {
    expect(
      starts(
        event(
          'UID:rdate',
          'DTSTART;TZID=Europe/London:20261102T090000',
          'DTEND;TZID=Europe/London:20261102T100000',
          'RDATE;TZID=Europe/London:20261105T150000',
          'SUMMARY:Twice',
        ),
      ),
    ).toEqual(['2026-11-02T09:00:00.000Z', '2026-11-05T15:00:00.000Z'])
  })

  it('reads RDATE periods instead of failing the whole calendar', () => {
    const events = parse(
      event(
        'UID:period',
        'DTSTART:20261102T090000Z',
        'DTEND:20261102T100000Z',
        'RRULE:FREQ=WEEKLY;COUNT=2',
        'RDATE;VALUE=PERIOD:20261105T150000Z/PT2H',
        'SUMMARY:Periods',
      ),
    )
    expect(events.map((e) => [iso(e.start), iso(e.end)])).toEqual([
      ['2026-11-02T09:00:00.000Z', '2026-11-02T10:00:00.000Z'],
      ['2026-11-05T15:00:00.000Z', '2026-11-05T17:00:00.000Z'],
      ['2026-11-09T09:00:00.000Z', '2026-11-09T10:00:00.000Z'],
    ])
  })

  it('excludes an EXDATE written in UTC from an event in a named zone without a VTIMEZONE', () => {
    expect(
      starts(
        event(
          'UID:ex',
          'DTSTART;TZID=America/New_York:20261102T090000',
          'DTEND;TZID=America/New_York:20261102T100000',
          'RRULE:FREQ=WEEKLY;COUNT=3',
          'EXDATE:20261109T140000Z',
          'SUMMARY:Sync',
        ),
      ),
    ).toEqual(['2026-11-02T14:00:00.000Z', '2026-11-16T14:00:00.000Z'])
  })

  it('ends a recurring overnight event at the same clock time after the clocks change', () => {
    const events = parse(
      event(
        'UID:night',
        'DTSTART;TZID=Europe/London:20260327T220000',
        'DTEND;TZID=Europe/London:20260328T080000',
        'RRULE:FREQ=DAILY;COUNT=3',
        'SUMMARY:Night shift',
      ),
      range('2026-03-27T00:00:00Z', '2026-04-01T00:00:00Z'),
    )
    // 28 March 22:00 GMT to 29 March 08:00 BST, which is 07:00 UTC.
    expect(iso(events[1]!.end)).toBe('2026-03-29T07:00:00.000Z')
  })

  it('includes the UNTIL day when UNTIL is a date on a timed event', () => {
    expect(
      starts(
        event(
          'UID:until',
          'DTSTART:20261102T090000Z',
          'RRULE:FREQ=DAILY;UNTIL=20261104',
          'SUMMARY:Three days',
        ),
      ),
    ).toHaveLength(3)
  })

  it('skips one broken event and keeps the rest', () => {
    const ics = cal(
      'BEGIN:VEVENT',
      'UID:broken',
      'DTSTART:20261102T090000Z',
      'RRULE:FREQ=DAILY;COUNT=2',
      'RDATE;VALUE=PERIOD:not-a-period',
      'SUMMARY:Broken',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:fine',
      'DTSTART:20261103T090000Z',
      'SUMMARY:Fine',
      'END:VEVENT',
    )
    expect(parse(ics).map((e) => e.title)).toContain('Fine')
  })

  it('parses a big file quickly', () => {
    const events = Array.from({ length: 15_000 }, (_, i) =>
      [
        'BEGIN:VEVENT',
        `UID:e${i}`,
        `DTSTART:2026${String((i % 12) + 1).padStart(2, '0')}10T090000Z`,
        `DTEND:2026${String((i % 12) + 1).padStart(2, '0')}10T100000Z`,
        `SUMMARY:Event ${i}`,
        'END:VEVENT',
      ].join('\r\n'),
    )
    const start = performance.now()
    expect(parse(cal(...events))).toHaveLength(15_000)
    expect(performance.now() - start).toBeLessThan(3_000)
  })
})
