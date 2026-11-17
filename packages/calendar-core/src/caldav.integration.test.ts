// Runs against a real CalDAV server. Start one with:
//   pnpm caldav:start
// then: CALDAV_TEST_PORT=5232 pnpm test:integration
import { DAVClient } from 'tsdav'
import { beforeAll, describe, expect, it } from 'vitest'
import { CalDavProvider } from './caldav'
import { CalendarStore } from './store'
import { syncCalendars } from './sync'

const port = Number(process.env['CALDAV_TEST_PORT'])
const serverUrl = `http://${process.env['CALDAV_TEST_HOST'] ?? '127.0.0.1'}:${port}/`
const credentials = { username: 'test@ordo.test', password: 'abcd-efgh-ijkl-mnop' }
const window = { start: new Date('2026-11-01T00:00:00Z'), end: new Date('2027-01-01T00:00:00Z') }

const ics = (...lines: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ordo//Test//EN', ...lines, 'END:VCALENDAR'].join('\r\n')

const WEEKLY = ics(
  'BEGIN:VEVENT',
  'UID:weekly@ordo.test',
  'DTSTART;TZID=Europe/London:20261102T090000',
  'DTEND;TZID=Europe/London:20261102T093000',
  'RRULE:FREQ=WEEKLY;COUNT=4',
  'EXDATE;TZID=Europe/London:20261109T090000',
  'SUMMARY:Standup',
  'END:VEVENT',
)
const TRIP = ics(
  'BEGIN:VEVENT',
  'UID:trip@ordo.test',
  'DTSTART;VALUE=DATE:20261120',
  'DTEND;VALUE=DATE:20261123',
  'SUMMARY:Lisbon',
  'END:VEVENT',
)

describe.skipIf(!port)('CalDAV integration (Radicale)', () => {
  // A fresh calendar per run, so leftovers from earlier runs don't matter.
  const name = `Ordo test ${Date.now()}`
  let admin: DAVClient

  beforeAll(async () => {
    admin = new DAVClient({ serverUrl, credentials, authMethod: 'Basic', defaultAccountType: 'caldav' })
    await admin.login()
    await admin.makeCalendar({
      url: `${admin.account!.homeUrl}${encodeURIComponent(name)}/`,
      props: { displayname: name, 'ca:calendar-color': '#FF2968FF' },
    })
    const calendar = (await admin.fetchCalendars()).find((c) => c.displayName === name)!
    await admin.createCalendarObject({ calendar, filename: 'weekly.ics', iCalString: WEEKLY })
  })

  it('lists the calendar and expands its events', async () => {
    const provider = new CalDavProvider({ serverUrl, ...credentials })
    await provider.connect()
    const cal = (await provider.listCalendars()).find((c) => c.name === name)
    expect(cal).toMatchObject({ readOnly: false, color: '#ff2968' })
    expect(cal!.version).toBeTruthy()

    const events = await provider.fetchEvents(cal!.id, window)
    expect(events.map((e) => e.start.toISOString())).toEqual([
      '2026-11-02T09:00:00.000Z',
      '2026-11-16T09:00:00.000Z',
      '2026-11-23T09:00:00.000Z',
    ])
    await provider.close()
  })

  it('syncs into the cache and refetches only after the calendar changes', async () => {
    const provider = new CalDavProvider({ serverUrl, ...credentials })
    const store = new CalendarStore(':memory:')
    await provider.connect()
    const id = (await provider.listCalendars()).find((c) => c.name === name)!.id
    const mine = () => store.events(window).filter((e) => e.calendarId === id)

    await syncCalendars(provider, store, { window })
    expect(mine()).toHaveLength(3)
    expect(store.syncState(id)).not.toBeNull()

    const before = store.syncState(id)!.version
    const again = await syncCalendars(provider, store, { window })
    expect(again.skipped).toBeGreaterThanOrEqual(1)

    const calendar = (await admin.fetchCalendars()).find((c) => c.displayName === name)!
    await admin.createCalendarObject({ calendar, filename: 'trip.ics', iCalString: TRIP })
    await syncCalendars(provider, store, { window })
    expect(store.syncState(id)!.version).not.toBe(before)
    expect(mine().map((e) => e.title)).toEqual(['Standup', 'Standup', 'Lisbon', 'Standup'])
    expect(mine().find((e) => e.title === 'Lisbon')).toMatchObject({
      allDay: true,
      start: new Date(2026, 10, 20),
    })
    store.close()
  })
})
