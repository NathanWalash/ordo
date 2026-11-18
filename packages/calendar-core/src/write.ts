// Writing iCalendar: a new event from a draft, a change to one occurrence or to a whole series,
// and deleting either. Pure (ical.js and Intl only), so the renderer can preview with it too.
//
// Changes keep everything Ordo doesn't edit (attendees, URLs, other apps' X- properties, extra
// alarms, times that didn't change) and bump SEQUENCE, as RFC 5545 asks. "This event only" writes
// a RECURRENCE-ID override, or an EXDATE when deleting. "All events" moves the series by however
// much the occurrence moved.
import ICAL from 'ical.js'
import {
  addWallMinutes,
  dayNumber,
  DRAFT_LIMITS,
  draftWalls,
  formatDay,
  formatDayTime,
  NEW_EVENT_TITLE,
  parseDay,
  sameRepeat,
  shiftDays,
  wallMinutes,
  type EventDraft,
  type RepeatFrequency,
  type RepeatRule,
} from './draft'
import { parseIcs } from './ics'
import { dayKey, floatingTime, ianaZone, localZone, utcToZoned, zonedTimeToUtc, type WallClock } from './time'
import type { CalendarEvent, DateRange } from './types'
import { buildVTimezone, VTIMEZONE_MAX_YEAR, VTIMEZONE_MIN_YEAR } from './vtimezone'

type Comp = InstanceType<typeof ICAL.Component>
type ITime = InstanceType<typeof ICAL.Time>
type ITimezone = InstanceType<typeof ICAL.Timezone>

export const PRODID = '-//Ordo//Ordo Calendar//EN'

/** Ordo refuses to change an event that uses more time zones than this. */
export const MAX_ZONES = 10

/** Which event, and which occurrence of it, a change is about. */
export interface EventTarget {
  uid: string
  /** The occurrence's `recurrenceId`, as `parseIcs` gives it, for one occurrence of a repeating event. */
  recurrenceId?: string
}

/** For a repeating event: change or delete just this occurrence, or the whole series. */
export type EditScope = 'this' | 'all'

export class IcsEditError extends Error {
  override name = 'IcsEditError'
  constructor(
    readonly kind: 'not-found' | 'invalid',
    message: string,
  ) {
    super(message)
  }
}

/** A DTSTART-like value as written: the wall clock and the TZID beside it. */
interface Moment {
  allDay: boolean
  wall: WallClock
  /** TZID as written; `UTC` for a trailing Z; null for floating time or a date. */
  zone: string | null
}

// ---- Time zones ----------------------------------------------------------------------------

/**
 * Turns wall clocks into instants and back for one document, the way `parseIcs` reads it: an
 * IANA zone with the runtime's data, otherwise the document's own VTIMEZONE (Outlook writes
 * `W. Europe Standard Time`), otherwise floating (local) time.
 */
class Zones {
  private defs = new Map<string, Comp>()
  private built = new Map<string, ITimezone | null>()

  constructor(vcal: Comp | null) {
    for (const z of vcal?.getAllSubcomponents('vtimezone') ?? []) {
      const id = z.getFirstPropertyValue('tzid')
      if (typeof id === 'string' && !this.defs.has(id)) this.defs.set(id, z)
    }
  }

  /** A zone defined only in the document, if its rules are safe to work out. */
  private custom(tzid: string): ITimezone | null {
    let tz = this.built.get(tzid)
    if (tz !== undefined) return tz
    const def = this.defs.get(tzid)
    const parts = def?.getAllSubcomponents() ?? []
    // A yearly rule (or a fixed change) is all a time zone needs. Anything faster, like a
    // secondly rule, would take ical.js forever to expand.
    const safe =
      parts.length > 0 &&
      parts.length <= 50 &&
      parts.every((o) =>
        o
          .getAllProperties('rrule')
          .every(
            (p) => String((p.getFirstValue() as { freq?: string } | null)?.freq).toUpperCase() === 'YEARLY',
          ),
      )
    tz = def && safe ? new ICAL.Timezone({ component: def, tzid }) : null
    this.built.set(tzid, tz)
    return tz
  }

  /** Whether Ordo can work with times in this zone. */
  known(zone: string | null): boolean {
    return zone === null || zone === 'UTC' || !!ianaZone(zone) || !!this.custom(zone)
  }

  date(m: Moment): Date {
    if (m.allDay) return new Date(m.wall.year, m.wall.month - 1, m.wall.day)
    const w = m.wall
    if (m.zone === 'UTC') return new Date(Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second))
    const iana = m.zone ? ianaZone(m.zone) : null
    if (iana) return zonedTimeToUtc(w, iana)
    const tz = m.zone ? this.custom(m.zone) : null
    if (tz) return new Date(ICAL.Time.fromData({ ...w, isDate: false }, tz).toUnixTime() * 1000)
    return floatingTime(w)
  }

  /** The wall clock in `zone` (a TZID, `UTC`, or null for local) at instant `d`. */
  wall(d: Date, zone: string | null): WallClock {
    if (zone === 'UTC') return utcToZoned(d, 'UTC')
    const iana = zone ? ianaZone(zone) : null
    if (iana) return utcToZoned(d, iana)
    const tz = zone ? this.custom(zone) : null
    if (tz) {
      const t = ICAL.Time.fromJSDate(d, true).convertToZone(tz)
      return { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second }
    }
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      second: d.getSeconds(),
    }
  }

  /** The key `parseIcs` uses for an occurrence: `YYYY-MM-DD` for all-day, else the ISO instant. */
  key(m: Moment): string {
    return m.allDay ? formatDay(m.wall) : this.date(m).toISOString()
  }
}

// ---- Reading -------------------------------------------------------------------------------

function momentOf(t: ITime, tzidParam: unknown): Moment {
  const wall = { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second }
  if (t.isDate) return { allDay: true, wall: { ...wall, hour: 0, minute: 0, second: 0 }, zone: null }
  if (t.zone === ICAL.Timezone.utcTimezone || t.zone?.tzid === 'UTC')
    return { allDay: false, wall, zone: 'UTC' }
  const tzid =
    typeof tzidParam === 'string' ? tzidParam : ((t as ITime & { timezone?: string }).timezone ?? null)
  return { allDay: false, wall, zone: tzid }
}

function readMoment(comp: Comp, name: string): Moment | null {
  const prop = comp.getFirstProperty(name)
  if (!prop) return null
  const t = prop.getFirstValue() as ITime | null
  return t && typeof t === 'object' && 'isDate' in t ? momentOf(t, prop.getParameter('tzid')) : null
}

/** The occurrence `recurrenceId` names, written the way the series' DTSTART is. */
function occurrenceMoment(z: Zones, recurrenceId: string, master: Moment): Moment {
  const day = parseDay(recurrenceId)
  if (master.allDay) {
    const d = day ?? parseDay(dayKey(new Date(recurrenceId)))
    if (!d) throw new IcsEditError('not-found', 'That occurrence isn’t a date.')
    return { allDay: true, wall: d, zone: null }
  }
  const instant = day ? new Date(day.year, day.month - 1, day.day) : new Date(recurrenceId)
  if (Number.isNaN(instant.getTime())) throw new IcsEditError('not-found', 'That occurrence isn’t a time.')
  return { allDay: false, wall: z.wall(instant, master.zone), zone: master.zone }
}

interface Found {
  vcal: Comp
  master: Comp | null
  overrides: Comp[]
  z: Zones
}

function load(ics: string): Comp {
  const jcal = ICAL.parse(ics)
  const root = (Array.isArray(jcal[0]) ? jcal[0] : jcal) as unknown
  const vcal = new ICAL.Component(root as never)
  if (vcal.name !== 'vcalendar') throw new IcsEditError('invalid', 'That isn’t a calendar.')
  return vcal
}

function find(ics: string, uid: string): Found {
  const vcal = load(ics)
  let master: Comp | null = null
  const overrides: Comp[] = []
  for (const v of vcal.getAllSubcomponents('vevent')) {
    if (String(v.getFirstPropertyValue('uid') ?? '') !== uid || !v.hasProperty('dtstart')) continue
    if (v.hasProperty('recurrence-id')) overrides.push(v)
    else master ??= v
  }
  if (!master && !overrides.length) throw new IcsEditError('not-found', 'That event wasn’t found.')
  return { vcal, master, overrides, z: new Zones(vcal) }
}

const isRecurring = (c: Comp | null) => !!c && (c.hasProperty('rrule') || c.hasProperty('rdate'))

function overrideFor(z: Zones, overrides: Comp[], recurrenceId: string | undefined): Comp | undefined {
  if (!recurrenceId) return undefined
  return overrides.find((o) => {
    const m = readMoment(o, 'recurrence-id')
    return m && z.key(m) === recurrenceId
  })
}

const NO_OCCURRENCE =
  'That occurrence isn’t part of this event. List the events again and use an occurrence from there.'

/**
 * Check that `recurrenceId` names a real occurrence of the series: one of its overrides, or one
 * its rule produces (as `parseIcs` lists them). A made-up id would otherwise write an override
 * or EXDATE that matches nothing.
 */
function checkOccurrence(ics: string, f: Found, target: EventTarget): void {
  const id = target.recurrenceId
  if (!id || overrideFor(f.z, f.overrides, id)) return
  const day = parseDay(id)
  const at = day ? new Date(day.year, day.month - 1, day.day) : new Date(id)
  if (Number.isNaN(at.getTime())) throw new IcsEditError('not-found', NO_OCCURRENCE)
  const range = {
    start: new Date(at.getTime() - 2 * 86_400_000),
    end: new Date(at.getTime() + 2 * 86_400_000),
  }
  const found = parseIcs(ics, { calendarId: '', range }).some(
    (e) => e.uid === target.uid && e.recurrenceId === id,
  )
  if (!found) throw new IcsEditError('not-found', NO_OCCURRENCE)
}

/** Start and end of a component, from DTEND or DURATION, as written. */
function span(z: Zones, comp: Comp): { start: Moment; end: Moment } {
  const start = readMoment(comp, 'dtstart')
  if (!start) throw new IcsEditError('invalid', 'That event has no start.')
  const end = readMoment(comp, 'dtend')
  if (end && end.allDay === start.allDay) return { start, end }
  const duration = comp.getFirstPropertyValue('duration') as InstanceType<typeof ICAL.Duration> | null
  if (duration && typeof duration === 'object' && 'toSeconds' in duration) {
    const seconds = duration.toSeconds()
    if (start.allDay)
      return {
        start,
        end: { ...start, wall: shiftDays(start.wall, Math.max(1, Math.round(seconds / 86_400))) },
      }
    const instant = new Date(z.date(start).getTime() + seconds * 1000)
    return { start, end: { ...start, wall: z.wall(instant, start.zone) } }
  }
  return { start, end: start.allDay ? { ...start, wall: shiftDays(start.wall, 1) } : start }
}

const text = (comp: Comp, name: string) => {
  const v = comp.getFirstPropertyValue(name)
  return typeof v === 'string' ? v : ''
}

/** Minutes before the start of an alarm Ordo's editor can show, or null. */
function alarmMinutes(alarm: Comp | null | undefined): number | null {
  const prop = alarm?.getFirstProperty('trigger')
  const v = prop?.getFirstValue() as { toSeconds?: () => number } | null
  if (!prop || !v || typeof v.toSeconds !== 'function') return null
  if (String(prop.getParameter('related') ?? 'START').toUpperCase() !== 'START') return null
  return Math.round(-v.toSeconds() / 60) || 0
}

/** The editor shows the first alarm, when it's one it can show. */
const readAlert = (comp: Comp) => alarmMinutes(comp.getFirstSubcomponent('valarm'))

const FREQS: Record<string, RepeatFrequency> = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  YEARLY: 'yearly',
}
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

function readRepeat(z: Zones, master: Comp, start: Moment): RepeatRule | null {
  const recur = master.getFirstPropertyValue('rrule') as InstanceType<typeof ICAL.Recur> | null
  if (!recur || typeof recur !== 'object' || !('freq' in recur))
    return master.hasProperty('rdate') ? { frequency: 'daily', custom: true } : null
  const frequency = FREQS[String(recur.freq).toUpperCase()]
  if (!frequency) return { frequency: 'daily', custom: true }
  const rule: RepeatRule = { frequency }
  if (recur.count) rule.count = recur.count
  if (recur.until) {
    const u = recur.until
    rule.until = u.isDate ? formatDay(u) : formatDay(z.wall(z.date(momentOf(u, undefined)), start.zone))
  }
  // An end the editor can't show (more than 1000 times, or past 2200) is kept as it is.
  if ((rule.count ?? 0) > DRAFT_LIMITS.count || (rule.until !== undefined && !parseDay(rule.until)))
    return { frequency, custom: true }
  // Parts that only restate the start (Google writes BYDAY=MO for a weekly Monday event) are fine.
  const weekday = new Date(Date.UTC(start.wall.year, start.wall.month - 1, start.wall.day)).getUTCDay()
  const expected: Record<string, string> = {
    BYDAY: frequency === 'weekly' ? BYDAY[weekday]! : '',
    BYMONTHDAY: frequency === 'monthly' || frequency === 'yearly' ? String(start.wall.day) : '',
    BYMONTH: frequency === 'yearly' ? String(start.wall.month) : '',
    WKST: '*',
  }
  const parts = Object.entries((recur.parts ?? {}) as Record<string, unknown[]>).filter(([, v]) => v?.length)
  const plain =
    (recur.interval ?? 1) === 1 &&
    !master.hasProperty('rdate') &&
    parts.every(
      ([k, v]) => expected[k] === '*' || (v.length === 1 && expected[k] && String(v[0]) === expected[k]),
    )
  return plain ? rule : { ...rule, custom: true }
}

/** What Ordo shows in its editor for an event's occurrence, and facts about it. */
export interface EventFacts {
  draft: EventDraft
  /** The event repeats, so changes ask "this event only" or "all events". */
  recurring: boolean
  /** The organiser's address, when the event is an invitation with other people on it. */
  organizer?: string
  attendees: number
  /** A TZID Ordo can't work out (not IANA, and no usable VTIMEZONE): it won't change the event. */
  unknownZone?: string
}

interface Occurrence {
  facts: EventFacts
  /** The component the draft came from, and its times as written. */
  start: Moment
  end: Moment
}

function occurrence(ics: string, f: Found, target: EventTarget): Occurrence {
  const { master, overrides, z } = f
  const own = overrideFor(z, overrides, target.recurrenceId)
  if (!own && master && target.recurrenceId && isRecurring(master)) checkOccurrence(ics, f, target)
  const base = own ?? master ?? overrides[0]!
  let { start, end } = span(z, base)
  if (!own && master && target.recurrenceId && isRecurring(master)) {
    // An occurrence of the series: the series' times, moved to this occurrence.
    const at = occurrenceMoment(z, target.recurrenceId, start)
    end = start.allDay
      ? { ...at, wall: shiftDays(at.wall, dayNumber(end.wall) - dayNumber(start.wall)) }
      : { ...at, wall: addWallMinutes(at.wall, wallMinutes(start.wall, endInZone(z, start, end))) }
    start = at
  }
  const series = master ?? base
  const organizer = String(series.getFirstPropertyValue('organizer') ?? '').replace(/^mailto:/i, '')
  const attendees = series.getAllProperties('attendee').length
  const unknown = [start, end].find((m) => !m.allDay && !z.known(m.zone))?.zone
  return {
    start,
    end,
    facts: {
      draft: {
        title: text(base, 'summary'),
        allDay: start.allDay,
        ...times(z, start, end),
        location: text(base, 'location'),
        notes: text(base, 'description'),
        repeat: master ? readRepeat(z, master, readMoment(master, 'dtstart')!) : null,
        alert: readAlert(base),
      },
      recurring: isRecurring(master),
      ...(organizer && attendees > 0 && { organizer }),
      attendees,
      ...(unknown && { unknownZone: unknown }),
    },
  }
}

/** The draft for one occurrence (or the only one) of event `uid` in a CalDAV resource. */
export function readEvent(ics: string, target: EventTarget): EventFacts {
  return occurrence(ics, find(ics, target.uid), target).facts
}

/** The end's wall clock in the start's zone. */
function endInZone(z: Zones, start: Moment, end: Moment): WallClock {
  if (end.zone === start.zone) return end.wall
  return z.wall(z.date(end), start.zone)
}

function times(z: Zones, start: Moment, end: Moment): Pick<EventDraft, 'start' | 'end' | 'timeZone'> {
  if (start.allDay) {
    const last = Math.max(dayNumber(start.wall), dayNumber(end.wall) - 1)
    return {
      start: formatDay(start.wall),
      end: formatDay(shiftDays(start.wall, last - dayNumber(start.wall))),
      timeZone: null,
    }
  }
  const zone = start.zone === 'UTC' ? 'UTC' : start.zone ? ianaZone(start.zone) : null
  if (zone || start.zone === null)
    return { start: formatDayTime(start.wall), end: formatDayTime(endInZone(z, start, end)), timeZone: zone }
  // A zone that isn't IANA (Outlook's names): show it on this computer's clock. Saving times
  // that weren't changed keeps them exactly as they were written.
  const local = localZone()
  return {
    start: formatDayTime(z.wall(z.date(start), local)),
    end: formatDayTime(z.wall(z.date(end), local)),
    timeZone: local,
  }
}

const unknownZone = (zone: string) =>
  new IcsEditError(
    'invalid',
    `This event uses a time zone Ordo doesn’t know (“${zone.slice(0, 60)}”), so Ordo won’t change it. Change it in the app that made it.`,
  )

// ---- Writing -------------------------------------------------------------------------------

// Control characters other than tab and newline aren't allowed in iCalendar text.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g
const clean = (s: string) => s.replace(/\r\n?/g, '\n').replace(CONTROL, '').trim()

function utcTime(d: Date): ITime {
  return ICAL.Time.fromJSDate(new Date(Math.floor(d.getTime() / 1000) * 1000), true)
}

function writeMoment(comp: Comp, name: string, m: Moment): void {
  comp.removeAllProperties(name)
  const prop = comp.addPropertyWithValue(name, toTime(m))
  if (!m.allDay && m.zone && m.zone !== 'UTC') prop.setParameter('tzid', m.zone)
}

function toTime(m: Moment): ITime {
  if (m.allDay)
    return ICAL.Time.fromData({ year: m.wall.year, month: m.wall.month, day: m.wall.day, isDate: true })
  return ICAL.Time.fromData(
    { ...m.wall, isDate: false },
    m.zone === 'UTC' ? ICAL.Timezone.utcTimezone : undefined,
  )
}

function setText(comp: Comp, name: string, value: string, keepEmpty = false): void {
  comp.removeAllProperties(name)
  const v = clean(value)
  if (v || keepEmpty) comp.addPropertyWithValue(name, v)
}

/**
 * Set the alert the editor shows: replace the alarm it read (the first, if it could show it)
 * and keep every other alarm, such as Apple's acknowledged default or a second reminder.
 */
function setAlert(comp: Comp, minutes: number | null): void {
  const alarms = comp.getAllSubcomponents('valarm')
  const replacing = alarmMinutes(alarms[0]) !== null
  let fresh: Comp | null = null
  if (minutes !== null) {
    fresh = new ICAL.Component('valarm')
    fresh.addPropertyWithValue('action', 'DISPLAY')
    fresh.addPropertyWithValue('description', 'Reminder')
    fresh.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-minutes * 60))
  }
  for (const a of alarms) comp.removeSubcomponent(a)
  for (const a of [...(fresh ? [fresh] : []), ...(replacing ? alarms.slice(1) : alarms)])
    comp.addSubcomponent(a)
}

function draftMoments(d: EventDraft): { start: Moment; end: Moment } {
  const w = draftWalls(d)
  const zone = d.allDay ? null : d.timeZone
  return { start: { allDay: d.allDay, wall: w.start, zone }, end: { allDay: d.allDay, wall: w.end, zone } }
}

function buildRrule(z: Zones, repeat: RepeatRule, start: Moment): InstanceType<typeof ICAL.Recur> {
  const data: Record<string, unknown> = { freq: repeat.frequency.toUpperCase() }
  if (repeat.count !== undefined) data['count'] = repeat.count
  if (repeat.until !== undefined) {
    const day = parseDay(repeat.until)
    if (!day) throw new IcsEditError('invalid', 'Enter the date the repeat ends.')
    if (start.allDay) data['until'] = ICAL.Time.fromData({ ...day, isDate: true })
    else {
      // The end of that day where the event happens. UNTIL is UTC unless the event is floating.
      const last: Moment = {
        allDay: false,
        wall: { ...day, hour: 23, minute: 59, second: 59 },
        zone: start.zone,
      }
      data['until'] = start.zone === null ? toTime(last) : utcTime(z.date(last))
    }
  }
  return ICAL.Recur.fromData(data as never)
}

function stamp(comp: Comp, now: Date, bump: boolean): void {
  comp.updatePropertyWithValue('dtstamp', utcTime(now))
  comp.updatePropertyWithValue('last-modified', utcTime(now))
  if (bump) {
    const seq = Number(comp.getFirstPropertyValue('sequence') ?? 0)
    comp.updatePropertyWithValue('sequence', Number.isFinite(seq) ? seq + 1 : 1)
  }
}

const plausibleYear = (y: number | undefined): y is number =>
  y !== undefined && Number.isInteger(y) && y >= VTIMEZONE_MIN_YEAR && y <= VTIMEZONE_MAX_YEAR

/** The properties whose TZIDs say when an event happens. Others don't need a VTIMEZONE built. */
const DATE_PROPS = ['dtstart', 'dtend', 'recurrence-id', 'exdate', 'rdate']

/**
 * Add a VTIMEZONE for every IANA TZID an event's times use, put them first, and drop ones nothing
 * refers to. The zones cover `focusYear` (the year of the event being written) to ten years on;
 * without one, the earliest plausible start in the document. Nothing from the server sets how
 * much work this is: years outside 1900–2200 are ignored, and more than MAX_ZONES zones is refused.
 */
function tidyTimezones(vcal: Comp, focusYear?: number): void {
  const events = vcal.getAllSubcomponents('vevent')
  const needed = new Set<string>()
  const referenced = new Set<string>()
  const visit = (c: Comp) => {
    for (const p of c.getAllProperties()) {
      const tzid = p.getParameter('tzid')
      if (typeof tzid === 'string') referenced.add(tzid)
    }
    for (const s of c.getAllSubcomponents()) visit(s)
  }
  let earliest: number | undefined
  for (const e of events) {
    visit(e)
    for (const name of DATE_PROPS)
      for (const p of e.getAllProperties(name)) {
        const tzid = p.getParameter('tzid')
        if (typeof tzid === 'string') needed.add(tzid)
      }
    const y = readMoment(e, 'dtstart')?.wall.year
    if (plausibleYear(y)) earliest = Math.min(earliest ?? y, y)
  }
  if (needed.size > MAX_ZONES)
    throw new IcsEditError('invalid', 'This event uses too many time zones for Ordo to change it.')
  const year = plausibleYear(focusYear) ? focusYear : (earliest ?? new Date().getFullYear())
  const have = new Set<string>()
  for (const z of vcal.getAllSubcomponents('vtimezone')) {
    const id = String(z.getFirstPropertyValue('tzid') ?? '')
    if (referenced.has(id) && !have.has(id)) have.add(id)
    else vcal.removeSubcomponent(z)
  }
  const added: Comp[] = []
  for (const id of needed) {
    if (have.has(id) || !ianaZone(id)) continue
    // Aliases of one zone (`/mozilla.org/…/Europe/London`) share the work: see buildVTimezone.
    const vtz = buildVTimezone(id, year, year + 10)
    if (vtz) added.push(vtz)
  }
  // VTIMEZONEs first, as most clients write them.
  const rest = vcal.getAllSubcomponents().filter((c) => c.name !== 'vtimezone')
  const keep = vcal.getAllSubcomponents('vtimezone')
  for (const c of vcal.getAllSubcomponents()) vcal.removeSubcomponent(c)
  for (const c of [...keep, ...added, ...rest]) vcal.addSubcomponent(c)
}

/** Set an event component's fields from a draft. Times are written by the caller. */
function applyText(comp: Comp, d: Pick<EventDraft, 'title' | 'location' | 'notes'>): void {
  setText(comp, 'summary', clean(d.title) || NEW_EVENT_TITLE, true)
  setText(comp, 'location', d.location)
  setText(comp, 'description', d.notes)
}

function setTimes(comp: Comp, start: Moment, end: Moment): void {
  comp.removeAllProperties('duration')
  writeMoment(comp, 'dtstart', start)
  writeMoment(comp, 'dtend', end)
}

/** A random UID, as Apple and Google make them. */
export function newUid(): string {
  return globalThis.crypto.randomUUID().toUpperCase()
}

/** A new CalDAV resource for one event (and its series, if it repeats). */
export function createEventIcs(draft: EventDraft, { uid = newUid(), now = new Date() } = {}): string {
  const vcal = new ICAL.Component('vcalendar')
  vcal.addPropertyWithValue('version', '2.0')
  vcal.addPropertyWithValue('prodid', PRODID)
  vcal.addPropertyWithValue('calscale', 'GREGORIAN')
  const ev = new ICAL.Component('vevent')
  ev.addPropertyWithValue('uid', uid)
  ev.addPropertyWithValue('created', utcTime(now))
  stamp(ev, now, false)
  ev.addPropertyWithValue('sequence', 0)
  applyText(ev, draft)
  const { start, end } = draftMoments(draft)
  setTimes(ev, start, end)
  if (draft.repeat && !draft.repeat.custom)
    ev.addPropertyWithValue('rrule', buildRrule(new Zones(null), draft.repeat, start))
  setAlert(ev, draft.alert)
  vcal.addSubcomponent(ev)
  tidyTimezones(vcal, start.wall.year)
  return vcal.toString() + '\r\n'
}

/** Rewrite each value of a date property with `map`. */
function remapDates(comp: Comp, name: string, map: (m: Moment) => Moment): void {
  const props = comp.getAllProperties(name)
  const out: Moment[] = []
  for (const p of props) {
    const values = p.getValues() as ITime[]
    // Leave anything that isn't a plain date or time (an RDATE period, say) as it was.
    if (!values.every((v) => v && typeof v === 'object' && 'isDate' in v)) continue
    for (const v of values) out.push(map(momentOf(v, p.getParameter('tzid'))))
    comp.removeProperty(p)
  }
  for (const m of out) {
    const prop = comp.addPropertyWithValue(name, toTime(m))
    if (!m.allDay && m.zone && m.zone !== 'UTC') prop.setParameter('tzid', m.zone)
  }
}

/** The draft's times differ from the ones it was read with. */
const timesChanged = (a: EventDraft, b: EventDraft) =>
  a.allDay !== b.allDay || a.start !== b.start || a.end !== b.end || a.timeZone !== b.timeZone

/**
 * Change event `target.uid` in a CalDAV resource. With scope `this` on a repeating event, only
 * the occurrence `target.recurrenceId` changes (an override is written or updated). Otherwise the
 * whole event changes: fields edited in `draft` apply to every occurrence, and the series moves by
 * however much this occurrence's start moved. Times that weren't changed are kept as written.
 */
export function updateEventIcs(
  ics: string,
  target: EventTarget,
  draft: EventDraft,
  scope: EditScope,
  { now = new Date() } = {},
): string {
  const f = find(ics, target.uid)
  const { vcal, master, overrides, z } = f
  const was = occurrence(ics, f, target)
  if (was.facts.unknownZone) throw unknownZone(was.facts.unknownZone)
  const before = was.facts.draft
  const recurring = isRecurring(master)
  const { start, end } = draftMoments(draft)
  const repeatChanged = !sameRepeat(before.repeat, draft.repeat)
  const moved = timesChanged(before, draft)

  if (scope === 'this' && recurring && target.recurrenceId) {
    if (repeatChanged)
      throw new IcsEditError('invalid', 'Change how an event repeats for all events, not just one.')
    const masterStart = readMoment(master!, 'dtstart')!
    let own = overrideFor(z, overrides, target.recurrenceId)
    if (!own) {
      own = new ICAL.Component(ICAL.parse(master!.toString()) as never)
      for (const name of ['rrule', 'rdate', 'exdate', 'exrule', 'recurrence-id', 'created'])
        own.removeAllProperties(name)
      writeMoment(own, 'recurrence-id', occurrenceMoment(z, target.recurrenceId, masterStart))
      vcal.addSubcomponent(own)
      // Unmoved, it keeps the occurrence's own times, in the series' own zone.
      setTimes(own, was.start, was.end)
    }
    applyText(own, draft)
    if (moved) setTimes(own, start, end)
    if (draft.alert !== before.alert) setAlert(own, draft.alert)
    stamp(own, now, true)
    tidyTimezones(vcal, start.wall.year)
    return vcal.toString() + '\r\n'
  }

  // The whole event. Without a master (only an invitation's single occurrence), that occurrence.
  const series = master ?? overrideFor(z, overrides, target.recurrenceId) ?? overrides[0]!
  const changed = {
    title: clean(draft.title) !== clean(before.title),
    location: clean(draft.location) !== clean(before.location),
    notes: clean(draft.notes) !== clean(before.notes),
    alert: draft.alert !== before.alert,
  }
  const textFor = (c: Comp) => ({
    title: changed.title ? draft.title : text(c, 'summary'),
    location: changed.location ? draft.location : text(c, 'location'),
    notes: changed.notes ? draft.notes : text(c, 'description'),
  })
  for (const c of [series, ...(recurring && draft.repeat ? overrides : [])]) {
    if (changed.title || changed.location || changed.notes) applyText(c, textFor(c))
    if (changed.alert) setAlert(c, draft.alert)
  }

  if (!recurring || !draft.repeat) {
    // A single event, or a series that stops repeating: it happens where the editor said.
    if (moved || (recurring && !draft.repeat)) setTimes(series, start, end)
    if (!draft.repeat) {
      for (const name of ['rrule', 'rdate', 'exdate', 'exrule']) series.removeAllProperties(name)
      for (const o of overrides) if (o !== series) vcal.removeSubcomponent(o)
    } else if (repeatChanged || !recurring) {
      series.removeAllProperties('rrule')
      const from = moved ? start : readMoment(series, 'dtstart')!
      if (!draft.repeat.custom) series.addPropertyWithValue('rrule', buildRrule(z, draft.repeat, from))
    }
  } else if (moved) moveSeries(f, series, before, draft, repeatChanged)
  else if (repeatChanged) {
    // Same times, new rule: the series keeps its own start and zone.
    const oldStart = readMoment(series, 'dtstart')!
    series.removeAllProperties('rrule')
    if (!draft.repeat.custom) series.addPropertyWithValue('rrule', buildRrule(z, draft.repeat, oldStart))
    if (before.repeat?.frequency !== draft.repeat.frequency || before.repeat?.custom) {
      series.removeAllProperties('exdate')
      for (const o of overrides) vcal.removeSubcomponent(o)
    }
  }
  stamp(series, now, true)
  for (const o of overrides) if (o !== series && o.parent) stamp(o, now, false)
  tidyTimezones(vcal, start.wall.year)
  return vcal.toString() + '\r\n'
}

/**
 * Move a series as one occurrence was moved: by whole days, then by the change in time of day.
 * EXDATEs, RDATEs, changed occurrences and UNTIL move with it. It keeps its own zone unless the
 * zone itself was changed.
 */
function moveSeries(
  f: Found,
  series: Comp,
  before: EventDraft,
  draft: EventDraft,
  repeatChanged: boolean,
): void {
  const { vcal, overrides, z } = f
  const repeat = draft.repeat!
  const { start, end } = draftMoments(draft)
  const was = draftMoments(before).start
  const oldStart = readMoment(series, 'dtstart')!
  const dayDelta = dayNumber(start.wall) - dayNumber(was.wall)
  const minuteDelta = minutesOfDay(start.wall) - minutesOfDay(was.wall)
  const zoneChanged = draft.timeZone !== before.timeZone || draft.allDay !== before.allDay
  if (before.repeat?.custom && !repeatChanged && (dayDelta !== 0 || start.allDay !== oldStart.allDay))
    // Its rule names days (every Monday and Wednesday, say): moving the start a day wouldn't move them.
    throw new IcsEditError(
      'invalid',
      'This event repeats in a way Ordo can’t move to other days. Change its time, change just this event, or move it in Calendar on your Mac or iPhone.',
    )
  // The series keeps its own zone unless the zone field was changed.
  const zone = start.allDay ? null : zoneChanged || oldStart.allDay ? start.zone : oldStart.zone
  // Each time, on the clock the deltas are measured against.
  const frame = (m: Moment): WallClock =>
    m.allDay || start.allDay ? m.wall : z.wall(z.date(m), zoneChanged ? before.timeZone : zone)
  const shift = (w: WallClock, wasAllDay: boolean): WallClock => {
    const shifted = shiftDays(w, dayDelta)
    if (start.allDay) return { ...shifted, hour: 0, minute: 0, second: 0 }
    if (wasAllDay) return { ...shifted, hour: start.wall.hour, minute: start.wall.minute, second: 0 }
    return addWallMinutes(shifted, minuteDelta)
  }
  const remap = (m: Moment): Moment => ({ allDay: start.allDay, wall: shift(frame(m), m.allDay), zone })

  const newStart = remap(oldStart)
  const length = start.allDay
    ? dayNumber(end.wall) - dayNumber(start.wall)
    : wallMinutes(start.wall, end.wall)
  const newEnd: Moment = {
    ...newStart,
    wall: start.allDay ? shiftDays(newStart.wall, length) : addWallMinutes(newStart.wall, length),
  }
  setTimes(series, newStart, newEnd)

  const frequencyChanged =
    before.repeat?.frequency !== repeat.frequency || (!!before.repeat?.custom && !repeat.custom)
  if (repeatChanged) {
    series.removeAllProperties('rrule')
    if (!repeat.custom) series.addPropertyWithValue('rrule', buildRrule(z, repeat, newStart))
  } else if (!before.repeat?.custom) {
    // UNTIL is an instant: write it again for the new time, and on the day it moved to.
    const until = repeat.until && parseDay(repeat.until)
    const moved = until && dayDelta ? { ...repeat, until: formatDay(shiftDays(until, dayDelta)) } : repeat
    series.removeAllProperties('rrule')
    series.addPropertyWithValue('rrule', buildRrule(z, moved, newStart))
  }
  if (frequencyChanged) {
    // Old exceptions don't line up with a different rule.
    series.removeAllProperties('exdate')
    for (const o of overrides) vcal.removeSubcomponent(o)
    return
  }
  remapDates(series, 'exdate', remap)
  remapDates(series, 'rdate', remap)
  // Changed occurrences move with the series, keeping any change to their own time.
  for (const o of overrides) {
    for (const name of ['recurrence-id', 'dtstart', 'dtend']) remapDates(o, name, remap)
    const s = readMoment(o, 'dtstart')
    const e = readMoment(o, 'dtend')
    // An all-day occurrence lasts at least a day.
    if (s?.allDay && e && dayNumber(e.wall) <= dayNumber(s.wall))
      writeMoment(o, 'dtend', { ...s, wall: shiftDays(s.wall, 1) })
  }
}

const minutesOfDay = (w: WallClock) => w.hour * 60 + w.minute

/**
 * Delete event `target.uid` from a CalDAV resource. Returns the resource without it, or null when
 * nothing is left and the whole resource should be deleted. With scope `this` on a repeating event
 * only that occurrence goes (an EXDATE, and its override if it had one).
 */
export function deleteFromIcs(
  ics: string,
  target: EventTarget,
  scope: EditScope,
  { now = new Date() } = {},
): string | null {
  const f = find(ics, target.uid)
  const { vcal, master, overrides, z } = f
  if (scope === 'all' || !target.recurrenceId || (master && !isRecurring(master))) {
    for (const v of [master, ...overrides]) if (v) vcal.removeSubcomponent(v)
    return vcal.getAllSubcomponents('vevent').length ? finish(vcal) : null
  }
  const own = overrideFor(z, overrides, target.recurrenceId)
  if (!own && !master) throw new IcsEditError('not-found', NO_OCCURRENCE)
  if (!own) checkOccurrence(ics, f, target)
  if (own) vcal.removeSubcomponent(own)
  if (master) {
    const masterStart = readMoment(master, 'dtstart')!
    if (!masterStart.allDay && !z.known(masterStart.zone)) throw unknownZone(masterStart.zone!)
    const m = occurrenceMoment(z, target.recurrenceId, masterStart)
    const prop = master.addPropertyWithValue('exdate', toTime(m))
    if (!m.allDay && m.zone && m.zone !== 'UTC') prop.setParameter('tzid', m.zone)
    stamp(master, now, true)
  }
  return vcal.getAllSubcomponents('vevent').length ? finish(vcal) : null
}

function finish(vcal: Comp): string {
  tidyTimezones(vcal)
  return vcal.toString() + '\r\n'
}

/** The occurrences a draft would have in `range`, for showing a new event before it's saved. */
export function previewDraft(
  draft: EventDraft,
  { uid, calendarId, range }: { uid: string; calendarId: string; range: DateRange },
): CalendarEvent[] {
  return parseIcs(createEventIcs(draft, { uid }), { calendarId, range })
}

/** The UID of the first event in an iCalendar document, if any. */
export function firstUid(ics: string): string | null {
  try {
    const vcal = load(ics)
    const uid = vcal.getFirstSubcomponent('vevent')?.getFirstPropertyValue('uid')
    return uid ? String(uid) : null
  } catch {
    return null
  }
}
