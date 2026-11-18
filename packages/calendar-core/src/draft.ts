// An event as people write it: wall-clock times in a time zone, a simple repeat rule and an
// alert. Pure, so the renderer, the main process and headless mode all share it.
import { addDays, floatingTime, ianaZone, utcToZoned, zonedTimeToUtc, type WallClock } from './time'

export type RepeatFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly'
export const REPEAT_FREQUENCIES: readonly RepeatFrequency[] = ['daily', 'weekly', 'monthly', 'yearly']

export interface RepeatRule {
  frequency: RepeatFrequency
  /** The last day it can happen on, `YYYY-MM-DD`, inclusive. */
  until?: string
  /** Or how many times it happens in all. */
  count?: number
  /**
   * The event's own rule has parts Ordo's editor doesn't show (every other week, on several days).
   * Saving the same rule back keeps it exactly as it was.
   */
  custom?: boolean
}

/**
 * A new or changed event. Times are wall-clock times in `timeZone`, so "09:00 in London" stays
 * 09:00 across a clock change.
 */
export interface EventDraft {
  title: string
  allDay: boolean
  /** All-day: the first day, `YYYY-MM-DD`. Timed: `YYYY-MM-DDTHH:mm`. */
  start: string
  /** All-day: the last day, inclusive. Timed: the end time (exclusive), in the same zone as `start`. */
  end: string
  /** IANA zone for timed events, e.g. `Europe/London`. `UTC` for UTC; null for floating (local) time. */
  timeZone: string | null
  location: string
  notes: string
  repeat: RepeatRule | null
  /** Minutes before the start to alert (0 = at the start, negative = after it), or null for none. */
  alert: number | null
}

export const NEW_EVENT_TITLE = 'New Event'

/** Limits that keep a draft within what CalDAV servers accept. */
export const DRAFT_LIMITS = {
  title: 500,
  location: 1000,
  notes: 10_000,
  count: 1000,
  /** Alerts from a week after the start to four weeks before it. */
  alertMin: -7 * 24 * 60,
  alertMax: 28 * 24 * 60,
} as const

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/
const DAY_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

function realDay(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d))
  return (
    y >= 1900 && y <= 2200 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
  )
}

/** `YYYY-MM-DD` as a wall clock at midnight, or null if it isn't a real day. */
export function parseDay(s: string): WallClock | null {
  const m = DAY.exec(s)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return realDay(y, mo, d) ? { year: y, month: mo, day: d, hour: 0, minute: 0, second: 0 } : null
}

/** `YYYY-MM-DDTHH:mm` as a wall clock, or null if it isn't a real time. */
export function parseDayTime(s: string): WallClock | null {
  const m = DAY_TIME.exec(s)
  if (!m) return null
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])]
  if (!realDay(y, mo, d) || h > 23 || mi > 59) return null
  return { year: y, month: mo, day: d, hour: h, minute: mi, second: 0 }
}

export const formatDay = (w: Pick<WallClock, 'year' | 'month' | 'day'>) =>
  `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`
export const formatDayTime = (w: WallClock) => `${formatDay(w)}T${pad(w.hour)}:${pad(w.minute)}`

/** Days from 1970-01-01 to this wall-clock date, for whole-day arithmetic that ignores zones. */
export const dayNumber = (w: Pick<WallClock, 'year' | 'month' | 'day'>) =>
  Math.round(Date.UTC(w.year, w.month - 1, w.day) / 86_400_000)

/** The wall-clock date `n` days after `w`, keeping the time of day. */
export function shiftDays(w: WallClock, n: number): WallClock {
  const t = new Date(Date.UTC(w.year, w.month - 1, w.day + n))
  return { ...w, year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() }
}

/** The wall clock `minutes` later, counting on the clock face (a 1-hour event stays 1 hour on the clock). */
export function addWallMinutes(w: WallClock, minutes: number): WallClock {
  const t = new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute + minutes, w.second))
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    second: t.getUTCSeconds(),
  }
}

/** Minutes between two wall clocks, on the clock face. */
export const wallMinutes = (a: WallClock, b: WallClock) =>
  Math.round(
    (Date.UTC(b.year, b.month - 1, b.day, b.hour, b.minute) -
      Date.UTC(a.year, a.month - 1, a.day, a.hour, a.minute)) /
      60_000,
  )

/** The instant a wall clock in `timeZone` (IANA, `UTC`, or null for floating) refers to. */
export function wallToDate(w: WallClock, timeZone: string | null): Date {
  if (timeZone === 'UTC') return new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second))
  const iana = timeZone ? ianaZone(timeZone) : null
  return iana ? zonedTimeToUtc(w, iana) : floatingTime(w)
}

/** What the wall clock reads in `timeZone` (IANA, `UTC`, or null for local) at instant `d`. */
export function dateToWall(d: Date, timeZone: string | null): WallClock {
  if (timeZone === 'UTC') return utcToZoned(d, 'UTC')
  const iana = timeZone ? ianaZone(timeZone) : null
  if (iana) return utcToZoned(d, iana)
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds(),
  }
}

/** The draft's start and end as wall clocks. All-day ends are the day after the last day. */
export function draftWalls(d: EventDraft): { start: WallClock; end: WallClock } {
  if (d.allDay) {
    const start = parseDay(d.start)
    const last = parseDay(d.end)
    if (!start || !last) throw new RangeError('Invalid all-day dates')
    return { start, end: shiftDays(last, 1) }
  }
  const start = parseDayTime(d.start)
  const end = parseDayTime(d.end)
  if (!start || !end) throw new RangeError('Invalid times')
  return { start, end }
}

/**
 * The draft's span as instants, like a CalendarEvent: all-day events run from local midnight of
 * the first day to local midnight after the last.
 */
export function draftSpan(d: EventDraft): { start: Date; end: Date } {
  const w = draftWalls(d)
  if (d.allDay) {
    const start = new Date(w.start.year, w.start.month - 1, w.start.day)
    return { start, end: addDays(start, dayNumber(w.end) - dayNumber(w.start)) }
  }
  return { start: wallToDate(w.start, d.timeZone), end: wallToDate(w.end, d.timeZone) }
}

/** Why a draft can't be saved, in words for people, or null if it's fine. */
export function checkDraft(d: EventDraft): string | null {
  if (d.title.length > DRAFT_LIMITS.title) return 'The title is too long.'
  if (d.location.length > DRAFT_LIMITS.location) return 'The location is too long.'
  if (d.notes.length > DRAFT_LIMITS.notes) return 'The notes are too long.'
  if (!d.allDay && d.timeZone !== null && d.timeZone !== 'UTC' && !ianaZone(d.timeZone))
    return 'Choose a time zone from the list.'
  const parse = d.allDay ? parseDay : parseDayTime
  const start = parse(d.start)
  const end = parse(d.end)
  if (!start) return d.allDay ? 'Enter a start date.' : 'Enter a start date and time.'
  if (!end) return d.allDay ? 'Enter an end date.' : 'Enter an end date and time.'
  if (d.allDay ? dayNumber(end) < dayNumber(start) : wallMinutes(start, end) < 0)
    return 'The event ends before it starts.'
  if (d.repeat) {
    if (!REPEAT_FREQUENCIES.includes(d.repeat.frequency)) return 'Choose how often it repeats.'
    if (d.repeat.until !== undefined && d.repeat.count !== undefined)
      return 'A repeat ends on a date or after a number of times, not both.'
    if (d.repeat.until !== undefined) {
      const until = parseDay(d.repeat.until)
      if (!until) return 'Enter the date the repeat ends.'
      if (dayNumber(until) < dayNumber(start)) return 'The repeat ends before the event starts.'
    }
    if (
      d.repeat.count !== undefined &&
      (!Number.isInteger(d.repeat.count) || d.repeat.count < 1 || d.repeat.count > DRAFT_LIMITS.count)
    )
      return `A repeat can happen between 1 and ${DRAFT_LIMITS.count} times.`
  }
  if (
    d.alert !== null &&
    (!Number.isInteger(d.alert) || d.alert < DRAFT_LIMITS.alertMin || d.alert > DRAFT_LIMITS.alertMax)
  )
    return 'Choose an alert from the list.'
  return null
}

/** Two repeat rules are the same (custom rules only if both are the untouched original). */
export function sameRepeat(a: RepeatRule | null, b: RepeatRule | null): boolean {
  if (!a || !b) return a === b
  return (
    a.frequency === b.frequency &&
    a.until === b.until &&
    a.count === b.count &&
    (a.custom ?? false) === (b.custom ?? false)
  )
}
