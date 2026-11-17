import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { syncWindow } from '@ordo/calendar-core'
import {
  CalDavProvider,
  CalendarAuthError,
  CalendarConnectionError,
  CalendarStore,
  ICLOUD_CALDAV_URL,
  syncCalendars,
} from '@ordo/calendar-core/node'
import {
  DateRangeSchema,
  IPC,
  SetVisibleSchema,
  type CalendarEvent,
  type CalendarListItem,
  type CalendarStatus,
  type CalendarSyncError,
  type CalendarSyncProgress,
  type CalendarSyncOutcome,
} from '@ordo/shared'
import { loadAccount } from './account'
import { toRenderer } from './writes'

let store: CalendarStore | null = null
let running: AbortController | null = null

const openStore = () => (store ??= new CalendarStore(join(app.getPath('userData'), 'calendar.sqlite')))

/** iCloud by default. Tests can point an unpackaged build at a local CalDAV server. */
function caldavUrl(): string {
  return (!app.isPackaged && process.env['ORDO_CALDAV_URL']) || ICLOUD_CALDAV_URL
}

/** The cache belongs to one account. Forget it if the account was removed or changed. */
function storeFor(email: string | null): CalendarStore {
  const s = openStore()
  if (s.meta('account') !== email) {
    s.clear()
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
  if (!a) return { connected: false }
  return {
    connected: true,
    email: a.email,
    lastSync: openStore().meta('lastSync'),
    syncing: running !== null,
  }
}

/** Fetch calendars changed since the last sync (all of them with `force`) into the cache. */
export async function sync(
  options?: { force?: boolean },
  onProgress?: (p: CalendarSyncProgress) => void,
): Promise<CalendarSyncOutcome> {
  const a = account()
  if (!a) return { ok: false, error: 'auth', message: 'Connect your iCloud account first.' }
  if (running) return { ok: false, error: 'busy', message: 'Your calendars are already syncing.' }
  const ctrl = (running = new AbortController())
  const provider = new CalDavProvider({ serverUrl: caldavUrl(), username: a.email, password: a.password })
  try {
    await provider.connect()
    const result = await syncCalendars(provider, openStore(), {
      window: syncWindow(),
      signal: ctrl.signal,
      force: options?.force === true,
      onProgress,
    })
    if (!result.stopped) openStore().setMeta('lastSync', new Date().toISOString())
    return { ok: true, ...result }
  } catch (err) {
    return { ok: false, ...explain(err) }
  } finally {
    if (running === ctrl) running = null
    await provider.close().catch(() => {})
  }
}

export function calendars(): CalendarListItem[] {
  return account() ? openStore().calendars() : []
}

export function events(range: unknown): CalendarEvent[] {
  const r = DateRangeSchema.parse(range)
  return account() ? openStore().events(r) : []
}

export function setVisible(input: unknown): void {
  const { calendarId, visible } = SetVisibleSchema.parse(input)
  openStore().setVisible(calendarId, visible)
}

/** Forget every cached calendar and event, e.g. when the account is disconnected. */
export function clearCalendar(): void {
  running?.abort()
  running = null
  openStore().clear()
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
}
