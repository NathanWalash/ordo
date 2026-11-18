import { join } from 'node:path'
import { app } from 'electron'
import { analyseSenders } from '@ordo/mail-core'
import {
  ICLOUD_IMAP,
  ICLOUD_SMTP,
  ImapMailProvider,
  MailAuthError,
  MailConnectionError,
  MailStore,
  scanMailbox,
  testImapLogin,
  type ImapConfig,
  type SmtpConfig,
} from '@ordo/mail-core/node'
import {
  ConnectInputSchema,
  type AccountStatus,
  type ConnectError,
  type ConnectInput,
  type ConnectResult,
  type ScanOutcome,
  type ScanProgress,
} from '@ordo/shared'
import { canStoreSecrets, deleteAccount, loadAccount, recordScan, saveAccount } from './account'
import { Locked, withWriteLock } from './writes'

export const INBOX = 'INBOX'
let store: MailStore | null = null
let running: AbortController | null = null
/** A clean-up or undo is changing the mailbox; scans wait for it. */
let changing = false

export const mailStore = () => (store ??= new MailStore(join(app.getPath('userData'), 'mail.sqlite')))

/** Run `fn` unless a scan or another change is already running. Returns null when busy. */
export async function exclusively<T>(fn: () => Promise<T>): Promise<T | null> {
  if (running || changing) return null
  changing = true
  try {
    return await fn()
  } finally {
    changing = false
  }
}

/**
 * Test-only: an unpackaged build may treat http://127.0.0.1 unsubscribe links like https,
 * so end-to-end tests can point one-click unsubscribe at a local server. Never in packaged builds.
 */
export const allowLoopbackHttp = () => !app.isPackaged && process.env['ORDO_TEST_ALLOW_LOOPBACK_HTTP'] === '1'

/** iCloud by default. Tests can point an unpackaged build at a local IMAP server. */
export function imapConfig(user: string, pass: string): ImapConfig {
  const host = !app.isPackaged ? process.env['ORDO_IMAP_HOST'] : undefined
  if (host)
    return {
      host,
      port: Number(process.env['ORDO_IMAP_PORT'] ?? 3143),
      secure: process.env['ORDO_IMAP_SECURE'] === '1',
      user,
      pass,
    }
  return { ...ICLOUD_IMAP, user, pass }
}

/** iCloud SMTP by default. Tests can point an unpackaged build at a local server, like ORDO_IMAP_*. */
export function smtpConfig(user: string, pass: string): SmtpConfig {
  const host = !app.isPackaged ? process.env['ORDO_SMTP_HOST'] : undefined
  if (host)
    return {
      host,
      port: Number(process.env['ORDO_SMTP_PORT'] ?? 3025),
      secure: process.env['ORDO_SMTP_SECURE'] === '1',
      requireTLS: process.env['ORDO_SMTP_REQUIRE_TLS'] === '1',
      user,
      pass,
    }
  return { ...ICLOUD_SMTP, user, pass }
}

export function explain(err: unknown): { error: ConnectError; message: string } {
  if (err instanceof MailAuthError)
    return {
      error: 'auth',
      message: "iCloud didn't accept that email and app-specific password. Check both and try again.",
    }
  if (err instanceof MailConnectionError)
    return {
      error: 'network',
      message: "Couldn't reach iCloud. Check your internet connection and try again.",
    }
  return { error: 'unknown', message: 'Something went wrong talking to iCloud. Try again in a moment.' }
}

async function check(input: ConnectInput): Promise<ConnectResult & { password?: string }> {
  const parsed = ConnectInputSchema.safeParse(input)
  if (!parsed.success)
    return { ok: false, error: 'invalid', message: parsed.error.issues[0]?.message ?? 'Check your details.' }
  const { email, password } = parsed.data
  try {
    await testImapLogin(imapConfig(email, password))
    return { ok: true, email, password }
  } catch (err) {
    return { ok: false, ...explain(err) }
  }
}

export function status(): AccountStatus {
  const a = loadAccount()
  if (!a) return { connected: false }
  return { connected: true, email: a.email, lastScan: a.lastScan, messageCount: mailStore().count(INBOX) }
}

export async function test(input: ConnectInput): Promise<ConnectResult> {
  const { password: _password, ...result } = await check(input)
  return result
}

export async function connect(input: ConnectInput): Promise<ConnectResult> {
  if (!canStoreSecrets())
    return {
      ok: false,
      error: 'unavailable',
      message: "This computer can't store passwords securely, so Ordo won't save yours.",
    }
  const result = await check(input)
  if (!result.ok) return result
  // A different account invalidates the cache.
  if (loadAccount()?.email !== result.email) mailStore().clear()
  saveAccount(result.email, result.password!)
  return { ok: true, email: result.email }
}

export async function disconnect(): Promise<void> {
  running?.abort()
  deleteAccount()
  mailStore().clear()
}

/** A scan of the inbox is running in this process. */
export const isScanning = () => running !== null

/**
 * Fetch new inbox headers into the cache. `onProgress` streams how far it has got. `then` runs
 * afterwards on the same connection and under the same lock (the mail client uses it to refresh
 * flags and the folder list).
 */
export async function scan(
  onProgress?: (p: ScanProgress) => void,
  then?: (provider: ImapMailProvider) => Promise<void>,
): Promise<ScanOutcome> {
  const a = loadAccount()
  if (!a) return { ok: false, error: 'auth', message: 'Connect your iCloud account first.' }
  if (running) return { ok: false, error: 'busy', message: 'A scan is already running.' }
  if (changing) return { ok: false, error: 'busy', message: 'Wait for the clean-up to finish.' }
  const ctrl = (running = new AbortController())
  try {
    const result = await withWriteLock('scanning the inbox', () =>
      fetchHeaders(a, ctrl.signal, onProgress, then),
    )
    return result instanceof Locked ? { ok: false, error: 'locked', message: result.message } : result
  } finally {
    running = null
  }
}

async function fetchHeaders(
  a: { email: string; password: string },
  signal: AbortSignal,
  onProgress?: (p: ScanProgress) => void,
  then?: (provider: ImapMailProvider) => Promise<void>,
): Promise<ScanOutcome> {
  const provider = new ImapMailProvider(imapConfig(a.email, a.password))
  try {
    await provider.connect()
    const result = await scanMailbox(provider, mailStore(), { mailbox: INBOX, signal, onProgress })
    if (!result.stopped) recordScan(new Date())
    if (!result.stopped) await then?.(provider)
    return { ok: true, ...result }
  } catch (err) {
    return { ok: false, ...explain(err) }
  } finally {
    await provider.close().catch(() => {})
  }
}

export function stopScan(): void {
  running?.abort()
}

export function senders() {
  const s = mailStore()
  return analyseSenders(s.headers(INBOX), s.repliedTo(), { allowLoopbackHttp: allowLoopbackHttp() })
}

/** Inbox headers already cached by a scan (no network), or null when Mail isn't connected. */
export function cachedInboxHeaders() {
  return loadAccount() ? mailStore().headers(INBOX) : null
}

export function closeMail(): void {
  running?.abort()
  store?.close()
  store = null
}
