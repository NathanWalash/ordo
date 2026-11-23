import ICAL from 'ical.js'
import { describe, expect, it } from 'vitest'
import {
  changedFields,
  googleCalendarIdFromFeedUrl,
  googleTimeKey,
  GoogleMappingError,
  groupToIcs,
  plainText,
  READ_ONLY_PROP,
  safeEmail,
  trimEvent,
  veventToGoogle,
  type GoogleEvent,
} from './google-map'
import { parseIcs } from './ics'
import { readEvent } from './write'

const CAL = 'me@work.example'
const range = { start: new Date('2026-11-01T00:00:00Z'), end: new Date('2027-01-01T00:00:00Z') }

const master = (over: Partial<GoogleEvent> = {}): GoogleEvent => ({
  id: 'abc',
  etag: '"1"',
  status: 'confirmed',
  iCalUID: 'abc@google.com',
  summary: 'Standup',
  start: { dateTime: '2026-11-02T09:00:00Z', timeZone: 'Europe/London' },
  end: { dateTime: '2026-11-02T09:15:00Z', timeZone: 'Europe/London' },
  ...over,
})

function vevents(ics: string) {
  return new ICAL.Component(ICAL.parse(ics) as never).getAllSubcomponents('vevent')
}

describe('groupToIcs', () => {
  it('writes a timed event in its own zone, so it reads back as the same instant and wall clock', () => {
    const built = groupToIcs({ master: master(), exceptions: [] }, CAL)!
    expect(built.uid).toBe('abc@google.com')
    expect(built.ics).toContain('DTSTART;TZID=Europe/London:20261102T090000')
    const [e] = parseIcs(built.ics, { calendarId: 'c', range })
    expect(e!.start.toISOString()).toBe('2026-11-02T09:00:00.000Z')
    expect(e!.end.toISOString()).toBe('2026-11-02T09:15:00.000Z')
    expect(readEvent(built.ics, { uid: built.uid }).draft).toMatchObject({
      start: '2026-11-02T09:00',
      end: '2026-11-02T09:15',
      timeZone: 'Europe/London',
    })
  })

  it('keeps a summer time event at its wall clock in New York', () => {
    const e = master({
      start: { dateTime: '2026-07-01T10:00:00-04:00', timeZone: 'America/New_York' },
      end: { dateTime: '2026-07-01T11:00:00-04:00', timeZone: 'America/New_York' },
    })
    const built = groupToIcs({ master: e, exceptions: [] }, CAL)!
    expect(built.ics).toContain('DTSTART;TZID=America/New_York:20260701T100000')
    const [occ] = parseIcs(built.ics, {
      calendarId: 'c',
      range: { start: new Date('2026-06-01'), end: new Date('2026-08-01') },
    })
    expect(occ!.start.toISOString()).toBe('2026-07-01T14:00:00.000Z')
  })

  it('writes UTC when Google gives no zone', () => {
    const built = groupToIcs(
      {
        master: master({
          start: { dateTime: '2026-11-02T09:00:00+01:00' },
          end: { dateTime: '2026-11-02T10:00:00+01:00' },
        }),
        exceptions: [],
      },
      CAL,
    )!
    expect(built.ics).toContain('DTSTART:20261102T080000Z')
  })

  it('keeps all-day events on their dates, with an exclusive end', () => {
    const built = groupToIcs(
      { master: master({ start: { date: '2026-11-10' }, end: { date: '2026-11-12' } }), exceptions: [] },
      CAL,
    )!
    const [e] = parseIcs(built.ics, { calendarId: 'c', range })
    expect(e!.allDay).toBe(true)
    expect([e!.start.getDate(), e!.end.getDate()]).toEqual([10, 12])
    expect(readEvent(built.ics, { uid: built.uid }).draft).toMatchObject({
      allDay: true,
      start: '2026-11-10',
      end: '2026-11-11',
    })
  })

  it('expands a series with its EXDATE lines, changed occurrences and cancelled ones', () => {
    const m = master({
      recurrence: ['RRULE:FREQ=WEEKLY;COUNT=5', 'EXDATE;TZID=Europe/London:20261109T090000'],
    })
    const moved: GoogleEvent = {
      id: 'abc_20261116T090000Z',
      etag: '"2"',
      iCalUID: 'abc@google.com',
      recurringEventId: 'abc',
      originalStartTime: { dateTime: '2026-11-16T09:00:00Z', timeZone: 'Europe/London' },
      summary: 'Standup (moved)',
      start: { dateTime: '2026-11-16T11:00:00Z', timeZone: 'Europe/London' },
      end: { dateTime: '2026-11-16T11:15:00Z', timeZone: 'Europe/London' },
    }
    const cancelled: GoogleEvent = {
      id: 'abc_20261123T090000Z',
      status: 'cancelled',
      recurringEventId: 'abc',
      originalStartTime: { dateTime: '2026-11-23T09:00:00Z', timeZone: 'Europe/London' },
    }
    const built = groupToIcs({ master: m, exceptions: [moved, cancelled] }, CAL)!
    const occ = parseIcs(built.ics, { calendarId: 'c', range })
    expect(occ.map((e) => [e.title, e.start.toISOString()])).toEqual([
      ['Standup', '2026-11-02T09:00:00.000Z'],
      ['Standup (moved)', '2026-11-16T11:00:00.000Z'],
      ['Standup', '2026-11-30T09:00:00.000Z'],
    ])
    expect(occ[1]!.recurrenceId).toBe('2026-11-16T09:00:00.000Z')
    expect(readEvent(built.ics, { uid: built.uid, recurrenceId: '2026-11-30T09:00:00.000Z' }).recurring).toBe(
      true,
    )
  })

  it('shows the occurrences of a series whose master Ordo can’t see', () => {
    const one: GoogleEvent = {
      id: 'zzz_20261105T120000Z',
      iCalUID: 'zzz@google.com',
      recurringEventId: 'zzz',
      originalStartTime: { dateTime: '2026-11-05T12:00:00Z' },
      summary: 'Guest slot',
      start: { dateTime: '2026-11-05T12:00:00Z' },
      end: { dateTime: '2026-11-05T13:00:00Z' },
    }
    const built = groupToIcs({ exceptions: [one] }, CAL)!
    expect(parseIcs(built.ics, { calendarId: 'c', range }).map((e) => e.title)).toEqual(['Guest slot'])
  })

  it('hides deleted events and ones you declined, as Google Calendar does', () => {
    expect(groupToIcs({ master: master({ status: 'cancelled' }), exceptions: [] }, CAL)).toBeNull()
    expect(
      groupToIcs(
        {
          master: master({ attendees: [{ email: CAL, self: true, responseStatus: 'declined' }] }),
          exceptions: [],
        },
        CAL,
      ),
    ).toBeNull()
  })

  it('marks someone else’s invitation with its organiser, but not events on a shared calendar', () => {
    const invite = groupToIcs(
      {
        master: master({
          organizer: { email: 'boss@work.example' },
          attendees: [{ email: CAL, self: true, responseStatus: 'accepted' }, { email: 'boss@work.example' }],
        }),
        exceptions: [],
      },
      CAL,
    )!
    expect(readEvent(invite.ics, { uid: invite.uid })).toMatchObject({
      organizer: 'boss@work.example',
      attendees: 2,
    })
    const own = groupToIcs(
      { master: master({ organizer: { email: CAL, self: true } }), exceptions: [] },
      CAL,
    )!
    expect(readEvent(own.ics, { uid: own.uid }).organizer).toBeUndefined()
    const team = groupToIcs(
      {
        master: master({
          organizer: { email: 'team@group.calendar.google.com' },
          attendees: [{ email: 'x@y.z' }],
        }),
        exceptions: [],
      },
      'team@group.calendar.google.com',
    )!
    expect(readEvent(team.ics, { uid: team.uid }).organizer).toBeUndefined()
  })

  it('marks out-of-office and focus time as read-only, and shows HTML descriptions as text', () => {
    const built = groupToIcs(
      {
        master: master({ eventType: 'outOfOffice', description: 'Back <b>Monday</b><br>Ask &amp; ping' }),
        exceptions: [],
      },
      CAL,
    )!
    expect(built.ics.toUpperCase()).toContain(`${READ_ONLY_PROP.toUpperCase()}:OUTOFOFFICE`)
    expect(readEvent(built.ics, { uid: built.uid }).draft.notes).toBe('Back Monday\nAsk & ping')
  })

  it('turns reminders into alarms the editor shows, and leaves Google’s defaults alone', () => {
    const own = groupToIcs(
      {
        master: master({ reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] } }),
        exceptions: [],
      },
      CAL,
    )!
    expect(readEvent(own.ics, { uid: own.uid }).draft.alert).toBe(10)
    const def = groupToIcs({ master: master({ reminders: { useDefault: true } }), exceptions: [] }, CAL)!
    expect(readEvent(def.ics, { uid: def.uid }).draft.alert).toBeNull()
  })

  it('never lets a recurrence line start another property', () => {
    const built = groupToIcs(
      {
        master: master({
          recurrence: [
            'RRULE:FREQ=DAILY;COUNT=2\r\nATTENDEE:mailto:evil@x',
            'X-EVIL:1',
            'RRULE:FREQ=DAILY;COUNT=2',
          ],
        }),
        exceptions: [],
      },
      CAL,
    )!
    expect(built.ics).not.toContain('evil')
    expect(built.ics).not.toContain('X-EVIL')
    expect(parseIcs(built.ics, { calendarId: 'c', range })).toHaveLength(2)
  })
})

describe('veventToGoogle', () => {
  const opts = { fallbackZone: 'Europe/London', master: true }

  it('reads back the same Google times and recurrence', () => {
    const built = groupToIcs(
      { master: master({ recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] }), exceptions: [] },
      CAL,
    )!
    const f = veventToGoogle(vevents(built.ics)[0]!, opts)
    expect(f).toEqual({
      summary: 'Standup',
      description: '',
      location: '',
      start: { dateTime: '2026-11-02T09:00:00', timeZone: 'Europe/London' },
      end: { dateTime: '2026-11-02T09:15:00', timeZone: 'Europe/London' },
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
    })
  })

  it('writes all-day dates, UTC, floating times in the fallback zone, and leaves out skipped EXDATEs', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:a',
      'DTSTART;VALUE=DATE:20261110',
      'DTEND;VALUE=DATE:20261111',
      'RRULE:FREQ=DAILY;COUNT=3',
      'EXDATE;VALUE=DATE:20261111,20261112',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:b',
      'DTSTART:20261110T090000Z',
      'DTEND:20261110T100000Z',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:c',
      'DTSTART:20261110T090000',
      'DURATION:PT30M',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    const [a, b, c] = vevents(ics)
    const fa = veventToGoogle(a!, { ...opts, skipExdates: new Set(['2026-11-11']) })
    expect(fa.start).toEqual({ date: '2026-11-10' })
    expect(fa.recurrence).toEqual(['RRULE:FREQ=DAILY;COUNT=3', 'EXDATE;VALUE=DATE:20261112'])
    expect(veventToGoogle(b!, opts).start).toEqual({ dateTime: '2026-11-10T09:00:00Z', timeZone: 'UTC' })
    expect(veventToGoogle(c!, opts).end).toEqual({
      dateTime: '2026-11-10T09:30:00',
      timeZone: 'Europe/London',
    })
  })

  it('refuses an alert after the start, which Google can’t do', () => {
    const ics =
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261110T090000Z\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:PT5M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR'
    expect(() => veventToGoogle(vevents(ics)[0]!, opts)).toThrow(GoogleMappingError)
  })

  it('refuses a zone Google wouldn’t know', () => {
    const ics =
      'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART;TZID=W. Europe Standard Time:20261110T090000\r\nEND:VEVENT\r\nEND:VCALENDAR'
    expect(() => veventToGoogle(vevents(ics)[0]!, opts)).toThrow(GoogleMappingError)
  })
})

describe('changedFields', () => {
  const base = {
    summary: 'A',
    description: '',
    location: '',
    start: { dateTime: '2026-11-02T09:00:00', timeZone: 'Europe/London' },
    end: { dateTime: '2026-11-02T10:00:00', timeZone: 'Europe/London' },
  }
  it('sends only what changed, start and end together', () => {
    expect(changedFields(base, { ...base, summary: 'B' })).toEqual({ summary: 'B' })
    expect(changedFields(base, { ...base, end: { ...base.end, dateTime: '2026-11-02T11:00:00' } })).toEqual({
      start: base.start,
      end: { ...base.end, dateTime: '2026-11-02T11:00:00' },
    })
    expect(changedFields(base, base)).toEqual({})
  })
  it('clears recurrence and reminders explicitly', () => {
    const rec = {
      ...base,
      recurrence: ['RRULE:FREQ=DAILY'],
      reminders: { useDefault: false as const, overrides: [{ method: 'popup' as const, minutes: 5 }] },
    }
    expect(changedFields(rec, base)).toEqual({
      recurrence: [],
      reminders: { useDefault: false, overrides: [] },
    })
  })
})

describe('helpers', () => {
  it('keys original start times as parseIcs keys occurrences', () => {
    expect(googleTimeKey({ dateTime: '2026-11-16T09:00:00Z', timeZone: 'Europe/London' })).toBe(
      '2026-11-16T09:00:00.000Z',
    )
    expect(googleTimeKey({ dateTime: '2026-11-16T10:00:00+01:00' })).toBe('2026-11-16T09:00:00.000Z')
    expect(googleTimeKey({ date: '2026-11-16' })).toBe('2026-11-16')
  })

  it('finds the calendar behind a Google iCal link', () => {
    expect(
      googleCalendarIdFromFeedUrl(
        'https://calendar.google.com/calendar/ical/me%40work.example/private-abc123/basic.ics',
      ),
    ).toBe('me@work.example')
    expect(
      googleCalendarIdFromFeedUrl(
        'webcal://calendar.google.com/calendar/ical/x%40group.calendar.google.com/public/basic.ics',
      ),
    ).toBe('x@group.calendar.google.com')
    expect(googleCalendarIdFromFeedUrl('https://evil.example/calendar/ical/a/public/basic.ics')).toBeNull()
    expect(googleCalendarIdFromFeedUrl('not a url')).toBeNull()
  })

  it('keeps only typed fields from the server', () => {
    expect(
      trimEvent({
        id: 'a',
        summary: 5,
        start: { dateTime: '2026-11-02T09:00:00Z' },
        extra: 'x',
        attendees: [{ email: 'a@b', self: 'yes' }],
      }),
    ).toEqual({
      id: 'a',
      start: { dateTime: '2026-11-02T09:00:00Z' },
      attendees: [{ email: 'a@b', self: false, responseStatus: undefined }],
    })
    expect(trimEvent(null)).toBeNull()
    expect(trimEvent({ summary: 'no id' })).toBeNull()
  })

  it('reads HTML as text and leaves plain text alone', () => {
    expect(plainText('a < b')).toBe('a < b')
    expect(plainText('<p>One</p><p>Two</p>')).toBe('One\nTwo')
  })
})

describe('crafted event JSON can’t add iCalendar properties', () => {
  const EVIL = '\r\nX-EVIL:1\r\nATTENDEE:mailto:evil@x.example'
  /** Every property and component name, as ical.js reads the serialised text back. */
  const names = (ics: string) =>
    new ICAL.Component(ICAL.parse(ics) as never)
      .getAllSubcomponents()
      .flatMap((c) => [
        c.name,
        ...c.getAllProperties().map((p) => p.name),
        ...c.getAllSubcomponents().flatMap((s) => [s.name, ...s.getAllProperties().map((p) => p.name)]),
      ])
  const ALLOWED = [
    'vevent',
    'uid',
    'dtstart',
    'dtend',
    'dtstamp',
    'summary',
    'location',
    'description',
    'organizer',
    'attendee',
    'rrule',
    READ_ONLY_PROP,
    'valarm',
    'action',
    'trigger',
  ]

  const crafted = {
    id: `abc${EVIL}`,
    etag: `"1"${EVIL}`,
    status: `confirmed${EVIL}`,
    iCalUID: `abc@google.com${EVIL}`,
    summary: `Title${EVIL}`,
    description: `Notes${EVIL}`,
    location: `Room${EVIL}`,
    eventType: `outOfOffice${EVIL}`,
    updated: `2026-11-01T00:00:00Z${EVIL}`,
    start: { dateTime: `2026-11-02T09:00:00Z${EVIL}`, timeZone: `Europe/London${EVIL}` },
    end: { dateTime: '2026-11-02T10:00:00Z', timeZone: 'Europe/London\tX' },
    recurrence: [
      `RRULE:FREQ=DAILY;COUNT=2${EVIL}`,
      'RRULE:FREQ=DAILY;COUNT=2\u0000',
      'RRULE:FREQ=DAILY;COUNT=2',
    ],
    organizer: { email: `boss@work.example${EVIL}` },
    attendees: [
      { email: 'a@work.example\nX-EVIL:1' },
      { email: 'b@work.example\tATTENDEE:mailto:c@x' },
      { email: '"quoted"@work.example' },
      { email: 'ok@work.example', responseStatus: `accepted${EVIL}` },
    ],
    reminders: { useDefault: false, overrides: [{ method: `popup${EVIL}`, minutes: 10 }] },
  }

  it('trims every non-text value to have no control characters', () => {
    const e = trimEvent(crafted)!
    for (const v of [
      e.id,
      e.etag,
      e.status,
      e.iCalUID,
      e.updated,
      e.start?.dateTime,
      e.start?.timeZone,
      e.end?.timeZone,
      e.reminders?.overrides?.[0]?.method,
      e.attendees?.[3]?.responseStatus,
    ])
      // eslint-disable-next-line no-control-regex
      expect(v).not.toMatch(/[\u0000-\u001f]/)
    expect(e.eventType).toBeUndefined()
    expect(e.recurrence).toEqual(['RRULE:FREQ=DAILY;COUNT=2'])
  })

  it('writes only the properties Ordo means to, from trimmed and untrimmed events alike', () => {
    for (const event of [trimEvent(crafted)!, crafted as unknown as GoogleEvent]) {
      const built = groupToIcs({ master: event, exceptions: [] }, CAL)!
      expect(built).not.toBeNull()
      expect(built.ics).not.toMatch(/^X-EVIL/m)
      expect(built.ics).not.toMatch(/^ATTENDEE:mailto:evil/m)
      expect(built.ics).not.toMatch(/mailto:(a|b|c|"quoted")@/)
      for (const n of names(built.ics)) expect(ALLOWED).toContain(n)
      const vevent = new ICAL.Component(ICAL.parse(built.ics) as never).getFirstSubcomponent('vevent')!
      // Free text is a TEXT value, which ical.js escapes: the line breaks stay inside SUMMARY.
      expect(vevent.getFirstPropertyValue('summary')).toBe(`Title${EVIL}`.replace(/\r\n/g, '\n'))
      expect(vevent.getAllProperties('attendee').map((p) => p.getFirstValue())).toEqual([
        'mailto:ok@work.example',
      ])
      // The organiser's address was refused, but it's still someone else's invitation.
      expect(readEvent(built.ics, { uid: String(vevent.getFirstPropertyValue('uid')) }).organizer).toBe(
        'unknown@invalid',
      )
    }
  })

  it('accepts ordinary addresses and refuses odd ones', () => {
    expect(safeEmail('me.name+tag@work.example')).toBe('me.name+tag@work.example')
    for (const bad of [
      'a@b',
      'a b@c.example',
      'a@c.example\r\n',
      '<a@c.example>',
      'a@c.example;x',
      'a@@c.example',
      '',
    ])
      expect(safeEmail(bad)).toBeUndefined()
  })
})
