import { DAVClient, type DAVCalendar } from 'tsdav'
import { parseIcs } from './ics'
import type { CalendarEvent, CalendarProvider, DateRange, RemoteCalendar } from './types'

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

/** Read-only CalDAV provider. With iCloud, sign in with the Apple ID email and an app-specific password. */
export class CalDavProvider implements CalendarProvider {
  private client: DAVClient
  private known = new Map<string, DAVCalendar>()

  constructor(config: CalDavConfig) {
    const timeout = config.timeoutMs ?? 30_000
    this.client = new DAVClient({
      serverUrl: config.serverUrl,
      credentials: { username: config.username, password: config.password },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
      fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeout) }),
    })
  }

  async connect(): Promise<void> {
    await this.call(() => this.client.login())
  }

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
    if (!this.known.has(calendarId)) await this.listCalendars()
    const calendar = this.known.get(calendarId)
    if (!calendar) throw new Error(`Unknown calendar ${calendarId}`)
    const objects = await this.call(() =>
      this.client.fetchCalendarObjects({
        calendar,
        timeRange: { start: range.start.toISOString(), end: range.end.toISOString() },
      }),
    )
    return objects.flatMap((o) => {
      if (typeof o.data !== 'string') return []
      try {
        return parseIcs(o.data, { calendarId, range })
      } catch {
        // One malformed event shouldn't hide the rest of the calendar.
        return []
      }
    })
  }

  async close(): Promise<void> {
    // CalDAV is plain HTTP: there's no connection to close.
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      throw classify(err)
    }
  }
}

function classify(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  if (/\b401\b|Invalid credentials|Unauthorized/i.test(message)) return new CalendarAuthError(message)
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
