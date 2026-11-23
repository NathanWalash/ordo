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
  type RepeatFrequency,
} from '@ordo/calendar-core'
import type { CalendarListItem } from '@ordo/shared'

/** Calendars new events can go in: iCloud and Google ones that aren't read-only. */
export const writable = (c: CalendarListItem) =>
  ((c.source ?? 'icloud') === 'icloud' || c.source === 'google') && !c.readOnly

/** What deleting an event on this calendar does, for the confirmation. */
export function deleteNote(c: CalendarListItem | undefined): string {
  return c?.source === 'google'
    ? `This deletes it from Google Calendar${c.account ? ` (${c.account})` : ''}, everywhere that calendar shows. You can’t undo this.`
    : 'This deletes it from iCloud and all your devices. You can’t undo this.'
}

/**
 * Calendars grouped by account, in list order: iCloud, each Google account (labelled with its
 * email), then the rest. With only one group, it has no label.
 */
export function calendarGroups(
  calendars: CalendarListItem[],
): { label: string; calendars: CalendarListItem[] }[] {
  const groups = new Map<string, CalendarListItem[]>()
  for (const c of calendars) {
    const label =
      c.source === 'google'
        ? (c.account ?? 'Google')
        : (c.source ?? 'icloud') === 'icloud'
          ? 'iCloud'
          : 'Other calendars'
    groups.set(label, [...(groups.get(label) ?? []), c])
  }
  const list = [...groups].map(([label, cs]) => ({ label, calendars: cs }))
  return list.length === 1 ? [{ label: '', calendars: list[0]!.calendars }] : list
}

/** Why an event on this calendar can't be changed, and where it can be, or null if it can. */
export function readOnlyReason(c: CalendarListItem | undefined): string | null {
  if (!c) return null
  if (c.source === 'link')
    return 'Added by link, so Ordo can’t change its events. Change them where the calendar is published.'
  if (c.source === 'file')
    return 'Imported from a file, so Ordo can’t change its events. Change them in the app the file came from.'
  if (c.readOnly)
    return 'Shared with you read-only, so Ordo can’t change its events. Ask its owner for access.'
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

/** What the editor remembers across switching all-day off and on: the times, zone and alert. */
export interface TimedMemory {
  startTime: string
  endTime: string
  timeZone: string | null
  alert: number | null
}

/** The all-day alert closest to a timed one (and back): "1 day before (09:00)". */
const ALL_DAY_DEFAULT_ALERT = 900
const TIMED_DEFAULT_ALERT = 1440

/**
 * In the editor: turn all-day on or off, keeping the days. Turning it off again brings back the
 * times, zone and alert the event had; an alert stays an alert (none stays none).
 */
export function toggleAllDay(
  d: EventDraft,
  allDay: boolean,
  memory: TimedMemory | null,
  zone = localZone(),
): { draft: EventDraft; memory: TimedMemory | null } {
  if (allDay === d.allDay) return { draft: d, memory }
  const day = (s: string) => s.slice(0, 10)
  if (allDay) {
    const end = day(d.end) < day(d.start) ? day(d.start) : day(d.end)
    return {
      draft: {
        ...d,
        allDay: true,
        start: day(d.start),
        end,
        timeZone: null,
        alert: d.alert === null ? null : ALL_DAY_DEFAULT_ALERT,
      },
      memory: {
        startTime: d.start.slice(11, 16),
        endTime: d.end.slice(11, 16),
        timeZone: d.timeZone,
        alert: d.alert,
      },
    }
  }
  const m = memory ?? { startTime: '09:00', endTime: '10:00', timeZone: zone, alert: null }
  let end = `${day(d.end)}T${m.endTime}`
  const start = `${day(d.start)}T${m.startTime}`
  if (end < start) end = `${day(d.start)}T${m.endTime}`
  if (end < start) end = start
  return {
    draft: {
      ...d,
      allDay: false,
      start,
      end,
      timeZone: m.timeZone,
      alert: d.alert === null ? null : (m.alert ?? TIMED_DEFAULT_ALERT),
    },
    memory: null,
  }
}

/**
 * Where a repeat ends by default when "On date" is chosen: a month on for daily and weekly
 * events, a year on for monthly and yearly ones.
 */
export function defaultUntil(start: string, frequency: RepeatFrequency): string {
  const d = parseDay(start.slice(0, 10))
  if (!d) return start.slice(0, 10)
  const months = frequency === 'daily' || frequency === 'weekly' ? 1 : 12
  const t = new Date(Date.UTC(d.year, d.month - 1 + months, d.day))
  // 31 January plus a month is the last day of February, not 3 March.
  if (t.getUTCDate() !== d.day) t.setUTCDate(0)
  return formatDay({ year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() })
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

/**
 * Keep a move by `days` inside the week shown, for an event in column `col` of `count` days.
 * `clamped` says it hit the edge.
 */
export function clampDays(col: number, days: number, count = 7): { days: number; clamped: boolean } {
  const kept = Math.max(-col, Math.min(count - 1 - col, days)) || 0
  return { days: kept, clamped: kept !== days }
}

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

const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** "3 days before", "1 hour 30 minutes before", "2 hours after the start". */
export function alertLabel(minutes: number): string {
  const known = [...TIMED_ALERTS, ...ALL_DAY_ALERTS].find((a) => a.value === minutes)
  if (known) return known.label
  const m = Math.abs(minutes)
  const parts: string[] = []
  const days = Math.floor(m / 1440)
  const hours = Math.floor((m % 1440) / 60)
  const mins = m % 60
  if (days) parts.push(unit(days, 'day'))
  if (hours) parts.push(unit(hours, 'hour'))
  if (mins) parts.push(unit(mins, 'minute'))
  const span = parts.join(' ')
  return minutes < 0 ? `${span} after the start` : `${span} before`
}

export const REPEAT_LABELS = {
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
  yearly: 'Every year',
} as const

/** Old names some runtimes still list, mapped to the names people know now. */
const RENAMED: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata',
  'Asia/Saigon': 'Asia/Ho_Chi_Minh',
  'Europe/Kiev': 'Europe/Kyiv',
  'Asia/Katmandu': 'Asia/Kathmandu',
  'America/Godthab': 'America/Nuuk',
  'Asia/Rangoon': 'Asia/Yangon',
}

/** The current name of a zone. */
export const canonicalZone = (z: string) => RENAMED[z] ?? z

/** "London" for Europe/London, "Ho Chi Minh" for Asia/Ho_Chi_Minh. */
export const zoneCity = (z: string) => (canonicalZone(z).split('/').pop() ?? z).replace(/_/g, ' ')

/** "London (United Kingdom Time)", for the time zone list. */
export function zoneLabel(z: string, at = new Date()): string {
  const city = zoneCity(z)
  try {
    const name = new Intl.DateTimeFormat(undefined, { timeZone: z, timeZoneName: 'longGeneric' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value
    return name && name !== city ? `${city} (${name})` : city
  } catch {
    return city
  }
}

/** Every time zone the runtime knows, by its current name, with the ones in use first. */
export function timeZones(...first: (string | null)[]): string[] {
  const all = [...new Set(supportedZones().map(canonicalZone))]
  const top = [...new Set(first.filter((z): z is string => !!z).map(canonicalZone))]
  return [...top, ...all.filter((z) => !top.includes(z))]
}
