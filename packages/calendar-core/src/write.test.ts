import ICAL from 'ical.js'
import { describe, expect, it } from 'vitest'
import { checkDraft, type EventDraft } from './draft'
import { parseIcs } from './ics'
import {
  createEventIcs,
  deleteFromIcs,
  firstUid,
  IcsEditError,
  previewDraft,
  readEvent,
  updateEventIcs,
} from './write'

const NOW = new Date('2026-11-18T10:00:00Z')
const YEAR = { start: new Date('2026-01-01T00:00:00Z'), end: new Date('2028-01-01T00:00:00Z') }
const parse = (ics: string) => parseIcs(ics, { calendarId: 'home', range: YEAR })
const isoStarts = (ics: string) => parse(ics).map((e) => e.start.toISOString())
const lines = (ics: string) => ics.split('\r\n')
const vevents = (ics: string) => lines(ics).filter((l) => l === 'BEGIN:VEVENT').length

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

const create = (d: Partial<EventDraft> = {}) => createEventIcs(draft(d), { uid: 'ev-1', now: NOW })

const cal = (...body: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Other//EN', ...body, 'END:VCALENDAR', ''].join('\r\n')

describe('createEventIcs', () => {
  it('writes a valid single event with its time zone', () => {
    const ics = create({ location: 'Room 1', notes: 'Bring notes' })
    const l = lines(ics)
    expect(l[0]).toBe('BEGIN:VCALENDAR')
    expect(l).toContain('VERSION:2.0')
    expect(l).toContain('PRODID:-//Ordo//Ordo Calendar//EN')
    expect(l).toContain('UID:ev-1')
    expect(l).toContain('DTSTAMP:20261118T100000Z')
    expect(l).toContain('SEQUENCE:0')
    expect(l).toContain('DTSTART;TZID=Europe/London:20261102T090000')
    expect(l).toContain('DTEND;TZID=Europe/London:20261102T093000')
    expect(l).toContain('LOCATION:Room 1')
    expect(l).toContain('DESCRIPTION:Bring notes')
    // VTIMEZONE comes before the event.
    expect(l.indexOf('BEGIN:VTIMEZONE')).toBeGreaterThan(0)
    expect(l.indexOf('BEGIN:VTIMEZONE')).toBeLessThan(l.indexOf('BEGIN:VEVENT'))
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
    expect(firstUid(ics)).toBe('ev-1')

    expect(parse(ics)).toEqual([
      {
        uid: 'ev-1',
        calendarId: 'home',
        title: 'Standup',
        start: new Date('2026-11-02T09:00:00Z'),
        end: new Date('2026-11-02T09:30:00Z'),
        allDay: false,
        location: 'Room 1',
        notes: 'Bring notes',
      },
    ])
  })

  it('names an untitled event “New Event” and leaves out empty fields', () => {
    const l = lines(create({ title: '   ' }))
    expect(l).toContain('SUMMARY:New Event')
    expect(l.some((x) => x.startsWith('LOCATION'))).toBe(false)
    expect(l.some((x) => x.startsWith('DESCRIPTION'))).toBe(false)
  })

  it('keeps untrusted text as text: no injected properties or lines', () => {
    const ics = create({
      title: 'Lunch\r\nATTENDEE:mailto:evil@example.com\r\nEND:VEVENT',
      notes: 'a;b,c\\d\u0000\u001b[31m',
    })
    expect(vevents(ics)).toBe(1)
    expect(lines(ics).some((l) => l.startsWith('ATTENDEE'))).toBe(false)
    const [e] = parse(ics)
    expect(e!.title).toBe('Lunch\nATTENDEE:mailto:evil@example.com\nEND:VEVENT')
    expect(e!.notes).toBe('a;b,c\\d[31m')
  })

  it('writes all-day events as dates, ending the day after the last day', () => {
    const ics = create({ allDay: true, start: '2026-11-20', end: '2026-11-22', timeZone: null })
    const l = lines(ics)
    expect(l).toContain('DTSTART;VALUE=DATE:20261120')
    expect(l).toContain('DTEND;VALUE=DATE:20261123')
    expect(l).not.toContain('BEGIN:VTIMEZONE')
    expect(parse(ics)[0]).toMatchObject({
      allDay: true,
      start: new Date(2026, 10, 20),
      end: new Date(2026, 10, 23),
    })
  })

  it('writes UTC with a Z and floating time with no zone', () => {
    expect(lines(create({ timeZone: 'UTC' }))).toContain('DTSTART:20261102T090000Z')
    const floating = create({ timeZone: null })
    expect(lines(floating)).toContain('DTSTART:20261102T090000')
    expect(lines(floating)).not.toContain('BEGIN:VTIMEZONE')
    expect(parse(floating)[0]!.start).toEqual(new Date(2026, 10, 2, 9))
  })

  it('writes an alert, before or on the day', () => {
    expect(lines(create({ alert: 15 }))).toEqual(
      expect.arrayContaining(['BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM']),
    )
    const allDay = create({
      allDay: true,
      start: '2026-11-20',
      end: '2026-11-20',
      timeZone: null,
      alert: -540,
    })
    expect(lines(allDay)).toContain('TRIGGER:PT9H')
    expect(readEvent(allDay, { uid: 'ev-1' }).draft.alert).toBe(-540)
  })

  it('keeps 09:00 in London at 09:00 across the October clock change', () => {
    const ics = create({
      start: '2026-10-19T09:00',
      end: '2026-10-19T09:30',
      repeat: { frequency: 'weekly', count: 3 },
    })
    expect(lines(ics)).toContain('RRULE:FREQ=WEEKLY;COUNT=3')
    expect(isoStarts(ics)).toEqual([
      '2026-10-19T08:00:00.000Z', // BST
      '2026-10-26T09:00:00.000Z', // GMT
      '2026-11-02T09:00:00.000Z',
    ])
  })

  it('keeps 09:00 in New York across the March change, wherever this computer is', () => {
    const ics = create({
      start: '2026-03-01T09:00',
      end: '2026-03-01T10:00',
      timeZone: 'America/New_York',
      repeat: { frequency: 'weekly', count: 2 },
    })
    expect(isoStarts(ics)).toEqual(['2026-03-01T14:00:00.000Z', '2026-03-08T13:00:00.000Z'])
  })

  it('ends a repeat on the last day, in the event’s own zone', () => {
    const winter = create({ repeat: { frequency: 'daily', until: '2026-11-04' } })
    expect(lines(winter)).toContain('RRULE:FREQ=DAILY;UNTIL=20261104T235959Z')
    expect(isoStarts(winter)).toHaveLength(3)
    const summer = create({
      start: '2026-07-01T09:00',
      end: '2026-07-01T10:00',
      repeat: { frequency: 'daily', until: '2026-07-03' },
    })
    expect(lines(summer)).toContain('RRULE:FREQ=DAILY;UNTIL=20260703T225959Z')
    expect(isoStarts(summer)).toHaveLength(3)
    const allDay = create({
      allDay: true,
      start: '2026-11-02',
      end: '2026-11-02',
      timeZone: null,
      repeat: { frequency: 'yearly', until: '2027-11-02' },
    })
    expect(lines(allDay)).toContain('RRULE:FREQ=YEARLY;UNTIL=20271102')
    expect(parse(allDay)).toHaveLength(2)
  })

  it('previews a draft as the occurrences it would have', () => {
    const shown = previewDraft(draft({ repeat: { frequency: 'daily', count: 2 } }), {
      uid: 'p',
      calendarId: 'home',
      range: YEAR,
    })
    expect(shown.map((e) => [e.uid, e.start.toISOString()])).toEqual([
      ['p', '2026-11-02T09:00:00.000Z'],
      ['p', '2026-11-03T09:00:00.000Z'],
    ])
  })
})

describe('readEvent', () => {
  it('round-trips drafts through iCalendar', () => {
    const drafts: EventDraft[] = [
      draft(),
      draft({ timeZone: 'America/New_York', location: 'NYC', notes: 'line 1\nline 2', alert: 0 }),
      draft({ allDay: true, start: '2026-12-24', end: '2026-12-26', timeZone: null, alert: -540 }),
      draft({ repeat: { frequency: 'weekly', until: '2027-01-31' }, alert: 60 }),
      draft({ repeat: { frequency: 'monthly', count: 6 } }),
      draft({ timeZone: 'UTC' }),
      draft({ timeZone: null }),
    ]
    for (const d of drafts) expect(readEvent(createEventIcs(d, { uid: 'x' }), { uid: 'x' }).draft).toEqual(d)
  })

  it('reads one occurrence of a series with that occurrence’s times', () => {
    const ics = create({ repeat: { frequency: 'weekly', count: 4 } })
    const facts = readEvent(ics, { uid: 'ev-1', recurrenceId: '2026-11-16T09:00:00.000Z' })
    expect(facts.recurring).toBe(true)
    expect(facts.draft).toMatchObject({ start: '2026-11-16T09:00', end: '2026-11-16T09:30' })
    expect(facts.draft.repeat).toEqual({ frequency: 'weekly', count: 4 })
  })

  it('reads DURATION, plain Google-style rules, and marks rules it can’t edit as custom', () => {
    const google = cal(
      'BEGIN:VEVENT',
      'UID:g',
      'DTSTART;TZID=Europe/London:20261102T090000',
      'DURATION:PT45M',
      'RRULE:FREQ=WEEKLY;BYDAY=MO;WKST=SU',
      'SUMMARY:Gym',
      'END:VEVENT',
    )
    expect(readEvent(google, { uid: 'g' }).draft).toMatchObject({
      end: '2026-11-02T09:45',
      repeat: { frequency: 'weekly' },
    })
    expect(readEvent(google, { uid: 'g' }).draft.repeat!.custom).toBeUndefined()
    const custom = google.replace('BYDAY=MO;', 'BYDAY=MO,WE;INTERVAL=2;')
    expect(readEvent(custom, { uid: 'g' }).draft.repeat).toEqual({ frequency: 'weekly', custom: true })
  })

  it('notices invitations from someone else', () => {
    const invite = cal(
      'BEGIN:VEVENT',
      'UID:i',
      'DTSTART:20261102T090000Z',
      'ORGANIZER;CN=Boss:mailto:boss@work.example',
      'ATTENDEE:mailto:me@icloud.example',
      'SUMMARY:1:1',
      'END:VEVENT',
    )
    expect(readEvent(invite, { uid: 'i' })).toMatchObject({ organizer: 'boss@work.example', attendees: 1 })
  })

  it('shows times in a zone this computer doesn’t know in local time', () => {
    const odd = cal(
      'BEGIN:VEVENT',
      'UID:o',
      'DTSTART;TZID=Customized Time Zone:20261102T090000',
      'DTEND;TZID=Customized Time Zone:20261102T100000',
      'SUMMARY:Odd',
      'END:VEVENT',
    )
    const d = readEvent(odd, { uid: 'o' }).draft
    expect(d.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(d.start).toBe('2026-11-02T09:00')
  })

  it('fails clearly for an event that isn’t there', () => {
    expect(() => readEvent(create(), { uid: 'nope' })).toThrow(IcsEditError)
  })
})

describe('updateEventIcs: one event', () => {
  it('changes the fields, keeps the UID and bumps SEQUENCE', () => {
    const ics = updateEventIcs(
      create(),
      { uid: 'ev-1' },
      draft({
        title: 'Retro',
        start: '2026-11-03T14:00',
        end: '2026-11-03T15:00',
        timeZone: 'America/New_York',
      }),
      'all',
      { now: NOW },
    )
    const l = lines(ics)
    expect(l).toContain('SUMMARY:Retro')
    expect(l).toContain('SEQUENCE:1')
    expect(l).toContain('DTSTART;TZID=America/New_York:20261103T140000')
    // The London zone isn't used any more; New York's is added.
    expect(l).toContain('TZID:America/New_York')
    expect(l).not.toContain('TZID:Europe/London')
    expect(parse(ics)).toMatchObject([{ uid: 'ev-1', start: new Date('2026-11-03T19:00:00Z') }])
  })

  it('keeps what it doesn’t edit: attendees, URLs, other apps’ properties and extra alarms', () => {
    const rich = cal(
      'BEGIN:VEVENT',
      'UID:r',
      'DTSTART;TZID=Europe/London:20261102T090000',
      'DTEND;TZID=Europe/London:20261102T100000',
      'SUMMARY:Party',
      'URL:https://party.example',
      'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
      'ATTENDEE;CN=Sam:mailto:sam@friend.example',
      'BEGIN:VALARM',
      'TRIGGER:-PT10M',
      'ACTION:DISPLAY',
      'DESCRIPTION:Reminder',
      'END:VALARM',
      'BEGIN:VALARM',
      'TRIGGER:-P1D',
      'ACTION:AUDIO',
      'END:VALARM',
      'END:VEVENT',
    )
    const before = readEvent(rich, { uid: 'r' }).draft
    const ics = updateEventIcs(rich, { uid: 'r' }, { ...before, title: 'Big party' }, 'all', { now: NOW })
    const l = lines(ics)
    expect(l).toContain('URL:https://party.example')
    expect(l).toContain('X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC')
    expect(l).toContain('ATTENDEE;CN=Sam:mailto:sam@friend.example')
    expect(l.filter((x) => x === 'BEGIN:VALARM')).toHaveLength(2)
    expect(l).toContain('SEQUENCE:1')
    expect(l).toContain('BEGIN:VTIMEZONE')

    const noAlert = updateEventIcs(rich, { uid: 'r' }, { ...before, alert: null }, 'all', { now: NOW })
    expect(lines(noAlert)).not.toContain('BEGIN:VALARM')
  })

  it('starts repeating when a repeat is added', () => {
    const ics = updateEventIcs(
      create(),
      { uid: 'ev-1' },
      draft({ repeat: { frequency: 'daily', count: 3 } }),
      'all',
    )
    expect(isoStarts(ics)).toHaveLength(3)
  })
})

const WEEKLY = () => create({ repeat: { frequency: 'weekly', count: 5 } })
const wk = (o: Partial<EventDraft>) => draft({ repeat: { frequency: 'weekly', count: 5 }, ...o })
// 2 Nov, 9 Nov, 16 Nov, 23 Nov, 30 Nov at 09:00 London (GMT).
const occ = (day: number, hour = 9) => new Date(Date.UTC(2026, 10, day, hour)).toISOString()

describe('updateEventIcs: this event only', () => {
  it('writes a RECURRENCE-ID override and leaves the rest of the series alone', () => {
    const target = { uid: 'ev-1', recurrenceId: occ(9) }
    const ics = updateEventIcs(
      WEEKLY(),
      target,
      wk({ title: 'Standup (late)', start: '2026-11-10T11:00', end: '2026-11-10T11:30' }),
      'this',
      { now: NOW },
    )
    expect(vevents(ics)).toBe(2)
    expect(lines(ics)).toContain('RECURRENCE-ID;TZID=Europe/London:20261109T090000')
    expect(lines(ics).filter((l) => l.startsWith('RRULE:FREQ=WEEKLY'))).toHaveLength(1)
    const events = parse(ics)
    expect(events.map((e) => [e.title, e.start.toISOString(), e.recurrenceId])).toEqual([
      ['Standup', occ(2), occ(2)],
      ['Standup (late)', occ(10, 11), occ(9)],
      ['Standup', occ(16), occ(16)],
      ['Standup', occ(23), occ(23)],
      ['Standup', occ(30), occ(30)],
    ])
    // Reading the moved occurrence gives its own times; changing it again updates the same override.
    expect(readEvent(ics, target).draft).toMatchObject({ title: 'Standup (late)', start: '2026-11-10T11:00' })
    const again = updateEventIcs(
      ics,
      target,
      wk({ title: 'Standup (later)', start: '2026-11-10T12:00', end: '2026-11-10T12:30' }),
      'this',
    )
    expect(vevents(again)).toBe(2)
    expect(parse(again)[1]).toMatchObject({ title: 'Standup (later)', start: new Date(occ(10, 12)) })
  })

  it('writes all-day overrides with a date RECURRENCE-ID', () => {
    const series = create({
      allDay: true,
      start: '2026-11-02',
      end: '2026-11-02',
      timeZone: null,
      repeat: { frequency: 'daily', count: 3 },
    })
    const ics = updateEventIcs(
      series,
      { uid: 'ev-1', recurrenceId: '2026-11-03' },
      draft({
        title: 'Day off',
        allDay: true,
        start: '2026-11-03',
        end: '2026-11-03',
        timeZone: null,
        repeat: { frequency: 'daily', count: 3 },
      }),
      'this',
    )
    expect(lines(ics)).toContain('RECURRENCE-ID;VALUE=DATE:20261103')
    expect(parse(ics).map((e) => e.title)).toEqual(['Standup', 'Day off', 'Standup'])
  })

  it('refuses to change the repeat for just one occurrence', () => {
    expect(() =>
      updateEventIcs(
        WEEKLY(),
        { uid: 'ev-1', recurrenceId: occ(9) },
        draft({ start: '2026-11-09T09:00', end: '2026-11-09T09:30', repeat: null }),
        'this',
      ),
    ).toThrow(/for all events/)
  })
})

describe('updateEventIcs: all events', () => {
  it('moves the whole series by the change made to one occurrence, keeping exceptions in step', () => {
    let ics = deleteFromIcs(WEEKLY(), { uid: 'ev-1', recurrenceId: occ(16) }, 'this')!
    ics = updateEventIcs(
      ics,
      { uid: 'ev-1', recurrenceId: occ(23) },
      wk({ title: 'Moved', start: '2026-11-23T11:00', end: '2026-11-23T11:30' }),
      'this',
    )
    // From the 9 Nov occurrence: an hour later, and a day later.
    const ics2 = updateEventIcs(
      ics,
      { uid: 'ev-1', recurrenceId: occ(9) },
      draft({
        start: '2026-11-10T10:00',
        end: '2026-11-10T11:00',
        repeat: { frequency: 'weekly', count: 5 },
      }),
      'all',
    )
    const l = lines(ics2)
    expect(l).toContain('DTSTART;TZID=Europe/London:20261103T100000')
    expect(l).toContain('DTEND;TZID=Europe/London:20261103T110000')
    expect(l).toContain('EXDATE;TZID=Europe/London:20261117T100000')
    expect(l).toContain('RECURRENCE-ID;TZID=Europe/London:20261124T100000')
    expect(l).toContain('DTSTART;TZID=Europe/London:20261124T120000')
    expect(parse(ics2).map((e) => [e.title, e.start.toISOString()])).toEqual([
      ['Standup', occ(3, 10)],
      ['Standup', occ(10, 10)],
      ['Moved', occ(24, 12)], // the changed occurrence moves with the series, an hour after it
      ['Standup', new Date(Date.UTC(2026, 11, 1, 10)).toISOString()],
    ])
  })

  it('changes the title everywhere without moving anything, even from a moved occurrence', () => {
    const moved = updateEventIcs(
      WEEKLY(),
      { uid: 'ev-1', recurrenceId: occ(9) },
      wk({ start: '2026-11-10T11:00', end: '2026-11-10T11:30' }),
      'this',
    )
    const target = { uid: 'ev-1', recurrenceId: occ(9) }
    const before = readEvent(moved, target).draft
    const ics = updateEventIcs(moved, target, { ...before, title: 'Daily sync' }, 'all')
    expect(parse(ics).map((e) => [e.title, e.start.toISOString()])).toEqual([
      ['Daily sync', occ(2)],
      ['Daily sync', occ(10, 11)],
      ['Daily sync', occ(16)],
      ['Daily sync', occ(23)],
      ['Daily sync', occ(30)],
    ])
  })

  it('stops repeating: one event where the editor said, with the exceptions gone', () => {
    const withException = deleteFromIcs(WEEKLY(), { uid: 'ev-1', recurrenceId: occ(16) }, 'this')!
    const ics = updateEventIcs(
      withException,
      { uid: 'ev-1', recurrenceId: occ(23) },
      draft({ start: '2026-11-23T09:00', end: '2026-11-23T09:30', repeat: null }),
      'all',
    )
    expect(lines(ics).some((l) => /^(RRULE:FREQ=WEEKLY|EXDATE)/.test(l))).toBe(false)
    expect(isoStarts(ics)).toEqual([occ(23)])
  })

  it('drops exceptions when the rule changes, and rewrites UNTIL for a new time of day', () => {
    const withException = deleteFromIcs(WEEKLY(), { uid: 'ev-1', recurrenceId: occ(16) }, 'this')!
    const daily = updateEventIcs(
      withException,
      { uid: 'ev-1', recurrenceId: occ(2) },
      draft({ repeat: { frequency: 'daily', count: 3 } }),
      'all',
    )
    expect(lines(daily).some((l) => l.startsWith('EXDATE'))).toBe(false)
    expect(isoStarts(daily)).toEqual([occ(2), occ(3), occ(4)])

    const until = create({ repeat: { frequency: 'daily', until: '2026-11-04' } })
    const later = updateEventIcs(
      until,
      { uid: 'ev-1', recurrenceId: occ(2) },
      draft({
        start: '2026-11-02T23:00',
        end: '2026-11-02T23:30',
        repeat: { frequency: 'daily', until: '2026-11-04' },
      }),
      'all',
    )
    expect(isoStarts(later)).toEqual([occ(2, 23), occ(3, 23), occ(4, 23)])
  })

  it('keeps a custom rule exactly as it was when only the title changes', () => {
    const custom = cal(
      'BEGIN:VEVENT',
      'UID:c',
      'DTSTART;TZID=Europe/London:20261102T090000',
      'DTEND;TZID=Europe/London:20261102T100000',
      'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=4',
      'SUMMARY:Class',
      'END:VEVENT',
    )
    const before = readEvent(custom, { uid: 'c', recurrenceId: occ(4) }).draft
    const ics = updateEventIcs(
      custom,
      { uid: 'c', recurrenceId: occ(4) },
      { ...before, title: 'Spanish' },
      'all',
    )
    expect(lines(ics)).toContain('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=4')
    expect(parse(ics).map((e) => e.title)).toEqual(['Spanish', 'Spanish', 'Spanish', 'Spanish'])
  })

  it('keeps a retitled occurrence in step when the whole series moves', () => {
    // 9 Nov only has a new title, so its override starts at 09:00 like the rest.
    const retitled = updateEventIcs(
      WEEKLY(),
      { uid: 'ev-1', recurrenceId: occ(9) },
      wk({ title: 'Demo day', start: '2026-11-09T09:00', end: '2026-11-09T09:30' }),
      'this',
    )
    const target = { uid: 'ev-1', recurrenceId: occ(16) }
    const before = readEvent(retitled, target).draft
    const later = updateEventIcs(
      retitled,
      target,
      { ...before, start: '2026-11-16T10:00', end: '2026-11-16T10:30' },
      'all',
    )
    expect(parse(later).map((e) => [e.title, e.start.toISOString()])).toEqual([
      ['Standup', occ(2, 10)],
      ['Demo day', occ(9, 10)],
      ['Standup', occ(16, 10)],
      ['Standup', occ(23, 10)],
      ['Standup', occ(30, 10)],
    ])
  })

  it('moves a custom rule’s time but won’t move it to other days', () => {
    const custom = cal(
      'BEGIN:VEVENT',
      'UID:c',
      'DTSTART;TZID=Europe/London:20261102T090000',
      'DTEND;TZID=Europe/London:20261102T100000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4',
      'EXDATE;TZID=Europe/London:20261104T090000',
      'SUMMARY:Class',
      'END:VEVENT',
    )
    const target = { uid: 'c', recurrenceId: occ(9) }
    const before = readEvent(custom, target).draft
    expect(() =>
      updateEventIcs(
        custom,
        target,
        { ...before, start: '2026-11-10T09:00', end: '2026-11-10T10:00' },
        'all',
      ),
    ).toThrow(/can’t move to other days/)
    const later = updateEventIcs(
      custom,
      target,
      { ...before, start: '2026-11-09T11:00', end: '2026-11-09T12:00' },
      'all',
    )
    expect(lines(later)).toContain('RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4')
    expect(lines(later)).toContain('EXDATE;TZID=Europe/London:20261104T110000')
    expect(isoStarts(later)).toEqual([occ(2, 11), occ(9, 11), occ(11, 11)])
  })

  it('keeps ends the editor can’t show, and still lets the event be edited', () => {
    const long = cal(
      'BEGIN:VEVENT',
      'UID:l',
      'DTSTART;TZID=Europe/London:20261102T090000',
      'DTEND;TZID=Europe/London:20261102T100000',
      'RRULE:FREQ=DAILY;COUNT=5000',
      'SUMMARY:Vitamins',
      'END:VEVENT',
    )
    const before = readEvent(long, { uid: 'l' }).draft
    expect(before.repeat).toEqual({ frequency: 'daily', custom: true })
    expect(checkDraft(before)).toBeNull()
    const renamed = updateEventIcs(long, { uid: 'l' }, { ...before, title: 'Vitamin D' }, 'all')
    expect(lines(renamed)).toContain('RRULE:FREQ=DAILY;COUNT=5000')
    const far = long.replace('COUNT=5000', 'UNTIL=29991231T000000Z')
    expect(readEvent(far, { uid: 'l' }).draft.repeat).toEqual({ frequency: 'daily', custom: true })
  })

  it('turns a timed series into an all-day one', () => {
    const ics = updateEventIcs(
      WEEKLY(),
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
    expect(lines(ics)).toContain('DTSTART;VALUE=DATE:20261102')
    expect(parse(ics).every((e) => e.allDay)).toBe(true)
    expect(parse(ics)).toHaveLength(5)
  })
})

describe('deleteFromIcs', () => {
  it('removes one occurrence with an EXDATE, and its override if it had one', () => {
    const moved = updateEventIcs(
      WEEKLY(),
      { uid: 'ev-1', recurrenceId: occ(9) },
      wk({ start: '2026-11-10T11:00', end: '2026-11-10T11:30' }),
      'this',
    )
    const ics = deleteFromIcs(moved, { uid: 'ev-1', recurrenceId: occ(9) }, 'this', { now: NOW })!
    expect(vevents(ics)).toBe(1)
    expect(lines(ics)).toContain('EXDATE;TZID=Europe/London:20261109T090000')
    expect(lines(ics)).toContain('SEQUENCE:1')
    expect(isoStarts(ics)).toEqual([occ(2), occ(16), occ(23), occ(30)])
  })

  it('writes date EXDATEs for all-day series', () => {
    const series = create({
      allDay: true,
      start: '2026-11-02',
      end: '2026-11-02',
      timeZone: null,
      repeat: { frequency: 'daily', count: 3 },
    })
    const ics = deleteFromIcs(series, { uid: 'ev-1', recurrenceId: '2026-11-03' }, 'this')!
    expect(lines(ics)).toContain('EXDATE;VALUE=DATE:20261103')
    expect(parse(ics).map((e) => e.recurrenceId)).toEqual(['2026-11-02', '2026-11-04'])
  })

  it('says to delete the whole resource for a single event or a whole series', () => {
    expect(deleteFromIcs(create(), { uid: 'ev-1' }, 'this')).toBeNull()
    expect(deleteFromIcs(WEEKLY(), { uid: 'ev-1', recurrenceId: occ(9) }, 'all')).toBeNull()
  })

  it('keeps other events that share the resource', () => {
    const two = cal(
      'BEGIN:VEVENT',
      'UID:a',
      'DTSTART:20261102T090000Z',
      'SUMMARY:A',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:b',
      'DTSTART:20261103T090000Z',
      'SUMMARY:B',
      'END:VEVENT',
    )
    expect(parse(deleteFromIcs(two, { uid: 'a' }, 'all')!).map((e) => e.uid)).toEqual(['b'])
  })

  it('produces documents ical.js reads back cleanly', () => {
    const ics = deleteFromIcs(WEEKLY(), { uid: 'ev-1', recurrenceId: occ(9) }, 'this')!
    expect(() => new ICAL.Component(ICAL.parse(ics))).not.toThrow()
  })
})

describe('years from server data', () => {
  const ms = (fn: () => unknown) => {
    const t = performance.now()
    try {
      fn()
    } catch {
      // Refusing quickly is fine too; hanging isn't.
    }
    return performance.now() - t
  }
  const doc = (dtstart: string, ...extra: string[]) =>
    cal(
      'BEGIN:VEVENT',
      'UID:far',
      `DTSTART;TZID=Africa/Casablanca:${dtstart}`,
      ...extra,
      'SUMMARY:Far',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:near',
      'DTSTART;TZID=Africa/Casablanca:20261102T090000',
      'DTEND;TZID=Africa/Casablanca:20261102T100000',
      'SUMMARY:Near',
      'END:VEVENT',
    )

  it('doesn’t scan time zone data for a start in year 9999 or 99999, or a far-off UNTIL', () => {
    const docs = [
      doc('99991102T090000'),
      doc('999991102T090000'),
      doc('20261102T090000', 'RRULE:FREQ=YEARLY;UNTIL=99991231T235959Z'),
    ]
    const near = draft({ timeZone: 'Africa/Casablanca' })
    for (const d of docs) {
      expect(ms(() => deleteFromIcs(d, { uid: 'near' }, 'all'))).toBeLessThan(2000)
      expect(ms(() => updateEventIcs(d, { uid: 'near' }, near, 'all'))).toBeLessThan(2000)
      expect(ms(() => deleteFromIcs(d, { uid: 'far' }, 'all'))).toBeLessThan(2000)
    }
    // The year-9999 event is kept untouched, and the zone still covers the event that was written.
    const kept = updateEventIcs(docs[0]!, { uid: 'near' }, near, 'all')
    expect(kept).toContain('DTSTART;TZID=Africa/Casablanca:99991102T090000')
    expect(kept).toMatch(/DTSTART:2026\d{4}T/)
  })

  it('builds zones around the event being written, not the document’s oldest event', () => {
    const old = cal(
      'BEGIN:VEVENT',
      'UID:old',
      'DTSTART;TZID=Africa/Casablanca:19200101T090000',
      'SUMMARY:Old',
      'END:VEVENT',
    )
    const ics = updateEventIcs(old, { uid: 'old' }, draft({ timeZone: 'Africa/Casablanca' }), 'all')
    expect(ics).toMatch(/DTSTART:2026\d{4}T/)
  })
})
