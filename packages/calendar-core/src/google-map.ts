// Google Calendar API v3 events, as Ordo keeps them: each series (a recurring event with its
// changed and cancelled occurrences) or single event becomes one iCalendar resource, so recurrence
// is expanded, shown and edited exactly as for iCloud. Going the other way, an edited iCalendar
// event is read back into the few Google fields Ordo changes. Pure (ical.js and Intl only).
import ICAL from 'ical.js'
import { dayKey, floatingTime, ianaZone, utcToZoned, zonedTimeToUtc } from './time'

type Comp = InstanceType<typeof ICAL.Component>
type ITime = InstanceType<typeof ICAL.Time>
type IProp = InstanceType<typeof ICAL.Property>

/** `start`, `end` and `originalStartTime` of a Google event: a date (all-day) or an instant. */
export interface GoogleTime {
  /** All-day: `YYYY-MM-DD`. */
  date?: string
  /** RFC 3339. Google sends it with an offset; Ordo writes a wall-clock time with `timeZone`. */
  dateTime?: string
  /** IANA zone. Google requires one on recurring events. */
  timeZone?: string
}

export interface GoogleReminders {
  useDefault?: boolean
  overrides?: { method?: string; minutes?: number }[]
}

/** The parts of a Calendar API event resource Ordo reads (everything else is left alone on Google). */
export interface GoogleEvent {
  id: string
  etag?: string
  status?: string
  iCalUID?: string
  summary?: string
  description?: string
  location?: string
  start?: GoogleTime
  end?: GoogleTime
  recurrence?: string[]
  recurringEventId?: string
  originalStartTime?: GoogleTime
  reminders?: GoogleReminders
  organizer?: { email?: string; self?: boolean }
  attendees?: { email?: string; self?: boolean; responseStatus?: string }[]
  /** `default`, `outOfOffice`, `focusTime`, `workingLocation`, `birthday`, `fromGmail`. */
  eventType?: string
  updated?: string
}

/** A calendarList entry. */
export interface GoogleCalendarListEntry {
  id: string
  summary?: string
  summaryOverride?: string
  backgroundColor?: string
  /** `owner` and `writer` can change events; `reader` and `freeBusyReader` can't. */
  accessRole?: string
  primary?: boolean
  selected?: boolean
  hidden?: boolean
  deleted?: boolean
  timeZone?: string
}

/** The fields Ordo writes to Google: compared before and after an edit, and only changes are sent. */
export interface GoogleFields {
  summary: string
  description: string
  location: string
  start: GoogleTime
  end: GoogleTime
  recurrence?: string[]
  reminders?: { useDefault: false; overrides: { method: 'popup'; minutes: number }[] }
}

/** Marks an event Ordo shows but won't change (out of office, focus time, birthdays). */
export const READ_ONLY_PROP = 'x-ordo-read-only'

const MAX_ATTENDEES = 100
const MAX_TEXT = 20_000
// Free text (titles, notes, places) keeps tabs and line breaks: ical.js escapes TEXT values when
// it writes them. Nothing else may hold a control character at all.
// eslint-disable-next-line no-control-regex
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
// eslint-disable-next-line no-control-regex
const ANY_CONTROL = /[\u0000-\u001f\u007f]/g
// eslint-disable-next-line no-control-regex
const HAS_CONTROL = /[\u0000-\u001f\u007f]/

/** Free text from the server: titles, descriptions, locations. */
const text = (v: unknown, max = MAX_TEXT) =>
  typeof v === 'string' ? v.replace(TEXT_CONTROL, '').slice(0, max) : undefined
/**
 * Every other value from the server (ids, ETags, statuses, times, zone names, addresses): no
 * control characters at all, so none can end an iCalendar line and start a property of its own.
 */
const token = (v: unknown, max: number) =>
  typeof v === 'string' ? v.replace(ANY_CONTROL, '').slice(0, max) : undefined

/**
 * An email address Ordo will write as a CAL-ADDRESS (`mailto:`), which ical.js doesn't escape:
 * one @, no spaces, quotes, angle brackets, separators or control characters.
 */
const EMAIL =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/
export function safeEmail(v: unknown): string | undefined {
  return typeof v === 'string' && v.length <= 254 && EMAIL.test(v) ? v : undefined
}

const time = (t: unknown): GoogleTime | undefined => {
  if (!t || typeof t !== 'object') return undefined
  const o = t as Record<string, unknown>
  const out: GoogleTime = {}
  const date = token(o['date'], 10)
  const dateTime = token(o['dateTime'], 40)
  const timeZone = token(o['timeZone'], 64)
  if (date) out.date = date
  if (dateTime) out.dateTime = dateTime
  if (timeZone) out.timeZone = timeZone
  return out.date || out.dateTime ? out : undefined
}

/**
 * Keep only what Ordo uses from an event the server sent, checked for type, so the cache stays
 * small and nothing unexpected is stored. Null when it isn't an event at all.
 */
export function trimEvent(raw: unknown): GoogleEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = token(o['id'], 1024)
  if (!id) return null
  const e: GoogleEvent = { id }
  const set = <K extends keyof GoogleEvent>(k: K, v: GoogleEvent[K] | undefined) => {
    if (v !== undefined && v !== '') e[k] = v
  }
  set('etag', token(o['etag'], 200))
  set('status', token(o['status'], 20))
  set('iCalUID', token(o['iCalUID'], 1024))
  set('summary', text(o['summary'], 1000))
  set('description', text(o['description']))
  set('location', text(o['location'], 2000))
  set('start', time(o['start']))
  set('end', time(o['end']))
  set('recurringEventId', token(o['recurringEventId'], 1024))
  set('originalStartTime', time(o['originalStartTime']))
  const kind = token(o['eventType'], 40)
  if (kind && /^\w+$/.test(kind)) e.eventType = kind
  set('updated', token(o['updated'], 40))
  // A recurrence line with any control character in it is dropped whole, never cleaned up into
  // something else.
  if (Array.isArray(o['recurrence']))
    e.recurrence = o['recurrence']
      .filter((l): l is string => typeof l === 'string' && l.length <= 4000 && !HAS_CONTROL.test(l))
      .slice(0, 100)
  const r = o['reminders']
  if (r && typeof r === 'object') {
    const rr = r as Record<string, unknown>
    e.reminders = {
      useDefault: rr['useDefault'] === true,
      ...(Array.isArray(rr['overrides']) && {
        overrides: rr['overrides'].slice(0, 5).map((x) => ({
          method: token((x as Record<string, unknown>)?.['method'], 20),
          minutes: Number((x as Record<string, unknown>)?.['minutes']),
        })),
      }),
    }
  }
  // Addresses are kept as sent (control characters and all) only to be checked with safeEmail()
  // before anything is written: cleaning one up could turn it into someone else's address.
  const org = o['organizer']
  if (org && typeof org === 'object') {
    const oo = org as Record<string, unknown>
    e.organizer = {
      email: typeof oo['email'] === 'string' ? oo['email'].slice(0, 320) : undefined,
      self: oo['self'] === true,
    }
  }
  if (Array.isArray(o['attendees']))
    e.attendees = o['attendees'].slice(0, MAX_ATTENDEES).map((a) => {
      const aa = (a ?? {}) as Record<string, unknown>
      return {
        email: typeof aa['email'] === 'string' ? aa['email'].slice(0, 320) : undefined,
        self: aa['self'] === true,
        responseStatus: token(aa['responseStatus'], 20),
      }
    })
  return e
}

// ---- Google → iCalendar ----------------------------------------------------------------------

const HAS_OFFSET = /(Z|[+-]\d\d:?\d\d)$/i

/** Google sends descriptions as HTML when they were written in its editor; show them as text. */
export function plainText(s: string | undefined): string {
  if (!s) return ''
  if (!/<\/?[a-z][^>]*>/i.test(s)) return s
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/

/** Write a Google time as an iCalendar property: a date, a TZID wall clock, or UTC. */
function addTime(comp: Comp, name: string, t: GoogleTime, zoneHint?: string): boolean {
  if (t.date) {
    const m = DATE.exec(t.date)
    if (!m) return false
    comp.addPropertyWithValue(
      name,
      ICAL.Time.fromData({ year: +m[1]!, month: +m[2]!, day: +m[3]!, isDate: true }),
    )
    return true
  }
  if (!t.dateTime) return false
  const zone = ianaZone(t.timeZone ?? zoneHint)
  let instant: Date
  if (HAS_OFFSET.test(t.dateTime)) instant = new Date(t.dateTime)
  else {
    // A wall-clock time in its zone (as Ordo writes them).
    const m = WALL.exec(t.dateTime)
    if (!m) return false
    const wall = {
      year: +m[1]!,
      month: +m[2]!,
      day: +m[3]!,
      hour: +m[4]!,
      minute: +m[5]!,
      second: +(m[6] ?? 0),
    }
    instant = zone
      ? zonedTimeToUtc(wall, zone)
      : new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second))
  }
  if (Number.isNaN(instant.getTime())) return false
  if (zone && zone !== 'UTC') {
    const w = utcToZoned(instant, zone)
    const prop = comp.addPropertyWithValue(name, ICAL.Time.fromData({ ...w, isDate: false }))
    prop.setParameter('tzid', zone)
  } else {
    comp.addPropertyWithValue(
      name,
      ICAL.Time.fromJSDate(new Date(Math.floor(instant.getTime() / 1000) * 1000), true),
    )
  }
  return true
}

const RECURRENCE_LINE = /^(RRULE|EXRULE|RDATE|EXDATE)[;:]/i

function addRecurrence(comp: Comp, lines: string[] | undefined): void {
  for (const line of lines ?? []) {
    // One property per line, from Google's server: never let a line break start another.
    if (!RECURRENCE_LINE.test(line) || HAS_CONTROL.test(line)) continue
    try {
      comp.addProperty(ICAL.Property.fromString(line))
    } catch {
      // A line ical.js can't read is left out rather than hiding the whole event.
    }
  }
}

function addText(comp: Comp, name: string, value: string | undefined): void {
  const v = (value ?? '').replace(/\r\n?/g, '\n').trim()
  if (v) comp.addPropertyWithValue(name, v)
}

function addAlarms(comp: Comp, reminders: GoogleReminders | undefined): void {
  if (!reminders || reminders.useDefault) return
  for (const r of reminders.overrides ?? []) {
    const minutes = Number(r.minutes)
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 40_320) continue
    const alarm = new ICAL.Component('valarm')
    alarm.addPropertyWithValue('action', 'DISPLAY')
    alarm.addPropertyWithValue('description', 'Reminder')
    alarm.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-Math.round(minutes) * 60))
    comp.addSubcomponent(alarm)
  }
}

const selfDeclined = (e: GoogleEvent) =>
  e.attendees?.some((a) => a.self && a.responseStatus === 'declined') ?? false

/** Out of office, focus time, birthdays and Gmail events: shown, but changed only in Google Calendar. */
const special = (e: GoogleEvent) =>
  !!e.eventType && /^\w{1,40}$/.test(e.eventType) && e.eventType !== 'default'

/** Stands in for an organiser (or guest) address Ordo won't write. */
const UNKNOWN_ORGANIZER = 'unknown@invalid'

function vevent(e: GoogleEvent, uid: string, calendarGoogleId: string, zoneHint?: string): Comp | null {
  const comp = new ICAL.Component('vevent')
  comp.addPropertyWithValue('uid', uid)
  if (!e.start || !addTime(comp, 'dtstart', e.start, zoneHint)) return null
  if (e.end) addTime(comp, 'dtend', e.end, e.start.timeZone ?? zoneHint)
  if (e.updated && !Number.isNaN(Date.parse(e.updated)))
    comp.addPropertyWithValue(
      'dtstamp',
      ICAL.Time.fromJSDate(new Date(Math.floor(Date.parse(e.updated) / 1000) * 1000), true),
    )
  addText(comp, 'summary', e.summary)
  addText(comp, 'location', e.location)
  addText(comp, 'description', plainText(e.description))
  if (e.status === 'tentative') comp.addPropertyWithValue('status', 'TENTATIVE')
  // Someone else's invitation: Ordo leaves it to Google Calendar, so the organiser hears about
  // changes. Events on a shared calendar are "organised" by the calendar itself: those are yours.
  // Addresses go in as CAL-ADDRESS values, which ical.js writes as they are: only ones that pass
  // safeEmail() are written. An organiser whose address doesn't still makes it an invitation.
  const org = e.organizer
  if (org?.email && !org.self && org.email.toLowerCase() !== calendarGoogleId.toLowerCase()) {
    comp.addPropertyWithValue('organizer', `mailto:${safeEmail(org.email) ?? UNKNOWN_ORGANIZER}`)
    for (const a of e.attendees ?? []) {
      const email = safeEmail(a.email)
      if (email) comp.addPropertyWithValue('attendee', `mailto:${email}`)
    }
    if (!comp.hasProperty('attendee')) comp.addPropertyWithValue('attendee', `mailto:${UNKNOWN_ORGANIZER}`)
  }
  if (special(e)) comp.addPropertyWithValue(READ_ONLY_PROP, e.eventType!)
  addAlarms(comp, e.reminders)
  return comp
}

function addRecurrenceId(comp: Comp, original: GoogleTime, zoneHint?: string): boolean {
  return addTime(comp, 'recurrence-id', original, zoneHint)
}

/**
 * One series (or single event) as an iCalendar resource: the master with its RRULE/EXDATE lines,
 * changed occurrences as RECURRENCE-ID overrides, cancelled ones (and ones you declined) as
 * cancelled overrides. Without a master (you were invited to a single occurrence), the
 * occurrences on their own. Null when nothing is left to show.
 */
export function groupToIcs(
  group: { master?: GoogleEvent; exceptions: GoogleEvent[] },
  calendarGoogleId: string,
): { ics: string; uid: string } | null {
  const { master } = group
  if (master && (master.status === 'cancelled' || selfDeclined(master))) return null
  const first = master ?? group.exceptions.find((e) => e.status !== 'cancelled' && !selfDeclined(e))
  if (!first) return null
  const uid = (first.iCalUID || first.recurringEventId || first.id).replace(ANY_CONTROL, '').slice(0, 1024)
  if (!uid) return null
  const vcal = new ICAL.Component('vcalendar')
  vcal.addPropertyWithValue('version', '2.0')
  vcal.addPropertyWithValue('prodid', '-//Ordo//Google Calendar//EN')
  const zone = master?.start?.timeZone
  if (master) {
    const m = vevent(master, uid, calendarGoogleId)
    if (!m) return null
    addRecurrence(m, master.recurrence)
    vcal.addSubcomponent(m)
  }
  for (const e of group.exceptions) {
    if (!e.originalStartTime) continue
    const gone = e.status === 'cancelled' || selfDeclined(e)
    if (gone && !master) continue
    let comp: Comp | null
    if (gone) {
      comp = new ICAL.Component('vevent')
      comp.addPropertyWithValue('uid', uid)
      if (!addTime(comp, 'dtstart', e.originalStartTime, zone)) continue
      comp.addPropertyWithValue('status', 'CANCELLED')
    } else comp = vevent(e, uid, calendarGoogleId, zone)
    if (!comp || !addRecurrenceId(comp, e.originalStartTime, zone)) continue
    vcal.addSubcomponent(comp)
  }
  if (!vcal.getFirstSubcomponent('vevent')) return null
  return { ics: vcal.toString() + '\r\n', uid }
}

// ---- iCalendar → Google ----------------------------------------------------------------------

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const wallText = (t: ITime) =>
  `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`
const isUtc = (t: ITime) => t.zone === ICAL.Timezone.utcTimezone || t.zone?.tzid === 'UTC'

/** An iCalendar time value with its TZID as a Google time. */
function googleTime(t: ITime, tzid: unknown, fallbackZone: string): GoogleTime {
  if (t.isDate) return { date: `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}` }
  if (isUtc(t)) return { dateTime: `${wallText(t)}Z`, timeZone: 'UTC' }
  if (typeof tzid === 'string') {
    const zone = ianaZone(tzid)
    if (!zone) throw new RangeError(`Unknown time zone ${tzid}`)
    return { dateTime: wallText(t), timeZone: zone }
  }
  // Floating time: Google has none, so it happens at that time where the calendar is.
  return { dateTime: wallText(t), timeZone: fallbackZone }
}

/** The instant (or day) a time value names, for matching occurrences: as `parseIcs` keys them. */
export function timeKey(t: ITime, tzid: unknown): string {
  const wall = { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second }
  if (t.isDate) return dayKey(new Date(t.year, t.month - 1, t.day))
  if (isUtc(t))
    return new Date(Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second)).toISOString()
  const zone = typeof tzid === 'string' ? ianaZone(tzid) : null
  return (zone ? zonedTimeToUtc(wall, zone) : floatingTime(wall)).toISOString()
}

/** The same key for a Google time (an exception's `originalStartTime`). */
export function googleTimeKey(t: GoogleTime): string | null {
  const comp = new ICAL.Component('vevent')
  if (!addTime(comp, 'x-key', t)) return null
  const p = comp.getFirstProperty('x-key')!
  return timeKey(p.getFirstValue() as ITime, p.getParameter('tzid'))
}

/** The values of a date-list property (EXDATE, RDATE) as keys. */
function dateKeys(prop: IProp): string[] {
  const tzid = prop.getParameter('tzid')
  return prop
    .getValues()
    .filter((v): v is ITime => v instanceof ICAL.Time)
    .map((v) => timeKey(v, tzid))
}

/** Every EXDATE of a component, as keys. */
export function exdateKeys(comp: Comp): Set<string> {
  return new Set(comp.getAllProperties('exdate').flatMap(dateKeys))
}

/** RRULE, EXRULE, RDATE and EXDATE lines, as Google's `recurrence` takes them, leaving out `skip` EXDATEs. */
function recurrenceLines(comp: Comp, skip: Set<string>): string[] {
  const out: string[] = []
  for (const name of ['rrule', 'exrule', 'rdate', 'exdate']) {
    for (const prop of comp.getAllProperties(name)) {
      if (name === 'exdate' && skip.size) {
        const tzid = prop.getParameter('tzid')
        const keep = prop.getValues().filter((v) => !(v instanceof ICAL.Time) || !skip.has(timeKey(v, tzid)))
        if (!keep.length) continue
        const copy = ICAL.Property.fromString(prop.toICALString())
        copy.setValues(keep as never)
        out.push(copy.toICALString())
      } else out.push(prop.toICALString())
    }
  }
  return out
}

/** Reminders from an event's alarms: minutes before the start. Null when one is after the start. */
function remindersOf(comp: Comp): GoogleFields['reminders'] | null | undefined {
  const minutes: number[] = []
  for (const alarm of comp.getAllSubcomponents('valarm')) {
    const trigger = alarm.getFirstPropertyValue('trigger')
    if (!(trigger instanceof ICAL.Duration)) continue
    const related = alarm.getFirstProperty('trigger')?.getParameter('related')
    if (related === 'END') continue
    const m = -trigger.toSeconds() / 60
    if (m < 0) return null
    minutes.push(Math.round(m))
  }
  if (!minutes.length) return undefined
  return {
    useDefault: false,
    overrides: minutes.slice(0, 5).map((m) => ({ method: 'popup' as const, minutes: m })),
  }
}

export class GoogleMappingError extends Error {
  override name = 'GoogleMappingError'
}

/**
 * The Google fields of an iCalendar event (master or override). `skipExdates` are left out of the
 * recurrence: Ordo cancels those occurrences on Google instead, as Google Calendar does.
 */
export function veventToGoogle(
  comp: Comp,
  {
    fallbackZone,
    master,
    skipExdates = new Set<string>(),
  }: { fallbackZone: string; master: boolean; skipExdates?: Set<string> },
): GoogleFields {
  const startProp = comp.getFirstProperty('dtstart')
  const startValue = startProp?.getFirstValue()
  if (!startProp || !(startValue instanceof ICAL.Time))
    throw new GoogleMappingError('The event has no start.')
  const startTzid = startProp.getParameter('tzid')
  const endProp = comp.getFirstProperty('dtend')
  let endValue = endProp?.getFirstValue()
  let endTzid = endProp?.getParameter('tzid')
  if (!(endValue instanceof ICAL.Time)) {
    const duration = comp.getFirstPropertyValue('duration')
    const end = startValue.clone()
    if (duration instanceof ICAL.Duration) end.addDuration(duration)
    else if (startValue.isDate) end.day += 1
    endValue = end
    endTzid = startTzid
  }
  let start: GoogleTime
  let end: GoogleTime
  try {
    start = googleTime(startValue, startTzid, fallbackZone)
    end = googleTime(endValue as ITime, endTzid, fallbackZone)
  } catch (err) {
    throw new GoogleMappingError(err instanceof Error ? err.message : String(err))
  }
  const reminders = remindersOf(comp)
  if (reminders === null)
    throw new GoogleMappingError('Google Calendar can only remind you before an event starts.')
  const text = (name: string) => {
    const v = comp.getFirstPropertyValue(name)
    return typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim() : ''
  }
  const fields: GoogleFields = {
    summary: text('summary'),
    description: text('description'),
    location: text('location'),
    start,
    end,
  }
  if (master) {
    const lines = recurrenceLines(comp, skipExdates)
    if (lines.length) fields.recurrence = lines
  }
  if (reminders) fields.reminders = reminders
  return fields
}

/** JSON with sorted keys, for comparing field objects. */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(v)
}

/**
 * The fields that differ between two versions of an event, as a PATCH body: start and end go
 * together, a dropped recurrence is sent as `[]`, and alarms that were all removed as an empty
 * list of overrides.
 */
export function changedFields(before: GoogleFields | null, after: GoogleFields): Partial<GoogleFields> {
  if (!before) return after
  const patch: Record<string, unknown> = {}
  for (const k of ['summary', 'description', 'location'] as const)
    if (before[k] !== after[k]) patch[k] = after[k]
  if (stable(before.start) !== stable(after.start) || stable(before.end) !== stable(after.end)) {
    patch['start'] = after.start
    patch['end'] = after.end
  }
  if (stable(before.recurrence ?? []) !== stable(after.recurrence ?? []))
    patch['recurrence'] = after.recurrence ?? []
  if (stable(before.reminders ?? null) !== stable(after.reminders ?? null))
    patch['reminders'] = after.reminders ?? { useDefault: false, overrides: [] }
  return patch as Partial<GoogleFields>
}

/** The calendar a feed link shows, when it's one of Google Calendar's iCal addresses. */
export function googleCalendarIdFromFeedUrl(url: string): string | null {
  try {
    const u = new URL(url.replace(/^webcals?:/i, 'https:'))
    if (!/^(calendar|www)\.google\.com$/i.test(u.hostname)) return null
    const m = /^\/calendar\/ical\/([^/]+)\/(?:private-[^/]+|public)\/basic\.ics$/i.exec(u.pathname)
    return m ? decodeURIComponent(m[1]!) : null
  } catch {
    return null
  }
}
