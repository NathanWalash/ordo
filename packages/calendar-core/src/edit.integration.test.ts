// Creating, changing and deleting events on a real CalDAV server. Start one with:
//   pnpm caldav:start
// then: CALDAV_TEST_PORT=5232 pnpm test:integration
import { DAVClient } from 'tsdav'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CalDavProvider } from './caldav'
import type { EventDraft } from './draft'
import { createEvent, deleteEvent, EventChangeError, eventDetails, updateEvent } from './edit'
import { CalendarStore } from './store'
import { syncCalendars } from './sync'
import { createEventIcs, readEvent } from './write'

const port = Number(process.env['CALDAV_TEST_PORT'])
const serverUrl = `http://${process.env['CALDAV_TEST_HOST'] ?? '127.0.0.1'}:${port}/`
const credentials = { username: 'events@ordo.test', password: 'abcd-efgh-ijkl-mnop' }
const window = { start: new Date('2026-09-01T00:00:00Z'), end: new Date('2027-06-01T00:00:00Z') }

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

describe.skipIf(!port)('changing events on CalDAV (Radicale)', () => {
  const name = `Ordo edits ${Date.now()}`
  let admin: DAVClient
  let provider: CalDavProvider
  let store: CalendarStore
  let id: string
  const opts = () => ({ window, me: credentials.username })
  const mine = () => store.events(window).filter((e) => e.calendarId === id)
  /** What the server itself has now, as a fresh client would see it. */
  const onServer = async () => {
    const fresh = new CalDavProvider({ serverUrl, ...credentials })
    await fresh.connect()
    return (await fresh.fetchResources(id, window)).resources
  }

  beforeAll(async () => {
    admin = new DAVClient({ serverUrl, credentials, authMethod: 'Basic', defaultAccountType: 'caldav' })
    await admin.login()
    await admin.makeCalendar({
      url: `${admin.account!.homeUrl}${encodeURIComponent(name)}/`,
      props: { displayname: name },
    })
    provider = new CalDavProvider({ serverUrl, ...credentials })
    await provider.connect()
    store = new CalendarStore(':memory:')
    await syncCalendars(provider, store, { window })
    id = store.calendars().find((c) => c.name === name)!.id
  })
  afterAll(() => store?.close())

  it('creates an event the server keeps, with an ETag', async () => {
    const { uid } = await createEvent(provider, store, id, draft({ location: 'High St', alert: 30 }), opts())
    const [res] = (await onServer()).filter((r) => r.uid === uid)
    expect(res!.etag).toBeTruthy()
    expect(readEvent(res!.ics, { uid }).draft).toEqual(draft({ location: 'High St', alert: 30 }))
    expect(mine().find((e) => e.uid === uid)).toMatchObject({ start: new Date('2026-11-20T09:00:00Z') })
    expect(store.resources(id, uid)[0]!.etag).toBe(res!.etag)
  })

  it('edits and deletes a single event', async () => {
    const { uid } = await createEvent(provider, store, id, draft({ title: 'Haircut' }), opts())
    await updateEvent(
      provider,
      store,
      { calendarId: id, uid },
      draft({
        title: 'Haircut',
        start: '2026-11-21T14:00',
        end: '2026-11-21T14:45',
        timeZone: 'America/New_York',
      }),
      'all',
      opts(),
    )
    const res = (await onServer()).find((r) => r.uid === uid)!
    expect(res.ics).toContain('DTSTART;TZID=America/New_York:20261121T140000')
    expect(res.ics).toContain('SEQUENCE:1')
    expect(
      mine()
        .find((e) => e.uid === uid)!
        .start.toISOString(),
    ).toBe('2026-11-21T19:00:00.000Z')

    await deleteEvent(provider, store, { calendarId: id, uid }, 'all', opts())
    expect((await onServer()).some((r) => r.uid === uid)).toBe(false)
    expect(mine().some((e) => e.uid === uid)).toBe(false)
  })

  it('keeps a weekly event at 09:00 London either side of the clock change, and edits one occurrence or all', async () => {
    const weekly = draft({
      title: 'Standup',
      start: '2026-10-19T09:00',
      end: '2026-10-19T09:15',
      repeat: { frequency: 'weekly', count: 4 },
    })
    const { uid } = await createEvent(provider, store, id, weekly, opts())
    const starts = () =>
      mine()
        .filter((e) => e.uid === uid)
        .map((e) => `${e.title} ${e.start.toISOString()}`)
    expect(starts()).toEqual([
      'Standup 2026-10-19T08:00:00.000Z',
      'Standup 2026-10-26T09:00:00.000Z',
      'Standup 2026-11-02T09:00:00.000Z',
      'Standup 2026-11-09T09:00:00.000Z',
    ])

    // This event only: move 26 October to 11:00.
    const second = mine().filter((e) => e.uid === uid)[1]!
    await updateEvent(
      provider,
      store,
      { calendarId: id, uid, recurrenceId: second.recurrenceId },
      { ...weekly, title: 'Standup (late)', start: '2026-10-26T11:00', end: '2026-10-26T11:15' },
      'this',
      opts(),
    )
    expect((await onServer()).find((r) => r.uid === uid)!.ics).toContain(
      'RECURRENCE-ID;TZID=Europe/London:20261026T090000',
    )
    expect(starts()[1]).toBe('Standup (late) 2026-10-26T11:00:00.000Z')

    // Delete 2 November only.
    const third = mine().filter((e) => e.uid === uid)[2]!
    await deleteEvent(
      provider,
      store,
      { calendarId: id, uid, recurrenceId: third.recurrenceId },
      'this',
      opts(),
    )
    expect(starts()).toEqual([
      'Standup 2026-10-19T08:00:00.000Z',
      'Standup (late) 2026-10-26T11:00:00.000Z',
      'Standup 2026-11-09T09:00:00.000Z',
    ])

    // All events: half an hour later, from the last occurrence.
    const last = mine().filter((e) => e.uid === uid)[2]!
    const details = eventDetails(
      store,
      { calendarId: id, uid, recurrenceId: last.recurrenceId },
      credentials.username,
    )!
    expect(details).toMatchObject({ recurring: true, editable: true })
    await updateEvent(
      provider,
      store,
      { calendarId: id, uid, recurrenceId: last.recurrenceId },
      { ...details.draft, start: '2026-11-09T09:30', end: '2026-11-09T09:45' },
      'all',
      opts(),
    )
    expect(starts()).toEqual([
      'Standup 2026-10-19T08:30:00.000Z',
      'Standup (late) 2026-10-26T11:30:00.000Z', // moves with the series, keeping its own change
      'Standup 2026-11-09T09:30:00.000Z',
    ])
    // The server agrees, read fresh.
    const fresh = new CalendarStore(':memory:')
    const client = new CalDavProvider({ serverUrl, ...credentials })
    await client.connect()
    await syncCalendars(client, fresh, { window })
    expect(
      fresh
        .events(window)
        .filter((e) => e.uid === uid)
        .map((e) => `${e.title} ${e.start.toISOString()}`),
    ).toEqual(starts())
    fresh.close()

    await deleteEvent(
      provider,
      store,
      { calendarId: id, uid, recurrenceId: last.recurrenceId },
      'all',
      opts(),
    )
    expect(starts()).toEqual([])
  })

  it('creates all-day and yearly events', async () => {
    const { uid } = await createEvent(
      provider,
      store,
      id,
      draft({
        title: 'Birthday',
        allDay: true,
        start: '2026-12-05',
        end: '2026-12-05',
        timeZone: null,
        repeat: { frequency: 'yearly' },
      }),
      opts(),
    )
    expect(mine().filter((e) => e.uid === uid)).toMatchObject([
      { allDay: true, start: new Date(2026, 11, 5), end: new Date(2026, 11, 6) },
    ])
  })

  it('refreshes after a conflict with a provider that never signed in, as the app’s are', async () => {
    const { uid } = await createEvent(provider, store, id, draft({ title: 'Tea' }), opts())
    const href = store.resources(id, uid)[0]!.href
    const current = (await onServer()).find((r) => r.uid === uid)!
    await admin.updateCalendarObject({
      calendarObject: {
        url: href,
        etag: current.etag,
        data: createEventIcs(draft({ title: 'Tea at 4' }), { uid }),
      },
    })
    const fresh = new CalDavProvider({ serverUrl, ...credentials })
    await expect(
      updateEvent(fresh, store, { calendarId: id, uid }, draft({ title: 'Tea at 3' }), 'all', opts()),
    ).rejects.toMatchObject({ kind: 'conflict' })
    expect(mine().find((e) => e.uid === uid)!.title).toBe('Tea at 4')
    await deleteEvent(
      new CalDavProvider({ serverUrl, ...credentials }),
      store,
      { calendarId: id, uid },
      'all',
      opts(),
    )
  })

  it('refuses to overwrite a change made by another client (HTTP 412), then shows it', async () => {
    const { uid } = await createEvent(provider, store, id, draft({ title: 'Lunch' }), opts())
    // Another device changes the event behind Ordo's back.
    const href = store.resources(id, uid)[0]!.href
    const current = (await onServer()).find((r) => r.uid === uid)!
    const res = await admin.updateCalendarObject({
      calendarObject: {
        url: href,
        etag: current.etag,
        data: createEventIcs(draft({ title: 'Lunch with Sam' }), { uid }),
      },
    })
    expect(res.ok).toBe(true)

    const attempt = updateEvent(
      provider,
      store,
      { calendarId: id, uid },
      draft({ title: 'Lunch at 1' }),
      'all',
      opts(),
    )
    await expect(attempt).rejects.toBeInstanceOf(EventChangeError)
    await expect(attempt).rejects.toMatchObject({ kind: 'conflict' })
    expect((await onServer()).find((r) => r.uid === uid)!.ics).toContain('SUMMARY:Lunch with Sam')
    expect(mine().find((e) => e.uid === uid)!.title).toBe('Lunch with Sam')

    // The same delete is refused too, until the change has been seen.
    await admin.updateCalendarObject({
      calendarObject: {
        url: href,
        etag: store.resources(id, uid)[0]!.etag,
        data: createEventIcs(draft({ title: 'Lunch moved' }), { uid }),
      },
    })
    await expect(deleteEvent(provider, store, { calendarId: id, uid }, 'all', opts())).rejects.toMatchObject({
      kind: 'conflict',
    })
    await deleteEvent(provider, store, { calendarId: id, uid }, 'all', opts())
    expect((await onServer()).some((r) => r.uid === uid)).toBe(false)
  })
})
