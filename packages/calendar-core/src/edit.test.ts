import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CalendarWriteError } from './caldav'
import type { EventDraft } from './draft'
import { createEvent, deleteEvent, EventChangeError, eventDetails, updateEvent } from './edit'
import { parseIcs } from './ics'
import { CalendarStore, FEEDS } from './store'
import { syncCalendars } from './sync'
import type {
  CalendarEvent,
  CalendarProvider,
  CalendarResource,
  DateRange,
  RemoteCalendar,
  WritableCalendarProvider,
} from './types'
import { createEventIcs, readEvent } from './write'

const HOME = 'https://cal.example/u/home/'
const WINDOW: DateRange = { start: new Date('2026-10-01T00:00:00Z'), end: new Date('2027-12-01T00:00:00Z') }

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

/** A CalDAV server in memory, with ETags, that can be changed "somewhere else". */
class FakeServer implements CalendarProvider, WritableCalendarProvider {
  objects = new Map<string, { ics: string; etag: number }>()
  calendars: RemoteCalendar[] = [{ id: HOME, name: 'Home', readOnly: false, version: '1' }]
  sendEtags = true
  forbid = false
  calls: string[] = []
  private n = 0

  async connect() {}
  async close() {}
  async listCalendars() {
    return this.calendars
  }
  async fetchEvents(calendarId: string, range: DateRange) {
    return (await this.fetchResources(calendarId, range)).events
  }
  async fetchResources(calendarId: string, range: DateRange) {
    const resources: CalendarResource[] = [...this.objects].map(([href, o]) => ({
      href,
      etag: `"${o.etag}"`,
      uid: readUid(o.ics),
      ics: o.ics,
    }))
    const events: CalendarEvent[] = resources.flatMap((r) => parseIcs(r.ics, { calendarId, range }))
    return { events, resources }
  }
  async fetchResource(_calendarId: string, href: string) {
    const o = this.objects.get(href)
    return o ? { href, etag: `"${o.etag}"`, uid: readUid(o.ics), ics: o.ics } : null
  }
  async createResource(calendarId: string, uid: string, ics: string) {
    this.calls.push('create')
    const href = `${calendarId}${uid}.ics`
    if (this.objects.has(href)) throw new CalendarWriteError('conflict', 'exists', 412)
    this.objects.set(href, { ics, etag: ++this.n })
    return { href, etag: this.sendEtags ? `"${this.n}"` : undefined }
  }
  async updateResource(_calendarId: string, href: string, ics: string, etag?: string) {
    this.calls.push(`update ${etag}`)
    if (this.forbid) throw new CalendarWriteError('forbidden', 'no', 403)
    const o = this.objects.get(href)
    if (!o) throw new CalendarWriteError('gone', 'gone', 404)
    if (etag !== `"${o.etag}"`) throw new CalendarWriteError('conflict', 'changed', 412)
    this.objects.set(href, { ics, etag: ++this.n })
    return { etag: this.sendEtags ? `"${this.n}"` : undefined }
  }
  async deleteResource(_calendarId: string, href: string, etag?: string) {
    this.calls.push(`delete ${etag}`)
    const o = this.objects.get(href)
    if (!o) throw new CalendarWriteError('gone', 'gone', 404)
    if (etag !== `"${o.etag}"`) throw new CalendarWriteError('conflict', 'changed', 412)
    this.objects.delete(href)
  }
  /** Someone edits the event on their phone. */
  changeElsewhere(href: string, ics: string) {
    this.objects.set(href, { ics, etag: ++this.n })
  }
}

const readUid = (ics: string) => /^UID:(.*)$/m.exec(ics)![1]!.trim()

let server: FakeServer
let store: CalendarStore
const opts = { window: WINDOW, now: new Date('2026-11-18T10:00:00Z'), me: 'me@icloud.example' }
const mine = () => store.events(WINDOW).filter((e) => e.calendarId === HOME)

beforeEach(async () => {
  server = new FakeServer()
  store = new CalendarStore(':memory:')
  await syncCalendars(server, store, { window: WINDOW })
})
afterEach(() => store.close())

describe('createEvent', () => {
  it('writes the event, caches it with its ETag and shows it straight away', async () => {
    const { uid } = await createEvent(
      server,
      store,
      HOME,
      draft({ repeat: { frequency: 'daily', count: 2 } }),
      opts,
    )
    expect(server.objects.size).toBe(1)
    expect(mine().map((e) => [e.uid, e.title, e.start.toISOString()])).toEqual([
      [uid, 'Dentist', '2026-11-20T09:00:00.000Z'],
      [uid, 'Dentist', '2026-11-21T09:00:00.000Z'],
    ])
    expect(store.resources(HOME, uid)[0]).toMatchObject({ etag: '"1"', href: `${HOME}${uid}.ics` })
  })

  it('asks the server for the ETag when it doesn’t send one', async () => {
    server.sendEtags = false
    const { uid } = await createEvent(server, store, HOME, draft(), opts)
    expect(store.resources(HOME, uid)[0]!.etag).toBe('"1"')
  })

  it('refuses read-only calendars, calendars added by link, and bad drafts', async () => {
    server.calendars.push({
      id: 'https://cal.example/u/shared/',
      name: 'Shared',
      readOnly: true,
      version: '1',
    })
    await syncCalendars(server, store, { window: WINDOW })
    store.addFeed({ id: 'feed:1', kind: 'link', name: 'Work (Google)' })
    store.setCalendars([{ id: 'feed:1', name: 'Work (Google)', readOnly: true }], FEEDS)

    await expect(
      createEvent(server, store, 'https://cal.example/u/shared/', draft(), opts),
    ).rejects.toMatchObject({
      kind: 'read-only',
      message: '“Shared” is read-only, so its events can’t be changed.',
    })
    await expect(createEvent(server, store, 'feed:1', draft(), opts)).rejects.toMatchObject({
      kind: 'read-only',
      message: '“Work (Google)” was added by link, so it’s read-only in Ordo.',
    })
    await expect(createEvent(server, store, 'nope', draft(), opts)).rejects.toMatchObject({
      kind: 'not-found',
    })
    await expect(
      createEvent(server, store, HOME, draft({ end: '2026-11-20T08:00' }), opts),
    ).rejects.toMatchObject({
      kind: 'invalid',
      message: 'The event ends before it starts.',
    })
    expect(server.calls).toEqual([])
  })
})

describe('updateEvent', () => {
  it('sends If-Match with the ETag Ordo last saw, and caches the new one', async () => {
    const { uid } = await createEvent(server, store, HOME, draft(), opts)
    await updateEvent(
      server,
      store,
      { calendarId: HOME, uid },
      draft({ title: 'Dentist (moved)', start: '2026-11-21T09:00', end: '2026-11-21T10:00' }),
      'all',
      opts,
    )
    expect(server.calls).toEqual(['create', 'update "1"'])
    expect(mine()).toMatchObject([{ title: 'Dentist (moved)', start: new Date('2026-11-21T09:00:00Z') }])
    expect(store.resources(HOME, uid)[0]!.etag).toBe('"2"')
  })

  it('never overwrites a change made elsewhere: 412 is reported and the cache shows the latest', async () => {
    const { uid } = await createEvent(server, store, HOME, draft(), opts)
    const href = store.resources(HOME, uid)[0]!.href
    server.changeElsewhere(href, createEventIcs(draft({ title: 'Changed on iPhone' }), { uid }))

    const attempt = updateEvent(
      server,
      store,
      { calendarId: HOME, uid },
      draft({ title: 'Mine' }),
      'all',
      opts,
    )
    await expect(attempt).rejects.toBeInstanceOf(EventChangeError)
    await expect(attempt).rejects.toMatchObject({
      kind: 'conflict',
      message: expect.stringMatching(/changed somewhere else/),
    })
    expect(readEvent(server.objects.get(href)!.ics, { uid }).draft.title).toBe('Changed on iPhone')
    expect(mine()[0]!.title).toBe('Changed on iPhone')

    // Trying again now works, against the refreshed ETag.
    await updateEvent(server, store, { calendarId: HOME, uid }, draft({ title: 'Mine' }), 'all', opts)
    expect(mine()[0]!.title).toBe('Mine')
  })

  it('without ETags, still notices a change made elsewhere by comparing the event', async () => {
    server.sendEtags = false
    const { uid } = await createEvent(server, store, HOME, draft(), opts)
    const href = store.resources(HOME, uid)[0]!.href
    // The cache lost its ETag (a server that never sends them).
    const cached = store.resources(HOME, uid)[0]!
    store.replaceResource(HOME, uid, href, { ...cached, etag: undefined }, mine())
    server.changeElsewhere(href, createEventIcs(draft({ title: 'Elsewhere' }), { uid }))
    await expect(
      updateEvent(server, store, { calendarId: HOME, uid }, draft({ title: 'Mine' }), 'all', opts),
    ).rejects.toMatchObject({ kind: 'conflict' })
  })

  it('says when the event was deleted elsewhere and drops it from the cache', async () => {
    const { uid } = await createEvent(server, store, HOME, draft(), opts)
    server.objects.clear()
    await expect(
      updateEvent(server, store, { calendarId: HOME, uid }, draft({ title: 'x' }), 'all', opts),
    ).rejects.toMatchObject({ kind: 'not-found', message: 'This event was deleted somewhere else.' })
    expect(mine()).toEqual([])
  })

  it('changes one occurrence of a series with an override', async () => {
    const { uid } = await createEvent(
      server,
      store,
      HOME,
      draft({ repeat: { frequency: 'daily', count: 3 } }),
      opts,
    )
    const second = mine()[1]!
    await updateEvent(
      server,
      store,
      { calendarId: HOME, uid, recurrenceId: second.recurrenceId },
      draft({
        title: 'Late',
        start: '2026-11-21T15:00',
        end: '2026-11-21T16:00',
        repeat: { frequency: 'daily', count: 3 },
      }),
      'this',
      opts,
    )
    expect(mine().map((e) => e.title)).toEqual(['Dentist', 'Late', 'Dentist'])
  })

  it('leaves invitations from other people alone', async () => {
    const ics = createEventIcs(draft(), { uid: 'inv' }).replace(
      'END:VEVENT',
      'ORGANIZER:mailto:boss@work.example\r\nATTENDEE:mailto:me@icloud.example\r\nEND:VEVENT',
    )
    server.objects.set(`${HOME}inv.ics`, { ics, etag: 99 })
    await syncCalendars(server, store, { window: WINDOW, force: true })
    await expect(
      updateEvent(server, store, { calendarId: HOME, uid: 'inv' }, draft({ title: 'x' }), 'all', opts),
    ).rejects.toMatchObject({ kind: 'invitation', message: expect.stringContaining('boss@work.example') })
    expect(eventDetails(store, { calendarId: HOME, uid: 'inv' }, opts.me)).toMatchObject({
      editable: false,
      reason: expect.stringContaining('invitation'),
    })
    // Your own invitations to others are yours to change.
    expect(eventDetails(store, { calendarId: HOME, uid: 'inv' }, 'boss@work.example')!.editable).toBe(true)
  })

  it('reports a server that forbids the change as read-only', async () => {
    const { uid } = await createEvent(server, store, HOME, draft(), opts)
    server.forbid = true
    await expect(
      updateEvent(server, store, { calendarId: HOME, uid }, draft({ title: 'x' }), 'all', opts),
    ).rejects.toMatchObject({ kind: 'read-only' })
  })

  it('fetches the calendar again when an event isn’t cached yet', async () => {
    server.objects.set(`${HOME}new.ics`, { ics: createEventIcs(draft(), { uid: 'new' }), etag: 50 })
    await updateEvent(server, store, { calendarId: HOME, uid: 'new' }, draft({ title: 'Found' }), 'all', opts)
    expect(mine().map((e) => e.title)).toEqual(['Found'])
  })
})

describe('deleteEvent', () => {
  it('deletes one occurrence with an EXDATE, or the whole event', async () => {
    const { uid } = await createEvent(
      server,
      store,
      HOME,
      draft({ repeat: { frequency: 'daily', count: 3 } }),
      opts,
    )
    await deleteEvent(
      server,
      store,
      { calendarId: HOME, uid, recurrenceId: mine()[1]!.recurrenceId },
      'this',
      opts,
    )
    expect(mine().map((e) => e.start.toISOString())).toEqual([
      '2026-11-20T09:00:00.000Z',
      '2026-11-22T09:00:00.000Z',
    ])
    expect(server.objects.size).toBe(1)

    await deleteEvent(
      server,
      store,
      { calendarId: HOME, uid, recurrenceId: mine()[0]!.recurrenceId },
      'all',
      opts,
    )
    expect(mine()).toEqual([])
    expect(server.objects.size).toBe(0)
    expect(store.resources(HOME, uid)).toEqual([])
  })

  it('won’t delete over a change made elsewhere', async () => {
    const { uid } = await createEvent(server, store, HOME, draft(), opts)
    const href = store.resources(HOME, uid)[0]!.href
    server.changeElsewhere(href, createEventIcs(draft({ title: 'Edited' }), { uid }))
    await expect(deleteEvent(server, store, { calendarId: HOME, uid }, 'all', opts)).rejects.toMatchObject({
      kind: 'conflict',
    })
    expect(server.objects.size).toBe(1)
    expect(mine()[0]!.title).toBe('Edited')
  })
})

describe('eventDetails', () => {
  it('gives the editor the occurrence’s draft and whether it repeats', async () => {
    const { uid } = await createEvent(
      server,
      store,
      HOME,
      draft({ repeat: { frequency: 'weekly', count: 2 }, alert: 15 }),
      opts,
    )
    const d = eventDetails(store, { calendarId: HOME, uid, recurrenceId: mine()[1]!.recurrenceId }, opts.me)
    expect(d).toMatchObject({
      calendarId: HOME,
      editable: true,
      recurring: true,
      draft: { start: '2026-11-27T09:00', alert: 15, repeat: { frequency: 'weekly', count: 2 } },
    })
    expect(eventDetails(store, { calendarId: HOME, uid: 'missing' })).toBeNull()
  })
})
