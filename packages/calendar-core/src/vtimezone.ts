// VTIMEZONE components built from the runtime's IANA time zone data, so the iCalendar Ordo writes
// is self-contained (RFC 5545 §3.6.5) without shipping a time zone database.
import ICAL from 'ical.js'
import { ianaZone, offsetAt } from './time'

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000

interface Transition {
  /** The instant the offset changes. */
  at: number
  from: number
  to: number
}

/** Offset changes in `tz` during `year`, to the minute. */
export function transitions(tz: string, year: number): Transition[] {
  const out: Transition[] = []
  const end = Date.UTC(year + 1, 0, 1)
  let t = Date.UTC(year, 0, 1)
  let offset = offsetAt(t, tz)
  for (; t < end; t += DAY_MS) {
    const next = offsetAt(t + DAY_MS, tz)
    if (next === offset) continue
    // Narrow the change down to the minute.
    let lo = t
    let hi = t + DAY_MS
    while (hi - lo > MINUTE_MS) {
      const mid = lo + Math.floor((hi - lo) / 2 / MINUTE_MS) * MINUTE_MS
      if (offsetAt(mid, tz) === offset) lo = mid
      else hi = mid
    }
    out.push({ at: hi, from: offset, to: next })
    offset = next
  }
  return out
}

interface Wall {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

/** The transition's local time, on the clock in use just before it (as VTIMEZONE's DTSTART is). */
function localBefore(t: Transition): Wall {
  const d = new Date(t.at + t.from)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  }
}

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

/** The date of the `n`th (or, with -1, last) `weekday` of a month. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
    return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7
  }
  const lastDay = daysInMonth(year, month)
  const last = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay()
  return lastDay - ((last - weekday + 7) % 7)
}

interface YearlyRule {
  month: number
  weekday: number
  n: number
}

/** A yearly "nth weekday of the month" rule that predicts this transition in every checked year. */
function findRule(tz: string, sample: Transition, years: number[]): YearlyRule | null {
  const w = localBefore(sample)
  const weekday = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay()
  const candidates = [-1, Math.ceil(w.day / 7)]
  const forward = sample.to > sample.from
  for (const n of candidates) {
    const ok = years.every((year) => {
      const t = transitions(tz, year).find((x) => x.to > x.from === forward)
      if (!t) return false
      const lw = localBefore(t)
      return (
        lw.month === w.month &&
        lw.day === nthWeekday(year, w.month, weekday, n) &&
        lw.hour === w.hour &&
        lw.minute === w.minute &&
        t.from === sample.from &&
        t.to === sample.to
      )
    })
    if (ok) return { month: w.month, weekday, n }
  }
  return null
}

function observance(kind: 'standard' | 'daylight', start: Wall, from: number, to: number, rrule?: string) {
  const c = new ICAL.Component(kind)
  c.addPropertyWithValue('dtstart', ICAL.Time.fromData({ ...start, second: 0, isDate: false }))
  c.addPropertyWithValue('tzoffsetfrom', ICAL.UtcOffset.fromSeconds(Math.round(from / 1000)))
  c.addPropertyWithValue('tzoffsetto', ICAL.UtcOffset.fromSeconds(Math.round(to / 1000)))
  if (rrule) c.addPropertyWithValue('rrule', ICAL.Recur.fromString(rrule))
  return c
}

/** Years a VTIMEZONE is built for. Outside them, the nearest year in range is used. */
export const VTIMEZONE_MIN_YEAR = 1900
export const VTIMEZONE_MAX_YEAR = 2200
/** At most this many years are scanned for one VTIMEZONE, whatever the caller asks for. */
export const VTIMEZONE_MAX_SPAN = 20

const clampYear = (y: number) => Math.min(VTIMEZONE_MAX_YEAR, Math.max(VTIMEZONE_MIN_YEAR, Math.trunc(y)))

/**
 * A VTIMEZONE for IANA zone `tz` that is right for `fromYear` to `toYear` (and, when the zone
 * follows a regular yearly rule, beyond). Null for UTC or a zone the runtime doesn't know.
 * The years are clamped to 1900–2200 and to a 20-year span, so odd input can't make it slow.
 */
export function buildVTimezone(
  tz: string,
  fromYear: number,
  toYear: number,
): InstanceType<typeof ICAL.Component> | null {
  if (!Number.isFinite(fromYear) || !Number.isFinite(toYear)) return null
  fromYear = clampYear(fromYear)
  toYear = Math.min(clampYear(Math.max(toYear, fromYear)), fromYear + VTIMEZONE_MAX_SPAN)
  const zone = ianaZone(tz)
  if (!zone) return null
  // Aliases of one zone (`/mozilla.org/…/Europe/London`, `Europe/London`) share the work.
  const key = `${zone}|${fromYear}|${toYear}`
  let jcal = built.get(key)
  if (jcal === undefined) {
    jcal = build(zone, fromYear, toYear)?.toJSON() ?? null
    if (built.size > 50) built.clear()
    built.set(key, jcal)
  }
  if (!jcal) return null
  const vtz = new ICAL.Component(structuredClone(jcal) as never)
  vtz.updatePropertyWithValue('tzid', tz)
  return vtz
}

/** Scanning a zone's changes takes a few milliseconds: remember the result. */
const built = new Map<string, unknown>()

function build(tz: string, fromYear: number, toYear: number): InstanceType<typeof ICAL.Component> | null {
  const zone = ianaZone(tz)
  if (!zone || zone === 'UTC' || zone === 'Etc/UTC') return null
  const vtz = new ICAL.Component('vtimezone')
  vtz.addPropertyWithValue('tzid', tz)

  // Observances start a year early, so the first one is in force before any event in range.
  const first = fromYear - 1
  const sample = transitions(zone, first)
  const check = Array.from({ length: Math.min(toYear, first + 12) - first + 1 }, (_, i) => first + i)
  const rules = sample.map((t) => ({ t, rule: findRule(zone, t, check) }))

  if (sample.length === 0) {
    const offset = offsetAt(Date.UTC(first, 0, 1), zone)
    vtz.addSubcomponent(
      observance('standard', { year: 1970, month: 1, day: 1, hour: 0, minute: 0 }, offset, offset),
    )
  } else if (sample.length === 2 && rules.every((r) => r.rule)) {
    for (const { t, rule } of rules) {
      const by = `${rule!.n}${WEEKDAYS[rule!.weekday]}`
      vtz.addSubcomponent(
        observance(
          t.to > t.from ? 'daylight' : 'standard',
          localBefore(t),
          t.from,
          t.to,
          `FREQ=YEARLY;BYMONTH=${rule!.month};BYDAY=${by}`,
        ),
      )
    }
  } else {
    // Irregular zone: list every change in the years asked for.
    const last = Math.max(toYear, fromYear)
    let any = false
    for (let y = first; y <= last; y++)
      for (const t of transitions(zone, y)) {
        any = true
        vtz.addSubcomponent(observance(t.to > t.from ? 'daylight' : 'standard', localBefore(t), t.from, t.to))
      }
    if (!any) {
      const offset = offsetAt(Date.UTC(first, 0, 1), zone)
      vtz.addSubcomponent(
        observance('standard', { year: 1970, month: 1, day: 1, hour: 0, minute: 0 }, offset, offset),
      )
    }
  }
  return vtz
}
