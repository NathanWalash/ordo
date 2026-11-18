// Writing iCalendar: a new event from a draft, a change to one occurrence or to a whole series,
// and deleting either. Pure (ical.js and Intl only), so the renderer can preview with it too.
//
// Changes keep everything Ordo doesn't edit (attendees, URLs, other apps' X- properties, extra
// alarms) and bump SEQUENCE, as RFC 5545 asks. "This event only" writes a RECURRENCE-ID override,
// or an EXDATE when deleting. "All events" moves the series by however much the occurrence moved.
import ICAL from 'ical.js'
import {
  addWallMinutes,
  dateToWall,
  dayNumber,
  draftWalls,
  formatDay,
  formatDayTime,
  NEW_EVENT_TITLE,
  parseDay,
  sameRepeat,
  shiftDays,
  wallMinutes,
  wallToDate,
  type EventDraft,
  type RepeatFrequency,
  type RepeatRule,
} from './draft'
import { parseIcs } from './ics'
import { dayKey, ianaZone, localZone, type WallClock } from './time'
import type { CalendarEvent, DateRange } from './types'
import { buildVTimezone } from './vtimezone'

type Comp = InstanceType<typeof ICAL.Component>
type ITime = InstanceType<typeof ICAL.Time>

export const PRODID = '-//Ordo//Ordo Calendar//EN'

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

/** The zone a moment's wall clock is in, as Ordo understands it (an unknown TZID counts as local). */
const zoneOf = (m: Moment): string | null => (m.zone === 'UTC' ? 'UTC' : m.zone ? ianaZone(m.zone) : null)

function momentToDate(m: Moment): Date {
  if (m.allDay) return new Date(m.wall.year, m.wall.month - 1, m.wall.day)
  return wallToDate(m.wall, zoneOf(m))
}

/** The key `parseIcs` uses for an occurrence: `YYYY-MM-DD` for all-day, else the ISO instant. */
const momentKey = (m: Moment) => (m.allDay ? formatDay(m.wall) : momentToDate(m).toISOString())

/** The occurrence `recurrenceId` names, written the way the series' DTSTART is. */
function occurrenceMoment(recurrenceId: string, master: Moment): Moment {
  const day = parseDay(recurrenceId)
  if (master.allDay) {
    const d = day ?? parseDay(dayKey(new Date(recurrenceId)))
    if (!d) throw new IcsEditError('invalid', 'That occurrence isn’t a date.')
    return { allDay: true, wall: d, zone: null }
  }
  const instant = day ? new Date(day.year, day.month - 1, day.day) : new Date(recurrenceId)
  if (Number.isNaN(instant.getTime())) throw new IcsEditError('invalid', 'That occurrence isn’t a time.')
  return { allDay: false, wall: dateToWall(instant, zoneOf(master)), zone: master.zone }
}

interface Found {
  vcal: Comp
  master: Comp | null
  overrides: Comp[]
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
  return { vcal, master, overrides }
}

const isRecurring = (c: Comp | null) => !!c && (c.hasProperty('rrule') || c.hasProperty('rdate'))

function overrideFor(overrides: Comp[], recurrenceId: string | undefined): Comp | undefined {
  if (!recurrenceId) return undefined
  return overrides.find((o) => {
    const m = readMoment(o, 'recurrence-id')
    return m && momentKey(m) === recurrenceId
  })
}

/** Start and end of a component, from DTEND or DURATION, as written. */
function span(comp: Comp): { start: Moment; end: Moment } {
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
    const instant = new Date(momentToDate(start).getTime() + seconds * 1000)
    return { start, end: { ...start, wall: dateToWall(instant, zoneOf(start)) } }
  }
  return { start, end: start.allDay ? { ...start, wall: shiftDays(start.wall, 1) } : start }
}

const text = (comp: Comp, name: string) => {
  const v = comp.getFirstPropertyValue(name)
  return typeof v === 'string' ? v : ''
}

function readAlert(comp: Comp): number | null {
  const alarm = comp.getFirstSubcomponent('valarm')
  if (!alarm) return null
  const prop = alarm.getFirstProperty('trigger')
  const v = prop?.getFirstValue() as { toSeconds?: () => number } | null
  if (!prop || !v || typeof v.toSeconds !== 'function') return null
  if (String(prop.getParameter('related') ?? 'START').toUpperCase() !== 'START') return null
  return Math.round(-v.toSeconds() / 60) || 0
}

const FREQS: Record<string, RepeatFrequency> = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  YEARLY: 'yearly',
}
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

function readRepeat(master: Comp, start: Moment): RepeatRule | null {
  const recur = master.getFirstPropertyValue('rrule') as InstanceType<typeof ICAL.Recur> | null
  if (!recur || typeof recur !== 'object' || !('freq' in recur))
    return master.hasProperty('rdate') ? { frequency: 'daily', custom: true } : null
  const frequency = FREQS[String(recur.freq).toUpperCase()]
  if (!frequency) return { frequency: 'daily', custom: true }
  const rule: RepeatRule = { frequency }
  if (recur.count) rule.count = recur.count
  if (recur.until) {
    const u = recur.until
    rule.until = u.isDate
      ? formatDay(u)
      : formatDay(dateToWall(momentToDate(momentOf(u, undefined)), zoneOf(start)))
  }
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
}

/** The draft for one occurrence (or the only one) of event `uid` in a CalDAV resource. */
export function readEvent(ics: string, target: EventTarget): EventFacts {
  const { master, overrides } = find(ics, target.uid)
  const own = overrideFor(overrides, target.recurrenceId)
  const base = own ?? master ?? overrides[0]!
  let { start, end } = span(base)
  if (!own && master && target.recurrenceId && isRecurring(master)) {
    // An occurrence of the series: the series' times, moved to this occurrence.
    const occurrence = occurrenceMoment(target.recurrenceId, start)
    end = start.allDay
      ? { ...occurrence, wall: shiftDays(occurrence.wall, dayNumber(end.wall) - dayNumber(start.wall)) }
      : {
          ...occurrence,
          wall: addWallMinutes(occurrence.wall, wallMinutes(start.wall, endInZone(start, end))),
        }
    start = occurrence
  }
  const series = master ?? base
  const organizer = String(series.getFirstPropertyValue('organizer') ?? '').replace(/^mailto:/i, '')
  const attendees = series.getAllProperties('attendee').length
  return {
    draft: {
      title: text(base, 'summary'),
      allDay: start.allDay,
      ...times(start, end),
      location: text(base, 'location'),
      notes: text(base, 'description'),
      repeat: master ? readRepeat(master, readMoment(master, 'dtstart')!) : null,
      alert: readAlert(base),
    },
    recurring: isRecurring(master),
    ...(organizer && attendees > 0 && { organizer }),
    attendees,
  }
}

/** The end's wall clock in the start's zone. */
function endInZone(start: Moment, end: Moment): WallClock {
  if (end.zone === start.zone) return end.wall
  return dateToWall(momentToDate(end), zoneOf(start))
}

function times(start: Moment, end: Moment): Pick<EventDraft, 'start' | 'end' | 'timeZone'> {
  if (start.allDay) {
    const last = Math.max(dayNumber(start.wall), dayNumber(end.wall) - 1)
    return {
      start: formatDay(start.wall),
      end: formatDay(shiftDays(start.wall, last - dayNumber(start.wall))),
      timeZone: null,
    }
  }
  const zone = zoneOf(start)
  if (zone || start.zone === null) {
    return { start: formatDayTime(start.wall), end: formatDayTime(endInZone(start, end)), timeZone: zone }
  }
  // A TZID this computer doesn't know: show it in local time, and save it that way.
  const local = localZone()
  return {
    start: formatDayTime(dateToWall(momentToDate(start), local)),
    end: formatDayTime(dateToWall(momentToDate(end), local)),
    timeZone: local,
  }
}

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

function setAlert(comp: Comp, minutes: number | null): void {
  for (const a of comp.getAllSubcomponents('valarm')) comp.removeSubcomponent(a)
  if (minutes === null) return
  const alarm = new ICAL.Component('valarm')
  alarm.addPropertyWithValue('action', 'DISPLAY')
  alarm.addPropertyWithValue('description', 'Reminder')
  alarm.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-minutes * 60))
  comp.addSubcomponent(alarm)
}

function draftMoments(d: EventDraft): { start: Moment; end: Moment } {
  const w = draftWalls(d)
  const zone = d.allDay ? null : d.timeZone
  return { start: { allDay: d.allDay, wall: w.start, zone }, end: { allDay: d.allDay, wall: w.end, zone } }
}

function buildRrule(repeat: RepeatRule, start: Moment): InstanceType<typeof ICAL.Recur> {
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
      data['until'] = start.zone === null ? toTime(last) : utcTime(momentToDate(last))
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

/** Add a VTIMEZONE for every TZID in use, put them first, and drop ones nothing uses. */
function tidyTimezones(vcal: Comp): void {
  const events = vcal.getAllSubcomponents('vevent')
  const used = new Set<string>()
  let from = Infinity
  let to = -Infinity
  const visit = (c: Comp) => {
    for (const p of c.getAllProperties()) {
      const tzid = p.getParameter('tzid')
      if (typeof tzid === 'string') used.add(tzid)
    }
    for (const s of c.getAllSubcomponents()) visit(s)
  }
  for (const e of events) {
    visit(e)
    const s = readMoment(e, 'dtstart')
    if (s) {
      from = Math.min(from, s.wall.year)
      to = Math.max(to, s.wall.year)
    }
  }
  const zones = vcal.getAllSubcomponents('vtimezone')
  const have = new Set<string>()
  for (const z of zones) {
    const id = String(z.getFirstPropertyValue('tzid') ?? '')
    if (used.has(id) && !have.has(id)) have.add(id)
    else vcal.removeSubcomponent(z)
  }
  const added: Comp[] = []
  for (const id of used) {
    if (have.has(id) || !ianaZone(id)) continue
    const year = Number.isFinite(from) ? from : new Date().getFullYear()
    const vtz = buildVTimezone(id, year, Math.max(year + 10, Number.isFinite(to) ? to : year))
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
  if (draft.repeat && !draft.repeat.custom) ev.addPropertyWithValue('rrule', buildRrule(draft.repeat, start))
  setAlert(ev, draft.alert)
  vcal.addSubcomponent(ev)
  tidyTimezones(vcal)
  return vcal.toString() + '\r\n'
}

/** Remove whichever values of a multi-valued date property match `drop`. */
function remapDates(comp: Comp, name: string, map: (m: Moment) => Moment | null): void {
  const props = comp.getAllProperties(name)
  const out: Moment[] = []
  for (const p of props) {
    for (const v of p.getValues() as ITime[]) {
      if (!v || typeof v !== 'object' || !('isDate' in v)) continue
      const m = map(momentOf(v, p.getParameter('tzid')))
      if (m) out.push(m)
    }
    comp.removeProperty(p)
  }
  for (const m of out) {
    const prop = comp.addPropertyWithValue(name, toTime(m))
    if (!m.allDay && m.zone && m.zone !== 'UTC') prop.setParameter('tzid', m.zone)
  }
}

/**
 * Change event `target.uid` in a CalDAV resource. With scope `this` on a repeating event, only
 * the occurrence `target.recurrenceId` changes (an override is written or updated). Otherwise the
 * whole event changes: fields edited in `draft` apply to every occurrence, and the series moves by
 * however much this occurrence's start moved.
 */
export function updateEventIcs(
  ics: string,
  target: EventTarget,
  draft: EventDraft,
  scope: EditScope,
  { now = new Date() } = {},
): string {
  const found = find(ics, target.uid)
  const { vcal, master, overrides } = found
  const before = readEvent(ics, target).draft
  const recurring = isRecurring(master)
  const { start, end } = draftMoments(draft)
  const repeatChanged = !sameRepeat(before.repeat, draft.repeat)

  if (scope === 'this' && recurring && target.recurrenceId) {
    if (repeatChanged)
      throw new IcsEditError('invalid', 'Change how an event repeats for all events, not just one.')
    const masterStart = readMoment(master!, 'dtstart')!
    let own = overrideFor(overrides, target.recurrenceId)
    if (!own) {
      own = new ICAL.Component(ICAL.parse(master!.toString()) as never)
      for (const name of ['rrule', 'rdate', 'exdate', 'exrule', 'recurrence-id', 'created'])
        own.removeAllProperties(name)
      writeMoment(own, 'recurrence-id', occurrenceMoment(target.recurrenceId, masterStart))
      vcal.addSubcomponent(own)
    }
    applyText(own, draft)
    setTimes(own, start, end)
    if (draft.alert !== before.alert) setAlert(own, draft.alert)
    stamp(own, now, true)
    tidyTimezones(vcal)
    return vcal.toString() + '\r\n'
  }

  // The whole event. Without a master (only an invitation's single occurrence), that occurrence.
  const series = master ?? overrideFor(overrides, target.recurrenceId) ?? overrides[0]!
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
    setTimes(series, start, end)
    if (!draft.repeat) {
      for (const name of ['rrule', 'rdate', 'exdate', 'exrule']) series.removeAllProperties(name)
      for (const o of overrides) if (o !== series) vcal.removeSubcomponent(o)
    } else if (repeatChanged || !recurring) {
      series.removeAllProperties('rrule')
      if (!draft.repeat.custom) series.addPropertyWithValue('rrule', buildRrule(draft.repeat, start))
    }
  } else {
    // Move the series as the occurrence moved: by whole days, then by the change in time of day.
    const oldStart = readMoment(series, 'dtstart')!
    const was = draftMoments(before).start
    const dayDelta = dayNumber(start.wall) - dayNumber(was.wall)
    const minuteDelta = minutesOfDay(start.wall) - minutesOfDay(was.wall)
    // The series start, on the clock of the zone the editor showed.
    const oldWall =
      start.allDay || oldStart.allDay ? oldStart.wall : dateToWall(momentToDate(oldStart), before.timeZone)
    const moved = (w: WallClock, wasAllDay: boolean): WallClock => {
      const shifted = shiftDays(w, dayDelta)
      if (start.allDay) return { ...shifted, hour: 0, minute: 0, second: 0 }
      if (wasAllDay) return { ...shifted, hour: start.wall.hour, minute: start.wall.minute, second: 0 }
      return addWallMinutes(shifted, minuteDelta)
    }
    const newStart: Moment = { allDay: start.allDay, wall: moved(oldWall, oldStart.allDay), zone: start.zone }
    const length = start.allDay
      ? dayNumber(end.wall) - dayNumber(start.wall)
      : wallMinutes(start.wall, end.wall)
    const newEnd: Moment = {
      ...newStart,
      wall: start.allDay ? shiftDays(newStart.wall, length) : addWallMinutes(newStart.wall, length),
    }
    setTimes(series, newStart, newEnd)

    const frequencyChanged =
      before.repeat?.frequency !== draft.repeat.frequency || (!!before.repeat?.custom && !draft.repeat.custom)
    if (repeatChanged) {
      series.removeAllProperties('rrule')
      if (!draft.repeat.custom) series.addPropertyWithValue('rrule', buildRrule(draft.repeat, newStart))
    } else if (
      !before.repeat?.custom &&
      (dayDelta || minuteDelta || start.allDay !== oldStart.allDay || start.zone !== oldStart.zone)
    ) {
      // UNTIL is an instant: write it again for the new time of day.
      series.removeAllProperties('rrule')
      series.addPropertyWithValue('rrule', buildRrule(draft.repeat, newStart))
    }
    if (frequencyChanged) {
      // Old exceptions don't line up with a different rule.
      series.removeAllProperties('exdate')
      for (const o of overrides) vcal.removeSubcomponent(o)
    } else {
      const remap = (m: Moment): Moment => {
        const wall = m.allDay || start.allDay ? m.wall : dateToWall(momentToDate(m), before.timeZone)
        return { allDay: start.allDay, wall: moved(wall, m.allDay), zone: start.zone }
      }
      remapDates(series, 'exdate', remap)
      for (const o of overrides) remapDates(o, 'recurrence-id', remap)
    }
  }
  stamp(series, now, true)
  for (const o of overrides) if (o !== series && o.parent) stamp(o, now, false)
  tidyTimezones(vcal)
  return vcal.toString() + '\r\n'
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
  const { vcal, master, overrides } = find(ics, target.uid)
  if (scope === 'all' || !target.recurrenceId || (master && !isRecurring(master))) {
    for (const v of [master, ...overrides]) if (v) vcal.removeSubcomponent(v)
    return vcal.getAllSubcomponents('vevent').length ? finish(vcal) : null
  }
  const own = overrideFor(overrides, target.recurrenceId)
  if (own) vcal.removeSubcomponent(own)
  if (master) {
    const m = occurrenceMoment(target.recurrenceId, readMoment(master, 'dtstart')!)
    const prop = master.addPropertyWithValue('exdate', toTime(m))
    if (!m.allDay && m.zone && m.zone !== 'UTC') prop.setParameter('tzid', m.zone)
    stamp(master, now, true)
  } else if (!own) throw new IcsEditError('not-found', 'That occurrence wasn’t found.')
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
