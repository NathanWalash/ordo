import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CalendarStore } from './store'
import { syncCalendars } from './sync'
import type {
  CalendarEvent,
  CalendarProvider,
  CalendarSyncProgress,
  DateRange,
  RemoteCalendar,
} from './types'

class FakeProvider implements CalendarProvider {
  fetched: string[] = []
  constructor(
    public calendars: RemoteCalendar[],
    public events: Record<string, CalendarEvent[]>,
  ) {}
  async connect() {}
  async close() {}
  async listCalendars() {
    return this.calendars
  }
  async fetchEvents(calendarId: string, _range: DateRange) {
    this.fetched.push(calendarId)
    return this.events[calendarId] ?? []
  }
}

const event = (calendarId: string, uid: string, day: number): CalendarEvent => ({
  uid,
  calendarId,
  title: uid,
  start: new Date(2026, 10, day, 9),
  end: new Date(2026, 10, day, 10),
  allDay: false,
})

const WINDOW = { start: new Date(2026, 9, 1), end: new Date(2027, 11, 1) }

let store: CalendarStore
let provider: FakeProvider
beforeEach(() => {
  store = new CalendarStore(':memory:')
  provider = new FakeProvider(
    [
      { id: 'home', name: 'Home', readOnly: false, version: 'h1' },
      { id: 'work', name: 'Work', readOnly: false, version: 'w1' },
    ],
    { home: [event('home', 'a', 18)], work: [event('work', 'b', 19), event('work', 'c', 20)] },
  )
})
afterEach(() => store.close())

describe('syncCalendars', () => {
  it('caches every calendar and reports progress', async () => {
    const progress: CalendarSyncProgress[] = []
    const result = await syncCalendars(provider, store, {
      window: WINDOW,
      onProgress: (p) => progress.push(p),
    })
    expect(result).toEqual({ calendars: 2, fetched: 2, skipped: 0, events: 3, stopped: false })
    expect(store.events(WINDOW).map((e) => e.uid)).toEqual(['a', 'b', 'c'])
    expect(progress).toEqual([
      { done: 0, total: 2, current: 'Home' },
      { done: 1, total: 2, current: 'Work' },
      { done: 2, total: 2 },
    ])
  })

  it('skips calendars whose version has not changed', async () => {
    await syncCalendars(provider, store, { window: WINDOW })
    provider.fetched = []
    provider.calendars[1]!.version = 'w2'
    provider.events['work'] = [event('work', 'd', 21)]
    const result = await syncCalendars(provider, store, { window: WINDOW })
    expect(provider.fetched).toEqual(['work'])
    expect(result).toMatchObject({ fetched: 1, skipped: 1 })
    expect(store.events(WINDOW).map((e) => e.uid)).toEqual(['a', 'd'])
  })

  it('refetches when the window moves past what was cached, or when forced', async () => {
    await syncCalendars(provider, store, { window: WINDOW })
    provider.fetched = []
    await syncCalendars(provider, store, {
      window: { start: new Date(2026, 10, 1), end: new Date(2028, 0, 1) },
    })
    expect(provider.fetched).toEqual(['home', 'work'])
    provider.fetched = []
    await syncCalendars(provider, store, { window: WINDOW, force: true })
    expect(provider.fetched).toEqual(['home', 'work'])
  })

  it('always refetches calendars that have no version', async () => {
    provider.calendars = [{ id: 'plain', name: 'Plain', readOnly: true }]
    await syncCalendars(provider, store, { window: WINDOW })
    await syncCalendars(provider, store, { window: WINDOW })
    expect(provider.fetched).toEqual(['plain', 'plain'])
  })

  it('stops between calendars when aborted', async () => {
    const ctrl = new AbortController()
    const result = await syncCalendars(provider, store, {
      window: WINDOW,
      signal: ctrl.signal,
      onProgress: (p) => p.done === 1 && ctrl.abort(),
    })
    expect(result).toMatchObject({ fetched: 1, stopped: true })
    expect(provider.fetched).toEqual(['home'])
  })
})
