import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FakeGoogle } from '../../../test/fake-google'
import { startFakeGoogle } from '../../../test/fake-google'
import { CalendarAuthError, CalendarUnavailableError } from './caldav'
import type { EventDraft } from './draft'
import { createEvent, deleteEvent, EventChangeError, eventDetails, updateEvent } from './edit'
import {
  GoogleApiError,
  GoogleCalendarProvider,
  googleCalendarKey,
  parseGoogleCalendarKey,
  retryAfterMs,
  syncGoogleAccount,
} from './google'
import { CalendarStore } from './store'
import type { DateRange } from './types'

const WINDOW: DateRange = { start: new Date('2026-10-01T00:00:00Z'), end: new Date('2027-12-01T00:00:00Z') }
const ME = 'me@work.example'
const PRIMARY = googleCalendarKey('1234567890', ME)
const opts = { window: WINDOW, me: ME, now: new Date('2026-11-15T12:00:00Z') }

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

let fake: FakeGoogle
let store: CalendarStore
let provider: GoogleCalendarProvider
let tokens: boolean[]
let waits: number[]

beforeEach(async () => {
  fake = await startFakeGoogle()
  fake.addCalendar({
    id: ME,
    summary: 'Work',
    accessRole: 'owner',
    primary: true,
    backgroundColor: '#3F51B5',
  })
  fake.addCalendar({
    id: 'team@group.calendar.google.com',
    summary: 'Team',
    accessRole: 'reader',
    backgroundColor: '#0B8043',
  })
  fake.addCalendar({ id: 'holidays', summary: 'Holidays', accessRole: 'reader', selected: false })
  store = new CalendarStore(':memory:')
  tokens = []
  waits = []
  let current: string | null = null
  provider = new GoogleCalendarProvider({
    accountId: '1234567890',
    store,
    apiBase: fake.base,
    fallbackZone: 'Europe/London',
    token: async (refresh) => {
      tokens.push(refresh)
      if (refresh || !current) current = fake.grant().access
      return current
    },
    sleep: async (ms) => {
      waits.push(ms)
    },
  })
})

afterEach(async () => {
  store.close()
  await fake.stop()
})

const sync = (o: { force?: boolean } = {}) => syncGoogleAccount(provider, store, { window: WINDOW, ...o })
const titles = () => store.events(WINDOW).map((e) => e.title)

describe('calendar ids', () => {
  it('keep the account apart, and read back', () => {
    expect(PRIMARY).toBe('google:1234567890:me@work.example')
    expect(parseGoogleCalendarKey(PRIMARY)).toEqual({ accountId: '1234567890', calendarId: ME })
    expect(parseGoogleCalendarKey('google:x')).toBeNull()
    expect(parseGoogleCalendarKey('icloud-thing')).toBeNull()
  })
  it('read Retry-After as seconds or a date', () => {
    expect(retryAfterMs('3')).toBe(3000)
    expect(retryAfterMs(new Date(Date.now() + 10_000).toUTCString())).toBeGreaterThan(8000)
    expect(retryAfterMs(null)).toBeUndefined()
  })
})

describe('syncing', () => {
  it('lists calendars primary first, read-only where Google says so, hidden ones off', async () => {
    fake.put(ME, {
      summary: 'Planning',
      start: { dateTime: '2026-11-20T10:00:00Z' },
      end: { dateTime: '2026-11-20T11:00:00Z' },
    })
    const r = await sync()
    expect(store.calendars().map((c) => [c.name, c.readOnly, c.visible, c.source, c.color])).toEqual([
      ['Work', false, true, 'google', '#3f51b5'],
      ['Holidays', true, false, 'google', undefined],
      ['Team', true, true, 'google', '#0b8043'],
    ])
    expect(r).toMatchObject({ calendars: 3, fetched: 2, skipped: 1 })
    expect(titles()).toEqual(['Planning'])
    expect(store.calendar(PRIMARY)?.syncedAt).toBeTypeOf('number')
    // Each request carried the bearer token, and a full sync used no time bounds.
    const list = fake.apiRequests().find((q) => q.path.endsWith('/events'))!
    expect(list.headers['authorization']).toMatch(/^Bearer at-/)
    expect(list.query).toMatchObject({ singleEvents: 'false', maxResults: '2500' })
    expect(list.query['syncToken']).toBeUndefined()
  })

  it('then fetches only changes with the sync token: edits and deletions', async () => {
    const a = fake.put(ME, {
      summary: 'A',
      start: { dateTime: '2026-11-20T10:00:00Z' },
      end: { dateTime: '2026-11-20T11:00:00Z' },
    })
    const b = fake.put(ME, {
      summary: 'B',
      start: { dateTime: '2026-11-21T10:00:00Z' },
      end: { dateTime: '2026-11-21T11:00:00Z' },
    })
    await sync()
    fake.requests = []
    fake.put(ME, { id: a.id, summary: 'A2' })
    fake.put(ME, { id: b.id, status: 'cancelled' })
    const r = await sync()
    expect(titles()).toEqual(['A2'])
    const list = fake
      .apiRequests()
      .find((q) => q.path === `/calendar/v3/calendars/${encodeURIComponent(ME)}/events`)!
    expect(list.query['syncToken']).toMatch(/^sync-/)
    expect(r.fetched).toBe(1)
    // Nothing changed: nothing is rebuilt.
    expect((await sync()).fetched).toBe(0)
  })

  it('reads every page, taking the sync token from the last', async () => {
    fake.pageSize = 2
    for (let i = 0; i < 5; i++)
      fake.put(ME, {
        summary: `E${i}`,
        start: { dateTime: `2026-11-1${i}T10:00:00Z` },
        end: { dateTime: `2026-11-1${i}T11:00:00Z` },
      })
    await sync()
    expect(titles()).toEqual(['E0', 'E1', 'E2', 'E3', 'E4'])
    const pages = fake.apiRequests().filter((q) => q.path.includes(encodeURIComponent(ME)))
    expect(pages.map((p) => p.query['pageToken'] ?? null)).toEqual([null, 'page-2', 'page-4'])
    expect(store.syncToken(PRIMARY)).toMatch(/^sync-/)
  })

  it('starts again with a full sync when Google says the token is gone (410)', async () => {
    const a = fake.put(ME, {
      summary: 'A',
      start: { dateTime: '2026-11-20T10:00:00Z' },
      end: { dateTime: '2026-11-20T11:00:00Z' },
    })
    await sync()
    fake.expireSyncTokens()
    // Deleted while the token was dead: a full sync doesn't list it, so it must still go.
    fake.calendars.get(ME)!.events.delete(a.id)
    fake.put(ME, {
      summary: 'C',
      start: { dateTime: '2026-11-22T10:00:00Z' },
      end: { dateTime: '2026-11-22T11:00:00Z' },
    })
    await sync()
    expect(titles()).toEqual(['C'])
  })

  it('expands a series with changed and cancelled occurrences, and hides declined ones', async () => {
    const m = fake.put(ME, {
      summary: 'Standup',
      start: { dateTime: '2026-11-02T09:00:00Z', timeZone: 'Europe/London' },
      end: { dateTime: '2026-11-02T09:15:00Z', timeZone: 'Europe/London' },
      recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'],
    })
    fake.put(ME, {
      id: `${m.id}_20261109T090000Z`,
      recurringEventId: m.id,
      iCalUID: m.iCalUID,
      status: 'cancelled',
      originalStartTime: { dateTime: '2026-11-09T09:00:00Z', timeZone: 'Europe/London' },
    })
    fake.put(ME, {
      summary: 'Offsite',
      start: { date: '2026-11-25' },
      end: { date: '2026-11-27' },
    })
    fake.put(ME, {
      summary: 'Declined',
      start: { dateTime: '2026-11-26T09:00:00Z' },
      end: { dateTime: '2026-11-26T10:00:00Z' },
      organizer: { email: 'boss@work.example' },
      attendees: [{ email: ME, self: true, responseStatus: 'declined' }],
    })
    await sync()
    expect(store.events(WINDOW).map((e) => [e.title, e.allDay, e.start.toISOString().slice(0, 10)])).toEqual([
      ['Standup', false, '2026-11-02'],
      ['Standup', false, '2026-11-16'],
      ['Standup', false, '2026-11-23'],
      ['Offsite', true, expect.any(String)],
    ])
  })

  it('gets a new access token once after a 401', async () => {
    fake.put(ME, {
      summary: 'A',
      start: { dateTime: '2026-11-20T10:00:00Z' },
      end: { dateTime: '2026-11-20T11:00:00Z' },
    })
    await sync()
    fake.expireAccessTokens()
    await sync()
    expect(tokens.filter(Boolean)).toHaveLength(1)
    expect(titles()).toEqual(['A'])
  })

  it('gives up as signed out when the token can’t be refreshed', async () => {
    const broken = new GoogleCalendarProvider({
      accountId: '1234567890',
      store,
      apiBase: fake.base,
      token: async () => {
        throw new Error('Sign in to Google again')
      },
    })
    await expect(syncGoogleAccount(broken, store, { window: WINDOW })).rejects.toBeInstanceOf(
      CalendarAuthError,
    )
  })

  it('waits as long as Retry-After says when Google is limiting requests, then carries on', async () => {
    fake.fail({ path: /calendarList/, status: 429, headers: { 'retry-after': '2' } })
    fake.fail({
      path: /events$/,
      status: 403,
      body: { error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } },
    })
    await sync()
    expect(waits[0]).toBe(2000)
    expect(waits).toHaveLength(2)
    expect(store.calendar(PRIMARY)?.syncError).toBeUndefined()
  })

  it('stops the round with the wait Google asked for when it’s too long to wait now', async () => {
    await sync()
    fake.fail({ path: /events$/, status: 429, headers: { 'retry-after': '120' }, times: 5 })
    const err = await sync().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CalendarUnavailableError)
    expect((err as CalendarUnavailableError).retryAfterMs).toBe(120_000)
    expect(store.calendar(PRIMARY)?.syncError).toMatch(/limiting/)
    expect(store.calendar(PRIMARY)?.syncedAt).toBeTypeOf('number')
  })

  it('says to turn on the Calendar API when the project hasn’t', async () => {
    fake.fail({
      path: /calendarList/,
      status: 403,
      body: { error: { code: 403, errors: [{ reason: 'accessNotConfigured' }] } },
    })
    const err = await sync().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GoogleApiError)
    expect((err as Error).message).toMatch(/Google Calendar API/)
  })

  it('lists a calendar that fails on its own and carries on with the rest', async () => {
    fake.fail({
      path: /group\.calendar/,
      status: 404,
      body: { error: { code: 404, errors: [{ reason: 'notFound' }] } },
    })
    const r = await sync()
    expect(r.failed).toEqual([expect.objectContaining({ name: 'Team' })])
    expect(store.calendar(PRIMARY)?.syncError).toBeUndefined()
  })
})

describe('changing events', () => {
  beforeEach(async () => {
    await sync()
    fake.requests = []
  })

  const last = (method: string) => [...fake.apiRequests()].reverse().find((r) => r.method === method)!

  it('adds an event with Ordo’s UID, telling no one', async () => {
    const { uid } = await createEvent(provider, store, PRIMARY, draft({ alert: 15 }), opts)
    const post = last('POST')
    expect(post.query['sendUpdates']).toBe('none')
    expect(post.body).toMatchObject({
      iCalUID: uid,
      summary: 'Dentist',
      start: { dateTime: '2026-11-20T09:00:00', timeZone: 'Europe/London' },
      end: { dateTime: '2026-11-20T10:00:00', timeZone: 'Europe/London' },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] },
    })
    expect(store.events(WINDOW).map((e) => [e.uid, e.title, e.start.toISOString()])).toEqual([
      [uid, 'Dentist', '2026-11-20T09:00:00.000Z'],
    ])
    expect(eventDetails(store, { calendarId: PRIMARY, uid }, ME)).toMatchObject({
      editable: true,
      draft: { alert: 15 },
    })
  })

  it('changes only the fields that changed, conditional on the ETag', async () => {
    const e = fake.put(ME, {
      summary: 'Lunch',
      location: 'Canteen',
      start: { dateTime: '2026-11-20T12:00:00Z', timeZone: 'Europe/London' },
      end: { dateTime: '2026-11-20T13:00:00Z', timeZone: 'Europe/London' },
    })
    await sync()
    const ref = { calendarId: PRIMARY, uid: e.iCalUID }
    await updateEvent(
      provider,
      store,
      ref,
      { ...eventDetails(store, ref, ME)!.draft, title: 'Long lunch' },
      'all',
      opts,
    )
    const patch = last('PATCH')
    expect(patch.path).toContain(`/events/${e.id}`)
    expect(patch.headers['if-match']).toBe(e.etag)
    expect(patch.body).toEqual({ summary: 'Long lunch' })
    expect(titles()).toEqual(['Long lunch'])
    expect(fake.calendars.get(ME)!.events.get(e.id)!.location).toBe('Canteen')
  })

  it('never overwrites a change made in Google Calendar (412), and shows the latest version', async () => {
    const e = fake.put(ME, {
      summary: 'Review',
      start: { dateTime: '2026-11-20T12:00:00Z' },
      end: { dateTime: '2026-11-20T13:00:00Z' },
    })
    await sync()
    fake.put(ME, { id: e.id, summary: 'Review (moved room)' })
    const ref = { calendarId: PRIMARY, uid: e.iCalUID }
    const err = await updateEvent(
      provider,
      store,
      ref,
      { ...eventDetails(store, ref, ME)!.draft, title: 'Mine' },
      'all',
      opts,
    ).catch((x: unknown) => x)
    expect(err).toBeInstanceOf(EventChangeError)
    expect((err as EventChangeError).kind).toBe('conflict')
    expect(fake.calendars.get(ME)!.events.get(e.id)!.summary).toBe('Review (moved room)')
    expect(titles()).toEqual(['Review (moved room)'])
  })

  describe('a repeating event', () => {
    let masterId: string
    let uid: string
    beforeEach(async () => {
      const m = fake.put(ME, {
        summary: 'Standup',
        start: { dateTime: '2026-11-02T09:00:00Z', timeZone: 'Europe/London' },
        end: { dateTime: '2026-11-02T09:15:00Z', timeZone: 'Europe/London' },
        recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'],
      })
      masterId = m.id
      uid = m.iCalUID
      await sync()
      fake.requests = []
    })
    const occurrence = '2026-11-16T09:00:00.000Z'

    it('changes just one occurrence on its own instance, after checking the series is unchanged', async () => {
      const ref = { calendarId: PRIMARY, uid, recurrenceId: occurrence }
      const d = eventDetails(store, ref, ME)!
      expect(d.recurring).toBe(true)
      await updateEvent(
        provider,
        store,
        ref,
        { ...d.draft, start: '2026-11-16T10:00', end: '2026-11-16T10:30' },
        'this',
        opts,
      )
      const calls = fake.apiRequests().map((r) => `${r.method} ${r.path.split('/events')[1]}`)
      expect(calls).toEqual([
        `GET /${masterId}`,
        `GET /${masterId}/instances`,
        `PATCH /${masterId}_20261116T090000Z`,
      ])
      expect(fake.apiRequests()[0]!.headers['if-none-match']).toBeDefined()
      expect(last('PATCH').body).toMatchObject({
        start: { dateTime: '2026-11-16T10:00:00', timeZone: 'Europe/London' },
      })
      expect(fake.calendars.get(ME)!.events.get(masterId)!.summary).toBe('Standup')
      expect(store.events(WINDOW).map((e) => e.start.toISOString())).toEqual([
        '2026-11-02T09:00:00.000Z',
        '2026-11-09T09:00:00.000Z',
        '2026-11-16T10:00:00.000Z',
        '2026-11-23T09:00:00.000Z',
      ])
      // Changing it again goes straight to its exception, with that exception's ETag.
      fake.requests = []
      const again = eventDetails(store, ref, ME)!
      await updateEvent(provider, store, ref, { ...again.draft, title: 'Standup (late)' }, 'this', opts)
      expect(fake.apiRequests().map((r) => r.method)).toEqual(['PATCH'])
      expect(last('PATCH').body).toEqual({ summary: 'Standup (late)' })
    })

    it('refuses to change an occurrence when the series changed in Google Calendar', async () => {
      fake.put(ME, { id: masterId, location: 'Room 2' })
      const ref = { calendarId: PRIMARY, uid, recurrenceId: occurrence }
      const err = await updateEvent(
        provider,
        store,
        ref,
        { ...eventDetails(store, ref, ME)!.draft, title: 'x' },
        'this',
        opts,
      ).catch((e: unknown) => e)
      expect((err as EventChangeError).kind).toBe('conflict')
      expect(fake.apiRequests().some((r) => r.method === 'PATCH')).toBe(false)
    })

    it('deletes just one occurrence by cancelling its instance', async () => {
      await deleteEvent(provider, store, { calendarId: PRIMARY, uid, recurrenceId: occurrence }, 'this', opts)
      expect(last('DELETE').path).toContain(`${masterId}_20261116T090000Z`)
      expect(fake.calendars.get(ME)!.events.get(masterId)!.status).toBe('confirmed')
      expect(store.events(WINDOW).map((e) => e.start.toISOString())).toEqual([
        '2026-11-02T09:00:00.000Z',
        '2026-11-09T09:00:00.000Z',
        '2026-11-23T09:00:00.000Z',
      ])
      // And a sync agrees.
      await sync()
      expect(store.events(WINDOW)).toHaveLength(3)
    })

    it('renames every occurrence by changing the series only', async () => {
      const ref = { calendarId: PRIMARY, uid, recurrenceId: occurrence }
      await updateEvent(
        provider,
        store,
        ref,
        { ...eventDetails(store, ref, ME)!.draft, title: 'Daily sync' },
        'all',
        opts,
      )
      expect(fake.apiRequests().map((r) => r.method)).toEqual(['PATCH'])
      expect(last('PATCH').body).toEqual({ summary: 'Daily sync' })
      expect(new Set(titles())).toEqual(new Set(['Daily sync']))
    })

    it('moves the whole series by as much as the occurrence moved', async () => {
      const ref = { calendarId: PRIMARY, uid, recurrenceId: occurrence }
      await updateEvent(
        provider,
        store,
        ref,
        { ...eventDetails(store, ref, ME)!.draft, start: '2026-11-16T09:30', end: '2026-11-16T09:45' },
        'all',
        opts,
      )
      expect(last('PATCH').body).toMatchObject({
        start: { dateTime: '2026-11-02T09:30:00', timeZone: 'Europe/London' },
        end: { dateTime: '2026-11-02T09:45:00', timeZone: 'Europe/London' },
      })
      await sync()
      expect(store.events(WINDOW).map((e) => e.start.toISOString().slice(11, 16))).toEqual([
        '09:30',
        '09:30',
        '09:30',
        '09:30',
      ])
    })

    it('deletes the whole series conditionally', async () => {
      await deleteEvent(provider, store, { calendarId: PRIMARY, uid, recurrenceId: occurrence }, 'all', opts)
      const del = last('DELETE')
      expect(del.path).toMatch(new RegExp(`/events/${masterId}$`))
      expect(del.headers['if-match']).toBeDefined()
      expect(store.events(WINDOW)).toEqual([])
    })
  })

  it('refuses calendars shared with you read-only, invitations, and out-of-office events', async () => {
    const team = googleCalendarKey('1234567890', 'team@group.calendar.google.com')
    await expect(createEvent(provider, store, team, draft(), opts)).rejects.toMatchObject({
      kind: 'read-only',
    })
    const invite = fake.put(ME, {
      summary: 'Board meeting',
      start: { dateTime: '2026-11-20T12:00:00Z' },
      end: { dateTime: '2026-11-20T13:00:00Z' },
      organizer: { email: 'ceo@work.example' },
      attendees: [{ email: ME, self: true, responseStatus: 'accepted' }, { email: 'ceo@work.example' }],
    })
    const ooo = fake.put(ME, {
      summary: 'Away',
      eventType: 'outOfOffice',
      start: { dateTime: '2026-11-21T09:00:00Z' },
      end: { dateTime: '2026-11-21T17:00:00Z' },
    })
    await sync()
    const inv = eventDetails(store, { calendarId: PRIMARY, uid: invite.iCalUID }, ME)!
    expect(inv).toMatchObject({ editable: false })
    expect(inv.reason).toMatch(/invitation from ceo@work\.example\. Change it in Google Calendar/)
    const away = eventDetails(store, { calendarId: PRIMARY, uid: ooo.iCalUID }, ME)!
    expect(away.reason).toMatch(/out-of-office event, so change it in Google Calendar/)
    await expect(
      deleteEvent(provider, store, { calendarId: PRIMARY, uid: ooo.iCalUID }, 'all', opts),
    ).rejects.toMatchObject({ kind: 'read-only' })
    expect(fake.apiRequests().some((r) => r.method === 'DELETE')).toBe(false)
  })

  it('deletes only your occurrences of someone else’s series, never the series', async () => {
    fake.put(ME, {
      id: 'theirs_20261120T120000Z',
      iCalUID: 'theirs@google.com',
      recurringEventId: 'theirs',
      originalStartTime: { dateTime: '2026-11-20T12:00:00Z' },
      summary: 'Drop-in',
      start: { dateTime: '2026-11-20T12:00:00Z' },
      end: { dateTime: '2026-11-20T13:00:00Z' },
    })
    await sync()
    fake.requests = []
    await deleteEvent(
      provider,
      store,
      { calendarId: PRIMARY, uid: 'theirs@google.com', recurrenceId: '2026-11-20T12:00:00.000Z' },
      'all',
      opts,
    )
    expect(fake.apiRequests().map((r) => `${r.method} ${r.path.split('/events/')[1]}`)).toEqual([
      'DELETE theirs_20261120T120000Z',
    ])
  })

  it('refuses an alert after the start, which Google can’t do, without sending anything', async () => {
    await expect(createEvent(provider, store, PRIMARY, draft({ alert: -10 }), opts)).rejects.toMatchObject({
      kind: 'invalid',
    })
    expect(fake.apiRequests()).toEqual([])
  })
})
