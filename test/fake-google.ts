/**
 * A fake Google for tests, on 127.0.0.1: the OAuth endpoints (consent, token, revoke) and the parts of
 * Calendar API v3 Ordo uses (calendarList, events list with sync and page tokens, get, insert, patch,
 * delete, instances), with ETags, If-Match / If-None-Match and injectable failures (401, 410, 412,
 * 429 with Retry-After, quota errors). Never a real Google endpoint: tests point Ordo at `base`.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { zonedTimeToUtc } from '../packages/calendar-core/src/time'

export interface FakeEvent {
  id: string
  etag: string
  status: 'confirmed' | 'tentative' | 'cancelled'
  iCalUID: string
  summary?: string
  description?: string
  location?: string
  start?: { date?: string; dateTime?: string; timeZone?: string }
  end?: { date?: string; dateTime?: string; timeZone?: string }
  recurrence?: string[]
  recurringEventId?: string
  originalStartTime?: { date?: string; dateTime?: string; timeZone?: string }
  reminders?: { useDefault: boolean; overrides?: { method: string; minutes: number }[] }
  organizer?: { email: string; self?: boolean }
  attendees?: { email: string; self?: boolean; responseStatus?: string }[]
  eventType?: string
  updated: string
  /** Fake-only: when it last changed, for sync tokens. */
  seq: number
}

export interface FakeCalendar {
  id: string
  summary: string
  accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader'
  backgroundColor?: string
  primary?: boolean
  selected?: boolean
  timeZone?: string
  events: Map<string, FakeEvent>
}

export interface Fault {
  method?: string
  /** Matched against the path (without the query). */
  path: RegExp
  status: number
  headers?: Record<string, string>
  body?: unknown
  /** How many requests it answers (default 1). */
  times?: number
}

export interface FakeAccount {
  sub: string
  email: string
}

export interface Recorded {
  method: string
  path: string
  query: Record<string, string>
  headers: IncomingMessage['headers']
  body: unknown
}

const json = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

const apiError = (res: ServerResponse, status: number, reason: string, message = reason) =>
  json(res, status, { error: { code: status, message, errors: [{ reason, message }] } })

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url')

/** `20261124T090000Z` or `20261124` from an RFC 3339 instant or a date, for instance ids. */
const compact = (s: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s)
    ? s.replace(/-/g, '')
    : new Date(s)
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '')

type Time = { date?: string; dateTime?: string; timeZone?: string }

/** Google answers with instants that have an offset, whatever form they were written in. */
function normalise(t: Time): Time {
  if (!t.dateTime || /(Z|[+-]\d\d:\d\d)$/.test(t.dateTime)) return t
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(t.dateTime)
  if (!m) return t
  const wall = {
    year: +m[1]!,
    month: +m[2]!,
    day: +m[3]!,
    hour: +m[4]!,
    minute: +m[5]!,
    second: +(m[6] ?? 0),
  }
  const at = t.timeZone
    ? zonedTimeToUtc(wall, t.timeZone)
    : new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second))
  return { ...t, dateTime: at.toISOString().replace('.000Z', 'Z') }
}

export class FakeGoogle {
  server: Server
  base = ''
  clientId = '1234-testclient.apps.googleusercontent.com'
  clientSecret = 'test-secret'
  account: FakeAccount = { sub: '1234567890', email: 'me@work.example' }
  calendars = new Map<string, FakeCalendar>()
  requests: Recorded[] = []
  faults: Fault[] = []
  /** Events per page in list responses (Google's own default is 250). */
  pageSize = 250
  /** Codes waiting to be exchanged. */
  private codes = new Map<
    string,
    { challenge: string; redirectUri: string; scope: string; account: FakeAccount }
  >()
  refreshTokens = new Map<string, { account: FakeAccount; scope: string }>()
  accessTokens = new Map<string, { account: FakeAccount; scope: string }>()
  revoked: string[] = []
  /** Sync tokens carry this; `expireSyncTokens` moves it on, so older ones get 410 Gone. */
  private generation = 1
  /** What the consent screen does: approve, or send back an error such as `access_denied`. */
  consent: { error?: string } = {}
  private seq = 1
  private ids = 1

  constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((err: unknown) => {
        json(res, 500, { error: { code: 500, message: String(err) } })
      })
    })
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  addCalendar(c: Omit<FakeCalendar, 'events'>): FakeCalendar {
    const cal = { ...c, events: new Map<string, FakeEvent>() }
    this.calendars.set(c.id, cal)
    return cal
  }

  /** Add or change an event as if someone did it in Google Calendar. */
  put(calendarId: string, e: Partial<FakeEvent> & { id?: string }): FakeEvent {
    const cal = this.calendars.get(calendarId)!
    const prev = e.id ? cal.events.get(e.id) : undefined
    const id = e.id ?? `ev${this.ids++}`
    for (const k of ['start', 'end', 'originalStartTime'] as const) if (e[k]) e[k] = normalise(e[k])
    const next: FakeEvent = {
      status: 'confirmed',
      iCalUID: prev?.iCalUID ?? `${id}@google.com`,
      ...prev,
      ...e,
      id,
      etag: `"${this.seq}"`,
      updated: new Date(Date.UTC(2026, 10, 1) + this.seq * 1000).toISOString(),
      seq: this.seq++,
    }
    cal.events.set(id, next)
    return next
  }

  /** Give the next matching request(s) this answer. */
  fail(f: Fault): void {
    this.faults.push({ times: 1, ...f })
  }

  /** Access tokens stop working (they expire), so the next request gets a 401. */
  expireAccessTokens(): void {
    this.accessTokens.clear()
  }

  /** Every sync token issued so far stops working (410 Gone). */
  expireSyncTokens(): void {
    this.generation++
  }

  apiRequests(): Recorded[] {
    return this.requests.filter((r) => r.path.startsWith('/calendar/'))
  }

  private async body(req: IncomingMessage): Promise<{ raw: string; parsed: unknown }> {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    const type = req.headers['content-type'] ?? ''
    if (!raw) return { raw, parsed: undefined }
    if (type.includes('application/json')) return { raw, parsed: JSON.parse(raw) }
    if (type.includes('application/x-www-form-urlencoded'))
      return { raw, parsed: Object.fromEntries(new URLSearchParams(raw)) }
    return { raw, parsed: raw }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.base)
    const { parsed } = await this.body(req)
    const method = req.method ?? 'GET'
    this.requests.push({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: parsed,
    })
    const fault = this.faults.find((f) => (!f.method || f.method === method) && f.path.test(url.pathname))
    if (fault) {
      fault.times = (fault.times ?? 1) - 1
      if (fault.times <= 0) this.faults.splice(this.faults.indexOf(fault), 1)
      return json(
        res,
        fault.status,
        fault.body ?? { error: { code: fault.status, message: 'fault' } },
        fault.headers,
      )
    }
    if (url.pathname === '/o/oauth2/v2/auth' && method === 'GET') return this.authorize(url, res)
    if (url.pathname === '/token' && method === 'POST')
      return this.token(parsed as Record<string, string>, res)
    if (url.pathname === '/revoke' && method === 'POST') {
      const token = (parsed as Record<string, string>)['token'] ?? url.searchParams.get('token') ?? ''
      this.revoked.push(token)
      this.refreshTokens.delete(token)
      return json(res, this.revoked.length ? 200 : 400, {})
    }
    if (url.pathname.startsWith('/calendar/v3/')) {
      const auth = /^Bearer (.+)$/.exec(req.headers['authorization'] ?? '')?.[1]
      if (!auth || !this.accessTokens.has(auth)) return apiError(res, 401, 'authError', 'Invalid Credentials')
      return this.calendarApi(method, url, req, parsed, res)
    }
    json(res, 404, { error: { code: 404, message: 'Not found' } })
  }

  /** The consent screen, approved at once: redirect back to the app with a code (or an error). */
  private authorize(url: URL, res: ServerResponse): void {
    const q = url.searchParams
    const redirect = q.get('redirect_uri') ?? ''
    if (q.get('client_id') !== this.clientId) return json(res, 400, { error: 'invalid_client' })
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge'))
      return json(res, 400, { error: 'invalid_request' })
    const back = new URL(redirect)
    if (this.consent.error) back.searchParams.set('error', this.consent.error)
    else {
      const code = `code-${b64url(randomBytes(12))}`
      this.codes.set(code, {
        challenge: q.get('code_challenge')!,
        redirectUri: redirect,
        scope: q.get('scope') ?? '',
        account: { ...this.account },
      })
      back.searchParams.set('code', code)
    }
    back.searchParams.set('state', q.get('state') ?? '')
    res.writeHead(302, { location: back.href })
    res.end()
  }

  private issue(account: FakeAccount, scope: string) {
    const access = `at-${b64url(randomBytes(12))}`
    this.accessTokens.set(access, { account, scope })
    return access
  }

  private idToken(account: FakeAccount): string {
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const payload = b64url(
      JSON.stringify({
        iss: 'https://accounts.google.com',
        aud: this.clientId,
        sub: account.sub,
        email: account.email,
        email_verified: true,
      }),
    )
    return `${header}.${payload}.fake-signature`
  }

  private token(form: Record<string, string>, res: ServerResponse): void {
    if (form['client_id'] !== this.clientId) return json(res, 401, { error: 'invalid_client' })
    if (form['client_secret'] !== undefined && form['client_secret'] !== this.clientSecret)
      return json(res, 401, { error: 'invalid_client' })
    if (form['grant_type'] === 'authorization_code') {
      const pending = this.codes.get(form['code'] ?? '')
      this.codes.delete(form['code'] ?? '')
      if (!pending) return json(res, 400, { error: 'invalid_grant', error_description: 'Bad code' })
      const challenge = createHash('sha256')
        .update(form['code_verifier'] ?? '')
        .digest('base64url')
      if (challenge !== pending.challenge)
        return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' })
      if (form['redirect_uri'] !== pending.redirectUri)
        return json(res, 400, { error: 'redirect_uri_mismatch' })
      const refresh = `rt-${b64url(randomBytes(12))}`
      this.refreshTokens.set(refresh, { account: pending.account, scope: pending.scope })
      return json(res, 200, {
        access_token: this.issue(pending.account, pending.scope),
        expires_in: 3599,
        refresh_token: refresh,
        scope: pending.scope,
        token_type: 'Bearer',
        id_token: this.idToken(pending.account),
      })
    }
    if (form['grant_type'] === 'refresh_token') {
      const known = this.refreshTokens.get(form['refresh_token'] ?? '')
      if (!known)
        return json(res, 400, {
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
        })
      return json(res, 200, {
        access_token: this.issue(known.account, known.scope),
        expires_in: 3599,
        scope: known.scope,
        token_type: 'Bearer',
      })
    }
    json(res, 400, { error: 'unsupported_grant_type' })
  }

  /** A refresh token the fake accepts, for tests that start signed in. */
  grant(scope = 'openid email https://www.googleapis.com/auth/calendar.events'): {
    refresh: string
    access: string
  } {
    const refresh = `rt-${b64url(randomBytes(12))}`
    this.refreshTokens.set(refresh, { account: { ...this.account }, scope })
    return { refresh, access: this.issue({ ...this.account }, scope) }
  }

  private visible(e: FakeEvent): Omit<FakeEvent, 'seq'> {
    const { seq: _seq, ...rest } = e
    return rest
  }

  private calendarApi(
    method: string,
    url: URL,
    req: IncomingMessage,
    body: unknown,
    res: ServerResponse,
  ): void {
    const path = url.pathname
    if (path === '/calendar/v3/users/me/calendarList' && method === 'GET')
      return json(res, 200, {
        items: [...this.calendars.values()].map(({ events: _e, ...c }) => c),
      })
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+)(\/instances)?)?$/.exec(path)
    if (!m) return apiError(res, 404, 'notFound')
    const cal = this.calendars.get(decodeURIComponent(m[1]!))
    if (!cal) return apiError(res, 404, 'notFound')
    const eventId = m[2] && decodeURIComponent(m[2])
    const canWrite = cal.accessRole === 'owner' || cal.accessRole === 'writer'
    if (!eventId && method === 'GET') return this.list(cal, url, res)
    if (!eventId && method === 'POST') {
      if (!canWrite) return apiError(res, 403, 'requiredAccessLevel')
      const b = body as Partial<FakeEvent>
      const e = this.put(cal.id, {
        ...b,
        id: undefined,
        iCalUID: b.iCalUID ?? `${this.ids}@google.com`,
        status: 'confirmed',
      })
      return json(res, 200, this.visible(e))
    }
    if (!eventId) return apiError(res, 405, 'notAllowed')
    if (m[3]) return this.instances(cal, eventId, url, res)
    let e = cal.events.get(eventId)
    // An occurrence that isn't an exception yet: Google lets you change it by its instance id.
    if (!e) e = this.virtual(cal, eventId) ?? undefined
    if (!e) return apiError(res, 404, 'notFound')
    const ifMatch = req.headers['if-match']
    const ifNoneMatch = req.headers['if-none-match']
    if (method === 'GET') {
      if (e.status === 'cancelled' && !e.recurringEventId) return apiError(res, 410, 'deleted')
      if (ifNoneMatch && ifNoneMatch === e.etag) {
        res.writeHead(304)
        return void res.end()
      }
      return json(res, 200, this.visible(e))
    }
    if (!canWrite) return apiError(res, 403, 'requiredAccessLevel')
    if (e.status === 'cancelled' && !e.recurringEventId) return apiError(res, 410, 'deleted')
    if (ifMatch && ifMatch !== e.etag) return apiError(res, 412, 'conditionNotMet', 'Precondition Failed')
    if (method === 'PATCH' || method === 'PUT') {
      const b = body as Partial<FakeEvent>
      const next = this.put(cal.id, { ...e, ...b, id: e.id, etag: e.etag })
      return json(res, 200, this.visible(next))
    }
    if (method === 'DELETE') {
      this.put(cal.id, { ...e, status: 'cancelled' })
      res.writeHead(204)
      return void res.end()
    }
    apiError(res, 405, 'notAllowed')
  }

  private list(cal: FakeCalendar, url: URL, res: ServerResponse): void {
    const q = url.searchParams
    for (const p of ['timeMin', 'timeMax', 'updatedMin', 'q', 'orderBy', 'iCalUID'])
      if (q.get('syncToken') && q.has(p))
        return apiError(res, 400, 'invalid', `${p} can't be used with syncToken`)
    if (q.get('singleEvents') === 'true')
      return apiError(res, 400, 'invalid', 'The fake only does singleEvents=false')
    const token = q.get('syncToken')
    let since = 0
    if (token) {
      const t = /^sync-(\d+)-(\d+)$/.exec(token)
      if (!t || Number(t[1]) !== this.generation)
        return apiError(res, 410, 'fullSyncRequired', 'Sync token is no longer valid')
      since = Number(t[2])
    }
    // A full sync lists cancelled events (deleted ones, and cancelled occurrences of a series)
    // only with showDeleted=true; a sync with a token always lists what changed, deletions too.
    const deleted = q.get('showDeleted') === 'true'
    const all = [...cal.events.values()]
      .filter((e) => (token ? e.seq >= since : deleted || e.status !== 'cancelled'))
      .sort((a, b) => a.seq - b.seq)
    const size = Math.min(Number(q.get('maxResults') ?? 250), this.pageSize, 2500)
    const offset = Number(/^page-(\d+)$/.exec(q.get('pageToken') ?? '')?.[1] ?? 0)
    const items = all.slice(offset, offset + size)
    const more = offset + size < all.length
    json(res, 200, {
      kind: 'calendar#events',
      items: items.map((e) => this.visible(e)),
      ...(more
        ? { nextPageToken: `page-${offset + size}` }
        : { nextSyncToken: `sync-${this.generation}-${this.seq}` }),
    })
  }

  /** The instance of a series that starts (originally) at `originalStart`, as Google makes them. */
  private virtual(cal: FakeCalendar, instanceId: string): FakeEvent | null {
    const m = /^(.+)_(\d{8}(?:T\d{6}Z)?)$/.exec(instanceId)
    if (!m) return null
    const master = cal.events.get(m[1]!)
    if (!master || !master.recurrence || !master.start) return null
    const raw = m[2]!
    const allDay = raw.length === 8
    const iso = allDay
      ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
      : `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`
    const original = allDay ? { date: iso } : { dateTime: iso, timeZone: master.start.timeZone }
    const startMs = Date.parse(master.start.dateTime ?? master.start.date!)
    const endMs = Date.parse(
      master.end?.dateTime ?? master.end?.date ?? master.start.dateTime ?? master.start.date!,
    )
    const at = Date.parse(iso)
    const shift = (t: { date?: string; dateTime?: string; timeZone?: string } | undefined, ms: number) =>
      allDay
        ? { date: new Date(ms).toISOString().slice(0, 10) }
        : { dateTime: new Date(ms).toISOString(), timeZone: t?.timeZone }
    return {
      ...master,
      id: instanceId,
      recurrence: undefined,
      recurringEventId: master.id,
      originalStartTime: original,
      start: shift(master.start, at),
      end: shift(master.end, at + (endMs - startMs)),
      etag: master.etag,
    }
  }

  private instances(cal: FakeCalendar, masterId: string, url: URL, res: ServerResponse): void {
    const master = cal.events.get(masterId)
    if (!master) return apiError(res, 404, 'notFound')
    const original = url.searchParams.get('originalStart')
    if (!original) return apiError(res, 400, 'required', 'The fake needs originalStart')
    const id = `${masterId}_${compact(original)}`
    const own = cal.events.get(id) ?? this.virtual(cal, id)
    json(res, 200, { items: own ? [this.visible(own)] : [] })
  }
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  return new FakeGoogle().start()
}
