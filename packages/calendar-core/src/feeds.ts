// Calendars you subscribe to by link (Google's "Secret address in iCal format", Outlook's
// published ICS link, webcal:// feeds) or import once from an .ics file. Read-only.

import { createHash } from 'node:crypto'
import ICAL from 'ical.js'
import { normaliseColor } from './caldav'
import { parseIcs } from './ics'
import type { CalendarEvent, CalendarProvider, DateRange, RemoteCalendar } from './types'

/** Feeds bigger than this are refused. Years of a busy work calendar are a few MB. */
export const FEED_MAX_BYTES = 20 * 1024 * 1024
const MAX_REDIRECTS = 5

export type FeedKind = 'link' | 'file'

/** A subscribed or imported calendar. `url` for links, `ics` for files. */
export interface Feed {
  id: string
  kind: FeedKind
  name: string
  color?: string
  url?: string
  ics?: string
}

export type FeedErrorKind = 'url' | 'denied' | 'not-found' | 'network' | 'not-calendar' | 'too-large'

export class FeedError extends Error {
  override name = 'FeedError'
  constructor(
    readonly kind: FeedErrorKind,
    message: string,
  ) {
    super(message)
  }
}

export type FeedUrlCheck = { ok: true; url: string; host: string } | { ok: false; message: string }

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Turn what someone pasted into a URL Ordo will fetch: `webcal://` becomes `https://`, and only
 * https is allowed (plain http only to this computer, for tests). The link is often a secret
 * (anyone with it can read the calendar), so it must not travel unencrypted.
 */
export function checkFeedUrl(input: string): FeedUrlCheck {
  const raw = input.trim().replace(/^webcals?:\/\//i, 'https://')
  if (!raw) return { ok: false, message: 'Paste the calendar’s link.' }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw))
    return { ok: false, message: 'Paste the full link, starting with https:// or webcal://.' }
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { ok: false, message: 'That doesn’t look like a link.' }
  }
  if (u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname)))
    return { ok: true, url: u.href, host: u.host }
  if (u.protocol === 'http:')
    return { ok: false, message: 'Ordo only subscribes over a secure link (https:// or webcal://).' }
  return { ok: false, message: 'That isn’t a calendar link. It should start with https:// or webcal://.' }
}

/** Name, colour and number of events of an .ics document, or null if it isn't a calendar. */
export function describeIcs(text: string): { name?: string; color?: string; events: number } | null {
  if (!/BEGIN:VCALENDAR/i.test(text.slice(0, 4096))) return null
  try {
    const jcal = ICAL.parse(text)
    const roots = (Array.isArray(jcal[0]) ? jcal : [jcal]) as unknown[]
    const cals = roots.map((r) => new ICAL.Component(r as never)).filter((c) => c.name === 'vcalendar')
    const first = cals[0]
    if (!first) return null
    const prop = (name: string) => {
      const v = first.getFirstPropertyValue(name)
      return typeof v === 'string' && v.trim() ? v.trim() : undefined
    }
    return {
      name: prop('x-wr-calname') ?? prop('name'),
      color: normaliseColor(prop('x-apple-calendar-color') ?? prop('color')),
      events: cals.reduce((n, c) => n + c.getAllSubcomponents('vevent').length, 0),
    }
  } catch {
    return null
  }
}

export interface FetchFeedOptions {
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
  fetch?: typeof fetch
}

/**
 * Download a feed. Follows up to five redirects, each of which must pass checkFeedUrl too,
 * and gives up past `maxBytes`. Errors are FeedErrors with a message for people.
 */
export async function fetchFeed(start: string, opts: FetchFeedOptions = {}): Promise<string> {
  const first = checkFeedUrl(start)
  if (!first.ok) throw new FeedError('url', first.message)
  const doFetch = opts.fetch ?? fetch
  const maxBytes = opts.maxBytes ?? FEED_MAX_BYTES
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 30_000)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
  let url = first.url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response
    try {
      res = await doFetch(url, {
        redirect: 'manual',
        signal,
        headers: { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1' },
      })
    } catch (err) {
      if (opts.signal?.aborted) throw err
      throw new FeedError('network', 'Couldn’t reach that calendar. Check your internet connection.')
    }
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      const next = checkFeedUrl(new URL(location, url).href)
      if (!next.ok) throw new FeedError('url', 'That calendar link redirects somewhere Ordo won’t follow.')
      url = next.url
      continue
    }
    if (res.status === 401 || res.status === 403)
      throw new FeedError('denied', 'That calendar link was refused. It may have been reset or made private.')
    if (res.status === 404 || res.status === 410)
      throw new FeedError('not-found', 'Nothing was found at that link. It may have been reset.')
    if (!res.ok)
      throw new FeedError('network', `The calendar’s server answered with an error (${res.status}).`)
    return readLimited(res, maxBytes)
  }
  throw new FeedError('url', 'That calendar link redirects too many times.')
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  const tooBig = () => new FeedError('too-large', 'That calendar is too big for Ordo to read.')
  if (Number(res.headers.get('content-length') ?? 0) > maxBytes) throw tooBig()
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel().catch(() => {})
      throw tooBig()
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

/** Serves subscribed links and imported files through the same sync as iCloud. */
export class FeedProvider implements CalendarProvider {
  constructor(
    private readonly feeds: Feed[],
    private readonly opts: Omit<FetchFeedOptions, 'maxBytes'> = {},
  ) {}

  async connect(): Promise<void> {}

  async listCalendars(): Promise<RemoteCalendar[]> {
    return this.feeds.map((f) => ({
      id: f.id,
      name: f.name,
      color: f.color,
      readOnly: true,
      // A file never changes, so it's only expanded again when the window moves. Links are
      // always fetched: many servers don't send a reliable ETag.
      version:
        f.kind === 'file'
          ? createHash('sha256')
              .update(f.ics ?? '')
              .digest('hex')
          : undefined,
    }))
  }

  async fetchEvents(calendarId: string, range: DateRange): Promise<CalendarEvent[]> {
    const feed = this.feeds.find((f) => f.id === calendarId)
    if (!feed) throw new Error(`Unknown calendar ${calendarId}`)
    if (feed.kind === 'link' && !feed.url)
      throw new FeedError(
        'url',
        `Ordo can’t read the saved link for ${feed.name}. Remove it and add it again.`,
      )
    const text = feed.kind === 'file' ? (feed.ics ?? '') : await fetchFeed(feed.url!, this.opts)
    if (!describeIcs(text))
      throw new FeedError('not-calendar', `${feed.name} didn’t return a calendar. The link may have changed.`)
    return parseIcs(text, { calendarId, range })
  }

  async close(): Promise<void> {}
}
