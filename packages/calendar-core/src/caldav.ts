import { DAVClient, type DAVCalendar } from 'tsdav'
import { parseIcs } from './ics'
import type {
  CalendarEvent,
  CalendarProvider,
  CalendarResource,
  DateRange,
  RemoteCalendar,
  WritableCalendarProvider,
} from './types'
import { firstUid } from './write'

export const ICLOUD_CALDAV_URL = 'https://caldav.icloud.com'

export interface CalDavConfig {
  serverUrl: string
  username: string
  password: string
  /** Per-request timeout. */
  timeoutMs?: number
}

export class CalendarAuthError extends Error {
  override name = 'CalendarAuthError'
}
export class CalendarConnectionError extends Error {
  override name = 'CalendarConnectionError'
}
/** The server answered, but is busy, limiting requests or down for now (HTTP 429, 502, 503, 504). */
export class CalendarUnavailableError extends CalendarConnectionError {
  override name = 'CalendarUnavailableError'
  /** How long the server asked Ordo to wait before trying again (Retry-After), if it said. */
  retryAfterMs?: number
}

/**
 * The server refused a change. `conflict`: the event changed since Ordo last fetched it (HTTP 412).
 * `gone`: it was deleted (404/410). `forbidden`: the calendar can't be written to (403).
 */
export class CalendarWriteError extends Error {
  override name = 'CalendarWriteError'
  constructor(
    readonly kind: 'conflict' | 'gone' | 'forbidden' | 'failed',
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

/**
 * CalDAV provider. With iCloud, sign in with the Apple ID email and an app-specific password.
 * Changes are conditional on the ETag Ordo last saw, so a change made elsewhere is never
 * overwritten without anyone knowing.
 */
export class CalDavProvider implements CalendarProvider, WritableCalendarProvider {
  private client: DAVClient
  private known = new Map<string, DAVCalendar>()

  constructor(config: CalDavConfig) {
    const timeout = config.timeoutMs ?? 30_000
    this.client = new DAVClient({
      serverUrl: config.serverUrl,
      credentials: { username: config.username, password: config.password },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
      fetch: async (input, init) => {
        const res = await fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeout) })
        // tsdav often reports a refused request as "cannot find principalUrl": remember why. Only
        // statuses that explain a failure count (discovery tolerates redirects, 400 and 405 from
        // .well-known), and a busy server outranks a refusal.
        if (severity(res.status) > severity(this.failedStatus)) this.failedStatus = res.status
        return res
      },
    })
  }

  /** The most telling HTTP error status in the current call, if any. */
  private failedStatus: number | null = null

  async connect(): Promise<void> {
    await this.call(() => this.client.login())
    this.loggedIn = true
  }

  /** Changes don't need the account's calendar list; fetching does, so sign in first if needed. */
  private loggedIn = false

  async listCalendars(): Promise<RemoteCalendar[]> {
    const calendars = await this.call(() =>
      this.client.fetchCalendars({
        props: {
          'd:displayname': {},
          'ca:calendar-color': {},
          'cs:getctag': {},
          'd:sync-token': {},
          'd:resourcetype': {},
          'c:supported-calendar-component-set': {},
          'd:current-user-privilege-set': {},
        },
        projectedProps: { currentUserPrivilegeSet: true },
      }),
    )
    // Reminders lists are calendars too, but only hold VTODOs.
    const withEvents = calendars.filter((c) => !c.components?.length || c.components.includes('VEVENT'))
    this.known = new Map(withEvents.map((c) => [c.url, c]))
    return withEvents.map((c) => ({
      id: c.url,
      name: (typeof c.displayName === 'string' && c.displayName.trim()) || 'Calendar',
      color: normaliseColor(c.calendarColor),
      readOnly: isReadOnly(c.projectedProps?.['currentUserPrivilegeSet']),
      version: c.ctag || c.syncToken || undefined,
    }))
  }

  async fetchEvents(calendarId: string, range: DateRange): Promise<CalendarEvent[]> {
    return (await this.fetchResources(calendarId, range)).events
  }

  async fetchResources(
    calendarId: string,
    range: DateRange,
  ): Promise<{ events: CalendarEvent[]; resources: CalendarResource[] }> {
    if (!this.known.has(calendarId)) {
      if (!this.loggedIn) await this.connect()
      await this.listCalendars()
    }
    const calendar = this.known.get(calendarId)
    if (!calendar) throw new Error(`Unknown calendar ${calendarId}`)
    const objects = await this.call(() =>
      this.client.fetchCalendarObjects({
        calendar,
        timeRange: { start: range.start.toISOString(), end: range.end.toISOString() },
      }),
    )
    const events: CalendarEvent[] = []
    const resources: CalendarResource[] = []
    for (const o of objects) {
      if (typeof o.data !== 'string') continue
      try {
        events.push(...parseIcs(o.data, { calendarId, range }))
      } catch {
        // One malformed event shouldn't hide the rest of the calendar.
        continue
      }
      const uid = firstUid(o.data)
      if (uid && inside(calendarId, o.url))
        resources.push({ href: o.url, etag: o.etag || undefined, uid, ics: o.data })
    }
    return { events, resources }
  }

  async fetchResource(calendarId: string, href: string): Promise<CalendarResource | null> {
    if (!inside(calendarId, href)) throw outside()
    let objects
    try {
      objects = await this.call(() =>
        this.client.fetchCalendarObjects({
          calendar: { url: calendarId } as DAVCalendar,
          objectUrls: [href],
        }),
      )
    } catch (err) {
      // tsdav throws when the server says the object isn't there (a 404 in the multistatus, or
      // an incomplete answer): that's "gone". A wrong password or no connection still fails.
      if (err instanceof CalendarAuthError || err instanceof CalendarConnectionError) throw err
      return null
    }
    const o = objects[0]
    const uid = typeof o?.data === 'string' ? firstUid(o.data) : null
    return o && uid ? { href, etag: o.etag || undefined, uid, ics: o.data as string } : null
  }

  async createResource(
    calendarId: string,
    uid: string,
    ics: string,
  ): Promise<{ href: string; etag?: string }> {
    const filename = `${uid.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200)}.ics`
    const res = await this.call(() =>
      this.client.createCalendarObject({
        calendar: { url: calendarId } as DAVCalendar,
        filename,
        iCalString: ics,
      }),
    )
    checkWrite(res)
    return { href: new URL(filename, withSlash(calendarId)).href, etag: res.headers.get('etag') ?? undefined }
  }

  async updateResource(
    calendarId: string,
    href: string,
    ics: string,
    etag?: string,
  ): Promise<{ etag?: string }> {
    if (!inside(calendarId, href)) throw outside()
    const res = await this.call(() =>
      this.client.updateCalendarObject({ calendarObject: { url: href, data: ics, etag } }),
    )
    checkWrite(res)
    return { etag: res.headers.get('etag') ?? undefined }
  }

  async deleteResource(calendarId: string, href: string, etag?: string): Promise<void> {
    if (!inside(calendarId, href)) throw outside()
    const res = await this.call(() =>
      this.client.deleteCalendarObject({ calendarObject: { url: href, etag } }),
    )
    checkWrite(res)
  }

  async close(): Promise<void> {
    // CalDAV is plain HTTP: there's no connection to close.
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    this.failedStatus = null
    try {
      return await fn()
    } catch (err) {
      throw classify(err, this.failedStatus)
    }
  }
}

const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`)

/**
 * Ordo only ever writes to objects inside the calendar they came from: same origin, under the
 * calendar's path. A server can't point a change (and the password with it) anywhere else.
 */
export function inside(calendarId: string, href: string): boolean {
  try {
    const cal = new URL(withSlash(calendarId))
    const obj = new URL(href, cal)
    return (
      obj.origin === cal.origin &&
      obj.pathname.startsWith(cal.pathname) &&
      obj.pathname.length > cal.pathname.length &&
      !obj.pathname.slice(cal.pathname.length).includes('/') &&
      !/(^|\/)\.\.?(\/|$)/.test(decodeURIComponent(obj.pathname))
    )
  } catch {
    return false
  }
}

const outside = () =>
  new CalendarWriteError('failed', 'That event isn’t in the calendar it was listed under.')

function checkWrite(res: Response): void {
  if (res.ok) return
  if (res.status === 412)
    throw new CalendarWriteError('conflict', 'The event was changed somewhere else.', res.status)
  if (res.status === 404 || res.status === 410)
    throw new CalendarWriteError('gone', 'The event was deleted somewhere else.', res.status)
  if (res.status === 401) throw new CalendarAuthError(`${res.status} Unauthorized`)
  if (res.status === 403)
    throw new CalendarWriteError('forbidden', 'The calendar doesn’t allow changes.', res.status)
  // Busy, limiting requests or down for now: nothing was changed, so trying again is safe.
  if (severity(res.status) === 2)
    throw new CalendarUnavailableError(`The calendar server is busy (HTTP ${res.status}).`)
  throw new CalendarWriteError(
    'failed',
    `The calendar server answered with an error (${res.status}).`,
    res.status,
  )
}

/** 2: busy or down (429, 5xx). 1: refused (401, 403). 0: anything else. */
function severity(status: number | null): number {
  if (status === null) return 0
  if (status === 429 || status >= 500) return 2
  return status === 401 || status === 403 ? 1 : 0
}

function classify(err: unknown, status: number | null = null): Error {
  const raw = err instanceof Error ? err.message : String(err)
  const message = status ? `${raw} (HTTP ${status})` : raw
  if (/\b401\b|Invalid credentials|Unauthorized/i.test(message)) return new CalendarAuthError(message)
  if (/\b(429|502|503|504)\b|Too Many Requests|Service Unavailable|Gateway Time-?out/i.test(message))
    return new CalendarUnavailableError(message)
  if (err instanceof TypeError || (err instanceof Error && ['TimeoutError', 'AbortError'].includes(err.name)))
    return new CalendarConnectionError(message)
  return err instanceof Error ? err : new Error(message)
}

/** CalDAV colours come as `#RRGGBB`, `#RRGGBBAA` or `#RGB`; return `#rrggbb`. */
export function normaliseColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const hex = value.trim().replace(/^#/, '')
  if (/^[0-9a-f]{3}$/i.test(hex)) return `#${[...hex].map((c) => c + c).join('')}`.toLowerCase()
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) return `#${hex.slice(0, 6)}`.toLowerCase()
  return undefined
}

/** A calendar is read-only if the server lists the user's privileges and none of them allow writing. */
export function isReadOnly(privileges: unknown): boolean {
  if (!privileges || typeof privileges !== 'object') return false
  const names = new Set<string>()
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === 'object')
      for (const [k, child] of Object.entries(v)) {
        names.add(k)
        walk(child)
      }
  }
  walk(privileges)
  return !['write', 'writeContent', 'bind', 'all'].some((p) => names.has(p))
}
