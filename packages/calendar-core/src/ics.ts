import ICAL from 'ical.js'
import { addDays, dayKey, floatingTime, ianaZone, overlaps, zonedTimeToUtc } from './time'
import type { CalendarEvent, DateRange } from './types'

type Component = InstanceType<typeof ICAL.Component>
type Time = InstanceType<typeof ICAL.Time>

/** Stop expanding a runaway rule (e.g. a minutely RRULE with no end) after this many steps. */
const MAX_STEPS = 50_000
const DAY_MS = 86_400_000

export interface ParseOptions {
  calendarId: string
  /** Only occurrences overlapping this range are returned. */
  range: DateRange
}

/**
 * Parse an iCalendar document (one CalDAV resource, or a whole .ics file) into event
 * occurrences within `range`. Recurring events are expanded using RRULE, RDATE and EXDATE;
 * RECURRENCE-ID overrides replace (or, if cancelled, remove) the occurrence they modify.
 */
export function parseIcs(ics: string, { calendarId, range }: ParseOptions): CalendarEvent[] {
  const roots = parseCalendars(ics)
  const byUid = new Map<string, { master?: Component; overrides: Component[] }>()
  for (const root of roots) {
    for (const vevent of new ICAL.Component(root as never).getAllSubcomponents('vevent')) {
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
      if (master && !cancelled(master)) events.push(...expand(master, calendarId, uid, range, replaced))
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

/**
 * The VCALENDARs of a document, as jCal. A byte order mark is dropped. If the document as a
 * whole won't parse (one event with an invalid rule or line), each event is parsed on its own
 * with the calendar's header and time zones, and the ones that still won't are left out.
 */
export function parseCalendars(text: string): unknown[] {
  const ics = text.replace(/^\uFEFF/, '')
  try {
    const jcal = ICAL.parse(ics)
    return (Array.isArray(jcal[0]) ? jcal : [jcal]) as unknown[]
  } catch {
    const start = ics.search(/^BEGIN:VCALENDAR/im)
    if (start < 0) throw new Error('Not a calendar')
    const body = ics.slice(start)
    const firstComponent = body.slice(1).search(/^BEGIN:V/im) + 1
    const header = firstComponent > 0 ? body.slice(0, firstComponent) : body
    const zones = body.match(/^BEGIN:VTIMEZONE[\s\S]*?^END:VTIMEZONE\r?$/gim) ?? []
    const roots: unknown[] = []
    for (const event of body.match(/^BEGIN:VEVENT[\s\S]*?^END:VEVENT\r?$/gim) ?? []) {
      const one = `${header.trimEnd()}\r\n${zones.join('\r\n')}\r\n${event}\r\nEND:VCALENDAR\r\n`
      try {
        roots.push(ICAL.parse(one.replace(/\r?\n(\r?\n)+/g, '\r\n')))
      } catch {
        // Leave this one out.
      }
    }
    if (!roots.length) throw new Error('Not a calendar')
    return roots
  }
}

function expand(
  master: Component,
  calendarId: string,
  uid: string,
  range: DateRange,
  replaced: Set<string>,
): CalendarEvent[] {
  const event = new ICAL.Event(master, NO_EXCEPTIONS)
  const base = toOccurrence(event, master, calendarId, uid)
  if (!event.isRecurring()) return overlaps(base.start, base.end, range) ? [base] : []

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
  // one in UTC never excluded an occurrence in a named zone without a VTIMEZONE).
  const excluded = new Set<string>()
  const excludedDays = new Set<string>()
  for (const prop of master.getAllProperties('exdate')) {
    const ztz = prop.getParameter('tzid')
    for (const value of prop.getValues() as Time[]) {
      if (!value || typeof value !== 'object' || !('isDate' in value)) continue
      if (value.isDate) excludedDays.add(dayKey(toDate(value, undefined)))
      else excluded.add(occurrenceKey(value, typeof ztz === 'string' ? ztz : tzid))
    }
  }
  const skip = (key: string, start: Date) =>
    replaced.has(key) || excluded.has(key) || excludedDays.has(dayKey(start))
  master.removeAllProperties('exdate')

  const out: CalendarEvent[] = []
  const seen = new Set<string>()
  const it = event.iterator()
  for (let step = 0; step < MAX_STEPS; step++) {
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
    if (skip(recurrenceId, start) || !overlaps(start, end, range)) continue
    out.push({ ...base, start, end, recurrenceId })
  }
  // With RDATEs and no RRULE, ical.js leaves out the DTSTART occurrence itself.
  if (!master.hasProperty('rrule')) {
    const key = occurrenceKey(event.startDate, tzid)
    if (!seen.has(key) && !skip(key, base.start) && overlaps(base.start, base.end, range))
      out.push({ ...base, recurrenceId: key })
  }
  return out
}

/** An iCalendar time's wall-clock reading, as if it were UTC: for comparing and measuring. */
const wallMs = (t: Time) => Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second)

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
