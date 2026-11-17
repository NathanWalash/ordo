/** A calendar the account can see, e.g. "Home" or "Work". */
export interface CalendarInfo {
  /** Stable id from the provider (for CalDAV, the calendar collection URL). */
  id: string
  name: string
  /** CSS colour, normalised to `#rrggbb`. */
  color?: string
  readOnly: boolean
}

/** A calendar as listed by a provider, with a token that changes whenever its contents do. */
export interface RemoteCalendar extends CalendarInfo {
  /** CalDAV `getctag` (or sync-token). Unchanged version means unchanged events. */
  version?: string
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

/** Anything that can serve calendars: iCloud CalDAV first, Google or Outlook later. */
export interface CalendarProvider {
  connect(): Promise<void>
  listCalendars(): Promise<RemoteCalendar[]>
  /** Every occurrence overlapping `range`, with recurring events expanded. */
  fetchEvents(calendarId: string, range: DateRange): Promise<CalendarEvent[]>
  close(): Promise<void>
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
}
