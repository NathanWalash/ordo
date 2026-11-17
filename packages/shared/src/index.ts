import { z } from 'zod'
import type { CategorisedSender, ScanProgress, ScanResult } from '@ordo/mail-core'
import type { SettingsApi } from './settings'
import type { AiApi } from './ai'
import type { CleanupApi } from './cleanup'
import { CALENDAR_IPC, type CalendarApi } from './calendar'

export * from './calendar'
import type { MoneyApi } from './money'

export * from './money'

/** A top-level area of the app shown in the sidebar (Mail, Finance, ...). */
export interface ModuleInfo {
  id: string
  name: string
  /** Shown greyed out in the sidebar until the module exists. */
  comingSoon?: boolean
}

export const MODULES: readonly ModuleInfo[] = [
  { id: 'mail', name: 'Mail' },
  { id: 'calendar', name: 'Calendar' },
  { id: 'money', name: 'Money' },
]

export const AppInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  platform: z.enum(['darwin', 'win32', 'linux']),
  accentColor: z.string().nullable(),
})
export type AppInfo = z.infer<typeof AppInfoSchema>

/** Apple app-specific passwords are four groups of four letters, e.g. abcd-efgh-ijkl-mnop. */
export const APP_PASSWORD = /^[a-z]{4}-?[a-z]{4}-?[a-z]{4}-?[a-z]{4}$/i

export const ConnectInputSchema = z.object({
  email: z.string().trim().pipe(z.email('Enter the email address you use for iCloud Mail.')),
  password: z.string().trim().regex(APP_PASSWORD, 'App-specific passwords look like abcd-efgh-ijkl-mnop.'),
})
export type ConnectInput = z.input<typeof ConnectInputSchema>

export type ConnectError = 'invalid' | 'auth' | 'network' | 'unavailable' | 'unknown'
export type ConnectResult = { ok: true; email: string } | { ok: false; error: ConnectError; message: string }

export type AccountStatus =
  { connected: false } | { connected: true; email: string; lastScan: string | null; messageCount: number }

/** `locked`: another Ordo process (the app, a headless command or an agent) is writing. */
export type ScanOutcome =
  ({ ok: true } & ScanResult) | { ok: false; error: ConnectError | 'locked'; message: string }

export type { CategorisedSender, ScanProgress }
export * from './settings'
export * from './ai'
export * from './cleanup'

/**
 * The API the preload script exposes to the renderer as `window.ordo`.
 * Every method maps to one ipcMain.handle channel in the main process.
 */
export interface OrdoApi {
  app: {
    info(): Promise<AppInfo>
  }
  settings: SettingsApi
  ai: AiApi
  account: {
    status(): Promise<AccountStatus>
    /** Check the credentials without saving them. */
    test(input: ConnectInput): Promise<ConnectResult>
    /** Check the credentials, then save them encrypted. */
    connect(input: ConnectInput): Promise<ConnectResult>
    /** Forget the credentials and every cached header. */
    disconnect(): Promise<void>
  }
  scan: {
    start(): Promise<ScanOutcome>
    stop(): Promise<void>
    /** Subscribe to progress events; returns an unsubscribe function. */
    onProgress(listener: (p: ScanProgress) => void): () => void
  }
  senders: {
    /** Senders sorted by the rules, plus any earlier AI answers when AI sorting is on. */
    list(): Promise<(CategorisedSender & { sortedBy?: 'rules' | 'ai'; confidence?: number })[]>
  }
  money: MoneyApi
  calendar: CalendarApi
  cleanup: CleanupApi
}

export const IPC = {
  appInfo: 'app:info',
  accountStatus: 'account:status',
  accountTest: 'account:test',
  accountConnect: 'account:connect',
  accountDisconnect: 'account:disconnect',
  scanStart: 'scan:start',
  scanStop: 'scan:stop',
  scanProgress: 'scan:progress',
  sendersList: 'senders:list',
  ...CALENDAR_IPC,
} as const
