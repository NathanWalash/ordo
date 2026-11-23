import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, powerMonitor, safeStorage } from 'electron'
import {
  parseIcs,
  syncWindow,
  type CalendarSyncResult,
  type WritableCalendarProvider,
} from '@ordo/calendar-core'
import {
  CalDavProvider,
  CalendarAuthError,
  CalendarConnectionError,
  CalendarUnavailableError,
  CalendarStore,
  CalendarWriteError,
  GOOGLE_PREFIX,
  GoogleApiError,
  GoogleCalendarProvider,
  googleCalendarIdFromFeedUrl,
  googleProvider,
  parseGoogleCalendarKey,
  syncGoogleAccount,
  createEvent as addEvent,
  deleteEvent as removeEvent,
  EventChangeError,
  eventDetails as readDetails,
  updateEvent as changeEvent,
  type ChangeOptions,
  checkFeedUrl,
  describeIcs,
  readIcs,
  FEED_MAX_BYTES,
  FeedError,
  FeedProvider,
  FEEDS,
  fetchFeed,
  ICLOUD,
  ICLOUD_CALDAV_URL,
  syncCalendars,
  LOCAL_ADDRESS_MESSAGE,
  type Feed,
  type FetchFeedOptions,
  type StoredFeed,
} from '@ordo/calendar-core/node'
import {
  AddCalendarLinkSchema,
  CalendarColorSchema,
  ConnectGoogleSchema,
  CreateEventSchema,
  DateRangeSchema,
  DeleteEventSchema,
  EventRefSchema,
  GOOGLE_IPC,
  GoogleAccountIdSchema,
  GoogleClientSchema,
  IPC,
  ReplaceFeedSchema,
  SetVisibleSchema,
  SignOutGoogleOptionsSchema,
  UpdateEventSchema,
  type AddCalendarOutcome,
  type GoogleAccountStatus,
  type GoogleConnectError,
  type GoogleConnectOutcome,
  type GoogleFeedMatch,
  type GoogleSimpleOutcome,
  type GoogleStatus,
  type CalendarChangeOutcome,
  type EventDetails,
  type CalendarEvent,
  type CalendarListItem,
  type CalendarStatus,
  type CalendarSyncError,
  type CalendarSyncProgress,
  type CalendarSyncOutcome,
} from '@ordo/shared'
import { createGuardedFetch } from '@ordo/mail-core/node'
import { hostRefusal } from '@ordo/mail-core'
import { accountsSignedInWith, canStoreSecrets, loadAccount } from './account'
import { allowLoopbackHttp, removeAccount } from './mail'
import { Locked, toRenderer, withWriteLock } from './writes'
import { fromAppWindow } from './ipc-sender'
import {
  CALENDAR_SCOPES,
  googleAuth,
  googleEndpoints,
  googleFetchFn,
  GoogleReauthError,
  hasCalendarScopes,
  OAuthError,
  SCOPES,
  type GoogleAccountInfo,
} from './google'
import { Poller, type PollResult } from './google/poller'

let store: CalendarStore | null = null
let running: AbortController | null = null

const openStore = () => (store ??= new CalendarStore(join(app.getPath('userData'), 'calendar.sqlite')))

/** iCloud by default. Tests can point an unpackaged build at a local CalDAV server. */
function caldavUrl(): string {
  return (!app.isPackaged && process.env['ORDO_CALDAV_URL']) || ICLOUD_CALDAV_URL
}

/**
 * iCloud calendars belong to one account: forget them if the account was removed or changed.
 * Calendars added by link or file stay.
 */
function storeFor(email: string | null): CalendarStore {
  const s = openStore()
  if (s.meta('account') !== email) {
    s.clearProvider(ICLOUD)
    s.setMeta('account', email)
  }
  // Google accounts signed out (perhaps by another Ordo process): forget their calendars too.
  const signedIn = new Set(googleAccounts().map((g) => googleProvider(g.id)))
  const stale = new Set(
    s
      .calendars()
      .map((c) => c.provider ?? '')
      .filter((p) => p.startsWith(GOOGLE_PREFIX) && !signedIn.has(p)),
  )
  for (const p of stale) s.clearProvider(p)
  return s
}

/** Every connected Google account (Calendar's and Mail's), or none if the file can't be read. */
function allGoogleAccounts(): GoogleAccountInfo[] {
  try {
    return googleAuth().accounts()
  } catch {
    return []
  }
}

/** The connected Google accounts that gave Ordo Calendar access (not those added for Mail only). */
function googleAccounts(): GoogleAccountInfo[] {
  return allGoogleAccounts().filter((g) => hasCalendarScopes(g.scopes))
}

/** Calendar needs to list calendars and change events; sign-in asked for these and openid/email. */
const CALENDAR_API_SCOPES = [SCOPES.calendarList, SCOPES.calendarEvents]

function googleCalendars(accountId: string): GoogleCalendarProvider {
  return new GoogleCalendarProvider({
    accountId,
    store: openStore(),
    apiBase: googleEndpoints().api,
    fetch: googleFetchFn(),
    token: (refresh) => googleAuth().getAccessToken(accountId, CALENDAR_API_SCOPES, { refresh }),
  })
}

/** The Google account behind a calendar, if it's a Google calendar. */
function googleAccountOf(calendarId: string): string | null {
  const provider = openStore().calendar(calendarId)?.provider ?? ''
  return provider.startsWith(GOOGLE_PREFIX) ? provider.slice(GOOGLE_PREFIX.length) : null
}

const reauthMessage = (email: string) =>
  `Google needs you to sign in to ${email} again. Open Settings › Google and choose Sign in again.`

function account() {
  const a = loadAccount()
  storeFor(a?.email ?? null)
  return a
}

export function explain(err: unknown): { error: CalendarSyncError; message: string } {
  if (err instanceof CalendarAuthError)
    return {
      error: 'auth',
      message:
        "iCloud didn't accept your app-specific password for Calendar. Reconnect your account and try again.",
    }
  if (err instanceof CalendarUnavailableError)
    return {
      error: 'network',
      message:
        'iCloud Calendar is busy or limiting requests right now. Wait a few minutes and try again, and check Apple’s System Status page if it keeps happening.',
    }
  if (err instanceof CalendarConnectionError)
    return {
      error: 'network',
      message: "Couldn't reach iCloud Calendar. Check your internet connection and try again.",
    }
  return { error: 'unknown', message: 'Something went wrong syncing your calendars. Try again in a moment.' }
}

export function status(): CalendarStatus {
  const a = account()
  const s = openStore()
  const base = {
    lastSync: s.meta('lastSync'),
    syncing: running !== null,
    subscriptions: s.feedCount(),
    google: googleAccounts().length,
  }
  return a ? { ...base, connected: true, email: a.email } : { ...base, connected: false }
}

export interface CalendarSyncOptions {
  force?: boolean
  /** Only the Google accounts (the background poll): iCloud and links keep their own pace. */
  googleOnly?: boolean
}

/**
 * Fetch calendars changed since the last sync (all of them with `force`) into the cache:
 * iCloud's, then each Google account's, then those added by link. A Google account or link that
 * fails doesn't stop the others; it's listed in `failed`. If iCloud fails, its error is returned
 * after the rest have been synced.
 */
export function sync(
  options?: CalendarSyncOptions,
  onProgress?: (p: CalendarSyncProgress) => void,
): Promise<CalendarSyncOutcome> {
  const p = runSync(options, onProgress)
  if (!syncing) {
    syncing = p
    const done = () => {
      if (syncing === p) syncing = null
    }
    p.then(done, done)
  }
  return p
}

/** The sync in progress, so a change can wait for it rather than be overwritten by stale data. */
let syncing: Promise<CalendarSyncOutcome> | null = null

async function runSync(
  options?: CalendarSyncOptions,
  onProgress?: (p: CalendarSyncProgress) => void,
): Promise<CalendarSyncOutcome> {
  const only = options?.googleOnly === true
  const signedIn = account()
  const a = only ? null : signedIn
  const feeds = only ? [] : openStore().feeds()
  const google = googleAccounts()
  if (!a && !feeds.length && !google.length)
    return only
      ? { ok: true, calendars: 0, fetched: 0, skipped: 0, events: 0, stopped: false }
      : {
          ok: false,
          error: 'auth',
          message: 'Connect your iCloud or Google account, or add a calendar first.',
        }
  if (running) return { ok: false, error: 'busy', message: 'Your calendars are already syncing.' }
  const ctrl = (running = new AbortController())
  // Let changes already on their way finish, so the sync doesn't cache what was there before them.
  const queued = changes
  try {
    await queued
    const result = await withWriteLock('syncing calendars', async (): Promise<CalendarSyncOutcome> => {
      let offset = 0
      const total: CalendarSyncResult = { calendars: 0, fetched: 0, skipped: 0, events: 0, stopped: false }
      let failure: CalendarSyncOutcome | null = null
      if (a) {
        const r = await fetchCalendars(a, ctrl.signal, options, (p) => {
          offset = p.total
          onProgress?.(p)
        })
        if (r.ok) add(total, r)
        else failure = r
      }
      for (const g of google) {
        if (ctrl.signal.aborted) break
        const r = await fetchGoogle(g, ctrl.signal, options, (p) =>
          onProgress?.({ done: offset + p.done, total: offset + p.total, current: p.current }),
        )
        if (r.ok) {
          add(total, r.result)
          offset += r.result.calendars
        } else total.failed = [...(total.failed ?? []), r.failed]
      }
      if (feeds.length && !ctrl.signal.aborted) {
        const r = await syncCalendars(
          new FeedProvider(feeds.map(unseal), feedFetch(ctrl.signal)),
          openStore(),
          {
            window: syncWindow(),
            signal: ctrl.signal,
            force: options?.force === true,
            provider: FEEDS,
            continueOnError: true,
            onProgress: (p) =>
              onProgress?.({ done: offset + p.done, total: offset + p.total, current: p.current }),
          },
        ).catch((err: unknown) => {
          failure ??= { ok: false, ...explain(err) }
          return null
        })
        if (r) add(total, r)
      }
      // The background Google poll doesn't count: iCloud and links still sync when they're stale.
      const synced = total.fetched + total.skipped > 0
      if (synced && !total.stopped && !only) openStore().setMeta('lastSync', new Date().toISOString())
      return failure ?? { ok: true, ...total }
    })
    return result instanceof Locked ? { ok: false, error: 'locked', message: result.message } : result
  } finally {
    if (running === ctrl) running = null
  }
}

function add(total: CalendarSyncResult, r: CalendarSyncResult): void {
  total.calendars += r.calendars
  total.fetched += r.fetched
  total.skipped += r.skipped
  total.events += r.events
  total.stopped ||= r.stopped
  if (r.failed?.length) total.failed = [...(total.failed ?? []), ...r.failed]
}

async function fetchCalendars(
  a: { email: string; password: string },
  signal: AbortSignal,
  options?: { force?: boolean },
  onProgress?: (p: CalendarSyncProgress) => void,
): Promise<CalendarSyncOutcome> {
  const provider = new CalDavProvider({ serverUrl: caldavUrl(), username: a.email, password: a.password })
  try {
    await provider.connect()
    const result = await syncCalendars(provider, openStore(), {
      window: syncWindow(),
      signal,
      force: options?.force === true,
      onProgress,
    })
    return { ok: true, ...result }
  } catch (err) {
    return { ok: false, ...explain(err) }
  } finally {
    await provider.close().catch(() => {})
  }
}

// ---- Google accounts: syncing, and keeping them near live ------------------------------------

/** How each Google account's syncs are going, for the background poll's back-off. */
const googleHealth = new Map<string, PollResult>()

/** Why a Google account couldn't sync, for people. */
function googleProblem(err: unknown, g: GoogleAccountInfo): string {
  const cause = err instanceof Error ? err.cause : undefined
  if (cause instanceof GoogleReauthError || googleAuth().account(g.id)?.needsReauth)
    return reauthMessage(g.email)
  if (err instanceof CalendarAuthError)
    return `Google didn’t accept Ordo’s sign-in for ${g.email}. Open Settings › Google and choose Sign in again.`
  if (err instanceof CalendarUnavailableError)
    return 'Google Calendar is busy or limiting requests right now. Ordo will try again in a few minutes.'
  if (err instanceof CalendarConnectionError || (cause instanceof OAuthError && cause.code === 'network'))
    return 'Couldn’t reach Google Calendar. Check your internet connection; Ordo will try again.'
  if (err instanceof GoogleApiError) return err.message
  return 'Something went wrong syncing your Google calendars. Ordo will try again in a few minutes.'
}

async function fetchGoogle(
  g: GoogleAccountInfo,
  signal: AbortSignal,
  options?: CalendarSyncOptions,
  onProgress?: (p: CalendarSyncProgress) => void,
): Promise<
  | { ok: true; result: CalendarSyncResult }
  | { ok: false; failed: { calendarId: string; name: string; message: string } }
> {
  const s = openStore()
  const fail = (message: string) => {
    for (const c of s.calendars())
      if (c.provider === googleProvider(g.id)) s.setSyncOutcome(c.id, { error: message })
    return { ok: false as const, failed: { calendarId: googleProvider(g.id), name: g.email, message } }
  }
  if (g.needsReauth) return fail(reauthMessage(g.email))
  try {
    const result = await syncGoogleAccount(googleCalendars(g.id), s, {
      window: syncWindow(),
      signal,
      force: options?.force === true,
      onProgress,
    })
    googleHealth.set(g.id, { failures: 0 })
    return { ok: true, result }
  } catch (err) {
    const was = googleHealth.get(g.id)?.failures ?? 0
    googleHealth.set(g.id, {
      failures: was + 1,
      ...(err instanceof CalendarUnavailableError &&
        err.retryAfterMs !== undefined && { retryAfterMs: err.retryAfterMs }),
    })
    return fail(googleProblem(err, g))
  }
}

/** Tell every window the calendars changed, so an open Calendar page shows it. */
function broadcastChanged(): void {
  for (const w of BrowserWindow.getAllWindows())
    if (!w.webContents.isDestroyed()) w.webContents.send(IPC.calendarChanged)
}

let poller: Poller | null = null

/**
 * While the app is open, keep Google calendars near live: a sync every few minutes (with jitter,
 * backing off after failures and honouring Retry-After), and soon after the window is focused,
 * the computer wakes, a Google calendar is shown or Ordo changes an event. Google's push
 * notifications need a public HTTPS address, which a desktop app doesn't have, so it polls.
 */
export function startCalendarPolling(): void {
  if (poller) return
  poller = new Poller({
    run: async () => {
      if (!googleAccounts().length) return { failures: 0 }
      const r = await sync({ googleOnly: true })
      if (r.ok && r.fetched > 0) broadcastChanged()
      const health = [...googleHealth.values()]
      return {
        failures: Math.max(0, ...health.map((h) => h.failures)),
        retryAfterMs: Math.max(0, ...health.map((h) => h.retryAfterMs ?? 0)) || undefined,
      }
    },
  })
  poller.start(5_000)
  app.on('browser-window-focus', () => poller?.poke('focus'))
  powerMonitor.on('resume', () => poller?.poke('resume'))
}

// ---- Creating, changing and deleting events -------------------------------------------------

/** The calendars with a cached event `uid`, for headless commands that name an event by its UID. */
export function locateEvent(uid: string): string[] {
  account()
  return openStore().calendarsWithEvent(uid)
}

/** Which account changes events on a calendar: iCloud's, or the Google account it belongs to. */
type Writer =
  | { ok: true; provider: WritableCalendarProvider; me: string; google?: string; close: () => Promise<void> }
  | { ok: false; outcome: CalendarChangeOutcome }

function writerFor(calendarId: string): Writer {
  const googleId = googleAccountOf(calendarId)
  if (googleId) {
    const g = googleAuth().account(googleId)
    if (!g)
      return {
        ok: false,
        outcome: {
          ok: false,
          error: 'not-connected',
          message: 'That Google account isn’t connected to Ordo any more.',
        },
      }
    if (g.needsReauth)
      return { ok: false, outcome: { ok: false, error: 'auth', message: reauthMessage(g.email) } }
    return {
      ok: true,
      provider: googleCalendars(googleId),
      me: g.email,
      google: googleId,
      close: async () => {},
    }
  }
  const a = account()
  if (!a)
    return {
      ok: false,
      outcome: {
        ok: false,
        error: 'not-connected',
        message: 'Connect your iCloud account to change events.',
      },
    }
  const provider = new CalDavProvider({ serverUrl: caldavUrl(), username: a.email, password: a.password })
  return { ok: true, provider, me: a.email, close: () => provider.close().catch(() => {}) }
}

/** An event's details for the editor, and whether Ordo can change it. */
export function eventDetails(input: unknown): EventDetails | null {
  const parsed = EventRefSchema.safeParse(input)
  if (!parsed.success) return null
  const a = account()
  const googleId = googleAccountOf(parsed.data.calendarId)
  const g = googleId ? googleAuth().account(googleId) : null
  const d = readDetails(openStore(), parsed.data, googleId ? g?.email : a?.email)
  if (!d) return null
  const signedIn = googleId ? !!g && !g.needsReauth : a !== null
  const editable = d.editable && signedIn
  const fallback = googleId
    ? g
      ? reauthMessage(g.email)
      : 'That Google account isn’t connected to Ordo any more.'
    : 'Connect your iCloud account to change events.'
  return {
    calendarId: d.calendarId,
    draft: d.draft,
    recurring: d.recurring,
    editable,
    ...(!editable && { reason: d.editable ? fallback : (d.reason ?? fallback) }),
  }
}

function changeFailure(err: unknown, google: GoogleAccountInfo | null): CalendarChangeOutcome {
  if (err instanceof EventChangeError) return { ok: false, error: err.kind, message: err.message }
  const where = google ? 'Google Calendar' : 'iCloud Calendar'
  if (err instanceof CalendarAuthError)
    return {
      ok: false,
      error: 'auth',
      message: google
        ? reauthMessage(google.email)
        : "iCloud didn't accept your app-specific password for Calendar. Reconnect your account and try again.",
    }
  if (err instanceof CalendarUnavailableError)
    return {
      ok: false,
      error: 'network',
      message: `${where} is busy or limiting requests, so nothing was changed. Try again in a few minutes.`,
    }
  if (err instanceof CalendarConnectionError)
    return {
      ok: false,
      error: 'network',
      message: `Couldn't reach ${where}, so nothing was changed. Check your internet connection and try again.`,
    }
  if (err instanceof GoogleApiError) return { ok: false, error: 'unknown', message: err.message }
  if (err instanceof CalendarWriteError)
    return {
      ok: false,
      error: 'unknown',
      message: `${google ? 'Google Calendar' : 'iCloud'} couldn’t save the change${err.status ? ` (${err.status})` : ''}. Try again in a moment.`,
    }
  return {
    ok: false,
    error: 'unknown',
    message: 'Something went wrong changing your calendar. Try again in a moment.',
  }
}

type ChangeFn = (
  provider: WritableCalendarProvider,
  store: CalendarStore,
  options: ChangeOptions,
) => Promise<string>

/**
 * Run one change against the calendar's account (iCloud or Google): after any sync in progress,
 * holding the write lock, with the cache updated from what the server saved. Never throws.
 */
async function change(task: string, calendarId: string, fn: ChangeFn): Promise<CalendarChangeOutcome> {
  account()
  const first = writerFor(calendarId)
  if (!first.ok) return first.outcome
  await first.close()
  // One change at a time, each after the syncs that started before it, so each one sends the
  // ETag the last one saved. (The write lock is shared within this process, so it can't do this.)
  const sync = syncing
  const turn = changes.then(async () => {
    if (sync) await sync.catch(() => {})
    return runChange(calendarId, task, fn)
  })
  changes = turn.catch(() => {})
  return turn
}

/** Changes in this process, in order. A sync waits for the ones queued before it. */
let changes: Promise<unknown> = Promise.resolve()

async function runChange(calendarId: string, task: string, fn: ChangeFn): Promise<CalendarChangeOutcome> {
  const r = await withWriteLock(task, async (): Promise<CalendarChangeOutcome> => {
    const w = writerFor(calendarId)
    if (!w.ok) return w.outcome
    try {
      const uid = await fn(w.provider, openStore(), { window: syncWindow(), me: w.me })
      return { ok: true, uid }
    } catch (err) {
      return changeFailure(err, w.google ? googleAuth().account(w.google) : null)
    } finally {
      await w.close()
    }
  })
  // A Google change: pick up whatever else Google changed with it (a moved series' occurrences).
  if (googleAccountOf(calendarId)) poller?.poke('write')
  return r instanceof Locked ? { ok: false, error: 'locked', message: r.message } : r
}

const invalid = (issues: { message: string }[]): CalendarChangeOutcome => ({
  ok: false,
  error: 'invalid',
  message: issues[0]?.message ?? 'That event isn’t complete.',
})

/** Add an event to a writable iCloud or Google calendar. */
export async function createEvent(input: unknown): Promise<CalendarChangeOutcome> {
  const parsed = CreateEventSchema.safeParse(input)
  if (!parsed.success) return invalid(parsed.error.issues)
  const { calendarId, draft } = parsed.data
  return change(
    'adding an event',
    calendarId,
    async (p, s, o) => (await addEvent(p, s, calendarId, draft, o)).uid,
  )
}

/** Change an event, or one occurrence of a repeating event (`scope: 'this'`). */
export async function updateEvent(input: unknown): Promise<CalendarChangeOutcome> {
  const parsed = UpdateEventSchema.safeParse(input)
  if (!parsed.success) return invalid(parsed.error.issues)
  const { ref, draft, scope } = parsed.data
  return change('changing an event', ref.calendarId, async (p, s, o) => {
    await changeEvent(p, s, ref, draft, scope, o)
    return ref.uid
  })
}

/** Delete an event, or one occurrence of a repeating event (`scope: 'this'`). */
export async function deleteEvent(input: unknown): Promise<CalendarChangeOutcome> {
  const parsed = DeleteEventSchema.safeParse(input)
  if (!parsed.success) return invalid(parsed.error.issues)
  const { ref, scope } = parsed.data
  return change('deleting an event', ref.calendarId, async (p, s, o) => {
    await removeEvent(p, s, ref, scope, o)
    return ref.uid
  })
}

export function calendars(): CalendarListItem[] {
  account()
  const emails = new Map(googleAccounts().map((g) => [googleProvider(g.id), g.email]))
  return openStore()
    .calendars()
    .map(({ provider, syncedAt, syncError, ...c }) => ({
      ...c,
      ...(provider && emails.has(provider) && { account: emails.get(provider) }),
      ...(syncedAt !== undefined && { syncedAt: new Date(syncedAt).toISOString() }),
      ...(syncError && { syncError }),
    }))
}

/** `calendars()`, for code where a parameter has that name. */
const listCalendars = () => calendars()

export function events(range: unknown): CalendarEvent[] {
  const r = DateRangeSchema.parse(range)
  account()
  return openStore().events(r)
}

// ---- Calendars added by link or file --------------------------------------------------------

/**
 * A feed link, or anything it redirects to, may only reach the public internet: never this
 * computer or the local network (checked when connecting, so DNS can't be used to slip past).
 */
function feedFetch(signal?: AbortSignal): Omit<FetchFeedOptions, 'maxBytes'> {
  const allowLoopback = allowLoopbackHttp()
  return {
    signal,
    allowLoopback,
    fetch: createGuardedFetch({ allowLoopback }) as unknown as typeof fetch,
    refuse: (url) => hostRefusal(url, { allowLoopback }),
  }
}

/** The link is a secret (anyone with it can read the calendar): keep it encrypted at rest. */
const seal = (url: string) => safeStorage.encryptString(url).toString('base64')

function unseal(f: StoredFeed): Feed {
  let url: string | undefined
  if (f.kind === 'link' && f.secret && canStoreSecrets()) {
    try {
      url = safeStorage.decryptString(Buffer.from(f.secret, 'base64'))
    } catch {
      url = undefined
    }
  }
  return { id: f.id, kind: f.kind, name: f.name, color: f.color, url, ics: f.ics }
}

const COLORS = ['#34c759', '#ff9500', '#af52de', '#ff2d55', '#5ac8fa', '#a2845e']

function nameFor(found: string | undefined, fallback: string): string {
  const name = (found ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  return name || fallback
}

function linkFallbackName(host: string): string {
  if (/(^|\.)google\.com$/i.test(host)) return 'Google Calendar'
  if (/(^|\.)(outlook|office365|live)\.com$/i.test(host)) return 'Outlook Calendar'
  if (/(^|\.)icloud\.com$/i.test(host)) return 'iCloud Calendar'
  return host
}

function feedFailure(err: unknown): AddCalendarOutcome {
  if (err instanceof FeedError) return { ok: false, error: err.kind, message: err.message }
  return { ok: false, error: 'network', message: 'Couldn’t read that calendar. Try again in a moment.' }
}

/**
 * Save a new link or file calendar and cache its events from `text`, which has already been
 * fetched or read, so it shows straight away.
 */
async function addFeed(
  feed: Omit<StoredFeed, 'id' | 'color'> & { color?: string },
  calendars: NonNullable<ReturnType<typeof readIcs>>,
): Promise<AddCalendarOutcome> {
  const r = await withWriteLock('adding a calendar', async (): Promise<AddCalendarOutcome> => {
    const s = openStore()
    const id = `feed:${randomUUID()}`
    const window = syncWindow()
    // Read the events before saving anything: a calendar that fails here must not be left half
    // added (saved, with no events, and "already added" when you try again).
    let events: CalendarEvent[]
    try {
      events = parseIcs(calendars, { calendarId: id, range: window })
    } catch {
      return { ok: false, error: 'not-calendar', message: 'Ordo couldn’t read the events in that calendar.' }
    }
    s.addFeed({ ...feed, id, color: feed.color ?? COLORS[s.feedCount() % COLORS.length] })
    s.setCalendars(
      s.feeds().map((f) => ({ id: f.id, name: f.name, color: f.color, readOnly: true })),
      FEEDS,
    )
    s.replaceEvents(id, events, window)
    return { ok: true as const, calendar: listCalendars().find((c) => c.id === id)! }
  })
  return r instanceof Locked ? { ok: false, error: 'locked', message: r.message } : r
}

/** Subscribe to a calendar by its link. Checks it really is a calendar before saving it. */
export async function addLink(input: unknown): Promise<AddCalendarOutcome> {
  const parsed = AddCalendarLinkSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'url', message: 'Paste the calendar’s link.' }
  const fetchOptions = feedFetch()
  const check = checkFeedUrl(parsed.data.url, { allowLoopback: fetchOptions.allowLoopback })
  if (!check.ok) return { ok: false, error: 'url', message: check.message }
  if (fetchOptions.refuse?.(check.url)) return { ok: false, error: 'url', message: LOCAL_ADDRESS_MESSAGE }
  if (!canStoreSecrets())
    return {
      ok: false,
      error: 'storage',
      message: 'Ordo can’t store this link securely on this computer, so it hasn’t been saved.',
    }
  account()
  if (
    openStore()
      .feeds()
      .some((f) => unseal(f).url === check.url)
  )
    return { ok: false, error: 'duplicate', message: 'You’ve already added this calendar.' }

  let text: string
  try {
    text = await fetchFeed(check.url, fetchOptions)
  } catch (err) {
    return feedFailure(err)
  }
  const calendars = readIcs(text)
  const info = calendars && describeIcs(calendars)
  if (!calendars || !info)
    return {
      ok: false,
      error: 'not-calendar',
      message: 'That link didn’t return a calendar. Check you copied the iCal (.ics) address.',
    }
  return addFeed(
    {
      kind: 'link',
      name: nameFor(info.name, linkFallbackName(check.host)),
      color: info.color,
      secret: seal(check.url),
      host: check.host,
    },
    calendars,
  )
}

/** Add an .ics file's events as a calendar of their own. */
export async function addIcsText(text: string, fileName: string): Promise<AddCalendarOutcome> {
  const calendars = readIcs(text)
  const info = calendars && describeIcs(calendars)
  if (!calendars || !info)
    return { ok: false, error: 'not-calendar', message: `${fileName} isn’t a calendar file.` }
  account()
  const name = nameFor(info.name, basename(fileName, extname(fileName)) || 'Imported calendar')
  return addFeed({ kind: 'file', name, color: info.color, ics: text }, calendars)
}

/** Pick an .ics file and add it. Null when the picker is cancelled. */
export async function importIcsFile(win?: BrowserWindow | null): Promise<AddCalendarOutcome | null> {
  const options: Electron.OpenDialogOptions = {
    title: 'Import a calendar',
    properties: ['openFile'],
    filters: [{ name: 'Calendar files', extensions: ['ics', 'ical', 'ifb', 'icalendar'] }],
  }
  const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  const path = r.filePaths[0]
  if (r.canceled || !path) return null
  if ((await stat(path)).size > FEED_MAX_BYTES)
    return { ok: false, error: 'too-large', message: 'That file is too big for Ordo to read.' }
  return addIcsText(await readFile(path, 'utf8'), basename(path))
}

/** Remove a calendar added by link or file, with its events. */
export async function removeCalendar(
  calendarId: unknown,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (typeof calendarId !== 'string' || !calendarId)
    return { ok: false, message: 'That calendar wasn’t found.' }
  const r = await withWriteLock('removing a calendar', async () => openStore().removeFeed(calendarId))
  if (r instanceof Locked) return { ok: false, message: r.message }
  return r
    ? { ok: true }
    : { ok: false, message: 'Only calendars added by link or file can be removed here.' }
}

export function setVisible(input: unknown): void {
  const { calendarId, visible } = SetVisibleSchema.parse(input)
  openStore().setVisible(calendarId, visible)
  // Hidden Google calendars aren't fetched: fetch one as soon as it's shown.
  if (visible && googleAccountOf(calendarId)) poller?.poke('shown')
}

/** Forget the iCloud calendars, when the account is disconnected. Link and file calendars stay. */
export function clearCalendar(): void {
  running?.abort()
  running = null
  openStore().clearProvider(ICLOUD)
}

export function closeCalendar(): void {
  poller?.stop()
  poller = null
  running?.abort()
  store?.close()
  store = null
}

// ---- Google accounts: Settings › Google -----------------------------------------------------

let signingIn = false

function accountStatus(g: GoogleAccountInfo): GoogleAccountStatus {
  const provider = googleProvider(g.id)
  return {
    id: g.id,
    email: g.email,
    needsReauth: g.needsReauth,
    calendars: openStore()
      .calendars()
      .filter((c) => c.provider === provider).length,
    calendar: hasCalendarScopes(g.scopes),
    mailAccounts: accountsSignedInWith(g.id).map((a) => ({ id: a.id, label: a.label, email: a.email })),
  }
}

export function googleStatus(): GoogleStatus {
  account()
  const auth = googleAuth()
  const client = (() => {
    try {
      return auth.client()
    } catch {
      return null
    }
  })()
  return {
    secureStorage: canStoreSecrets(),
    client: client ? { clientId: client.clientId, hasSecret: !!client.clientSecret } : null,
    accounts: allGoogleAccounts().map(accountStatus),
    signingIn,
  }
}

export function setGoogleClient(input: unknown): GoogleSimpleOutcome {
  const parsed = GoogleClientSchema.safeParse(input)
  if (!parsed.success)
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the client ID.' }
  try {
    googleAuth().setClient(parsed.data.clientId, parsed.data.clientSecret)
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Couldn’t save the client ID.' }
  }
}

function connectFailure(err: unknown): GoogleConnectOutcome {
  if (err instanceof OAuthError) {
    const map: Record<OAuthError['code'], GoogleConnectError> = {
      timeout: 'timeout',
      cancelled: 'cancelled',
      denied: 'denied',
      'admin-blocked': 'admin-blocked',
      scopes: 'scopes',
      'invalid-grant': 'unknown',
      'invalid-client': 'invalid-client',
      network: 'network',
      server: 'unknown',
      'wrong-account': 'unknown',
      'already-connected': 'unknown',
    }
    return { ok: false, error: map[err.code], message: err.message }
  }
  return { ok: false, error: 'unknown', message: 'Google sign-in didn’t finish. Try again.' }
}

/**
 * Sign in to Google in the browser: a new account, or `accountId` again (after Google stopped
 * accepting Ordo's sign-in, or with `addCalendar` to give an account added for Mail only Calendar
 * access too). Signing in again asks for everything the account has already given (so Mail keeps
 * working) and, for Calendar's accounts, Calendar. Then sync its calendars straight away.
 */
export async function connectGoogle(input: unknown): Promise<GoogleConnectOutcome> {
  const parsed = ConnectGoogleSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'unknown', message: 'That account wasn’t found.' }
  if (!canStoreSecrets())
    return {
      ok: false,
      error: 'storage',
      message: 'Ordo can’t store Google sign-ins securely on this computer.',
    }
  const auth = googleAuth()
  if (!auth.client())
    return {
      ok: false,
      error: 'not-configured',
      message: 'Add your Google OAuth client ID first (see the guide).',
    }
  const again = parsed.data?.accountId ? auth.account(parsed.data.accountId) : null
  signingIn = true
  try {
    const calendarToo = !again || hasCalendarScopes(again.scopes) || parsed.data?.addCalendar === true
    const g = await auth.signIn({
      scopes: again
        ? [...new Set([...again.scopes, ...(calendarToo ? CALENDAR_SCOPES : [])])]
        : CALENDAR_SCOPES,
      ...(again && { loginHint: again.email, expectAccount: again.id }),
    })
    googleHealth.delete(g.id)
    // Show its calendars as soon as they're listed.
    void sync({ googleOnly: true }).then((r) => {
      if (r.ok) broadcastChanged()
    })
    return { ok: true, account: accountStatus(g) }
  } catch (err) {
    return connectFailure(err)
  } finally {
    signingIn = false
  }
}

const listNames = (accounts: { label: string; email: string }[]) =>
  accounts.map((a) => `${a.label} (${a.email})`).join(', ')

/**
 * Revoke Ordo's access at Google and forget the account and its calendars. Revoking ends the whole
 * grant, so mail accounts that sign in with it would stop working: they're removed first, as
 * Settings → Accounts removes an account (downloaded mail cleared, nothing changed in Gmail), but
 * only the ones the user confirmed (`removeMail`). Any other refuses the sign-out, naming them.
 */
export async function signOutGoogle(accountId: unknown, options?: unknown): Promise<GoogleSimpleOutcome> {
  const id = GoogleAccountIdSchema.safeParse(accountId)
  if (!id.success) return { ok: false, message: 'That account wasn’t found.' }
  const opts = SignOutGoogleOptionsSchema.safeParse(options)
  if (!opts.success) return { ok: false, message: 'That account wasn’t found.' }
  const linked = accountsSignedInWith(id.data)
  const confirmed = new Set(opts.data?.removeMail ?? [])
  const unconfirmed = linked.filter((a) => !confirmed.has(a.id))
  if (unconfirmed.length) {
    const email = googleAuth().account(id.data)?.email ?? 'this Google account'
    return {
      ok: false,
      message: `Mail in Ordo signs in with ${email}: ${listNames(unconfirmed)}. Signing out would stop it working, so remove ${unconfirmed.length === 1 ? 'it' : 'them'} too, or remove ${unconfirmed.length === 1 ? 'it' : 'them'} in Settings → Accounts first.`,
    }
  }
  // Before taking the write lock: removing an account waits for its running syncs, which take it.
  try {
    for (const a of linked) await removeAccount(a.id)
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Couldn’t remove the mail account.' }
  }
  running?.abort()
  const r = await withWriteLock('signing out of Google', async () => {
    const done = await googleAuth().signOut(id.data)
    openStore().clearProvider(googleProvider(id.data))
    googleHealth.delete(id.data)
    return done
  })
  if (r instanceof Locked) return { ok: false, message: r.message }
  return r ? { ok: true } : { ok: false, message: 'That account wasn’t found.' }
}

export function setCalendarColor(input: unknown): void {
  const { calendarId, color } = CalendarColorSchema.parse(input)
  openStore().setColor(calendarId, color)
}

/** Calendars added by their Google iCal link that are also in a connected Google account. */
export function googleFeedMatches(): GoogleFeedMatch[] {
  account()
  const s = openStore()
  const emails = new Map(googleAccounts().map((g) => [g.id, g.email]))
  const google = s
    .calendars()
    .map((c) => ({ c, key: parseGoogleCalendarKey(c.id) }))
    .filter((x) => x.key && emails.has(x.key.accountId))
  const out: GoogleFeedMatch[] = []
  for (const f of s.feeds()) {
    const url = unseal(f).url
    const id = url ? googleCalendarIdFromFeedUrl(url) : null
    const match = id && google.find((x) => x.key!.calendarId.toLowerCase() === id.toLowerCase())
    if (match)
      out.push({
        feedId: f.id,
        feedName: f.name,
        calendarId: match.c.id,
        calendarName: match.c.name,
        email: emails.get(match.key!.accountId)!,
      })
  }
  return out
}

/** Swap a link calendar for the live one: remove the link, show the Google calendar. */
export async function replaceFeed(input: unknown): Promise<GoogleSimpleOutcome> {
  const parsed = ReplaceFeedSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: 'That calendar wasn’t found.' }
  const match = googleFeedMatches().find((m) => m.feedId === parsed.data.feedId)
  if (!match) return { ok: false, message: 'That link isn’t the same as a calendar in your Google account.' }
  const r = await withWriteLock('replacing a calendar', async () => {
    const s = openStore()
    s.setVisible(match.calendarId, true)
    return s.removeFeed(match.feedId)
  })
  if (r instanceof Locked) return { ok: false, message: r.message }
  poller?.poke('shown')
  return r ? { ok: true } : { ok: false, message: 'That calendar wasn’t found.' }
}

export function registerCalendarIpc(): void {
  ipcMain.handle(IPC.calendarStatus, () => status())
  ipcMain.handle(IPC.calendarSync, (e, options?: { force?: unknown }) =>
    sync({ force: options?.force === true }, toRenderer(e.sender, IPC.calendarSyncProgress)),
  )
  ipcMain.handle(IPC.calendarList, () => calendars())
  ipcMain.handle(IPC.calendarEvents, (_e, range: unknown) => events(range))
  ipcMain.handle(IPC.calendarSetVisible, (_e, input: unknown) => setVisible(input))
  ipcMain.handle(IPC.calendarAddLink, (_e, input: unknown) => addLink(input))
  ipcMain.handle(IPC.calendarImportFile, (e) => importIcsFile(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle(IPC.calendarRemove, (_e, id: unknown) => removeCalendar(id))
  ipcMain.handle(IPC.calendarDetails, (_e, ref: unknown) => eventDetails(ref))
  ipcMain.handle(IPC.calendarCreateEvent, (_e, input: unknown) => createEvent(input))
  ipcMain.handle(IPC.calendarUpdateEvent, (_e, input: unknown) => updateEvent(input))
  ipcMain.handle(IPC.calendarDeleteEvent, (_e, input: unknown) => deleteEvent(input))
  ipcMain.handle(GOOGLE_IPC.googleStatus, () => googleStatus())
  // Changing a Google sign-in runs only for Ordo's own page in its window (on top of the
  // preload's user-activation check), never for content in another frame.
  const refused = { ok: false as const, message: 'Ordo only accepts this from its own window.' }
  ipcMain.handle(GOOGLE_IPC.googleSetClient, (e, input: unknown) =>
    fromAppWindow(e) ? setGoogleClient(input) : refused,
  )
  ipcMain.handle(GOOGLE_IPC.googleConnect, (e, input: unknown) =>
    fromAppWindow(e) ? connectGoogle(input) : { ...refused, error: 'unknown' as const },
  )
  ipcMain.handle(GOOGLE_IPC.googleCancel, () => googleAuth().cancelSignIn())
  ipcMain.handle(GOOGLE_IPC.googleSignOut, (e, id: unknown, options?: unknown) =>
    fromAppWindow(e) ? signOutGoogle(id, options) : refused,
  )
  ipcMain.handle(GOOGLE_IPC.googleSetColor, (_e, input: unknown) => setCalendarColor(input))
  ipcMain.handle(GOOGLE_IPC.googleFeedMatches, () => googleFeedMatches())
  ipcMain.handle(GOOGLE_IPC.googleReplaceFeed, (e, input: unknown) =>
    fromAppWindow(e) ? replaceFeed(input) : refused,
  )
}
