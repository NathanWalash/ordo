// Google Calendar through the Calendar API v3, signed in with OAuth (the token comes from the
// caller, so this package never sees a refresh token). Events are kept as the API sends them
// (`google_items`) and incremental sync uses each calendar's `nextSyncToken`; every series is then
// turned into one iCalendar resource, so recurrence, the editor and `edit.ts` work exactly as for
// iCloud. A change arrives here as edited iCalendar: it's compared with what was cached and only
// the fields that changed are sent, conditional on the event's ETag (If-Match), so a change made
// elsewhere is never overwritten. "This event only" changes and deletes go to that occurrence's
// own event, as Google Calendar does it.
import ICAL from 'ical.js'
import {
  CalendarAuthError,
  CalendarConnectionError,
  CalendarUnavailableError,
  CalendarWriteError,
  normaliseColor,
} from './caldav'
import { EventChangeError } from './edit'
import {
  changedFields,
  exdateKeys,
  googleTimeKey,
  GoogleMappingError,
  groupToIcs,
  stable,
  timeKey,
  trimEvent,
  veventToGoogle,
  type GoogleCalendarListEntry,
  type GoogleEvent,
  type GoogleFields,
} from './google-map'
import { parseIcs } from './ics'
import { GOOGLE_PREFIX, type CalendarStore } from './store'
import { localZone } from './time'
import type {
  CalendarEvent,
  CalendarProvider,
  CalendarResource,
  CalendarSyncProgress,
  CalendarSyncResult,
  DateRange,
  RemoteCalendar,
  WritableCalendarProvider,
} from './types'

type Comp = InstanceType<typeof ICAL.Component>

/** The only API host a packaged Ordo talks to for calendars. Tests point `apiBase` at a local fake. */
export const GOOGLE_API_BASE = 'https://www.googleapis.com'

/** The store's provider for one Google account's calendars. */
export const googleProvider = (accountId: string) => `${GOOGLE_PREFIX}${accountId}`

/** Ordo's id for a Google calendar: unique even when two accounts can see the same calendar. */
export const googleCalendarKey = (accountId: string, calendarId: string) =>
  `${GOOGLE_PREFIX}${accountId}:${calendarId}`

/** The account and Google calendar id behind an Ordo calendar id, or null if it isn't Google's. */
export function parseGoogleCalendarKey(id: string): { accountId: string; calendarId: string } | null {
  if (!id.startsWith(GOOGLE_PREFIX)) return null
  const rest = id.slice(GOOGLE_PREFIX.length)
  const i = rest.indexOf(':')
  if (i <= 0 || i === rest.length - 1) return null
  return { accountId: rest.slice(0, i), calendarId: rest.slice(i + 1) }
}

/** Google said no for a reason that isn't a busy server or a refused change. */
export class GoogleApiError extends Error {
  override name = 'GoogleApiError'
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message)
  }
}

export interface GoogleCalendarConfig {
  /** The Google account (its `sub`), for calendar ids. */
  accountId: string
  /** An access token for the account. `refresh`: the last one was refused, so get a new one. */
  token: (refresh: boolean) => Promise<string>
  store: CalendarStore
  /** API origin; only tests and development builds change it. */
  apiBase?: string
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  timeoutMs?: number
  /** Waits before a retry; tests pass one that doesn't really wait. */
  sleep?: (ms: number) => Promise<void>
  /** Waits for a busy server (Retry-After) up to this long within one request, else gives up for now. */
  maxWaitMs?: number
  /** Retries of a request the server was too busy for. */
  retries?: number
  /** For times written without a zone (Google has no floating time). */
  fallbackZone?: string
}

const RATE_REASONS = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
  'RATE_LIMIT_EXCEEDED',
  'RESOURCE_EXHAUSTED',
])
const MAX_PAGES = 200
const CONFLICT = 'The event was changed somewhere else.'
const GONE = 'The event was deleted somewhere else.'

/** Seconds or an HTTP date, in milliseconds from now. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined
  const s = Number(header)
  if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000)
  const at = Date.parse(header)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

async function readError(res: Response): Promise<{ reason?: string; message?: string }> {
  try {
    const body = (await res.json()) as {
      error?: {
        message?: string
        status?: string
        errors?: { reason?: string }[]
        details?: { reason?: string }[]
      }
    }
    const e = body.error
    return {
      reason: e?.errors?.[0]?.reason ?? e?.details?.find((d) => d.reason)?.reason ?? e?.status,
      message: typeof e?.message === 'string' ? e.message.slice(0, 300) : undefined,
    }
  } catch {
    return {}
  }
}

interface Split {
  master?: Comp
  overrides: Map<string, Comp>
}

function split(ics: string): Split {
  const vcal = new ICAL.Component(ICAL.parse(ics) as never)
  const out: Split = { overrides: new Map() }
  for (const v of vcal.getAllSubcomponents('vevent')) {
    const rid = v.getFirstProperty('recurrence-id')
    const value = rid?.getFirstValue()
    if (rid && value instanceof ICAL.Time) out.overrides.set(timeKey(value, rid.getParameter('tzid')), v)
    else if (!rid) out.master = v
  }
  return out
}

const isCancelled = (c: Comp | undefined) =>
  String(c?.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED'

/** Whether a single event ended before `t` (with a day to spare for all-day dates and zones). */
function endedBefore(e: GoogleEvent, t: Date): boolean {
  const end = e.end?.dateTime ?? e.end?.date
  const ms = end ? Date.parse(end) : NaN
  return Number.isFinite(ms) && ms + 86_400_000 < t.getTime()
}

/**
 * One Google account's calendars. Reads go through the local cache of Google events; `syncCalendar`
 * brings that cache up to date with one request per page of changes.
 */
export class GoogleCalendarProvider implements CalendarProvider, WritableCalendarProvider {
  readonly key: string
  private base: string
  private fetchFn: (url: string, init: RequestInit) => Promise<Response>
  private sleep: (ms: number) => Promise<void>

  constructor(private config: GoogleCalendarConfig) {
    this.key = googleProvider(config.accountId)
    this.base = config.apiBase ?? GOOGLE_API_BASE
    this.fetchFn = config.fetch ?? ((url, init) => fetch(url, init))
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  }

  private get store() {
    return this.config.store
  }

  private gid(calendarId: string): string {
    const p = parseGoogleCalendarKey(calendarId)
    if (!p || p.accountId !== this.config.accountId)
      throw new CalendarWriteError('failed', 'That calendar isn’t in this Google account.')
    return p.calendarId
  }

  private eventsPath(calendarId: string, eventId?: string, suffix = ''): string {
    const cal = `/calendar/v3/calendars/${encodeURIComponent(this.gid(calendarId))}/events`
    return eventId ? `${cal}/${encodeURIComponent(eventId)}${suffix}` : cal
  }

  /**
   * One API request, with a fresh token after a 401 and waits (Retry-After, else exponential)
   * when Google is busy or limiting requests. Writes turn refusals into CalendarWriteErrors.
   */
  private async request<T>(
    method: string,
    path: string,
    o: {
      query?: Record<string, string | undefined>
      body?: unknown
      ifMatch?: string
      ifNoneMatch?: string
      write?: boolean
    } = {},
  ): Promise<{ status: number; data: T | null }> {
    const url = new URL(path, this.base)
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, v)
    let refreshed = false
    let busy = 0
    const retries = this.config.retries ?? 2
    for (;;) {
      let token: string
      try {
        token = await this.config.token(refreshed)
      } catch (err) {
        throw new CalendarAuthError(err instanceof Error ? err.message : String(err), { cause: err })
      }
      let res: Response
      try {
        res = await this.fetchFn(url.href, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(o.body !== undefined && { 'Content-Type': 'application/json' }),
            ...(o.ifMatch && { 'If-Match': o.ifMatch }),
            ...(o.ifNoneMatch && { 'If-None-Match': o.ifNoneMatch }),
          },
          ...(o.body !== undefined && { body: JSON.stringify(o.body) }),
          redirect: 'error',
          signal: AbortSignal.timeout(this.config.timeoutMs ?? 30_000),
        })
      } catch (err) {
        throw new CalendarConnectionError(
          `Couldn’t reach Google Calendar (${err instanceof Error ? err.message : String(err)}).`,
        )
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true
        await res.body?.cancel().catch(() => {})
        continue
      }
      if (res.status === 304) return { status: 304, data: null }
      if (res.ok) {
        const text = await res.text()
        return { status: res.status, data: text ? (JSON.parse(text) as T) : null }
      }
      const { reason, message } = await readError(res)
      const wait = retryAfterMs(res.headers.get('retry-after'))
      const limited = res.status === 429 || (res.status === 403 && !!reason && RATE_REASONS.has(reason))
      if ((limited || res.status >= 500) && busy < retries) {
        const ms = wait ?? Math.min(1000 * 2 ** busy, 8000) + Math.floor(Math.random() * 250)
        if (ms <= (this.config.maxWaitMs ?? 30_000)) {
          busy++
          await this.sleep(ms)
          continue
        }
      }
      throw this.failure(res.status, reason, message, limited, wait, o.write === true)
    }
  }

  private failure(
    status: number,
    reason: string | undefined,
    message: string | undefined,
    limited: boolean,
    wait: number | undefined,
    write: boolean,
  ): Error {
    if (status === 401)
      return new CalendarAuthError(
        'Google didn’t accept Ordo’s sign-in. Sign in to Google again in Settings.',
      )
    if (limited || status >= 500) {
      const err = new CalendarUnavailableError(
        limited
          ? 'Google Calendar is limiting requests right now.'
          : `Google Calendar is busy or down right now (HTTP ${status}).`,
      )
      if (wait !== undefined) err.retryAfterMs = wait
      return err
    }
    if (reason === 'accessNotConfigured' || reason === 'SERVICE_DISABLED')
      return new GoogleApiError(
        'The Google Calendar API isn’t turned on in your Google Cloud project. Turn it on (APIs & Services › Library › Google Calendar API), then sync again.',
        status,
        reason,
      )
    if (reason === 'insufficientPermissions' || reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT')
      return new GoogleApiError(
        'Ordo wasn’t given permission to use this Google calendar. Sign in to Google again and allow calendar access.',
        status,
        reason,
      )
    if (write) {
      if (status === 412) return new CalendarWriteError('conflict', CONFLICT, status)
      if (status === 404 || status === 410) return new CalendarWriteError('gone', GONE, status)
      if (status === 403)
        return new CalendarWriteError(
          'forbidden',
          'Google Calendar doesn’t allow changes to that event.',
          status,
        )
      if (status === 400)
        return new CalendarWriteError(
          'failed',
          `Google Calendar refused the change${message ? `: ${message}` : ''}.`,
          status,
        )
      return new CalendarWriteError('failed', `Google Calendar answered with an error (${status}).`, status)
    }
    return new GoogleApiError(`Google Calendar answered with an error (${status}).`, status, reason)
  }

  async connect(): Promise<void> {
    // Plain HTTPS with a bearer token: nothing to open.
  }

  async close(): Promise<void> {}

  /** The account's calendars, primary first, then ones you can change, then by name. */
  async listCalendars(): Promise<RemoteCalendar[]> {
    const entries: GoogleCalendarListEntry[] = []
    let pageToken: string | undefined
    for (let page = 0; page < 20; page++) {
      const r = await this.request<{ items?: GoogleCalendarListEntry[]; nextPageToken?: string }>(
        'GET',
        '/calendar/v3/users/me/calendarList',
        { query: { maxResults: '250', pageToken } },
      )
      for (const e of r.data?.items ?? []) if (e && typeof e.id === 'string' && !e.deleted) entries.push(e)
      pageToken = r.data?.nextPageToken
      if (!pageToken) break
    }
    const writable = (e: GoogleCalendarListEntry) => e.accessRole === 'owner' || e.accessRole === 'writer'
    const name = (e: GoogleCalendarListEntry) =>
      (e.summaryOverride || e.summary || e.id).replace(/\s+/g, ' ').trim().slice(0, 200) || 'Calendar'
    entries.sort(
      (a, b) =>
        Number(b.primary === true) - Number(a.primary === true) ||
        Number(writable(b)) - Number(writable(a)) ||
        name(a).localeCompare(name(b)),
    )
    return entries.map((e) => ({
      id: googleCalendarKey(this.config.accountId, e.id.slice(0, 1024)),
      name: name(e),
      color: normaliseColor(e.backgroundColor),
      readOnly: !writable(e),
      visible: e.selected !== false && e.hidden !== true,
    }))
  }

  /**
   * Every change to a calendar since `syncToken` (everything, without one), page by page. A token
   * Google no longer accepts (410 Gone) means starting again with a full sync.
   */
  async listChanges(
    calendarId: string,
    syncToken: string | null,
  ): Promise<{ items: GoogleEvent[]; nextSyncToken: string | null; full: boolean }> {
    let token = syncToken
    let items: GoogleEvent[] = []
    let pageToken: string | undefined
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES)
        throw new GoogleApiError('This calendar has too many events for Ordo to read.', 0)
      let r
      try {
        r = await this.request<{ items?: unknown[]; nextPageToken?: string; nextSyncToken?: string }>(
          'GET',
          this.eventsPath(calendarId),
          {
            // The same parameters every time (full sync, deltas, every page), as Google asks. With
            // singleEvents=false a series comes as one event with its RRULE plus its changed
            // occurrences; showDeleted=true also brings its cancelled occurrences in a full sync,
            // without which a deleted occurrence would come back after a full resync.
            query: {
              maxResults: '2500',
              singleEvents: 'false',
              showDeleted: 'true',
              syncToken: token ?? undefined,
              pageToken,
            },
          },
        )
      } catch (err) {
        if (err instanceof GoogleApiError && err.status === 410 && token) {
          token = null
          items = []
          pageToken = undefined
          continue
        }
        throw err
      }
      for (const raw of r.data?.items ?? []) {
        const e = trimEvent(raw)
        // Working locations ("Home", "Office") are Google Calendar's own banner, not events.
        if (e && e.eventType !== 'workingLocation') items.push(e)
      }
      pageToken = r.data?.nextPageToken
      if (!pageToken) return { items, nextSyncToken: r.data?.nextSyncToken ?? null, full: token === null }
    }
  }

  /** Bring one calendar's cached Google events up to date. True if anything changed. */
  async syncCalendar(calendarId: string, { force = false } = {}): Promise<boolean> {
    const r = await this.listChanges(calendarId, force ? null : this.store.syncToken(calendarId))
    this.store.applyGoogleItems(calendarId, r.items, r.full)
    this.store.setSyncToken(calendarId, r.nextSyncToken)
    return r.full || r.items.length > 0
  }

  /**
   * The calendar's resources (one per series or single event) and occurrences in `range`, from the
   * cached Google events. Single events that ended before `range` are forgotten.
   */
  build(calendarId: string, range: DateRange): { events: CalendarEvent[]; resources: CalendarResource[] } {
    const gid = this.gid(calendarId)
    const groups = new Map<string, { master?: GoogleEvent; exceptions: GoogleEvent[] }>()
    for (const e of this.store.googleItems(calendarId)) {
      const key = e.recurringEventId ?? e.id
      const g = groups.get(key) ?? { exceptions: [] }
      if (e.recurringEventId) g.exceptions.push(e)
      else g.master = e
      groups.set(key, g)
    }
    const events: CalendarEvent[] = []
    const resources: CalendarResource[] = []
    const past: string[] = []
    for (const [href, g] of groups) {
      if (
        g.master &&
        !g.master.recurrence?.length &&
        !g.exceptions.length &&
        endedBefore(g.master, range.start)
      ) {
        past.push(href)
        continue
      }
      const r = this.resource(href, g, gid)
      if (!r) continue
      try {
        events.push(...parseIcs(r.ics, { calendarId, range }))
      } catch {
        continue
      }
      resources.push(r)
    }
    if (past.length) this.store.dropGoogleItems(calendarId, past)
    return { events, resources }
  }

  private resource(
    href: string,
    g: { master?: GoogleEvent; exceptions: GoogleEvent[] },
    gid: string,
  ): CalendarResource | null {
    let built
    try {
      built = groupToIcs(g, gid)
    } catch {
      return null
    }
    if (!built) return null
    const etag = g.master?.etag ?? g.exceptions.find((e) => e.etag)?.etag
    return { href, uid: built.uid, ics: built.ics, ...(etag && { etag }) }
  }

  async fetchResources(
    calendarId: string,
    range: DateRange,
  ): Promise<{ events: CalendarEvent[]; resources: CalendarResource[] }> {
    await this.syncCalendar(calendarId)
    return this.build(calendarId, range)
  }

  async fetchEvents(calendarId: string, range: DateRange): Promise<CalendarEvent[]> {
    return (await this.fetchResources(calendarId, range)).events
  }

  /** A series as Ordo now has it cached (after its own change, or the last sync). */
  async fetchResource(calendarId: string, href: string): Promise<CalendarResource | null> {
    const g = this.store.googleGroup(calendarId, href)
    if (!g.master && !g.exceptions.length) return null
    return this.resource(href, g, this.gid(calendarId))
  }

  private fields(comp: Comp, master: boolean, skipExdates?: Set<string>): GoogleFields {
    return veventToGoogle(comp, {
      fallbackZone: this.config.fallbackZone ?? localZone(),
      master,
      skipExdates,
    })
  }

  private keep(calendarId: string, raw: unknown): GoogleEvent | null {
    const e = trimEvent(raw)
    if (e) this.store.applyGoogleItems(calendarId, [e])
    return e
  }

  async createResource(
    calendarId: string,
    uid: string,
    ics: string,
  ): Promise<{ href: string; etag?: string }> {
    return mapping(async () => {
      const { master } = split(ics)
      if (!master) throw new GoogleMappingError('The event has no start.')
      const r = await this.request<unknown>('POST', this.eventsPath(calendarId), {
        query: { sendUpdates: 'none' },
        body: { ...this.fields(master, true), iCalUID: uid },
        write: true,
      })
      const e = this.keep(calendarId, r.data)
      if (!e) throw new CalendarWriteError('failed', 'Google Calendar didn’t say what it saved.')
      // No ETag: edit.ts then reads the series back from the cache this just updated.
      return { href: e.id }
    })
  }

  async updateResource(
    calendarId: string,
    href: string,
    ics: string,
    etag?: string,
  ): Promise<{ etag?: string }> {
    return mapping(async () => {
      const old = this.store.resourceAt(calendarId, href)
      if (!old) throw new CalendarWriteError('gone', GONE)
      const before = split(old.ics)
      const after = split(ics)
      const group = this.store.googleGroup(calendarId, href)
      const checked = { master: false }
      const cancel = new Set<string>()

      if (after.master && group.master && before.master) {
        const oldEx = exdateKeys(before.master)
        const added = new Set([...exdateKeys(after.master)].filter((k) => !oldEx.has(k)))
        const was = this.fields(before.master, true)
        const moved = stable(was.start) !== stable(this.fields(after.master, true).start)
        // New EXDATEs are occurrences deleted with "this event only": cancel them on Google, as
        // Google Calendar does, unless the whole series moved (then they moved with it).
        const now = this.fields(after.master, true, moved ? undefined : added)
        const patch = changedFields(was, now)
        if (Object.keys(patch).length) {
          const r = await this.request<unknown>('PATCH', this.eventsPath(calendarId, href), {
            query: { sendUpdates: 'none' },
            body: patch,
            ifMatch: group.master.etag ?? etag,
            write: true,
          })
          this.keep(calendarId, r.data)
          checked.master = true
        }
        // A series that moved or repeats differently: Google keeps or drops its changed
        // occurrences itself, and the next sync shows which.
        if ('start' in patch || 'recurrence' in patch) return {}
        if (!moved) for (const k of added) cancel.add(k)
      }

      for (const [key, comp] of after.overrides) {
        if (isCancelled(comp)) continue
        const prev = before.overrides.get(key)
        const next = this.fields(comp, false)
        const patch = prev && !isCancelled(prev) ? changedFields(this.fields(prev, false), next) : next
        if (!Object.keys(patch).length) continue
        const inst = await this.occurrence(calendarId, group, key, checked)
        const r = await this.request<unknown>('PATCH', this.eventsPath(calendarId, inst.id), {
          query: { sendUpdates: 'none' },
          body: patch,
          ifMatch: inst.etag,
          write: true,
        })
        this.keep(calendarId, r.data)
      }
      for (const [key, comp] of before.overrides)
        if (!isCancelled(comp) && !after.overrides.has(key)) cancel.add(key)
      for (const key of cancel) await this.cancelOccurrence(calendarId, group, key, checked)
      return {}
    })
  }

  /**
   * The Google event for one occurrence of a series: its exception if it has one, otherwise the
   * instance Google generates (asked for by its original start). Before changing an occurrence
   * that isn't an exception yet, check the series itself hasn't changed since Ordo last saw it.
   */
  private async occurrence(
    calendarId: string,
    group: { master?: GoogleEvent; exceptions: GoogleEvent[] },
    key: string,
    checked: { master: boolean },
  ): Promise<GoogleEvent> {
    const own = group.exceptions.find(
      (e) => e.originalStartTime && googleTimeKey(e.originalStartTime) === key,
    )
    if (own) return own
    const master = group.master
    if (!master) throw new EventChangeError('not-found', 'That occurrence wasn’t found in Google Calendar.')
    if (!checked.master && master.etag) {
      const r = await this.request<unknown>('GET', this.eventsPath(calendarId, master.id), {
        ifNoneMatch: master.etag,
        write: true,
      })
      if (r.status !== 304) {
        this.keep(calendarId, r.data)
        throw new CalendarWriteError('conflict', CONFLICT, 412)
      }
      checked.master = true
    }
    const r = await this.request<{ items?: unknown[] }>(
      'GET',
      this.eventsPath(calendarId, master.id, '/instances'),
      { query: { originalStart: key, showDeleted: 'true', maxResults: '1' }, write: true },
    )
    const inst = trimEvent(r.data?.items?.[0])
    if (!inst || !inst.originalStartTime || googleTimeKey(inst.originalStartTime) !== key)
      throw new EventChangeError('not-found', 'That occurrence wasn’t found in Google Calendar.')
    if (inst.status === 'cancelled') throw new CalendarWriteError('gone', GONE, 410)
    return inst
  }

  private async cancelOccurrence(
    calendarId: string,
    group: { master?: GoogleEvent; exceptions: GoogleEvent[] },
    key: string,
    checked: { master: boolean },
  ): Promise<void> {
    const inst = await this.occurrence(calendarId, group, key, checked)
    await this.request('DELETE', this.eventsPath(calendarId, inst.id), {
      query: { sendUpdates: 'none' },
      ifMatch: inst.etag,
      write: true,
    })
    this.store.applyGoogleItems(calendarId, [{ ...inst, status: 'cancelled' }])
  }

  async deleteResource(calendarId: string, href: string, etag?: string): Promise<void> {
    const group = this.store.googleGroup(calendarId, href)
    if (group.master || !group.exceptions.length) {
      await this.request('DELETE', this.eventsPath(calendarId, href), {
        query: { sendUpdates: 'none' },
        ifMatch: group.master?.etag ?? etag,
        write: true,
      })
      this.store.dropGoogleItems(calendarId, [href])
      return
    }
    // Only some occurrences of someone else's series are on this calendar: delete those, never
    // the series itself.
    for (const e of group.exceptions) {
      if (e.status === 'cancelled') continue
      await this.request('DELETE', this.eventsPath(calendarId, e.id), {
        query: { sendUpdates: 'none' },
        ifMatch: e.etag,
        write: true,
      })
      this.store.applyGoogleItems(calendarId, [{ ...e, status: 'cancelled' }])
    }
  }
}

/** Times or alarms Google can't take become a change Ordo refuses, with the reason. */
async function mapping<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof GoogleMappingError) throw new EventChangeError('invalid', err.message)
    throw err
  }
}

export interface GoogleSyncOptions {
  /** Span to cache; see `syncWindow()`. */
  window: DateRange
  signal?: AbortSignal
  onProgress?: (p: CalendarSyncProgress) => void
  /** Sync every calendar in full instead of from its sync token. */
  force?: boolean
  now?: () => Date
}

/**
 * Bring one Google account's calendars up to date: the calendar list, then the changes to each
 * calendar that's shown. Each calendar records when it synced or why it couldn't. A refused
 * sign-in or a busy Google stops the round (and is thrown) so the caller can back off; any other
 * failure is listed in `failed` and the rest carry on.
 */
export async function syncGoogleAccount(
  provider: GoogleCalendarProvider,
  store: CalendarStore,
  { window, signal, onProgress, force = false, now = () => new Date() }: GoogleSyncOptions,
): Promise<CalendarSyncResult> {
  const calendars = await provider.listCalendars()
  store.setCalendars(calendars, provider.key)
  const result: CalendarSyncResult = {
    calendars: calendars.length,
    fetched: 0,
    skipped: 0,
    events: 0,
    stopped: false,
  }
  for (const [i, cal] of calendars.entries()) {
    onProgress?.({ done: i, total: calendars.length, current: cal.name })
    if (signal?.aborted) return { ...result, stopped: true }
    // Hidden calendars are fetched when they're shown.
    if (!store.calendar(cal.id)?.visible) {
      result.skipped++
      continue
    }
    try {
      const changed = await provider.syncCalendar(cal.id, { force })
      const state = store.syncState(cal.id)
      const same =
        state !== null &&
        state.from.getTime() === window.start.getTime() &&
        state.to.getTime() === window.end.getTime()
      if (changed || !same || force) {
        const { events, resources } = provider.build(cal.id, window)
        store.replaceEvents(cal.id, events, window, undefined, resources)
        result.fetched++
        result.events += events.length
      } else result.skipped++
      store.setSyncOutcome(cal.id, { at: now() })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      store.setSyncOutcome(cal.id, { error: message })
      if (signal?.aborted || err instanceof CalendarAuthError || err instanceof CalendarConnectionError)
        throw err
      ;(result.failed ??= []).push({ calendarId: cal.id, name: cal.name, message })
    }
  }
  onProgress?.({ done: calendars.length, total: calendars.length })
  return result
}
