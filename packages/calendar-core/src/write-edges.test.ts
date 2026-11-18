// Edge cases from review: zones that aren't IANA names, series with an end date, made-up
// occurrence ids, time zone work bounded by the event, and series details.
import { describe, expect, it } from 'vitest'
import type { EventDraft } from './draft'
import { parseIcs } from './ics'
import { createEventIcs, deleteFromIcs, IcsEditError, readEvent, updateEventIcs } from './write'

const YEAR = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2028-01-01T00:00:00Z') }
const parse = (ics: string) => parseIcs(ics, { calendarId: 'home', range: YEAR })
const isoStarts = (ics: string) => parse(ics).map((e) => e.start.toISOString())
const lines = (ics: string) => ics.split('\r\n')
const cal = (...body: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other//EN', ...body, 'END:VCALENDAR', ''].join('\r\n')

const draft = (o: Partial<EventDraft> = {}): EventDraft => ({
  title: 'Standup',
  allDay: false,
  start: '2026-11-02T09:00',
  end: '2026-11-02T09:30',
  timeZone: 'Europe/London',
  location: '',
  notes: '',
  repeat: null,
  alert: null,
  ...o,
})
const create = (d: Partial<EventDraft> = {}) => createEventIcs(draft(d), { uid: 'ev-1' })
const WEEKLY = () => create({ repeat: { frequency: 'weekly', count: 5 } })
const wk = (o: Partial<EventDraft>) => draft({ repeat: { frequency: 'weekly', count: 5 }, ...o })
// 09:00 London in November is 09:00 UTC.
const occ = (day: number, hour = 9) => new Date(Date.UTC(2026, 10, day, hour)).toISOString()

// Outlook and Exchange name zones their own way, defined only in the file's VTIMEZONE.
const OUTLOOK_ZONE = [
  'BEGIN:VTIMEZONE',
  'TZID:W. Europe Standard Time',
  'BEGIN:STANDARD',
  'DTSTART:16010101T030000',
  'TZOFFSETFROM:+0200',
  'TZOFFSETTO:+0100',
  'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10',
  'END:STANDARD',
  'BEGIN:DAYLIGHT',
  'DTSTART:16010101T020000',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
]
const outlook = (...extra: string[]) =>
  cal(
    ...OUTLOOK_ZONE,
    'BEGIN:VEVENT',
    'UID:o',
    'DTSTART;TZID=W. Europe Standard Time:20261102T090000',
    'DTEND;TZID=W. Europe Standard Time:20261102T100000',
    ...extra,
    'SUMMARY:Sync',
    'END:VEVENT',
  )
// 09:00 in Berlin in November is 08:00 UTC.
const cet = (day: number, hour = 9) => new Date(Date.UTC(2026, 10, day, hour - 1)).toISOString()

describe('zones that aren’t IANA names', () => {
  it('a title change keeps the event exactly where it was', () => {
    const ics = outlook()
    expect(isoStarts(ics)).toEqual([cet(2)])
    const before = readEvent(ics, { uid: 'o' }).draft
    const renamed = updateEventIcs(ics, { uid: 'o' }, { ...before, title: 'Weekly sync' }, 'all')
    expect(lines(renamed)).toContain('DTSTART;TZID=W. Europe Standard Time:20261102T090000')
    expect(lines(renamed)).toContain('TZID:W. Europe Standard Time')
    expect(isoStarts(renamed)).toEqual([cet(2)])
  })

  it('shows the event on this computer’s clock, at the right instant', () => {
    const d = readEvent(outlook(), { uid: 'o' }).draft
    const shown = new Date(cet(2))
    const pad = (n: number) => String(n).padStart(2, '0')
    expect(d.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(d.start).toBe(`2026-11-02T${pad(shown.getHours())}:${pad(shown.getMinutes())}`)
  })

  it('changes and deletes one occurrence of a series in that zone', () => {
    const series = outlook('RRULE:FREQ=WEEKLY;COUNT=3')
    expect(isoStarts(series)).toEqual([cet(2), cet(9), cet(16)])
    const target = { uid: 'o', recurrenceId: cet(9) }
    const before = readEvent(series, target).draft
    const renamed = updateEventIcs(series, target, { ...before, title: 'Moved sync' }, 'this')
    expect(lines(renamed)).toContain('RECURRENCE-ID;TZID=W. Europe Standard Time:20261109T090000')
    expect(parse(renamed).map((e) => [e.title, e.start.toISOString()])).toEqual([
      ['Sync', cet(2)],
      ['Moved sync', cet(9)],
      ['Sync', cet(16)],
    ])
    const deleted = deleteFromIcs(series, { uid: 'o', recurrenceId: cet(16) }, 'this')!
    expect(lines(deleted)).toContain('EXDATE;TZID=W. Europe Standard Time:20261116T090000')
    expect(isoStarts(deleted)).toEqual([cet(2), cet(9)])
  })

  it('won’t change an event in a zone it can’t work out', () => {
    const unknown = cal(
      'BEGIN:VEVENT',
      'UID:u',
      'DTSTART;TZID=Somewhere Else:20261102T090000',
      'RRULE:FREQ=DAILY;COUNT=2',
      'SUMMARY:Mystery',
      'END:VEVENT',
    )
    const facts = readEvent(unknown, { uid: 'u' })
    expect(facts.unknownZone).toBe('Somewhere Else')
    expect(() => updateEventIcs(unknown, { uid: 'u' }, { ...facts.draft, title: 'x' }, 'all')).toThrow(
      /time zone Ordo doesn’t know/,
    )
    const second = parse(unknown)[1]!.recurrenceId!
    expect(() => deleteFromIcs(unknown, { uid: 'u', recurrenceId: second }, 'this')).toThrow(
      /time zone Ordo doesn’t know/,
    )
    // A VTIMEZONE with a rule faster than yearly isn't worked out either: it would take too long.
    const fast = outlook().replace('RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10', 'RRULE:FREQ=SECONDLY')
    expect(readEvent(fast, { uid: 'o' }).unknownZone).toBe('W. Europe Standard Time')
  })
})

describe('moving a series with an end date', () => {
  // Monday 2 to Friday 6 November, every day.
  const weekdays = () => create({ repeat: { frequency: 'daily', until: '2026-11-06' } })
  const move = (days: number) => {
    const target = { uid: 'ev-1', recurrenceId: occ(2) }
    const before = readEvent(weekdays(), target).draft
    const start = `2026-11-${String(2 + days).padStart(2, '0')}T09:00`
    return updateEventIcs(
      weekdays(),
      target,
      { ...before, start, end: start.replace('09:00', '09:30') },
      'all',
    )
  }

  it('moves UNTIL with it, keeping the number of occurrences', () => {
    expect(isoStarts(weekdays())).toHaveLength(5)
    expect(isoStarts(move(1))).toEqual([occ(3), occ(4), occ(5), occ(6), occ(7)])
    expect(isoStarts(move(-1))).toEqual([occ(1), occ(2), occ(3), occ(4), occ(5)])
    expect(readEvent(move(1), { uid: 'ev-1' }).draft.repeat).toEqual({
      frequency: 'daily',
      until: '2026-11-07',
    })
  })
})

describe('occurrence ids', () => {
  const bogus = { uid: 'ev-1', recurrenceId: new Date(Date.UTC(2026, 10, 9, 13, 37)).toISOString() }

  it('refuses one that isn’t an occurrence of the series, changing nothing', () => {
    expect(() => readEvent(WEEKLY(), bogus)).toThrow(/isn’t part of this event/)
    expect(() => updateEventIcs(WEEKLY(), bogus, wk({ title: 'x' }), 'this')).toThrow(IcsEditError)
    expect(() => deleteFromIcs(WEEKLY(), bogus, 'this')).toThrow(/isn’t part of this event/)
    expect(() => deleteFromIcs(WEEKLY(), { uid: 'ev-1', recurrenceId: 'not a date' }, 'this')).toThrow(
      IcsEditError,
    )
    // One already deleted isn't there any more either.
    const less = deleteFromIcs(WEEKLY(), { uid: 'ev-1', recurrenceId: occ(9) }, 'this')!
    expect(() => deleteFromIcs(less, { uid: 'ev-1', recurrenceId: occ(9) }, 'this')).toThrow(IcsEditError)
  })

  it('accepts real ones, including occurrences that were moved', () => {
    expect(() => readEvent(WEEKLY(), { uid: 'ev-1', recurrenceId: occ(30) })).not.toThrow()
    const moved = updateEventIcs(
      WEEKLY(),
      { uid: 'ev-1', recurrenceId: occ(9) },
      wk({ start: '2026-11-10T11:00', end: '2026-11-10T11:30' }),
      'this',
    )
    expect(() => deleteFromIcs(moved, { uid: 'ev-1', recurrenceId: occ(9) }, 'this')).not.toThrow()
  })
})

describe('time zone work is bounded by the event, not the document', () => {
  const ms = (fn: () => unknown) => {
    const t = performance.now()
    try {
      fn()
    } catch {
      // Refusing quickly is fine.
    }
    return performance.now() - t
  }

  it('ignores TZIDs on properties that aren’t times', () => {
    const noisy = WEEKLY().replace(
      'SUMMARY:Standup',
      [
        'SUMMARY:Standup',
        ...Array.from({ length: 400 }, (_, i) => `X-ZONE-${i};TZID=/p${i}/Asia/Tehran:x`),
      ].join('\r\n'),
    )
    const before = readEvent(noisy, { uid: 'ev-1' }).draft
    let ics = ''
    const took = ms(() => (ics = updateEventIcs(noisy, { uid: 'ev-1' }, { ...before, title: 'x' }, 'all')))
    expect(took).toBeLessThan(1000)
    expect(lines(ics).filter((l) => l === 'BEGIN:VTIMEZONE')).toHaveLength(1)
  })

  it('treats aliases of one zone as one, and refuses an event with too many zones', () => {
    const aliased = WEEKLY().replace(
      'SUMMARY:Standup',
      'EXDATE;TZID=/mozilla.org/20050126_1/Europe/London:20261109T090000\r\nSUMMARY:Standup',
    )
    const before = readEvent(aliased, { uid: 'ev-1' }).draft
    expect(
      isoStarts(updateEventIcs(aliased, { uid: 'ev-1' }, { ...before, title: 'x' }, 'all')),
    ).toHaveLength(4)

    const zones = [
      'Europe/Paris',
      'Europe/Berlin',
      'Europe/Rome',
      'Europe/Madrid',
      'Asia/Tokyo',
      'Asia/Dubai',
      'America/Chicago',
      'America/Denver',
      'America/Phoenix',
      'Australia/Perth',
      'Pacific/Auckland',
    ]
    const many = WEEKLY().replace(
      'SUMMARY:Standup',
      [...zones.map((z, i) => `EXDATE;TZID=${z}:2027010${(i % 9) + 1}T090000`), 'SUMMARY:Standup'].join(
        '\r\n',
      ),
    )
    const b = readEvent(many, { uid: 'ev-1' }).draft
    expect(ms(() => updateEventIcs(many, { uid: 'ev-1' }, { ...b, title: 'x' }, 'all'))).toBeLessThan(1000)
    expect(() => updateEventIcs(many, { uid: 'ev-1' }, { ...b, title: 'x' }, 'all')).toThrow(
      /too many time zones/,
    )
  })
})

describe('series details', () => {
  it('gives changed occurrences at least a day when a series becomes all-day', () => {
    const retitled = updateEventIcs(
      WEEKLY(),
      { uid: 'ev-1', recurrenceId: occ(9) },
      wk({ title: 'Demo', start: '2026-11-09T09:00', end: '2026-11-09T09:30' }),
      'this',
    )
    const allDay = updateEventIcs(
      retitled,
      { uid: 'ev-1', recurrenceId: occ(2) },
      draft({
        allDay: true,
        start: '2026-11-02',
        end: '2026-11-02',
        timeZone: null,
        repeat: { frequency: 'weekly', count: 5 },
      }),
      'all',
    )
    expect(lines(allDay)).toContain('DTSTART;VALUE=DATE:20261109')
    expect(lines(allDay)).toContain('DTEND;VALUE=DATE:20261110')
    expect(parse(allDay).find((e) => e.title === 'Demo')).toMatchObject({
      allDay: true,
      start: new Date(2026, 10, 9),
      end: new Date(2026, 10, 10),
    })
  })

  it('keeps the series in its own zone when “all events” is edited from an occurrence in another', () => {
    // 9 Nov was moved to 05:00 in New York (10:00 in London).
    const ny = updateEventIcs(
      WEEKLY(),
      { uid: 'ev-1', recurrenceId: occ(9) },
      wk({ start: '2026-11-09T05:00', end: '2026-11-09T05:30', timeZone: 'America/New_York' }),
      'this',
    )
    const target = { uid: 'ev-1', recurrenceId: occ(9) }
    const before = readEvent(ny, target).draft
    expect(before.timeZone).toBe('America/New_York')
    // An hour later, for every event.
    const later = updateEventIcs(
      ny,
      target,
      { ...before, start: '2026-11-09T06:00', end: '2026-11-09T06:30' },
      'all',
    )
    expect(lines(later)).toContain('DTSTART;TZID=Europe/London:20261102T100000')
    expect(isoStarts(later)[0]).toBe(occ(2, 10))
  })
})
