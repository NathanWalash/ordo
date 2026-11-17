import { describe, expect, it } from 'vitest'
import { checkFeedUrl, describeIcs, FeedError, FeedProvider, fetchFeed } from './feeds'

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Test//EN',
  'X-WR-CALNAME:Work',
  'X-APPLE-CALENDAR-COLOR:#1BADF8',
  'BEGIN:VEVENT',
  'UID:standup',
  'DTSTART:20261116T093000Z',
  'DTEND:20261116T094500Z',
  'RRULE:FREQ=DAILY;COUNT=5',
  'SUMMARY:Standup',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:offsite',
  'DTSTART;VALUE=DATE:20261120',
  'DTEND;VALUE=DATE:20261121',
  'SUMMARY:Team offsite',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n')

const week = { start: new Date('2026-11-16T00:00:00Z'), end: new Date('2026-11-23T00:00:00Z') }

/** A fetch that answers from a table of URL → response. */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: string[] = []
  const f = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    const route = routes[url]
    if (!route) throw new TypeError('fetch failed')
    return route()
  }) as typeof fetch
  return Object.assign(f, { calls })
}

describe('checkFeedUrl', () => {
  it('turns webcal into https and accepts https', () => {
    expect(checkFeedUrl(' webcal://p01-caldav.icloud.com/published/2/abc ')).toEqual({
      ok: true,
      url: 'https://p01-caldav.icloud.com/published/2/abc',
      host: 'p01-caldav.icloud.com',
    })
    expect(
      checkFeedUrl('https://calendar.google.com/calendar/ical/me%40work.com/private-123/basic.ics'),
    ).toMatchObject({ ok: true, host: 'calendar.google.com' })
  })

  it('refuses plain http, other schemes and fragments of links', () => {
    expect(checkFeedUrl('http://example.com/cal.ics')).toMatchObject({ ok: false, message: /secure/ })
    expect(checkFeedUrl('file:///etc/passwd')).toMatchObject({ ok: false })
    expect(checkFeedUrl('javascript:alert(1)')).toMatchObject({ ok: false })
    expect(checkFeedUrl('calendar.google.com/calendar/ical/x/basic.ics')).toMatchObject({
      ok: false,
      message: /full link/,
    })
    expect(checkFeedUrl('')).toMatchObject({ ok: false })
  })

  it('allows plain http only to this computer, and only in tests', () => {
    expect(checkFeedUrl('http://127.0.0.1:5555/cal.ics')).toMatchObject({ ok: false })
    expect(checkFeedUrl('http://127.0.0.1:5555/cal.ics', { allowLoopback: true })).toMatchObject({ ok: true })
    expect(checkFeedUrl('http://localhost/cal.ics', { allowLoopback: true })).toMatchObject({ ok: true })
    expect(checkFeedUrl('http://192.168.1.10/cal.ics', { allowLoopback: true })).toMatchObject({ ok: false })
  })
})

describe('describeIcs', () => {
  it("reads the calendar's name, colour and number of events", () => {
    expect(describeIcs(ICS)).toEqual({ name: 'Work', color: '#1badf8', events: 2 })
  })

  it("returns null for things that aren't calendars", () => {
    expect(describeIcs('<!doctype html><title>Sign in</title>')).toBeNull()
    expect(describeIcs('BEGIN:VCALENDAR\r\nnot really')).toBeNull()
    expect(describeIcs('')).toBeNull()
  })
})

describe('fetchFeed', () => {
  it('follows a redirect to another https link', async () => {
    const f = fakeFetch({
      'https://a.test/cal': () =>
        new Response(null, { status: 302, headers: { location: 'https://b.test/c.ics' } }),
      'https://b.test/c.ics': () => new Response(ICS),
    })
    await expect(fetchFeed('https://a.test/cal', { fetch: f })).resolves.toBe(ICS)
    expect(f.calls).toEqual(['https://a.test/cal', 'https://b.test/c.ics'])
  })

  it("won't follow a redirect to plain http", async () => {
    const f = fakeFetch({
      'https://a.test/cal': () =>
        new Response(null, { status: 301, headers: { location: 'http://10.0.0.1/c.ics' } }),
    })
    await expect(fetchFeed('https://a.test/cal', { fetch: f })).rejects.toMatchObject({ kind: 'url' })
  })

  it('checks every redirect hop with the same rules as the first link', async () => {
    const refuse = (u: string) => (new URL(u).hostname === '10.0.0.1' ? 'IP address' : null)
    const f = fakeFetch({
      'https://a.test/cal': () =>
        new Response(null, { status: 302, headers: { location: 'https://10.0.0.1/admin' } }),
    })
    await expect(fetchFeed('https://a.test/cal', { fetch: f, refuse })).rejects.toMatchObject({ kind: 'url' })
    expect(f.calls).toEqual(['https://a.test/cal'])
    await expect(fetchFeed('https://10.0.0.1/cal.ics', { fetch: f, refuse })).rejects.toMatchObject({
      kind: 'url',
      message: /only subscribes to calendars on the internet/,
    })
  })

  it('explains a name that turns out to point at the local network', async () => {
    const blocked = Object.assign(new Error('a.test points to 192.168.1.1'), { name: 'BlockedAddressError' })
    const f = (async () => {
      throw new TypeError('fetch failed', { cause: blocked })
    }) as typeof fetch
    await expect(fetchFeed('https://a.test/cal', { fetch: f })).rejects.toMatchObject({
      kind: 'url',
      message: /not on this computer or your local network/,
    })
  })

  it('explains refused, missing and unreachable links', async () => {
    const f = fakeFetch({
      'https://a.test/401': () => new Response('no', { status: 401 }),
      'https://a.test/404': () => new Response('no', { status: 404 }),
      'https://a.test/500': () => new Response('no', { status: 500 }),
    })
    await expect(fetchFeed('https://a.test/401', { fetch: f })).rejects.toMatchObject({ kind: 'denied' })
    await expect(fetchFeed('https://a.test/404', { fetch: f })).rejects.toMatchObject({ kind: 'not-found' })
    await expect(fetchFeed('https://a.test/500', { fetch: f })).rejects.toMatchObject({ kind: 'network' })
    await expect(fetchFeed('https://a.test/gone', { fetch: f })).rejects.toBeInstanceOf(FeedError)
  })

  it('gives up on a feed bigger than the limit', async () => {
    const f = fakeFetch({ 'https://a.test/big': () => new Response('x'.repeat(2000)) })
    await expect(fetchFeed('https://a.test/big', { fetch: f, maxBytes: 1000 })).rejects.toMatchObject({
      kind: 'too-large',
    })
  })
})

describe('FeedProvider', () => {
  it('serves links and files as read-only calendars, with events expanded', async () => {
    const f = fakeFetch({ 'https://a.test/work.ics': () => new Response(ICS) })
    const p = new FeedProvider(
      [
        { id: 'feed:1', kind: 'link', name: 'Work', url: 'https://a.test/work.ics', color: '#1badf8' },
        { id: 'feed:2', kind: 'file', name: 'Imported', ics: ICS },
      ],
      { fetch: f },
    )
    const cals = await p.listCalendars()
    expect(cals.map((c) => [c.id, c.readOnly, c.version === undefined])).toEqual([
      ['feed:1', true, true],
      ['feed:2', true, false],
    ])
    const events = await p.fetchEvents('feed:1', week)
    expect(events.filter((e) => e.title === 'Standup')).toHaveLength(5)
    expect(events.find((e) => e.title === 'Team offsite')).toMatchObject({
      allDay: true,
      calendarId: 'feed:1',
    })
    expect(await p.fetchEvents('feed:2', week)).toHaveLength(6)
  })

  it('says so when a link stops returning a calendar', async () => {
    const f = fakeFetch({ 'https://a.test/work.ics': () => new Response('<html>Sign in</html>') })
    const p = new FeedProvider(
      [{ id: 'feed:1', kind: 'link', name: 'Work', url: 'https://a.test/work.ics' }],
      {
        fetch: f,
      },
    )
    await expect(p.fetchEvents('feed:1', week)).rejects.toMatchObject({
      kind: 'not-calendar',
      message: /Work didn’t return a calendar/,
    })
  })
})
