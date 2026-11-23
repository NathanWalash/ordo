import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CalendarStore } from './store'
import type { CalendarEvent, RemoteCalendar } from './types'

const HOME: RemoteCalendar = { id: 'home', name: 'Home', color: '#007aff', readOnly: false, version: 'v1' }
const WORK: RemoteCalendar = { id: 'work', name: 'Work', color: '#ff9500', readOnly: true, version: 'w1' }
const WINDOW = { start: new Date(2026, 9, 1), end: new Date(2027, 11, 1) }

const ev = (o: Partial<CalendarEvent> & Pick<CalendarEvent, 'uid' | 'start' | 'end'>): CalendarEvent => ({
  calendarId: 'home',
  title: o.uid,
  allDay: false,
  ...o,
})

let store: CalendarStore
beforeEach(() => {
  store = new CalendarStore(':memory:')
  store.setCalendars([HOME, WORK])
})
afterEach(() => store.close())

describe('CalendarStore', () => {
  it('lists calendars in provider order, visible by default', () => {
    expect(store.calendars()).toEqual([
      {
        id: 'home',
        name: 'Home',
        color: '#007aff',
        readOnly: false,
        visible: true,
        source: 'icloud',
        provider: 'icloud',
      },
      {
        id: 'work',
        name: 'Work',
        color: '#ff9500',
        readOnly: true,
        visible: true,
        source: 'icloud',
        provider: 'icloud',
      },
    ])
  })

  it('keeps visibility when the list is refreshed, and forgets removed calendars and their events', () => {
    store.setVisible('home', false)
    store.replaceEvents(
      'work',
      [ev({ uid: 'w', calendarId: 'work', start: new Date(2026, 10, 2, 9), end: new Date(2026, 10, 2, 10) })],
      WINDOW,
    )
    store.setCalendars([{ ...HOME, name: 'Personal' }])
    expect(store.calendars()).toEqual([
      {
        id: 'home',
        name: 'Personal',
        color: '#007aff',
        readOnly: false,
        visible: false,
        source: 'icloud',
        provider: 'icloud',
      },
    ])
    expect(store.count()).toBe(0)
  })

  it('round-trips timed, all-day and recurring occurrences', () => {
    const timed = ev({
      uid: 'a',
      start: new Date('2026-11-18T09:00:00Z'),
      end: new Date('2026-11-18T10:00:00Z'),
      location: 'Café',
      notes: 'Bring notes',
    })
    const allDay = ev({ uid: 'b', start: new Date(2026, 10, 20), end: new Date(2026, 10, 23), allDay: true })
    const occ1 = ev({
      uid: 'c',
      start: new Date('2026-11-02T09:00:00Z'),
      end: new Date('2026-11-02T09:30:00Z'),
      recurrenceId: '2026-11-02T09:00:00.000Z',
    })
    const occ2 = {
      ...occ1,
      start: new Date('2026-11-09T09:00:00Z'),
      end: new Date('2026-11-09T09:30:00Z'),
      recurrenceId: '2026-11-09T09:00:00.000Z',
    }
    store.replaceEvents('home', [timed, allDay, occ1, occ2], WINDOW, 'v1')
    expect(store.events(WINDOW)).toEqual([occ1, occ2, timed, allDay])
  })

  it('returns only occurrences overlapping the range, from visible calendars', () => {
    const day = (d: number) => ({ start: new Date(2026, 10, d), end: new Date(2026, 10, d + 1) })
    store.replaceEvents(
      'home',
      [
        ev({ uid: 'morning', start: new Date(2026, 10, 18, 9), end: new Date(2026, 10, 18, 10) }),
        ev({ uid: 'overnight', start: new Date(2026, 10, 17, 22), end: new Date(2026, 10, 18, 1) }),
        ev({ uid: 'trip', start: new Date(2026, 10, 16), end: new Date(2026, 10, 18), allDay: true }),
      ],
      WINDOW,
    )
    store.replaceEvents(
      'work',
      [
        ev({
          uid: 'standup',
          calendarId: 'work',
          start: new Date(2026, 10, 18, 9, 30),
          end: new Date(2026, 10, 18, 9, 45),
        }),
      ],
      WINDOW,
    )

    expect(store.events(day(18)).map((e) => e.uid)).toEqual(['overnight', 'morning', 'standup'])
    // The trip ends (exclusive) at the start of the 18th.
    expect(store.events(day(17)).map((e) => e.uid)).toEqual(['trip', 'overnight'])

    store.setVisible('work', false)
    expect(store.events(day(18)).map((e) => e.uid)).toEqual(['overnight', 'morning'])
    expect(store.events(day(18), { includeHidden: true })).toHaveLength(3)
  })

  it('replaces a calendar’s events and records what was synced', () => {
    expect(store.syncState('home')).toBeNull()
    store.replaceEvents(
      'home',
      [ev({ uid: 'old', start: new Date(2026, 10, 1, 9), end: new Date(2026, 10, 1, 10) })],
      WINDOW,
      'v1',
    )
    store.replaceEvents(
      'home',
      [ev({ uid: 'new', start: new Date(2026, 10, 1, 9), end: new Date(2026, 10, 1, 10) })],
      WINDOW,
      'v2',
    )
    expect(store.events(WINDOW).map((e) => e.uid)).toEqual(['new'])
    expect(store.syncState('home')).toEqual({ version: 'v2', from: WINDOW.start, to: WINDOW.end })
  })

  it('stores metadata and clears everything', () => {
    store.setMeta('lastSync', '2026-11-17T09:00:00.000Z')
    expect(store.meta('lastSync')).toBe('2026-11-17T09:00:00.000Z')
    store.setMeta('lastSync', null)
    expect(store.meta('lastSync')).toBeNull()
    store.setMeta('account', 'you@icloud.com')
    store.clear()
    expect(store.calendars()).toEqual([])
    expect(store.meta('account')).toBeNull()
  })
})

describe('subscriptions next to iCloud', () => {
  const FEED = { id: 'feed:1', name: 'Work (Google)', readOnly: true }

  it("keeps each provider's calendars when the other syncs", () => {
    store.addFeed({
      id: 'feed:1',
      kind: 'link',
      name: 'Work (Google)',
      secret: 'enc',
      host: 'calendar.google.com',
    })
    store.setCalendars([FEED], 'feeds')
    store.setCalendars([HOME]) // iCloud's list changed: Work went away
    expect(store.calendars().map((c) => [c.id, c.source])).toEqual([
      ['home', 'icloud'],
      ['feed:1', 'link'],
    ])
    store.setCalendars([], 'feeds')
    expect(store.calendars().map((c) => c.id)).toEqual(['home'])
  })

  it('forgets one provider without touching the other', () => {
    store.addFeed({ id: 'feed:1', kind: 'file', name: 'Holidays', ics: 'BEGIN:VCALENDAR' })
    store.setCalendars([FEED], 'feeds')
    store.replaceEvents(
      'feed:1',
      [
        ev({
          uid: 'x',
          calendarId: 'feed:1',
          start: new Date(2026, 10, 2, 9),
          end: new Date(2026, 10, 2, 10),
        }),
      ],
      WINDOW,
    )
    store.clearProvider('icloud')
    expect(store.calendars().map((c) => c.id)).toEqual(['feed:1'])
    expect(store.count()).toBe(1)
    expect(store.feeds()).toEqual([{ id: 'feed:1', kind: 'file', name: 'Holidays', ics: 'BEGIN:VCALENDAR' }])
  })

  it('removes a subscription with its calendar and events', () => {
    store.addFeed({ id: 'feed:1', kind: 'link', name: 'Work', secret: 'enc' })
    store.setCalendars([FEED], 'feeds')
    store.replaceEvents(
      'feed:1',
      [
        ev({
          uid: 'x',
          calendarId: 'feed:1',
          start: new Date(2026, 10, 2, 9),
          end: new Date(2026, 10, 2, 10),
        }),
      ],
      WINDOW,
    )
    expect(store.removeFeed('home')).toBe(false)
    expect(store.removeFeed('feed:1')).toBe(true)
    expect(store.feeds()).toEqual([])
    expect(store.calendars().map((c) => c.id)).toEqual(['home', 'work'])
    expect(store.count()).toBe(0)
  })
})

describe('upgrading an older cache', () => {
  it('adds the provider column and treats existing calendars as iCloud', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const path = join(mkdtempSync(join(tmpdir(), 'ordo-cal-')), 'calendar.sqlite')
    const old = new DatabaseSync(path)
    old.exec(
      'CREATE TABLE calendars (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT, read_only INTEGER NOT NULL, ' +
        'visible INTEGER NOT NULL DEFAULT 1, position INTEGER NOT NULL, version TEXT, synced_from INTEGER, synced_to INTEGER);' +
        "INSERT INTO calendars (id, name, read_only, position) VALUES ('home', 'Home', 0, 0);",
    )
    old.close()
    const upgraded = new CalendarStore(path)
    expect(upgraded.calendars()).toMatchObject([{ id: 'home', source: 'icloud' }])
    upgraded.setCalendars([], 'feeds')
    expect(upgraded.calendars()).toHaveLength(1)
    upgraded.close()
  })

  it('makes calendars cached before resources were kept sync again, once', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ordo-cal-')), 'calendar.sqlite')
    const first = new CalendarStore(path)
    first.setCalendars([HOME])
    first.replaceEvents('home', [], WINDOW, 'v1')
    first.setMeta('lastSync', '2026-11-18T09:00:00.000Z')
    first.setMeta('schema', null) // as a cache from before this version
    first.close()
    const upgraded = new CalendarStore(path)
    expect(upgraded.syncState('home')!.version).toBeNull()
    expect(upgraded.meta('lastSync')).toBeNull()
    upgraded.setMeta('lastSync', '2026-11-18T10:00:00.000Z')
    upgraded.replaceEvents('home', [], WINDOW, 'v2')
    upgraded.close()
    const again = new CalendarStore(path)
    expect(again.syncState('home')!.version).toBe('v2')
    expect(again.meta('lastSync')).toBe('2026-11-18T10:00:00.000Z')
    again.close()
  })
})

describe('CalendarStore resources', () => {
  const res = (uid: string, etag = '"1"') => ({
    href: `https://cal.example/home/${uid}.ics`,
    etag,
    uid,
    ics: `ICS ${uid}`,
  })
  const at = (uid: string, day: number) =>
    ev({ uid, start: new Date(2026, 10, day, 9), end: new Date(2026, 10, day, 10) })

  it('keeps the resources a calendar was fetched with, and swaps one after a change', () => {
    store.replaceEvents('home', [at('a', 2), at('b', 3)], WINDOW, 'v1', [res('a'), res('b')])
    expect(store.resources('home', 'a')).toEqual([res('a')])

    store.replaceResource('home', 'a', res('a').href, res('a', '"2"'), [at('a', 5)])
    expect(store.resources('home', 'a')).toEqual([res('a', '"2"')])
    expect(store.events(WINDOW).map((e) => [e.uid, e.start.getDate()])).toEqual([
      ['b', 3],
      ['a', 5],
    ])

    store.replaceResource('home', 'b', res('b').href, null, [])
    expect(store.resources('home', 'b')).toEqual([])
    expect(store.events(WINDOW).map((e) => e.uid)).toEqual(['a'])
  })

  it('keeps resources when a provider without them refreshes, and forgets them with the calendar', () => {
    store.replaceEvents('home', [at('a', 2)], WINDOW, 'v1', [res('a')])
    store.replaceEvents('home', [at('a', 2)], WINDOW, 'v2')
    expect(store.resources('home', 'a')).toHaveLength(1)
    store.setCalendars([WORK])
    expect(store.resources('home', 'a')).toEqual([])
  })

  it('finds which calendars hold an event', () => {
    store.replaceEvents('home', [at('a', 2)], WINDOW, 'v1', [res('a')])
    store.replaceEvents('work', [ev({ ...at('a', 2), calendarId: 'work' })], WINDOW, 'w1')
    expect(store.calendarsWithEvent('a')).toEqual(['home', 'work'])
    expect(store.calendarsWithEvent('zzz')).toEqual([])
  })

  it('says which provider owns a calendar', () => {
    expect(store.calendar('home')).toMatchObject({ name: 'Home', provider: 'icloud', readOnly: false })
    expect(store.calendar('nope')).toBeNull()
  })
})
