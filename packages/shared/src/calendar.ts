import { z } from 'zod'
import type {
  CalendarEvent,
  CalendarInfo,
  CalendarSyncProgress,
  CalendarSyncResult,
  DateRange,
} from '@ordo/calendar-core'

export type { CalendarEvent, CalendarInfo, CalendarSyncProgress, DateRange }

/** A calendar in the sidebar list, with the user's choice of whether to show it. */
export interface CalendarListItem extends CalendarInfo {
  visible: boolean
}

/** Calendar uses the same iCloud account as Mail: connected means an account is saved. */
export type CalendarStatus =
  { connected: false } | { connected: true; email: string; lastSync: string | null; syncing: boolean }

export type CalendarSyncError = 'auth' | 'network' | 'busy' | 'unknown'
export type CalendarSyncOutcome =
  ({ ok: true } & CalendarSyncResult) | { ok: false; error: CalendarSyncError; message: string }

export const DateRangeSchema = z.object({ start: z.date(), end: z.date() }).refine((r) => r.start < r.end, {
  message: 'start must be before end',
})

export const SetVisibleSchema = z.object({ calendarId: z.string().min(1), visible: z.boolean() })
export type SetVisibleInput = z.infer<typeof SetVisibleSchema>

/**
 * Something another module wants shown on the calendar without being a calendar event,
 * such as a bill due date or a subscription renewal from Money. Rendered distinctly.
 */
export interface CalendarOverlayItem {
  id: string
  /** The day it falls on (local midnight). */
  date: Date
  title: string
  kind: 'bill' | 'renewal' | 'trial'
  amount?: { value: number; currency: string }
}

export interface CalendarApi {
  status(): Promise<CalendarStatus>
  /** Fetch calendars changed since the last sync (or all of them with `force`). */
  sync(options?: { force?: boolean }): Promise<CalendarSyncOutcome>
  /** Subscribe to sync progress; returns an unsubscribe function. */
  onSyncProgress(listener: (p: CalendarSyncProgress) => void): () => void
  calendars(): Promise<CalendarListItem[]>
  /** Cached occurrences overlapping the range, from visible calendars only. */
  events(range: DateRange): Promise<CalendarEvent[]>
  setVisible(input: SetVisibleInput): Promise<void>
}

export const CALENDAR_IPC = {
  calendarStatus: 'calendar:status',
  calendarSync: 'calendar:sync',
  calendarSyncProgress: 'calendar:sync-progress',
  calendarList: 'calendar:list',
  calendarEvents: 'calendar:events',
  calendarSetVisible: 'calendar:set-visible',
} as const
