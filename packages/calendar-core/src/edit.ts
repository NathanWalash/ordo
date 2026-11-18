// Creating, changing and deleting events on a writable calendar, and keeping the cache in step.
// One service for every front end: the window's IPC, headless commands, MCP tools, and later the
// AI assistant. Each call reads the cached resource, writes it back with If-Match on the ETag
// Ordo last saw, and on a conflict refreshes the calendar and says so instead of overwriting.
import { CalendarWriteError } from './caldav'
import { checkDraft, type EventDraft } from './draft'
import { parseIcs } from './ics'
import { ICLOUD, type CalendarStore } from './store'
import type { CalendarResource, DateRange, WritableCalendarProvider } from './types'
import {
  createEventIcs,
  deleteFromIcs,
  IcsEditError,
  newUid,
  readEvent,
  updateEventIcs,
  type EditScope,
  type EventFacts,
  type EventTarget,
} from './write'

/** An event, or one occurrence of it, on one calendar. */
export interface CalendarEventRef extends EventTarget {
  calendarId: string
}

export type EventChangeErrorKind = 'not-found' | 'read-only' | 'invitation' | 'conflict' | 'invalid'

/** A change Ordo won't make, or the server refused, with a message for people. */
export class EventChangeError extends Error {
  override name = 'EventChangeError'
  constructor(
    readonly kind: EventChangeErrorKind,
    message: string,
  ) {
    super(message)
  }
}

export interface ChangeOptions {
  /** The span the cache keeps (see `syncWindow()`); occurrences are recomputed for it. */
  window: DateRange
  now?: Date
  /** The account's email, to tell the user's own events from invitations. */
  me?: string
}

/** What the editor needs to know about an event before changing it. */
export interface EventDetails extends EventFacts {
  calendarId: string
  /** False when Ordo can't change it, with `reason` saying why. */
  editable: boolean
  reason?: string
}

const CONFLICT =
  'This event was changed somewhere else, so Ordo didn’t save your change. It now shows the latest version: make your change again if you still need it.'
const GONE = 'This event was deleted somewhere else.'

/** Why a calendar can't be written to, or null if it can. */
function refusal(store: CalendarStore, calendarId: string): EventChangeError | null {
  const cal = store.calendar(calendarId)
  if (!cal)
    return new EventChangeError('not-found', 'That calendar isn’t in Ordo any more. Sync and try again.')
  if (cal.provider !== ICLOUD || cal.source === 'link' || cal.source === 'file')
    return new EventChangeError(
      'read-only',
      `“${cal.name}” was added by ${cal.source === 'file' ? 'file' : 'link'}, so it’s read-only in Ordo.`,
    )
  if (cal.readOnly)
    return new EventChangeError('read-only', `“${cal.name}” is read-only, so its events can’t be changed.`)
  return null
}

/** Why Ordo won't change this particular event (someone else's invitation, a zone it can't read). */
function invitation(facts: EventFacts, me: string | undefined): EventChangeError | null {
  if (facts.unknownZone)
    return new EventChangeError(
      'read-only',
      `This event uses a time zone Ordo doesn’t know (“${facts.unknownZone.slice(0, 60)}”), so Ordo won’t change it. Change it in the app that made it.`,
    )
  if (!facts.organizer || !me || facts.organizer.toLowerCase() === me.toLowerCase()) return null
  return new EventChangeError(
    'invitation',
    `This is an invitation from ${facts.organizer}. Change it in Calendar on your Mac or iPhone, so they hear about it.`,
  )
}

function resourceFor(store: CalendarStore, ref: CalendarEventRef): CalendarResource | null {
  return store.resources(ref.calendarId, ref.uid)[0] ?? null
}

/** The cached details of an event, and whether Ordo can change it. Null if it isn't cached. */
export function eventDetails(store: CalendarStore, ref: CalendarEventRef, me?: string): EventDetails | null {
  const res = resourceFor(store, ref)
  if (!res) return null
  let facts: EventFacts
  try {
    facts = readEvent(res.ics, ref)
  } catch {
    return null
  }
  const blocked = refusal(store, ref.calendarId) ?? invitation(facts, me)
  return {
    ...facts,
    calendarId: ref.calendarId,
    editable: !blocked,
    ...(blocked && { reason: blocked.message }),
  }
}

/** Fetch one calendar again into the cache, e.g. after a conflict. */
export async function refreshCalendar(
  provider: WritableCalendarProvider,
  store: CalendarStore,
  calendarId: string,
  window: DateRange,
): Promise<void> {
  const { events, resources } = await provider.fetchResources(calendarId, window)
  // No version: the next sync fetches it again anyway, and that's harmless.
  store.replaceEvents(calendarId, events, window, undefined, resources)
}

/** The cached resource for `ref`, fetching the calendar again once if it isn't cached yet. */
async function loadResource(
  provider: WritableCalendarProvider,
  store: CalendarStore,
  ref: CalendarEventRef,
  window: DateRange,
): Promise<CalendarResource> {
  let res = resourceFor(store, ref)
  if (!res) {
    await refreshCalendar(provider, store, ref.calendarId, window)
    res = resourceFor(store, ref)
  }
  if (!res)
    throw new EventChangeError(
      'not-found',
      'That event wasn’t found. It may have been deleted somewhere else.',
    )
  return res
}

/**
 * The ETag to send. A server that gave none: fetch the event now, and only go ahead if it's
 * still exactly what Ordo has, so a change made elsewhere is still never overwritten.
 */
async function currentEtag(
  provider: WritableCalendarProvider,
  ref: CalendarEventRef,
  res: CalendarResource,
): Promise<string | undefined> {
  if (res.etag) return res.etag
  const now = await provider.fetchResource(ref.calendarId, res.href)
  if (!now) throw new CalendarWriteError('gone', GONE)
  if (now.ics.replace(/\r\n/g, '\n').trim() !== res.ics.replace(/\r\n/g, '\n').trim())
    throw new CalendarWriteError('conflict', CONFLICT)
  return now.etag
}

/**
 * Write `ics` over `res` and cache what the server now has. A server that changed the event as
 * it saved it (and so sent no ETag) is asked for its version.
 */
async function save(
  provider: WritableCalendarProvider,
  store: CalendarStore,
  ref: CalendarEventRef,
  res: CalendarResource,
  ics: string | null,
  window: DateRange,
): Promise<void> {
  const etag = await currentEtag(provider, ref, res)
  if (ics === null) {
    await provider.deleteResource(ref.calendarId, res.href, etag)
    store.replaceResource(ref.calendarId, ref.uid, res.href, null, [])
    return
  }
  const r = await provider.updateResource(ref.calendarId, res.href, ics, etag)
  await cache(provider, store, ref.calendarId, ref.uid, res.href, ics, r.etag, window)
}

async function cache(
  provider: WritableCalendarProvider,
  store: CalendarStore,
  calendarId: string,
  uid: string,
  href: string,
  ics: string,
  etag: string | undefined,
  window: DateRange,
): Promise<void> {
  let saved: CalendarResource = { href, etag, uid, ics }
  if (!etag) saved = (await provider.fetchResource(calendarId, href).catch(() => null)) ?? saved
  store.replaceResource(calendarId, uid, href, saved, parseIcs(saved.ics, { calendarId, range: window }))
}

/** Turn the server's refusals into EventChangeErrors, refreshing the cache when it's out of date. */
async function guarded<T>(
  provider: WritableCalendarProvider,
  store: CalendarStore,
  calendarId: string,
  window: DateRange,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof IcsEditError)
      throw new EventChangeError(err.kind === 'not-found' ? 'not-found' : 'invalid', err.message)
    if (!(err instanceof CalendarWriteError)) throw err
    if (err.kind === 'conflict' || err.kind === 'gone') {
      await refreshCalendar(provider, store, calendarId, window).catch(() => {})
      throw new EventChangeError(
        err.kind === 'conflict' ? 'conflict' : 'not-found',
        err.kind === 'conflict' ? CONFLICT : GONE,
      )
    }
    if (err.kind === 'forbidden')
      throw new EventChangeError(
        'read-only',
        'iCloud didn’t allow that change. The calendar may be read-only.',
      )
    throw err
  }
}

function checked(draft: EventDraft): void {
  const problem = checkDraft(draft)
  if (problem) throw new EventChangeError('invalid', problem)
}

/** Add a new event to a writable calendar. Returns its UID. */
export async function createEvent(
  provider: WritableCalendarProvider,
  store: CalendarStore,
  calendarId: string,
  draft: EventDraft,
  { window, now = new Date() }: ChangeOptions,
): Promise<{ uid: string }> {
  const blocked = refusal(store, calendarId)
  if (blocked) throw blocked
  checked(draft)
  const uid = newUid()
  const ics = createEventIcs(draft, { uid, now })
  return guarded(provider, store, calendarId, window, async () => {
    const r = await provider.createResource(calendarId, uid, ics)
    await cache(provider, store, calendarId, uid, r.href, ics, r.etag, window)
    return { uid }
  })
}

/**
 * Change an event. For one occurrence of a repeating event, `scope` says whether the change is
 * for that occurrence only or for all of them; `draft` describes the occurrence `ref` names.
 */
export async function updateEvent(
  provider: WritableCalendarProvider,
  store: CalendarStore,
  ref: CalendarEventRef,
  draft: EventDraft,
  scope: EditScope,
  { window, now = new Date(), me }: ChangeOptions,
): Promise<void> {
  const blocked = refusal(store, ref.calendarId)
  if (blocked) throw blocked
  checked(draft)
  await guarded(provider, store, ref.calendarId, window, async () => {
    const res = await loadResource(provider, store, ref, window)
    const refused = invitation(readEvent(res.ics, ref), me)
    if (refused) throw refused
    await save(provider, store, ref, res, updateEventIcs(res.ics, ref, draft, scope, { now }), window)
  })
}

/** Delete an event: just one occurrence of a repeating event with scope `this`, or all of it. */
export async function deleteEvent(
  provider: WritableCalendarProvider,
  store: CalendarStore,
  ref: CalendarEventRef,
  scope: EditScope,
  { window, now = new Date(), me }: ChangeOptions,
): Promise<void> {
  const blocked = refusal(store, ref.calendarId)
  if (blocked) throw blocked
  await guarded(provider, store, ref.calendarId, window, async () => {
    const res = await loadResource(provider, store, ref, window)
    const refused = invitation(readEvent(res.ics, ref), me)
    if (refused) throw refused
    try {
      await save(provider, store, ref, res, deleteFromIcs(res.ics, ref, scope, { now }), window)
    } catch (err) {
      // Already gone: that's what was asked for.
      if (err instanceof CalendarWriteError && err.kind === 'gone' && scope === 'all') {
        store.replaceResource(ref.calendarId, ref.uid, res.href, null, [])
        return
      }
      throw err
    }
  })
}
