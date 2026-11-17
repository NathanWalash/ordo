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
  const jcal = ICAL.parse(ics)
  const roots = (Array.isArray(jcal[0]) ? jcal : [jcal]) as unknown[]
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
    const replaced = new Set<string>()
    for (const o of overrides) {
      const event = new ICAL.Event(o)
      const recurrenceId = occurrenceKey(event.recurrenceId, tzidOf(o, 'recurrence-id'))
      replaced.add(recurrenceId)
      if (cancelled(o)) continue
      const occ = toOccurrence(event, o, calendarId, uid)
      if (overlaps(occ.start, occ.end, range)) out.push({ ...occ, recurrenceId })
    }
    if (!master || cancelled(master)) continue
    out.push(...expand(master, calendarId, uid, range, replaced))
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime())
}

function expand(
  master: Component,
  calendarId: string,
  uid: string,
  range: DateRange,
  replaced: Set<string>,
): CalendarEvent[] {
  const event = new ICAL.Event(master)
  const base = toOccurrence(event, master, calendarId, uid)
  if (!event.isRecurring()) return overlaps(base.start, base.end, range) ? [base] : []

  const tzid = tzidOf(master, 'dtstart')
  const length = base.end.getTime() - base.start.getTime()
  const days = Math.round(length / DAY_MS)
  const out: CalendarEvent[] = []
  const it = event.iterator()
  for (let step = 0; step < MAX_STEPS; step++) {
    const next = it.next()
    if (!next) break
    // Cheap bounds check on the wall-clock time before the exact (time zone) conversion.
    const rough = Date.UTC(next.year, next.month - 1, next.day, next.hour, next.minute, next.second)
    if (rough - 2 * DAY_MS >= range.end.getTime()) break
    if (rough + length + 2 * DAY_MS < range.start.getTime()) continue

    const start = toDate(next, tzid)
    const end = base.allDay ? addDays(start, days) : new Date(start.getTime() + length)
    const recurrenceId = occurrenceKey(next, tzid)
    if (replaced.has(recurrenceId) || !overlaps(start, end, range)) continue
    out.push({ ...base, start, end, recurrenceId })
  }
  return out
}

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
