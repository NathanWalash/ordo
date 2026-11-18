// Pure helpers for creating and changing events in the window: default drafts, what the views
// show while a change is on its way (optimistic), and moving an event by drag or keyboard.
import {
  addWallMinutes,
  dateToWall,
  draftSpan,
  formatDay,
  formatDayTime,
  localZone,
  parseDay,
  parseDayTime,
  previewDraft,
  shiftDays,
  wallMinutes,
  type CalendarEvent,
  type DateRange,
  type EditScope,
  type EventDraft,
} from '@ordo/calendar-core'
import type { CalendarListItem } from '@ordo/shared'

/** Calendars new events can go in: iCloud ones that aren't read-only. */
export const writable = (c: CalendarListItem) => (c.source ?? 'icloud') === 'icloud' && !c.readOnly

/** Why an event on this calendar can't be changed, or null if it can. */
export function readOnlyReason(c: CalendarListItem | undefined): string | null {
  if (!c) return null
  if (c.source === 'link' || c.source === 'file')
    return `${c.source === 'file' ? 'Calendars imported from a file' : 'Calendars added by link'} are read-only in Ordo.`
  if (c.readOnly) return 'This calendar is read-only, so its events can’t be changed here.'
  return null
}

const wallOf = (d: Date) => ({
  year: d.getFullYear(),
  month: d.getMonth() + 1,
  day: d.getDate(),
  hour: d.getHours(),
  minute: d.getMinutes(),
  second: 0,
})

/**
 * A new event's draft. From a day: 09:00 for an hour (today: the next whole hour). From a time
 * slot: that time, for an hour. All-day: just that day.
 */
export function newDraft(at: Date, { allDay = false, exact = false, now = new Date() } = {}): EventDraft {
  const base = { title: '', location: '', notes: '', repeat: null, alert: null }
  if (allDay)
    return { ...base, allDay: true, start: formatDay(wallOf(at)), end: formatDay(wallOf(at)), timeZone: null }
  let start = wallOf(at)
  if (!exact) {
    const today = at.toDateString() === now.toDateString()
    start = { ...start, hour: today ? Math.min(23, now.getHours() + 1) : 9, minute: 0 }
  }
  const end = addWallMinutes(start, 60)
  return {
    ...base,
    allDay: false,
    start: formatDayTime(start),
    end: formatDayTime(end),
    timeZone: localZone(),
  }
}

/** A draft with new start and end instants, written as wall-clock times in the draft's own zone. */
export function moveDraft(d: EventDraft, start: Date, end: Date): EventDraft {
  if (d.allDay) {
    const days = Math.max(0, Math.round((end.getTime() - start.getTime()) / 86_400_000) - 1)
    const first = wallOf(start)
    return { ...d, start: formatDay(first), end: formatDay(shiftDays(first, days)) }
  }
  return {
    ...d,
    start: formatDayTime(dateToWall(start, d.timeZone)),
    end: formatDayTime(dateToWall(end, d.timeZone)),
  }
}

/** In the editor: a new start keeps the event's length. */
export function withStart(d: EventDraft, start: string): EventDraft {
  if (d.allDay) {
    const a = parseDay(d.start)
    const b = parseDay(d.end)
    const s = parseDay(start)
    if (!a || !b || !s) return { ...d, start }
    const days = Math.round(
      (Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000,
    )
    return { ...d, start, end: formatDay(shiftDays(s, Math.max(0, days))) }
  }
  const a = parseDayTime(d.start)
  const b = parseDayTime(d.end)
  const s = parseDayTime(start)
  if (!a || !b || !s) return { ...d, start }
  return { ...d, start, end: formatDayTime(addWallMinutes(s, Math.max(0, wallMinutes(a, b)))) }
}

/** In the editor: turn all-day on or off, keeping the days. */
export function withAllDay(d: EventDraft, allDay: boolean, zone = localZone()): EventDraft {
  if (allDay === d.allDay) return d
  const day = (s: string) => s.slice(0, 10)
  if (allDay) {
    const end = day(d.end) < day(d.start) ? day(d.start) : day(d.end)
    return { ...d, allDay: true, start: day(d.start), end, timeZone: null }
  }
  return { ...d, allDay: false, start: `${day(d.start)}T09:00`, end: `${day(d.end)}T10:00`, timeZone: zone }
}

// ---- Optimistic changes ------------------------------------------------------------------------

/** How the events look while a change is on its way to iCloud. */
export type Optimistic = (events: CalendarEvent[]) => CalendarEvent[]

const same = (a: CalendarEvent, calendarId: string, uid: string) =>
  a.calendarId === calendarId && a.uid === uid

/** A draft's occurrences, or none if the preview can't read it (it's still sent; iCloud decides). */
function preview(
  draft: EventDraft,
  opts: { uid: string; calendarId: string; range: DateRange },
): CalendarEvent[] {
  try {
    return previewDraft(draft, opts)
  } catch {
    return []
  }
}

function supportedZones(): string[] {
  try {
    return (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []
  } catch {
    return []
  }
}

/** A new event shows straight away, under a temporary UID. */
export function optimisticCreate(calendarId: string, draft: EventDraft, range: DateRange): Optimistic {
  const shown = preview(draft, { uid: `pending-${Date.now()}`, calendarId, range })
  return (events) => [...events, ...shown]
}

export function optimisticUpdate(
  ref: { calendarId: string; uid: string; recurrenceId?: string },
  draft: EventDraft,
  scope: EditScope,
  range: DateRange,
): Optimistic {
  const span = draftSpan(draft)
  const fields = {
    title: draft.title.trim() || 'New Event',
    allDay: draft.allDay,
    location: draft.location || undefined,
    notes: draft.notes || undefined,
  }
  return (events) => {
    const target = events.find((e) => same(e, ref.calendarId, ref.uid) && e.recurrenceId === ref.recurrenceId)
    if (scope === 'this' && ref.recurrenceId)
      return events.map((e) => (e === target ? { ...e, ...fields, ...span } : e))
    const others = events.filter((e) => !same(e, ref.calendarId, ref.uid))
    if (!draft.repeat || !target)
      return [...others, ...preview(draft, { uid: ref.uid, calendarId: ref.calendarId, range })]
    // Every occurrence moves as this one did.
    const delta = span.start.getTime() - target.start.getTime()
    const length = span.end.getTime() - span.start.getTime()
    const moved = events
      .filter((e) => same(e, ref.calendarId, ref.uid))
      .map((e) => {
        const start = new Date(e.start.getTime() + delta)
        return { ...e, ...fields, start, end: new Date(start.getTime() + length) }
      })
    return [...others, ...moved]
  }
}

export function optimisticDelete(
  ref: { calendarId: string; uid: string; recurrenceId?: string },
  scope: EditScope,
): Optimistic {
  return (events) =>
    events.filter(
      (e) => !same(e, ref.calendarId, ref.uid) || (scope === 'this' && e.recurrenceId !== ref.recurrenceId),
    )
}

// ---- Moving in the week view -------------------------------------------------------------------

/** Drag and keyboard moves snap to this many minutes. */
export const SNAP = 15

/** An event's span after moving it by whole days and minutes, or resizing its end. */
export function nudged(
  span: { start: Date; end: Date },
  { days = 0, minutes = 0, resize = 0 }: { days?: number; minutes?: number; resize?: number },
): { start: Date; end: Date } {
  const start = new Date(span.start)
  start.setDate(start.getDate() + days)
  start.setMinutes(start.getMinutes() + minutes)
  const length = span.end.getTime() - span.start.getTime() + resize * 60_000
  return { start, end: new Date(start.getTime() + Math.max(SNAP * 60_000, length)) }
}

/** Snap minutes to the grid, rounding to the nearest step. */
export const snap = (minutes: number) => Math.round(minutes / SNAP) * SNAP

/** The keyboard nudge for a key press on a focused event, if any. Option (Alt) + arrows. */
export function nudgeFor(e: { key: string; altKey: boolean; shiftKey: boolean }) {
  if (!e.altKey) return null
  if (e.shiftKey) {
    if (e.key === 'ArrowUp') return { resize: -SNAP }
    if (e.key === 'ArrowDown') return { resize: SNAP }
    return null
  }
  if (e.key === 'ArrowUp') return { minutes: -SNAP }
  if (e.key === 'ArrowDown') return { minutes: SNAP }
  if (e.key === 'ArrowLeft') return { days: -1 }
  if (e.key === 'ArrowRight') return { days: 1 }
  return null
}

// ---- Alerts --------------------------------------------------------------------------------------

export const TIMED_ALERTS: { value: number; label: string }[] = [
  { value: 0, label: 'At time of event' },
  { value: 5, label: '5 minutes before' },
  { value: 10, label: '10 minutes before' },
  { value: 15, label: '15 minutes before' },
  { value: 30, label: '30 minutes before' },
  { value: 60, label: '1 hour before' },
  { value: 120, label: '2 hours before' },
  { value: 1440, label: '1 day before' },
  { value: 2880, label: '2 days before' },
  { value: 10080, label: '1 week before' },
]

/** All-day alerts are at 09:00: on the day is 9 hours after midnight, a day before is 15 hours before. */
export const ALL_DAY_ALERTS: { value: number; label: string }[] = [
  { value: -540, label: 'On the day (09:00)' },
  { value: 900, label: '1 day before (09:00)' },
  { value: 2340, label: '2 days before (09:00)' },
  { value: 9540, label: '1 week before (09:00)' },
]

export function alertLabel(minutes: number): string {
  const known = [...TIMED_ALERTS, ...ALL_DAY_ALERTS].find((a) => a.value === minutes)
  if (known) return known.label
  return minutes < 0 ? `${-minutes} minutes after the start` : `${minutes} minutes before`
}

export const REPEAT_LABELS = {
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
  yearly: 'Every year',
} as const

/** Every time zone the runtime knows, with the ones in use first. */
export function timeZones(...first: (string | null)[]): string[] {
  const all = supportedZones()
  const top = [...new Set(first.filter((z): z is string => !!z))]
  return [...top, ...all.filter((z) => !top.includes(z))]
}
