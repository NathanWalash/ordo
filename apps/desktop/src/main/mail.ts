import { join } from 'node:path'
import { app } from 'electron'
import {
  analyseSenders,
  PROVIDERS,
  SyncSchedule,
  withUnsubscribed,
  type SyncFailureKind,
} from '@ordo/mail-core'
import {
  ImapMailProvider,
  MailAuthError,
  MailConnectionError,
  MailUnavailableError,
  MailStore,
  classifyImapError,
  serverWords,
  type MailConnectionReason,
  scanMailbox,
  testImapLogin,
  type ImapConfig,
  type SmtpConfig,
} from '@ordo/mail-core/node'
import {
  ConnectInputSchema,
  defaultLabel,
  nextColor,
  type AccountStatus,
  type ConnectError,
  type ConnectInput,
  type ConnectResult,
  type MailAccount,
  type ScanOutcome,
  type ScanProgress,
} from '@ordo/shared'
import {
  addStoredAccount,
  assertAccountsWritable,
  canStoreSecrets,
  getAccount,
  listAccounts,
  recordScan,
  removeStoredAccount,
  setSecret,
} from './account'
import { getCredentials } from './auth'
import { Locked, withWriteLock } from './writes'

export const INBOX = 'INBOX'
let store: MailStore | null = null
/** Inbox scans running in this process, by account. */
const running = new Map<string, AbortController>()
/** Accounts a clean-up or undo is changing; their scans wait for it. */
const changing = new Set<string>()

/** The mail cache: every account's rows in one file. */
export const mailStore = () =>
  (store ??= new MailStore(join(app.getPath('userData'), 'mail.sqlite'), undefined, undefined, {
    // A cache from before several accounts is copied once before it's migrated: a way back.
    backupTo: join(app.getPath('userData'), 'mail.sqlite.pre-accounts-v1'),
  }))

/** One account's part of the cache. */
export const accountStore = (account: string) => mailStore().forAccount(account)

/** When each account may next be checked by itself (see SyncSchedule): one failing never blocks the rest. */
export const syncSchedule = new SyncSchedule()

/**
 * Run `fn` unless a scan or another change of this account is already running. Returns null
 * when busy.
 */
export async function exclusively<T>(account: string, fn: () => Promise<T>): Promise<T | null> {
  if (running.has(account) || changing.has(account)) return null
  changing.add(account)
  try {
    return await fn()
  } finally {
    changing.delete(account)
  }
}

/**
 * Test-only: an unpackaged build may treat http://127.0.0.1 unsubscribe links like https,
 * so end-to-end tests can point one-click unsubscribe at a local server. Never in packaged builds.
 */
export const allowLoopbackHttp = () => !app.isPackaged && process.env['ORDO_TEST_ALLOW_LOOPBACK_HTTP'] === '1'

/** Accounts being removed: no new work starts on them while their running work settles. */
const removing = new Set<string>()

/** The account named, or the first one when none is named. Null if there's no such account. */
export function resolveAccount(id?: string): MailAccount | null {
  const a = id ? getAccount(id) : (listAccounts().find((x) => !removing.has(x.id)) ?? null)
  return a && !removing.has(a.id) ? a : null
}

/** Tests can point an unpackaged build at a local IMAP server, for every account. */
function testImapServer(): Omit<ImapConfig, 'user'> | null {
  const host = !app.isPackaged ? process.env['ORDO_IMAP_HOST'] : undefined
  if (!host) return null
  return {
    host,
    port: Number(process.env['ORDO_IMAP_PORT'] ?? 3143),
    secure: process.env['ORDO_IMAP_SECURE'] === '1',
  }
}

/** Tests can point an unpackaged build at a local SMTP server, like ORDO_IMAP_*. */
function testSmtpServer(): Omit<SmtpConfig, 'user'> | null {
  const host = !app.isPackaged ? process.env['ORDO_SMTP_HOST'] : undefined
  if (!host) return null
  return {
    host,
    port: Number(process.env['ORDO_SMTP_PORT'] ?? 3025),
    secure: process.env['ORDO_SMTP_SECURE'] === '1',
    requireTLS: process.env['ORDO_SMTP_REQUIRE_TLS'] === '1',
  }
}

/**
 * IMAP settings for servers and credentials. Without TLS from the start, STARTTLS is required, so
 * a password never crosses the network in the clear.
 */
function imapSettings(
  server: MailAccount['imap'],
  creds: { user: string; pass: string } | { user: string; accessToken: string },
): ImapConfig {
  const test = testImapServer()
  if (test) return { ...test, ...creds }
  return { host: server.host, port: server.port, secure: server.secure, requireTLS: !server.secure, ...creds }
}

function smtpSettings(
  server: MailAccount['smtp'],
  creds: { user: string; pass: string } | { user: string; accessToken: string },
): SmtpConfig {
  const test = testSmtpServer()
  if (test) return { ...test, ...creds }
  return { ...server, requireTLS: server.secure ? server.requireTLS : true, ...creds }
}

/** How to reach and sign in to an account's IMAP server, now (an OAuth token is refreshed here). */
export async function imapConfigFor(account: MailAccount): Promise<ImapConfig> {
  return imapSettings(account.imap, await getCredentials(account))
}

/** How to reach and sign in to an account's SMTP server, now. */
export async function smtpConfigFor(account: MailAccount): Promise<SmtpConfig> {
  return smtpSettings(account.smtp, await getCredentials(account))
}

/** Settings for details being tested, before there's an account. */
export const imapConfigForTest = (server: MailAccount['imap'], user: string, pass: string) =>
  imapSettings(server, { user, pass })

const ICLOUD_DOMAINS = /@(icloud|me|mac)\.com$/i

/** What the user calls a provider in a message: "iCloud", "Gmail", or the server's name. */
function providerName(account?: Pick<MailAccount, 'provider' | 'imap'> | null): string {
  if (!account) return 'iCloud'
  return account.provider === 'other' ? account.imap.host : PROVIDERS[account.provider].name
}

/** Why a wrong-password error happened, and what to do, for each provider. */
function authMessage(
  account: Pick<MailAccount, 'provider' | 'imap'> | null | undefined,
  email?: string,
): string {
  const provider = account?.provider ?? 'icloud'
  if (provider === 'icloud')
    return (
      "iCloud didn't accept that email and app-specific password. Make sure it's an app-specific password " +
      'from account.apple.com (your Apple ID password won’t work here) and that iCloud Mail is turned on ' +
      'for this Apple ID.' +
      (email && !ICLOUD_DOMAINS.test(email.trim())
        ? ' If your Apple ID isn’t an iCloud address, sign in with your @icloud.com address instead.'
        : '')
    )
  if (provider === 'gmail')
    return (
      "Gmail didn't accept that email and app password. Make sure it's an app password from " +
      'myaccount.google.com/apppasswords (your Google password won’t work here) and that 2-Step ' +
      'Verification is on. Work and school accounts may not allow app passwords or IMAP: ask your admin.'
    )
  const name = providerName(account)
  return `${name} didn't accept that email and password. If ${name} offers app passwords, use one, and check that IMAP is turned on.`
}

/**
 * A clear message, with a next step, for each way talking to a mail server can fail. `account`
 * says which provider (iCloud when left out); `email` is the address being connected, to spot an
 * Apple ID that isn't an iCloud Mail address.
 */
export function explain(
  err: unknown,
  email?: string,
  account?: Pick<MailAccount, 'provider' | 'imap'> | null,
): { error: ConnectError; message: string } {
  const e = classifyImapError(err)
  const name = providerName(account)
  const mailName = account && account.provider !== 'icloud' ? name : 'iCloud Mail'
  if (e instanceof MailAuthError) return { error: 'auth', message: authMessage(account, email) }
  if (e instanceof MailUnavailableError)
    return {
      error: 'unavailable',
      message:
        `${mailName} is turning connections away right now` +
        (e.serverText ? ` (it said “${e.serverText}”)` : '') +
        (account && account.provider !== 'icloud'
          ? '. This usually passes: wait a few minutes and try again.'
          : '. This usually passes: wait a few minutes and try again, and check Apple’s System Status page if it keeps happening.'),
    }
  if (e instanceof MailConnectionError) {
    const messages: Record<MailConnectionReason, string> = {
      offline: `Couldn't reach ${name}. Check you're online, and that a VPN or firewall isn't blocking ${mailName}.`,
      timeout: `${name} didn't answer in time. Your connection may be slow, or a VPN or firewall may be blocking ${mailName}. Try again in a minute.`,
      tls: `Couldn't make a secure connection to ${name}. If you're on public Wi-Fi, sign in to it in your browser first; a VPN or antivirus that inspects traffic can also cause this.`,
      dropped: `The connection to ${name} closed part way. Check your connection and try again.`,
    }
    return { error: 'network', message: messages[e.reason] }
  }
  // The error's code or message can carry the server's own text: cleaned like everything it says.
  const detail = serverWords((e as { code?: unknown }).code ?? e.message)
  return {
    error: 'unknown',
    message:
      `Something unexpected went wrong talking to ${name}` +
      (detail ? ` (${detail.slice(0, 120)})` : '') +
      '. Try again in a moment.',
  }
}

async function check(input: ConnectInput): Promise<ConnectResult & { password?: string }> {
  const parsed = ConnectInputSchema.safeParse(input)
  if (!parsed.success)
    return { ok: false, error: 'invalid', message: parsed.error.issues[0]?.message ?? 'Check your details.' }
  const { email, password } = parsed.data
  try {
    await testImapLogin(imapConfigForTest(PROVIDERS.icloud.imap!, email, password))
    return { ok: true, email, password }
  } catch (err) {
    return { ok: false, ...explain(err, email) }
  }
}

export function status(): AccountStatus {
  const accounts = listAccounts()
  const first = accounts[0]
  if (!first) return { connected: false }
  return {
    connected: true,
    email: first.email,
    lastScan: first.lastScan,
    messageCount: accountStore(first.id).count(INBOX),
    accounts,
  }
}

export async function test(input: ConnectInput): Promise<ConnectResult> {
  const { password: _password, ...result } = await check(input)
  return result
}

/**
 * Connect an iCloud account (the first-run sheet). The same address again replaces its password;
 * a new one is added beside the others.
 */
export async function connect(input: ConnectInput): Promise<ConnectResult> {
  if (!canStoreSecrets())
    return {
      ok: false,
      error: 'unavailable',
      message: "This computer can't store passwords securely, so Ordo won't save yours.",
    }
  const result = await check(input)
  if (!result.ok) return result
  const same = listAccounts().find(
    (a) => a.provider === 'icloud' && a.email.toLowerCase() === result.email.toLowerCase(),
  )
  try {
    if (same) {
      setSecret(same.id, result.password!)
      syncSchedule.reset(same.id)
      return { ok: true, email: result.email }
    }
    const icloud = PROVIDERS.icloud
    const taken = listAccounts()
    addStoredAccount(
      {
        label: defaultLabel(
          'icloud',
          taken.map((a) => a.label),
        ),
        email: result.email,
        color: nextColor(taken.map((a) => a.color)),
        provider: 'icloud',
        imap: { ...icloud.imap! },
        smtp: { ...icloud.smtp! },
        auth: { kind: 'password' },
      },
      result.password!,
      // Never an id that still has mail in the cache.
      mailStore().cachedAccounts(),
    )
  } catch (err) {
    return { ok: false, error: 'unavailable', message: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, email: result.email }
}

/** Scans and syncs still running, by account, so removing one can wait for them before clearing. */
const inflight = new Map<string, Set<Promise<unknown>>>()
const stoppers = new Map<string, Set<() => void>>()

/**
 * Track a piece of one account's mail work that writes to the cache: `stop` is called when the
 * account is removed, and removing it waits for the work to settle before clearing its cache.
 */
export function trackMailWork<T>(account: string, work: Promise<T>, stop?: () => void): Promise<T> {
  const works = inflight.get(account) ?? inflight.set(account, new Set()).get(account)!
  const stops = stoppers.get(account) ?? stoppers.set(account, new Set()).get(account)!
  works.add(work)
  if (stop) stops.add(stop)
  const done = () => {
    works.delete(work)
    if (stop) stops.delete(stop)
  }
  work.then(done, done)
  return work
}

/** Things the mail client keeps per account (its IMAP session, undo records), dropped on removal. */
const removedListeners = new Set<(account: string) => void>()
export function onAccountRemoved(listener: (account: string) => void): () => void {
  removedListeners.add(listener)
  return () => removedListeners.delete(listener)
}

/** The longest removing an account waits for its running work before clearing anyway. */
const DISCONNECT_WAIT_MS = 10_000

/**
 * Forget one account: stop its work, wait for it, then delete its password and everything cached
 * for it (mail, folders, clean-up history). Nothing on the server changes. Other accounts carry on.
 */
export async function removeAccount(account: string): Promise<void> {
  // A newer Ordo's accounts file can't be changed: refuse before stopping or clearing anything.
  assertAccountsWritable()
  // No new work starts on it from here on.
  removing.add(account)
  try {
    running.get(account)?.abort()
    for (const stop of stoppers.get(account) ?? []) stop()
    for (const listener of removedListeners) listener(account)
    syncSchedule.reset(account)
    // A sync that was running would otherwise write old mail into the cache after it's cleared.
    const pending = [...(inflight.get(account) ?? [])].map((p) => p.catch(() => {}))
    await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, DISCONNECT_WAIT_MS))])
    // The cache first, then the list: a crash in between leaves the account listed with nothing
    // cached (it downloads again), never rows that a later account could inherit. Ids are never
    // reused either.
    accountStore(account).clear()
    removeStoredAccount(account)
    if (!listAccounts().length) mailStore().clearAll()
  } finally {
    removing.delete(account)
  }
}

/** Forget every account (and anything cached for one that's gone). */
export async function disconnect(): Promise<void> {
  const ids = new Set([...listAccounts().map((a) => a.id), ...mailStore().cachedAccounts()])
  await Promise.all([...ids].map((id) => removeAccount(id)))
  mailStore().clearAll()
}

/** A scan of an inbox (one account's, or any when none is named) is running in this process. */
export const isScanning = (account?: string) => (account ? running.has(account) : running.size > 0)

/** A scan failure as the schedule's kind. */
const failureKind = (error: string): SyncFailureKind =>
  error === 'auth' || error === 'network' || error === 'unavailable' ? error : 'unknown'

/**
 * Fetch new inbox headers for one account (the first when none is named) into the cache.
 * `onProgress` streams how far it has got. `then` runs afterwards on the same connection and under
 * the same lock (the mail client uses it to refresh flags and the folder list).
 */
export async function scan(
  onProgress?: (p: ScanProgress) => void,
  then?: (provider: ImapMailProvider) => Promise<void>,
  accountId?: string,
): Promise<ScanOutcome> {
  const a = resolveAccount(accountId)
  if (!a)
    return accountId
      ? { ok: false, error: 'invalid', message: 'There’s no such account. Check Settings → Accounts.' }
      : { ok: false, error: 'auth', message: 'Connect your iCloud account first.' }
  if (running.has(a.id)) return { ok: false, error: 'busy', message: 'A scan is already running.' }
  if (changing.has(a.id)) return { ok: false, error: 'busy', message: 'Wait for the clean-up to finish.' }
  const ctrl = new AbortController()
  running.set(a.id, ctrl)
  try {
    const result = await trackMailWork(
      a.id,
      withWriteLock('scanning the inbox', () => fetchHeaders(a, ctrl.signal, onProgress, then)),
    )
    const outcome: ScanOutcome =
      result instanceof Locked ? { ok: false, error: 'locked', message: result.message } : result
    if (outcome.ok) syncSchedule.succeeded(a.id)
    else if (outcome.error !== 'busy' && outcome.error !== 'locked')
      syncSchedule.failed(a.id, failureKind(outcome.error), outcome.message, Date.now())
    return outcome
  } finally {
    running.delete(a.id)
  }
}

/**
 * Scan every account's inbox at once, each on its own connection. Progress is the sum of them all.
 * One account failing doesn't stop the others: the outcome is ok if any worked, listing the rest
 * in `failed`.
 */
export async function scanAll(onProgress?: (p: ScanProgress) => void): Promise<ScanOutcome> {
  const accounts = listAccounts()
  if (!accounts.length) return { ok: false, error: 'auth', message: 'Connect your iCloud account first.' }
  if (accounts.length === 1) return scan(onProgress, undefined, accounts[0]!.id)
  const progress = new Map<string, ScanProgress>()
  const report = () => {
    const all = [...progress.values()]
    const phase = all.some((p) => p.phase === 'inbox')
      ? 'inbox'
      : all.some((p) => p.phase === 'sent')
        ? 'sent'
        : 'done'
    onProgress?.({
      phase: all.length < accounts.length && phase === 'done' ? 'inbox' : phase,
      checked: all.reduce((n, p) => n + p.checked, 0),
      total: all.reduce((n, p) => n + p.total, 0),
    })
  }
  const results = await Promise.all(
    accounts.map(async (a) => ({
      account: a,
      outcome: await scan(
        (p) => {
          progress.set(a.id, p)
          report()
        },
        undefined,
        a.id,
      ),
    })),
  )
  const ok = results.filter((r) => r.outcome.ok)
  const failed = results.flatMap((r) =>
    r.outcome.ok ? [] : [{ account: r.account.id, error: r.outcome.error, message: r.outcome.message }],
  )
  if (!ok.length) return results[0]!.outcome
  let added = 0
  let total = 0
  let stopped = false
  for (const r of ok)
    if (r.outcome.ok) {
      added += r.outcome.added
      total += r.outcome.total
      stopped ||= r.outcome.stopped
    }
  return { ok: true, added, total, stopped, ...(failed.length && { failed }) }
}

async function fetchHeaders(
  a: MailAccount,
  signal: AbortSignal,
  onProgress?: (p: ScanProgress) => void,
  then?: (provider: ImapMailProvider) => Promise<void>,
): Promise<ScanOutcome> {
  let provider: ImapMailProvider | null = null
  try {
    provider = new ImapMailProvider(await imapConfigFor(a))
    await provider.connect()
    const result = await scanMailbox(provider, accountStore(a.id), { mailbox: INBOX, signal, onProgress })
    if (!result.stopped) recordScan(new Date(), a.id)
    if (!result.stopped) await then?.(provider)
    return { ok: true, ...result }
  } catch (err) {
    return { ok: false, ...explain(err, undefined, a) }
  } finally {
    await provider?.close().catch(() => {})
  }
}

/** Stop the inbox scans running in this process (one account's, or all). */
export function stopScan(account?: string): void {
  for (const [id, ctrl] of running) if (!account || id === account) ctrl.abort()
}

/** Account ids to read: one (if it exists), or every account. */
export function accountIds(account?: string | 'all'): string[] {
  const all = listAccounts()
    .map((a) => a.id)
    .filter((id) => !removing.has(id))
  if (!account || account === 'all') return all
  return all.includes(account) ? [account] : []
}

/**
 * The inbox's senders in one account or all of them, each marked when clean-up history says Ordo
 * has unsubscribed from it, and with the accounts its mail is in.
 */
export function senders(account?: string | 'all') {
  const s = mailStore()
  return withUnsubscribed(
    analyseSenders(s.headersAcross(accountIds(account), INBOX), s.repliedTo(), {
      allowLoopbackHttp: allowLoopbackHttp(),
    }),
    s.cleanupSenders(),
  )
}

/** Every account's inbox headers already cached by a scan (no network), or null when there's no account. */
export function cachedInboxHeaders() {
  const ids = accountIds()
  return ids.length ? mailStore().headersAcross(ids, INBOX) : null
}

export function closeMail(): void {
  for (const ctrl of running.values()) ctrl.abort()
  store?.close()
  store = null
}
