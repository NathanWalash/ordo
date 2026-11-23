import { z } from 'zod'
import { checkDraft, DRAFT_LIMITS, REPEAT_FREQUENCIES } from '@ordo/calendar-core'
import type {
  CalendarEvent,
  CalendarInfo,
  CalendarSource,
  CalendarSyncProgress,
  CalendarSyncResult,
  DateRange,
  EditScope,
  EventDraft,
  RepeatRule,
} from '@ordo/calendar-core'

export type {
  CalendarEvent,
  CalendarInfo,
  CalendarSource,
  CalendarSyncProgress,
  DateRange,
  EditScope,
  EventDraft,
  RepeatRule,
}

/** A calendar in the sidebar list, with the user's choice of whether to show it. */
export interface CalendarListItem extends CalendarInfo {
  visible: boolean
  /** For a Google calendar: the account it's in. */
  account?: string
  /** For a Google calendar: when it last synced (ISO), and why the last try failed, if it did. */
  syncedAt?: string
  syncError?: string
}

/**
 * Calendar uses the same iCloud account as Mail: connected means an account is saved.
 * `subscriptions` counts calendars added by link or file, which work without iCloud.
 */
export type CalendarStatus = {
  lastSync: string | null
  syncing: boolean
  subscriptions: number
  /** Google accounts connected for Calendar. */
  google?: number
} & ({ connected: false } | { connected: true; email: string })

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

// ---- Creating and changing events ------------------------------------------------------------

/** A new or changed event, checked with the same rules everywhere (see `checkDraft`). */
export const EventDraftSchema = z
  .strictObject({
    title: z.string().max(DRAFT_LIMITS.title),
    allDay: z.boolean(),
    start: z.string().max(16),
    end: z.string().max(16),
    timeZone: z.string().max(64).nullable(),
    location: z.string().max(DRAFT_LIMITS.location),
    notes: z.string().max(DRAFT_LIMITS.notes),
    repeat: z
      .strictObject({
        frequency: z.enum(REPEAT_FREQUENCIES as [RepeatRule['frequency'], ...RepeatRule['frequency'][]]),
        until: z.string().max(10).optional(),
        count: z.number().int().min(1).max(DRAFT_LIMITS.count).optional(),
        custom: z.boolean().optional(),
      })
      .nullable(),
    alert: z.number().int().min(DRAFT_LIMITS.alertMin).max(DRAFT_LIMITS.alertMax).nullable(),
  })
  .superRefine((d, ctx) => {
    const problem = checkDraft(d as EventDraft)
    if (problem) ctx.addIssue({ code: 'custom', message: problem })
  })

/** An event, or one occurrence of a repeating one, as the views list it. */
export const EventRefSchema = z.strictObject({
  calendarId: z.string().min(1).max(2048),
  uid: z.string().min(1).max(1024),
  recurrenceId: z.string().min(1).max(40).optional(),
})
export type EventRef = z.infer<typeof EventRefSchema>

const scope = z.enum(['this', 'all'])

export const CreateEventSchema = z.strictObject({
  calendarId: z.string().min(1).max(2048),
  draft: EventDraftSchema,
})
export type CreateEventInput = z.infer<typeof CreateEventSchema>
export const UpdateEventSchema = z.strictObject({ ref: EventRefSchema, draft: EventDraftSchema, scope })
export type UpdateEventInput = z.infer<typeof UpdateEventSchema>
export const DeleteEventSchema = z.strictObject({ ref: EventRefSchema, scope })
export type DeleteEventInput = z.infer<typeof DeleteEventSchema>

/** What the editor needs about an event, and whether Ordo can change it (`reason` says why not). */
export interface EventDetails {
  calendarId: string
  draft: EventDraft
  recurring: boolean
  editable: boolean
  reason?: string
}

/**
 * Why a change wasn't made. `conflict`: it changed somewhere else first (Ordo now shows that
 * version). `invitation`: someone else's event. `locked`: another Ordo process is writing.
 */
export type CalendarChangeError =
  | 'invalid'
  | 'not-found'
  | 'read-only'
  | 'invitation'
  | 'conflict'
  | 'not-connected'
  | 'auth'
  | 'network'
  | 'locked'
  | 'unknown'
export type CalendarChangeOutcome =
  { ok: true; uid: string } | { ok: false; error: CalendarChangeError; message: string }

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
  /** Calendars changed in the background (a Google sync); returns an unsubscribe function. */
  onChanged(listener: () => void): () => void
  calendars(): Promise<CalendarListItem[]>
  /** Cached occurrences overlapping the range, from visible calendars only. */
  events(range: DateRange): Promise<CalendarEvent[]>
  setVisible(input: SetVisibleInput): Promise<void>
  /** Subscribe to a calendar by its link (https:// or webcal://), e.g. Google's secret iCal address. */
  addLink(input: AddCalendarLinkInput): Promise<AddCalendarOutcome>
  /** Pick an .ics file and add it as a calendar; null if the picker was cancelled. */
  importFile(): Promise<AddCalendarOutcome | null>
  /** Remove a calendar added by link or file. iCloud and Google calendars can't be removed here. */
  remove(calendarId: string): Promise<{ ok: true } | { ok: false; message: string }>
  /** An event's details for the editor, or null if it isn't cached (or its calendar is read-only). */
  details(ref: EventRef): Promise<EventDetails | null>
  /** Add an event to a writable iCloud or Google calendar. */
  createEvent(input: CreateEventInput): Promise<CalendarChangeOutcome>
  /** Change an event: one occurrence (`this`) or all of a repeating event. */
  updateEvent(input: UpdateEventInput): Promise<CalendarChangeOutcome>
  /** Delete an event: one occurrence (`this`) or all of a repeating event. */
  deleteEvent(input: DeleteEventInput): Promise<CalendarChangeOutcome>
}

export const CALENDAR_IPC = {
  calendarStatus: 'calendar:status',
  calendarSync: 'calendar:sync',
  calendarSyncProgress: 'calendar:sync-progress',
  calendarChanged: 'calendar:changed',
  calendarList: 'calendar:list',
  calendarEvents: 'calendar:events',
  calendarSetVisible: 'calendar:set-visible',
  calendarAddLink: 'calendar:add-link',
  calendarImportFile: 'calendar:import-file',
  calendarRemove: 'calendar:remove',
  calendarDetails: 'calendar:event-details',
  calendarCreateEvent: 'calendar:create-event',
  calendarUpdateEvent: 'calendar:update-event',
  calendarDeleteEvent: 'calendar:delete-event',
} as const
