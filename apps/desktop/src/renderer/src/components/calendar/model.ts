import {
  addDays,
  sameDay,
  startOfDay,
  type CalendarEvent,
  type CalendarView,
  type DateRange,
} from '@ordo/calendar-core'
import type { CalendarListItem, CalendarOverlayItem } from '@ordo/shared'

/** What the views draw: a calendar event, or an overlay item from another module. */
export type CalendarItem =
  | {
      type: 'event'
      key: string
      title: string
      start: Date
      end: Date
      allDay: boolean
      color: string
      event: CalendarEvent
      calendar?: CalendarListItem
    }
  | {
      type: 'overlay'
      key: string
      title: string
      start: Date
      end: Date
      allDay: true
      overlay: CalendarOverlayItem
    }

/** Opens the detail popover for an item, anchored to the element that was clicked. */
export type OpenItem = (item: CalendarItem, anchor: DOMRect) => void

export function toItems(
  events: CalendarEvent[],
  overlays: CalendarOverlayItem[],
  calendars: CalendarListItem[],
): CalendarItem[] {
  const byId = new Map(calendars.map((c) => [c.id, c]))
  const visible = events.filter((e) => byId.get(e.calendarId)?.visible !== false)
  return [
    ...visible.map((e): CalendarItem => {
      const calendar = byId.get(e.calendarId)
      return {
        type: 'event',
        key: `${e.calendarId}|${e.uid}|${e.recurrenceId ?? ''}`,
        title: e.title,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        color: calendar?.color ?? 'var(--accent)',
        event: e,
        calendar,
      }
    }),
    ...overlays.map((o): CalendarItem => ({
      type: 'overlay',
      key: `overlay|${o.id}`,
      title: o.title,
      start: startOfDay(o.date),
      end: addDays(startOfDay(o.date), 1),
      allDay: true,
      overlay: o,
    })),
  ]
}

/** Calendar colour as a soft fill and a readable text colour, in light and dark mode. */
export const fill = (color: string, pct = 20) => `color-mix(in srgb, ${color} ${pct}%, transparent)`
export const ink = (color: string) => `color-mix(in srgb, ${color} 62%, var(--ink))`

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
export const formatTime = (d: Date) => timeFormat.format(d)

/**
 * What the agenda shows for an item under `day`: its start time on its first day, "Until" its
 * end on its last, and "All day" for an all-day item or the days in between.
 */
export function agendaTime(item: { start: Date; end: Date; allDay: boolean }, day: Date): string {
  if (item.allDay) return 'All day'
  if (sameDay(item.start, day)) return formatTime(item.start)
  // The end is exclusive: an event that ends at midnight ends on the day before.
  if (sameDay(new Date(item.end.getTime() - 1), day)) return `Until ${formatTime(item.end)}`
  return 'All day'
}

/** Short time for dense cells: "9:30" or "18:00", without the AM/PM where the locale allows. */
export function formatTimeShort(d: Date): string {
  return timeFormat
    .formatToParts(d)
    .filter((p) => p.type !== 'dayPeriod')
    .map((p) => p.value)
    .join('')
    .trim()
}

/** Hour label for the time grid: "09:00" with a 24-hour clock, "9 AM" with a 12-hour one. */
export function formatHour(hour: number): string {
  const at = new Date(2026, 0, 1, hour)
  const h12 = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12
  return h12 ? new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(at) : formatTime(at)
}

/** Toolbar title for the view: "November 2026", or "Nov – Dec 2026" for a week across months. */
export function viewTitle(
  view: CalendarView,
  cursor: Date,
  range: DateRange,
): { month: string; year: string } {
  const year = (d: Date) => String(d.getFullYear())
  if (view === 'week') {
    const first = range.start
    const last = addDays(range.end, -1)
    if (first.getMonth() !== last.getMonth()) {
      const short = (d: Date) => d.toLocaleDateString(undefined, { month: 'short' })
      return {
        month: `${short(first)} – ${short(last)}`,
        year: first.getFullYear() === last.getFullYear() ? year(last) : `${year(first)} – ${year(last)}`,
      }
    }
    return { month: first.toLocaleDateString(undefined, { month: 'long' }), year: year(first) }
  }
  return { month: cursor.toLocaleDateString(undefined, { month: 'long' }), year: year(cursor) }
}

/** The locale's first day of the week (0 = Sunday), Monday if the runtime can't say. */
export function firstDayOfWeek(locale = navigator.language): number {
  try {
    const l = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number }
      weekInfo?: { firstDay: number }
    }
    const info = l.getWeekInfo?.() ?? l.weekInfo
    if (info) return info.firstDay % 7
  } catch {
    // Fall through to the default.
  }
  return 1
}

/** "Tuesday 17 November 2026" and "09:00 – 10:00" (or "All day"), for the detail popover and agenda. */
export function describeWhen(item: { start: Date; end: Date; allDay: boolean }): {
  date: string
  time: string
} {
  const long: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
  if (item.allDay) {
    const last = addDays(item.end, -1)
    const sameDay = last.getTime() <= item.start.getTime()
    return {
      date: sameDay
        ? item.start.toLocaleDateString(undefined, long)
        : `${item.start.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} – ${last.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`,
      time: 'All day',
    }
  }
  const sameDay = item.start.toDateString() === item.end.toDateString()
  if (sameDay)
    return {
      date: item.start.toLocaleDateString(undefined, long),
      time: `${formatTime(item.start)} – ${formatTime(item.end)}`,
    }
  const short: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }
  return {
    date: `${item.start.toLocaleDateString(undefined, short)} – ${item.end.toLocaleDateString(undefined, short)}`,
    time: `${formatTime(item.start)} – ${formatTime(item.end)}`,
  }
}
