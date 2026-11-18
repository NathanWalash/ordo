import ICAL from 'ical.js'
import { addDays, dayKey, floatingTime, ianaZone, overlaps, zonedTimeToUtc } from './time'
import type { CalendarEvent, DateRange } from './types'

type Component = InstanceType<typeof ICAL.Component>
type Time = InstanceType<typeof ICAL.Time>

/** Stop expanding a runaway rule (e.g. a minutely RRULE with no end) after this many steps. */
const MAX_STEPS = 50_000
/** And stop expanding a whole document's rules after this many steps in all. */
export const MAX_TOTAL_STEPS = 500_000
const DAY_MS = 86_400_000

export interface ParseOptions {
  calendarId: string
  /** Only occurrences overlapping this range are returned. */
  range: DateRange
  /** Expansion steps allowed for the whole document (default MAX_TOTAL_STEPS). */
  maxSteps?: number
}

/**
 * Parse an iCalendar document (one CalDAV resource, or a whole .ics file) into event
 * occurrences within `range`. Recurring events are expanded using RRULE, RDATE and EXDATE;
 * RECURRENCE-ID overrides replace (or, if cancelled, remove) the occurrence they modify.
 */
export function parseIcs(
  ics: string | Component[],
  { calendarId, range, maxSteps = MAX_TOTAL_STEPS }: ParseOptions,
): CalendarEvent[] {
  const calendars = typeof ics === 'string' ? parseCalendars(ics) : ics
  const byUid = new Map<string, { master?: Component; overrides: Component[] }>()
  // Expansion steps left for the whole document: many runaway rules (minutely since 1900) in a
  // hostile feed would otherwise take hours. When it runs out, what's expanded so far is kept.
  const budget = { steps: maxSteps }
  for (const calendar of calendars) {
    for (const vevent of calendar.getAllSubcomponents('vevent')) {
      if (!vevent.hasProperty('dtstart')) continue
      const uid = String(vevent.getFirstPropertyValue('uid') ?? '') || `no-uid-${byUid.size}`
      const entry = byUid.get(uid) ?? { overrides: [] }
      if (vevent.hasProperty('recurrence-id')) entry.overrides.push(vevent)
      else entry.master = vevent
      byUid.set(uid, entry)
    }
  }

  const out: CalendarEvent[] = []
  for (const [uid, { master, overrides }] of byUid) {
    // One broken event (a bad date, an odd rule) mustn't hide the rest of the calendar.
    try {
      const events: CalendarEvent[] = []
      const replaced = new Set<string>()
      for (const o of overrides) {
        const event = new ICAL.Event(o, NO_EXCEPTIONS)
        const recurrenceId = occurrenceKey(event.recurrenceId, tzidOf(o, 'recurrence-id'))
        replaced.add(recurrenceId)
        if (cancelled(o)) continue
        const occ = toOccurrence(event, o, calendarId, uid)
        if (overlaps(occ.start, occ.end, range)) events.push({ ...occ, recurrenceId })
      }
      if (master && !cancelled(master))
        events.push(...expand(master, calendarId, uid, range, replaced, budget))
      out.push(...events)
    } catch {
      continue
    }
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime())
}

/**
 * Without this, ical.js looks through every event in the document for each event's exceptions,
 * which made big files take seconds to minutes. Overrides are matched above instead.
 */
const NO_EXCEPTIONS = { exceptions: [] }

/** Limits on reading a document that didn't parse as a whole, which may be hostile. */
export const FALLBACK_LIMITS = { events: 50_000, zones: 200 }

/**
 * The VCALENDARs in a document. A byte order mark is dropped. If the document as a whole won't
 * parse (one event with an invalid rule or line), it is read again component by component: one
 * pass over the lines, the header and each time zone parsed once, and each event parsed on its
 * own into a single shared calendar, leaving out the ones that still won't parse. At most
 * FALLBACK_LIMITS events and zones are kept, so a hostile link can't run away with memory or time.
 */
export function parseCalendars(text: string): Component[] {
  const ics = text.replace(/^\uFEFF/, '')
  try {
    const jcal = ICAL.parse(ics)
    const roots = (Array.isArray(jcal[0]) ? jcal : [jcal]) as unknown[]
    return roots.map((r) => new ICAL.Component(r as never)).filter((c) => c.name === 'vcalendar')
  } catch {
    return parseLeniently(ics)
  }
}

function parseLeniently(ics: string): Component[] {
  const lines = ics.split(/\r?\n|\r/)
  const header: string[] = []
  const zones: string[][] = []
  const events: string[][] = []
  let inCalendar = false
  let headerDone = false
  let depth = 0 // inside the calendar: 1 is the calendar itself, 2+ its components
  let current: string[] | null = null
  let kind = ''
  for (const line of lines) {
    const tag = /^(BEGIN|END):([A-Z-]+)\s*$/i.exec(line)
    const what = tag?.[2]!.toUpperCase()
    if (!inCalendar) {
      if (tag?.[1]!.toUpperCase() === 'BEGIN' && what === 'VCALENDAR') {
        inCalendar = true
        depth = 1
      }
      continue
    }
    if (tag?.[1]!.toUpperCase() === 'BEGIN') {
      depth++
      if (depth === 2) {
        headerDone = true
        kind = what!
        current = []
      }
    }
    if (current) current.push(line)
    else if (!headerDone && depth === 1 && !tag) header.push(line)
    if (tag?.[1]!.toUpperCase() === 'END') {
      if (depth === 2 && current) {
        if (kind === 'VEVENT' && what === 'VEVENT' && events.length < FALLBACK_LIMITS.events)
          events.push(current)
        else if (kind === 'VTIMEZONE' && what === 'VTIMEZONE' && zones.length < FALLBACK_LIMITS.zones)
          zones.push(current)
        current = null
      }
      depth--
      if (depth === 0) break // END:VCALENDAR; anything after is ignored
    }
  }
  if (!inCalendar) throw new Error('Not a calendar')

  const parse = (text: string) => {
    try {
      return new ICAL.Component(ICAL.parse(text) as never)
    } catch {
      return null
    }
  }
  const wrap = (body: string[]) => ['BEGIN:VCALENDAR', ...body, 'END:VCALENDAR'].join('\r\n')
  // The header as a whole, or else the properties of it that parse on their own (the calendar's
  // name and colour, say), unfolded first. At most a couple of hundred are tried.
  let calendar = parse(wrap(header))
  if (!calendar) {
    const props: string[] = []
    for (const line of header.slice(0, 2_000))
      if (/^[ \t]/.test(line) && props.length) props[props.length - 1] += line.slice(1)
      else props.push(line)
    const good = props.slice(0, 200).filter((p) => parse(wrap([p])))
    calendar = parse(wrap(good)) ?? parse(wrap(['VERSION:2.0']))!
  }
  for (const z of zones) {
    const zone = parse(z.join('\r\n'))
    if (zone?.name === 'vtimezone') calendar.addSubcomponent(zone)
  }
  let added = 0
  for (const e of events) {
    const event = parse(e.join('\r\n'))
    if (event?.name !== 'vevent') continue
    calendar.addSubcomponent(event)
    added++
  }
  if (!added) throw new Error('Not a calendar')
  return [calendar]
}

function expand(
  master: Component,
  calendarId: string,
  uid: string,
  range: DateRange,
  replaced: Set<string>,
  budget: { steps: number },
): CalendarEvent[] {
  const event = new ICAL.Event(master, NO_EXCEPTIONS)
  const base = toOccurrence(event, master, calendarId, uid)
  if (!event.isRecurring()) return overlaps(base.start, base.end, range) ? [base] : []
  if (budget.steps <= 0) return [] // the document has used up its expansion budget

  const tzid = tzidOf(master, 'dtstart')
  const length = base.end.getTime() - base.start.getTime()
  const days = Math.round(length / DAY_MS)
  // Timed occurrences keep the master's wall-clock length, so one that crosses a clock change
  // still ends at the same time on the clock (22:00 to 08:00 stays 08:00).
  const wallLength =
    !base.allDay && tzidOf(master, 'dtend') === tzid && master.hasProperty('dtend')
      ? (wallMs(event.endDate) - wallMs(event.startDate)) / 1000
      : null

  // UNTIL as a date on a timed event: other calendar apps include that whole day.
  const rule = master.getFirstPropertyValue('rrule') as InstanceType<typeof ICAL.Recur> | null
  if (rule?.until?.isDate && !event.startDate.isDate) {
    const u = rule.until
    rule.until = ICAL.Time.fromData(
      { year: u.year, month: u.month, day: u.day, hour: 23, minute: 59, second: 59, isDate: false },
      event.startDate.zone,
    )
  }

  // EXDATEs, matched here like RECURRENCE-IDs (ical.js compares them as wall-clock times, so
  // one in UTC never excluded an occurrence in a named zone without a VTIMEZONE):
  // - in UTC or a named zone: the same instant;
  // - floating (no zone): the same time on the event's own clock, whatever its zone;
  // - a date (or any EXDATE on an all-day event): any occurrence on that date, by the event's
  //   own calendar, not the viewer's.
  const excluded = new Set<string>()
  const excludedWall = new Set<number>()
  const excludedDays = new Set<string>()
  for (const prop of master.getAllProperties('exdate')) {
    const param = prop.getParameter('tzid')
    const ztz = typeof param === 'string' ? param : undefined
    for (const value of prop.getValues() as Time[]) {
      if (!value || typeof value !== 'object' || !('isDate' in value)) continue
      if (value.isDate || base.allDay) excludedDays.add(wallDay(value))
      else if (ztz || value.zone === ICAL.Timezone.utcTimezone) excluded.add(occurrenceKey(value, ztz))
      else excludedWall.add(wallMs(value))
    }
  }
  const skip = (key: string, t: Time) =>
    replaced.has(key) || excluded.has(key) || excludedWall.has(wallMs(t)) || excludedDays.has(wallDay(t))
  master.removeAllProperties('exdate')

  const out: CalendarEvent[] = []
  const seen = new Set<string>()
  const it = event.iterator()
  for (let step = 0; step < MAX_STEPS && budget.steps > 0; step++, budget.steps--) {
    const value = it.next() as Time | InstanceType<typeof ICAL.Period> | null
    if (!value) break
    // RDATE;VALUE=PERIOD gives a start and an end.
    const period = value instanceof ICAL.Period ? value : null
    const next = period ? period.start : (value as Time)
    // Cheap bounds check on the wall-clock time before the exact (time zone) conversion.
    const rough = wallMs(next)
    if (rough - 2 * DAY_MS >= range.end.getTime()) break
    if (rough + length + 2 * DAY_MS < range.start.getTime()) continue

    const start = toDate(next, tzid)
    const recurrenceId = occurrenceKey(next, tzid)
    seen.add(recurrenceId)
    let end: Date
    if (period) end = toDate(period.getEnd(), tzid)
    else if (base.allDay) end = addDays(start, days)
    else if (wallLength !== null) {
      const endTime = next.clone()
      endTime.addDuration(ICAL.Duration.fromSeconds(wallLength))
      end = toDate(endTime, tzid)
    } else end = new Date(start.getTime() + length)
    if (skip(recurrenceId, next) || !overlaps(start, end, range)) continue
    out.push({ ...base, start, end, recurrenceId })
  }
  // With RDATEs and no RRULE, ical.js leaves out the DTSTART occurrence itself.
  if (!master.hasProperty('rrule')) {
    const key = occurrenceKey(event.startDate, tzid)
    if (!seen.has(key) && !skip(key, event.startDate) && overlaps(base.start, base.end, range))
      out.push({ ...base, recurrenceId: key })
  }
  return out
}

/** An iCalendar time's wall-clock reading, as if it were UTC: for comparing and measuring. */
const wallMs = (t: Time) => Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second)
/** An iCalendar time's date as written, in its own zone: `2026-01-12`. */
const wallDay = (t: Time) => `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`

function toOccurrence(
  event: InstanceType<typeof ICAL.Event>,
  comp: Component,
  calendarId: string,
  uid: string,
): CalendarEvent {
  const startTime = event.startDate
  const allDay = startTime.isDate
  const start = toDate(startTime, tzidOf(comp, 'dtstart'))
  const endTime = event.endDate
  let end = toDate(endTime, tzidOf(comp, comp.hasProperty('dtend') ? 'dtend' : 'dtstart'))
  if (allDay && end <= start) end = addDays(start, 1)
  if (end < start) end = start
  const text = (name: string) => {
    const v = comp.getFirstPropertyValue(name)
    const s = typeof v === 'string' ? v.trim() : ''
    return s || undefined
  }
  return {
    uid,
    calendarId,
    title: text('summary') ?? 'Untitled event',
    start,
    end,
    allDay,
    location: text('location'),
    notes: text('description'),
  }
}

function cancelled(comp: Component): boolean {
  return String(comp.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED'
}

function tzidOf(comp: Component, prop: string): string | undefined {
  const p = comp.getFirstProperty(prop)
  const tzid = p?.getParameter('tzid')
  return typeof tzid === 'string' ? tzid : undefined
}

/** The original start of an occurrence, used to match RECURRENCE-ID overrides. */
function occurrenceKey(t: Time, tzid: string | undefined): string {
  const d = toDate(t, tzid)
  return t.isDate ? dayKey(d) : d.toISOString()
}

/**
 * Convert an iCalendar time to a JS Date. All-day dates become local midnight. Times with
 * a TZID use the runtime's IANA database when it knows the zone (more reliable than the
 * VTIMEZONE rules many clients send), then the document's VTIMEZONE, and otherwise are
 * treated as floating (local) time.
 */
function toDate(t: Time, fallbackTzid: string | undefined): Date {
  const wall = { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second }
  if (t.isDate) return new Date(t.year, t.month - 1, t.day)
  if (t.zone === ICAL.Timezone.utcTimezone || t.zone?.tzid === 'UTC')
    return new Date(Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second))
  const declared = t.zone && t.zone !== ICAL.Timezone.localTimezone ? t.zone.tzid : undefined
  const tzid = declared ?? (t as Time & { timezone?: string }).timezone ?? fallbackTzid
  const iana = ianaZone(tzid)
  if (iana) return zonedTimeToUtc(wall, iana)
  if (declared) return new Date(t.toUnixTime() * 1000)
  return floatingTime(wall)
}
