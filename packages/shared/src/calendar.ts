import { z } from 'zod'
import type {
  CalendarEvent,
  CalendarInfo,
  CalendarSource,
  CalendarSyncProgress,
  CalendarSyncResult,
  DateRange,
} from '@ordo/calendar-core'

export type { CalendarEvent, CalendarInfo, CalendarSource, CalendarSyncProgress, DateRange }

/** A calendar in the sidebar list, with the user's choice of whether to show it. */
export interface CalendarListItem extends CalendarInfo {
  visible: boolean
}

/**
 * Calendar uses the same iCloud account as Mail: connected means an account is saved.
 * `subscriptions` counts calendars added by link or file, which work without iCloud.
 */
export type CalendarStatus = { lastSync: string | null; syncing: boolean; subscriptions: number } & (
  { connected: false } | { connected: true; email: string }
)

/** `busy`: already syncing in this process; `locked`: another Ordo process is writing. */
export type CalendarSyncError = 'auth' | 'network' | 'busy' | 'locked' | 'unknown'
export type CalendarSyncOutcome =
  ({ ok: true } & CalendarSyncResult) | { ok: false; error: CalendarSyncError; message: string }

export const DateRangeSchema = z.object({ start: z.date(), end: z.date() }).refine((r) => r.start < r.end, {
  message: 'start must be before end',
})

export const AddCalendarLinkSchema = z.object({ url: z.string().trim().min(1).max(4096) })
export type AddCalendarLinkInput = z.infer<typeof AddCalendarLinkSchema>

export type AddCalendarError =
  | 'url'
  | 'denied'
  | 'not-found'
  | 'network'
  | 'not-calendar'
  | 'too-large'
  | 'duplicate'
  | 'storage'
  | 'locked'
export type AddCalendarOutcome =
  { ok: true; calendar: CalendarListItem } | { ok: false; error: AddCalendarError; message: string }

export const SetVisibleSchema = z.object({ calendarId: z.string().min(1), visible: z.boolean() })
export type SetVisibleInput = z.infer<typeof SetVisibleSchema>

/**
 * Something another module wants shown on the calendar without being a calendar event,
 * such as a bill due date or a subscription renewal from Money. Rendered distinctly.
 */
export interface CalendarOverlayItem {
  id: string
  /** The day it falls on (local midnight), or the first day of a range. */
  date: Date
  /** The last day of a range (local midnight, inclusive). Absent for a single day. */
  until?: Date
  title: string
  kind: 'bill' | 'renewal' | 'trial' | 'card'
  amount?: { value: number; currency: string }
  /** A second line for the popover, e.g. the board a card is on. */
  detail?: string
  /** An app route that shows the item where it came from, e.g. `boards?card=…`. */
  route?: string
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
  /** Subscribe to a calendar by its link (https:// or webcal://), e.g. Google's secret iCal address. */
  addLink(input: AddCalendarLinkInput): Promise<AddCalendarOutcome>
  /** Pick an .ics file and add it as a calendar; null if the picker was cancelled. */
  importFile(): Promise<AddCalendarOutcome | null>
  /** Remove a calendar added by link or file. iCloud calendars can't be removed here. */
  remove(calendarId: string): Promise<{ ok: true } | { ok: false; message: string }>
}

export const CALENDAR_IPC = {
  calendarStatus: 'calendar:status',
  calendarSync: 'calendar:sync',
  calendarSyncProgress: 'calendar:sync-progress',
  calendarList: 'calendar:list',
  calendarEvents: 'calendar:events',
  calendarSetVisible: 'calendar:set-visible',
  calendarAddLink: 'calendar:add-link',
  calendarImportFile: 'calendar:import-file',
  calendarRemove: 'calendar:remove',
} as const
