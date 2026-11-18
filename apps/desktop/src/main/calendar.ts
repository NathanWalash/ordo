import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron'
import { parseIcs, syncWindow, type CalendarSyncResult } from '@ordo/calendar-core'
import {
  CalDavProvider,
  CalendarAuthError,
  CalendarConnectionError,
  CalendarStore,
  CalendarWriteError,
  createEvent as addEvent,
  deleteEvent as removeEvent,
  EventChangeError,
  eventDetails as readDetails,
  updateEvent as changeEvent,
  type ChangeOptions,
  checkFeedUrl,
  describeIcs,
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
  CreateEventSchema,
  DateRangeSchema,
  DeleteEventSchema,
  EventRefSchema,
  IPC,
  SetVisibleSchema,
  UpdateEventSchema,
  type AddCalendarOutcome,
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
import { canStoreSecrets, loadAccount } from './account'
import { allowLoopbackHttp } from './mail'
import { Locked, toRenderer, withWriteLock } from './writes'

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
  return s
}

function account() {
  const a = loadAccount()
  storeFor(a?.email ?? null)
  return a
}

function explain(err: unknown): { error: CalendarSyncError; message: string } {
  if (err instanceof CalendarAuthError)
    return {
      error: 'auth',
      message:
        "iCloud didn't accept your app-specific password for Calendar. Reconnect your account and try again.",
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
  const base = { lastSync: s.meta('lastSync'), syncing: running !== null, subscriptions: s.feedCount() }
  return a ? { ...base, connected: true, email: a.email } : { ...base, connected: false }
}

/**
 * Fetch calendars changed since the last sync (all of them with `force`) into the cache:
 * iCloud's, then those added by link. A link that fails doesn't stop the others; it's listed
 * in `failed`. If iCloud fails, its error is returned after the links have been synced.
 */
export function sync(
  options?: { force?: boolean },
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
  options?: { force?: boolean },
  onProgress?: (p: CalendarSyncProgress) => void,
): Promise<CalendarSyncOutcome> {
  const a = account()
  const feeds = openStore().feeds()
  if (!a && !feeds.length)
    return { ok: false, error: 'auth', message: 'Connect your iCloud account or add a calendar first.' }
  if (running) return { ok: false, error: 'busy', message: 'Your calendars are already syncing.' }
  const ctrl = (running = new AbortController())
  try {
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
      const synced = total.fetched + total.skipped > 0
      if (synced && !total.stopped) openStore().setMeta('lastSync', new Date().toISOString())
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

// ---- Creating, changing and deleting events -------------------------------------------------

/** An event's details for the editor, and whether Ordo can change it. */
export function eventDetails(input: unknown): EventDetails | null {
  const parsed = EventRefSchema.safeParse(input)
  if (!parsed.success) return null
  const a = account()
  const d = readDetails(openStore(), parsed.data, a?.email)
  if (!d) return null
  const editable = d.editable && a !== null
  return {
    calendarId: d.calendarId,
    draft: d.draft,
    recurring: d.recurring,
    editable,
    ...(!editable && { reason: d.reason ?? 'Connect your iCloud account to change events.' }),
  }
}

function changeFailure(err: unknown): CalendarChangeOutcome {
  if (err instanceof EventChangeError) return { ok: false, error: err.kind, message: err.message }
  if (err instanceof CalendarAuthError)
    return {
      ok: false,
      error: 'auth',
      message:
        "iCloud didn't accept your app-specific password for Calendar. Reconnect your account and try again.",
    }
  if (err instanceof CalendarConnectionError)
    return {
      ok: false,
      error: 'network',
      message:
        "Couldn't reach iCloud Calendar, so nothing was changed. Check your internet connection and try again.",
    }
  if (err instanceof CalendarWriteError)
    return {
      ok: false,
      error: 'unknown',
      message: `iCloud couldn’t save the change${err.status ? ` (${err.status})` : ''}. Try again in a moment.`,
    }
  return {
    ok: false,
    error: 'unknown',
    message: 'Something went wrong changing your calendar. Try again in a moment.',
  }
}

/**
 * Run one change against iCloud: after any sync in progress, holding the write lock, with the
 * cache updated from what the server saved. Never throws.
 */
async function change(
  task: string,
  fn: (provider: CalDavProvider, store: CalendarStore, options: ChangeOptions) => Promise<string>,
): Promise<CalendarChangeOutcome> {
  const a = account()
  if (!a)
    return { ok: false, error: 'not-connected', message: 'Connect your iCloud account to change events.' }
  if (syncing) await syncing.catch(() => {})
  const r = await withWriteLock(task, async (): Promise<CalendarChangeOutcome> => {
    const provider = new CalDavProvider({ serverUrl: caldavUrl(), username: a.email, password: a.password })
    try {
      const uid = await fn(provider, openStore(), { window: syncWindow(), me: a.email })
      return { ok: true, uid }
    } catch (err) {
      return changeFailure(err)
    } finally {
      await provider.close().catch(() => {})
    }
  })
  return r instanceof Locked ? { ok: false, error: 'locked', message: r.message } : r
}

const invalid = (issues: { message: string }[]): CalendarChangeOutcome => ({
  ok: false,
  error: 'invalid',
  message: issues[0]?.message ?? 'That event isn’t complete.',
})

/** Add an event to a writable iCloud calendar. */
export async function createEvent(input: unknown): Promise<CalendarChangeOutcome> {
  const parsed = CreateEventSchema.safeParse(input)
  if (!parsed.success) return invalid(parsed.error.issues)
  const { calendarId, draft } = parsed.data
  return change('adding an event', async (p, s, o) => (await addEvent(p, s, calendarId, draft, o)).uid)
}

/** Change an event, or one occurrence of a repeating event (`scope: 'this'`). */
export async function updateEvent(input: unknown): Promise<CalendarChangeOutcome> {
  const parsed = UpdateEventSchema.safeParse(input)
  if (!parsed.success) return invalid(parsed.error.issues)
  const { ref, draft, scope } = parsed.data
  return change('changing an event', async (p, s, o) => {
    await changeEvent(p, s, ref, draft, scope, o)
    return ref.uid
  })
}

/** Delete an event, or one occurrence of a repeating event (`scope: 'this'`). */
export async function deleteEvent(input: unknown): Promise<CalendarChangeOutcome> {
  const parsed = DeleteEventSchema.safeParse(input)
  if (!parsed.success) return invalid(parsed.error.issues)
  const { ref, scope } = parsed.data
  return change('deleting an event', async (p, s, o) => {
    await removeEvent(p, s, ref, scope, o)
    return ref.uid
  })
}

export function calendars(): CalendarListItem[] {
  account()
  return openStore().calendars()
}

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
  text: string,
): Promise<AddCalendarOutcome> {
  const r = await withWriteLock('adding a calendar', async () => {
    const s = openStore()
    const id = `feed:${randomUUID()}`
    s.addFeed({ ...feed, id, color: feed.color ?? COLORS[s.feedCount() % COLORS.length] })
    s.setCalendars(
      s.feeds().map((f) => ({ id: f.id, name: f.name, color: f.color, readOnly: true })),
      FEEDS,
    )
    const window = syncWindow()
    s.replaceEvents(id, parseIcs(text, { calendarId: id, range: window }), window)
    return { ok: true as const, calendar: s.calendars().find((c) => c.id === id)! }
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
  const info = describeIcs(text)
  if (!info)
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
    text,
  )
}

/** Add an .ics file's events as a calendar of their own. */
export async function addIcsText(text: string, fileName: string): Promise<AddCalendarOutcome> {
  const info = describeIcs(text)
  if (!info) return { ok: false, error: 'not-calendar', message: `${fileName} isn’t a calendar file.` }
  account()
  const name = nameFor(info.name, basename(fileName, extname(fileName)) || 'Imported calendar')
  return addFeed({ kind: 'file', name, color: info.color, ics: text }, text)
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
}

/** Forget the iCloud calendars, when the account is disconnected. Link and file calendars stay. */
export function clearCalendar(): void {
  running?.abort()
  running = null
  openStore().clearProvider(ICLOUD)
}

export function closeCalendar(): void {
  running?.abort()
  store?.close()
  store = null
}

export function registerCalendarIpc(): void {
  ipcMain.handle(IPC.calendarStatus, () => status())
  ipcMain.handle(IPC.calendarSync, (e, options?: { force?: boolean }) =>
    sync(options, toRenderer(e.sender, IPC.calendarSyncProgress)),
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
}
