/**
 * Where a calendar comes from: the iCloud account, a connected Google account, a subscribed link
 * or an imported .ics file.
 */
export type CalendarSource = 'icloud' | 'google' | 'link' | 'file'

/** A calendar the account can see, e.g. "Home" or "Work". */
export interface CalendarInfo {
  /** Stable id from the provider (for CalDAV, the calendar collection URL). */
  id: string
  name: string
  /** CSS colour, normalised to `#rrggbb`. */
  color?: string
  readOnly: boolean
  /** Set on calendars read from the cache. */
  source?: CalendarSource
}

/** A calendar as listed by a provider, with a token that changes whenever its contents do. */
export interface RemoteCalendar extends CalendarInfo {
  /** CalDAV `getctag` (or sync-token). Unchanged version means unchanged events. */
  version?: string
  /** Whether to show it when it's first seen (Google's own "selected" choice). Later, the user's choice wins. */
  visible?: boolean
}

/**
 * One occurrence of an event. Recurring events are expanded, so each occurrence is
 * its own CalendarEvent with the same `uid` and a distinct `recurrenceId`.
 */
export interface CalendarEvent {
  uid: string
  calendarId: string
  title: string
  /**
   * Timed events: the exact instant. All-day events: local midnight of the first day,
   * and `end` is local midnight of the day after the last day (exclusive), as in iCalendar.
   */
  start: Date
  end: Date
  allDay: boolean
  location?: string
  notes?: string
  /**
   * Set on occurrences of a recurring event: the original start of this occurrence,
   * as an ISO instant (timed) or `YYYY-MM-DD` (all-day).
   */
  recurrenceId?: string
}

/** Half-open time range `[start, end)`. */
export interface DateRange {
  start: Date
  end: Date
}

/** One CalDAV object: an event (with its overrides) as the server stores it. */
export interface CalendarResource {
  /** The object's URL. */
  href: string
  /** The server's version tag, sent back as If-Match so a change made elsewhere isn't overwritten. */
  etag?: string
  uid: string
  ics: string
}

/** Anything that can serve calendars: iCloud CalDAV first, Google or Outlook later. */
export interface CalendarProvider {
  connect(): Promise<void>
  listCalendars(): Promise<RemoteCalendar[]>
  /** Every occurrence overlapping `range`, with recurring events expanded. */
  fetchEvents(calendarId: string, range: DateRange): Promise<CalendarEvent[]>
  /**
   * Providers whose calendars can be changed also give the resources the events came from,
   * so they're cached for editing.
   */
  fetchResources?(
    calendarId: string,
    range: DateRange,
  ): Promise<{ events: CalendarEvent[]; resources: CalendarResource[] }>
  close(): Promise<void>
}

/** A provider Ordo can write events to (CalDAV). Every method throws CalendarWriteError on refusal. */
export interface WritableCalendarProvider {
  fetchResources(
    calendarId: string,
    range: DateRange,
  ): Promise<{ events: CalendarEvent[]; resources: CalendarResource[] }>
  /** One resource as the server has it now, or null if it's gone. */
  fetchResource(calendarId: string, href: string): Promise<CalendarResource | null>
  /** Add a new resource. Fails with `conflict` if one already exists at that name. */
  createResource(calendarId: string, uid: string, ics: string): Promise<{ href: string; etag?: string }>
  /** Replace a resource, only if it still has `etag`. */
  updateResource(calendarId: string, href: string, ics: string, etag?: string): Promise<{ etag?: string }>
  /** Delete a resource, only if it still has `etag`. */
  deleteResource(calendarId: string, href: string, etag?: string): Promise<void>
}

export interface CalendarSyncProgress {
  /** Calendars finished so far. */
  done: number
  total: number
  /** Name of the calendar being fetched, if any. */
  current?: string
}

export interface CalendarSyncResult {
  calendars: number
  /** Calendars whose events were fetched. */
  fetched: number
  /** Calendars skipped because their version had not changed. */
  skipped: number
  events: number
  stopped: boolean
  /** Calendars that couldn't be fetched this time, when the sync carried on without them. */
  failed?: { calendarId: string; name: string; message: string }[]
}
