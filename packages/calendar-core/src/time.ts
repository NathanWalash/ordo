import type { DateRange } from './types'

export interface WallClock {
  year: number
  /** 1-12 */
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const DAY_MS = 86_400_000

const formatters = new Map<string, Intl.DateTimeFormat | null>()

function formatter(tz: string): Intl.DateTimeFormat | null {
  let f = formatters.get(tz)
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      })
    } catch {
      f = null
    }
    formatters.set(tz, f)
  }
  return f
}

/**
 * Turn an iCalendar TZID into an IANA zone name the runtime knows, or null.
 * Handles plain names (`Europe/London`) and prefixed ones (`/mozilla.org/20050126_1/America/New_York`).
 */
export function ianaZone(tzid: string | undefined | null): string | null {
  if (!tzid) return null
  const name = tzid.trim()
  if (formatter(name)) return name
  const tail = /([A-Za-z_]+\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?)$/.exec(name)?.[1]
  return tail && formatter(tail) ? tail : null
}

/** Offset of `tz` from UTC at the instant `utcMs`, in milliseconds (positive east of Greenwich). */
function offsetAt(utcMs: number, tz: string): number {
  const parts = formatter(tz)!.formatToParts(new Date(utcMs))
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - Math.floor(utcMs / 1000) * 1000
}

/**
 * The instant at which the wall clock in IANA zone `tz` reads `t`.
 * In the hour skipped by a DST change, times are moved forward (02:30 becomes 03:30),
 * and in the repeated hour the first (daylight) occurrence wins, as most calendar apps do.
 */
export function zonedTimeToUtc(t: WallClock, tz: string): Date {
  const asUtc = Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second)
  // Zones change offset at most a few times a year, so the offsets a day either side
  // are the only candidates.
  const before = offsetAt(asUtc - DAY_MS, tz)
  const after = offsetAt(asUtc + DAY_MS, tz)
  const valid = [before, after].map((o) => asUtc - o).filter((utc) => asUtc - offsetAt(utc, tz) === utc)
  // Repeated hour: both are valid, take the earlier. Skipped hour: neither is, use the old offset.
  return new Date(valid.length ? Math.min(...valid) : asUtc - before)
}

/** Wall-clock time in the machine's own zone (iCalendar "floating" time). */
export function floatingTime(t: WallClock): Date {
  return new Date(t.year, t.month - 1, t.day, t.hour, t.minute, t.second)
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Add whole calendar days, keeping the wall-clock time across DST changes. */
export function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** `YYYY-MM-DD` for the local calendar day of `d`. */
export function dayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** True if `[start, end)` overlaps `range`. Zero-length items count if they start inside it. */
export function overlaps(start: Date, end: Date, range: DateRange): boolean {
  const s = start.getTime()
  const e = Math.max(end.getTime(), s + 1)
  return s < range.end.getTime() && e > range.start.getTime()
}

/**
 * The span kept in the local cache: from the start of last month to the start of the
 * month a year after next, so roughly one month back and twelve ahead. Month-aligned, so
 * the window only moves once a month and unchanged calendars can be skipped in between.
 */
export function syncWindow(now: Date = new Date()): DateRange {
  return { start: addMonths(now, -1), end: addMonths(now, 13) }
}
