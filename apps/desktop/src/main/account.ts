import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'
import { PROVIDERS } from '@ordo/mail-core'
import {
  ACCOUNT_COLORS,
  AccountIdSchema,
  FIRST_ACCOUNT_ID,
  type AccountColor,
  type MailAccount,
} from '@ordo/shared'

/**
 * The mail accounts, in `accounts.json` in the profile. Each account's secret (an app-specific
 * password today; an OAuth refresh token once Sign in with Google lands) is encrypted with the
 * OS keychain (safeStorage) and stored as base64; nothing else in the file is secret. The window
 * never sees a secret: `listAccounts` leaves it out.
 *
 * Durability:
 * - Every write goes to a temp file that is flushed to disk, then renamed over the old file, and
 *   the folder is flushed too, so a crash leaves the old list or the new one, never half of one.
 * - Entries this version doesn't understand (a newer auth kind, a provider it doesn't know, fields
 *   added later) are kept exactly as they were and written back untouched. A file written by a
 *   newer Ordo (a higher `version`) is read but never written.
 * - A file that can't be read is moved aside (`accounts.json.bak-<time>`), never overwritten.
 *
 * Installs from before several accounts kept one account in `account.json`. The first read moves
 * it into the list as account #1 (FIRST_ACCOUNT_ID, the id the mail cache's migration gives its
 * rows), copying the encrypted password as it is, so nothing has to be decrypted to migrate. The
 * old file is renamed `account.json.migrated`, and removed on a later launch once the list has
 * been read back. A damaged list falls back to it.
 *
 * Account ids are never reused (`acc-1`, `acc-2`…, the highest one issued is kept in the file), so
 * a new account can never inherit or lose another's cached mail.
 */

export const ACCOUNTS_FILE_VERSION = 1

export interface StoredAccount extends MailAccount {
  /** The secret for `auth.kind`, encrypted with safeStorage, base64. */
  secret: string
}

export interface AccountsFile {
  version: typeof ACCOUNTS_FILE_VERSION
  /** The highest account number ever issued (`acc-<n>`), so ids are never reused. */
  lastId?: number
  /** The iCloud account Calendar uses, by id. */
  calendarAccount?: string
  accounts: StoredAccount[]
}

/** What `account.json` held before several accounts. */
interface LegacyAccount {
  email: string
  password: string
  lastScan: string | null
}

/** Refused: the accounts file was written by a newer Ordo, which this one mustn't overwrite. */
export class AccountsFileTooNew extends Error {
  override name = 'AccountsFileTooNew'
  constructor() {
    super('Your accounts were saved by a newer version of Ordo. Update Ordo to change them.')
  }
}

const dir = () => app.getPath('userData')
const file = () => join(dir(), 'accounts.json')
const legacyFile = () => join(dir(), 'account.json')
const migratedFile = () => join(dir(), 'account.json.migrated')

export const canStoreSecrets = () => safeStorage.isEncryptionAvailable()

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Account #1 from a single-account `account.json`, or null if it isn't one. Pure: the encrypted
 * password is copied as it is.
 */
export function fromLegacy(legacy: unknown): AccountsFile | null {
  if (!isObject(legacy)) return null
  const { email, password, lastScan } = legacy as Partial<LegacyAccount>
  if (typeof email !== 'string' || !email.includes('@') || typeof password !== 'string' || !password)
    return null
  const icloud = PROVIDERS.icloud
  return {
    version: ACCOUNTS_FILE_VERSION,
    lastId: 1,
    calendarAccount: FIRST_ACCOUNT_ID,
    accounts: [
      {
        id: FIRST_ACCOUNT_ID,
        label: icloud.name,
        email,
        color: 'blue',
        provider: 'icloud',
        imap: { ...icloud.imap! },
        smtp: { ...icloud.smtp! },
        auth: { kind: 'password' },
        lastScan: typeof lastScan === 'string' ? lastScan : null,
        secret: password,
      },
    ],
  }
}

/** One stored account this version understands, or null (it's then kept as it is, unused). */
function parseStored(v: unknown): StoredAccount | null {
  if (!isObject(v)) return null
  const a = v as Partial<StoredAccount>
  const server = (s: unknown) => isObject(s) && typeof s['host'] === 'string' && typeof s['port'] === 'number'
  if (
    !AccountIdSchema.safeParse(a.id).success ||
    typeof a.email !== 'string' ||
    typeof a.secret !== 'string' ||
    !a.provider ||
    !(a.provider in PROVIDERS) ||
    !server(a.imap) ||
    !server(a.smtp) ||
    !isObject(a.auth) ||
    a.auth.kind !== 'password'
  )
    return null
  return {
    id: a.id!,
    label: typeof a.label === 'string' && a.label.trim() ? a.label : PROVIDERS[a.provider].name,
    email: a.email,
    color: ACCOUNT_COLORS.includes(a.color as AccountColor) ? (a.color as AccountColor) : 'blue',
    provider: a.provider,
    imap: { host: a.imap!.host, port: a.imap!.port, secure: a.imap!.secure !== false },
    smtp: {
      host: a.smtp!.host,
      port: a.smtp!.port,
      secure: a.smtp!.secure === true,
      // Never plain text: without TLS from the start, STARTTLS is required.
      requireTLS: a.smtp!.secure === true ? a.smtp!.requireTLS === true : true,
    },
    auth: { kind: 'password' },
    lastScan: typeof a.lastScan === 'string' ? a.lastScan : null,
    secret: a.secret,
  }
}

/** An entry of the list: one this version understands (with what it was read from), or not. */
type Entry = { account: StoredAccount; raw: Record<string, unknown> } | { account: null; raw: unknown }

/** The file as read: everything in it, so a write keeps what this version doesn't know about. */
interface Loaded {
  top: Record<string, unknown>
  entries: Entry[]
  /** Written by a newer Ordo: read it, never write it. */
  tooNew: boolean
}

/** The file's contents, or null when it isn't an accounts file at all (damaged). Pure. */
export function parseLoaded(raw: unknown): Loaded | null {
  if (!isObject(raw) || !Array.isArray(raw['accounts'])) return null
  const version = typeof raw['version'] === 'number' ? raw['version'] : ACCOUNTS_FILE_VERSION
  const seen = new Set<string>()
  const entries: Entry[] = (raw['accounts'] as unknown[]).map((v) => {
    const account = parseStored(v)
    // A repeated id is kept, unused, rather than lost.
    if (!account || seen.has(account.id)) return { account: null, raw: v }
    seen.add(account.id)
    return { account, raw: v as Record<string, unknown> }
  })
  return { top: raw, entries, tooNew: version > ACCOUNTS_FILE_VERSION }
}

/** The accounts this version understands in a parsed `accounts.json`, in order. */
export function parseAccountsFile(raw: unknown): StoredAccount[] {
  return (parseLoaded(raw)?.entries ?? []).flatMap((e) => (e.account ? [e.account] : []))
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

/** Flush a folder's entries to disk (where the system allows it: not on Windows). */
function syncDir(path: string): void {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    fsyncSync(fd)
  } catch {
    // Folders can't be opened or flushed on every system; the file itself was flushed.
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** Write a file in one step: a flushed temp file renamed over it, then the folder flushed. */
function writeDurably(path: string, contents: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, contents)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
  syncDir(dir())
}

/** The file as it will be written: unknown fields and entries kept as they were. Pure. */
export function serialise(loaded: Loaded): string {
  const known = loaded.entries.flatMap((e) => (e.account ? [e.account.id] : []))
  const numbers = [
    ...known,
    ...loaded.entries.map((e) => (isObject(e.raw) && typeof e.raw['id'] === 'string' ? e.raw['id'] : '')),
  ].map(idNumber)
  const lastId = Math.max(typeof loaded.top['lastId'] === 'number' ? loaded.top['lastId'] : 0, ...numbers)
  return JSON.stringify({
    ...loaded.top,
    version: ACCOUNTS_FILE_VERSION,
    lastId,
    accounts: loaded.entries.map((e) => (e.account ? { ...e.raw, ...e.account } : e.raw)),
  })
}

/** Throws AccountsFileTooNew when the accounts can't be changed, before anything else is done. */
export function assertAccountsWritable(): void {
  if (load().tooNew) throw new AccountsFileTooNew()
}

function save(loaded: Loaded): void {
  if (loaded.tooNew) throw new AccountsFileTooNew()
  writeDurably(file(), serialise(loaded))
}

/** Set aside an accounts file that can't be read, with the time in its name. Never overwritten. */
function setAside(): void {
  try {
    renameSync(file(), `${file()}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  } catch {
    // Another Ordo process set it aside first.
  }
}

/** The old single-account file, wherever it is now (not yet migrated, or kept after migrating). */
const legacy = () => fromLegacy(readJson(legacyFile())) ?? fromLegacy(readJson(migratedFile()))

/** Whether this process migrated `account.json`: its copy is only removed on a later launch. */
let migratedThisRun = false

/**
 * The accounts file, migrating a single-account `account.json` first if there's no list yet (or
 * the list is damaged). Idempotent: once a readable list exists, it wins.
 */
function load(): Loaded {
  const empty: Loaded = { top: { version: ACCOUNTS_FILE_VERSION }, entries: [], tooNew: false }
  if (existsSync(file())) {
    const loaded = parseLoaded(readJson(file()))
    // Usable: empty, or with at least one entry that is an account (perhaps one only a newer Ordo
    // understands, which is kept). Anything else is damage.
    const usable =
      loaded &&
      (loaded.entries.length === 0 ||
        loaded.entries.some((e) => e.account || (isObject(e.raw) && typeof e.raw['id'] === 'string')))
    if (loaded && usable) {
      // Read back fine on a later launch: the pre-migration copy can go.
      if (!migratedThisRun && existsSync(migratedFile())) rmSync(migratedFile(), { force: true })
      return loaded
    }
    // Unreadable: keep it, and start again from the old single account if there is one.
    setAside()
  }
  const old = legacy()
  if (!old) return empty
  const migrated = parseLoaded(old)!
  save(migrated)
  if (existsSync(legacyFile())) {
    renameSync(legacyFile(), migratedFile())
    syncDir(dir())
  }
  migratedThisRun = true
  return migrated
}

/** Every stored account this version understands, in order. */
export function storedAccounts(): StoredAccount[] {
  return load().entries.flatMap((e) => (e.account ? [e.account] : []))
}

const withoutSecret = ({ secret: _secret, ...a }: StoredAccount): MailAccount => a

/** Every account, without secrets, in order. */
export function listAccounts(): MailAccount[] {
  return storedAccounts().map(withoutSecret)
}

export function getAccount(id: string): MailAccount | null {
  const a = storedAccounts().find((x) => x.id === id)
  return a ? withoutSecret(a) : null
}

/** The first account: where mail goes from, and what callers that name no account mean. */
export function defaultAccount(): MailAccount | null {
  const a = storedAccounts()[0]
  return a ? withoutSecret(a) : null
}

/** An account's secret, decrypted, or null (no account, no keychain, or it can't be read). */
export function readSecret(id: string): string | null {
  const a = storedAccounts().find((x) => x.id === id)
  if (!a || !canStoreSecrets()) return null
  try {
    return safeStorage.decryptString(Buffer.from(a.secret, 'base64'))
  } catch {
    return null
  }
}

const encrypt = (secret: string) => {
  if (!canStoreSecrets()) throw new Error('Secure storage is not available on this system')
  return safeStorage.encryptString(secret).toString('base64')
}

/** The number in an `acc-<n>` id, or 0. */
const idNumber = (id: string) => {
  const m = /^acc-(\d{1,9})$/.exec(id)
  return m ? Number(m[1]) : 0
}

/**
 * The next account id: one more than any ever issued (kept in the file), any in the list, and any
 * the caller says is in use elsewhere (ids with mail still in the cache). Never reused. Pure.
 */
export function nextAccountId(loaded: Loaded, inUse: readonly string[] = []): string {
  const ids = [
    ...loaded.entries.map((e) =>
      e.account ? e.account.id : isObject(e.raw) && typeof e.raw['id'] === 'string' ? e.raw['id'] : '',
    ),
    ...inUse,
  ]
  const last = Math.max(
    typeof loaded.top['lastId'] === 'number' ? loaded.top['lastId'] : 0,
    ...ids.map(idNumber),
  )
  return `acc-${last + 1}`
}

/**
 * Save a new account at the end of the list, with a fresh id that's never been used and isn't in
 * `inUse`. A new iCloud account becomes Calendar's when Calendar has none (or its was removed).
 */
export function addStoredAccount(
  account: Omit<MailAccount, 'id' | 'lastScan'>,
  secret: string,
  inUse: readonly string[] = [],
): MailAccount {
  const loaded = load()
  const id = nextAccountId(loaded, inUse)
  const stored: StoredAccount = { ...account, id, lastScan: null, secret: encrypt(secret) }
  const calendar = loaded.top['calendarAccount']
  const calendarGone = typeof calendar !== 'string' || !loaded.entries.some((e) => e.account?.id === calendar)
  save({
    ...loaded,
    top: {
      ...loaded.top,
      lastId: idNumber(id),
      ...(account.provider === 'icloud' &&
        account.auth.kind === 'password' &&
        calendarGone && {
          calendarAccount: id,
        }),
    },
    entries: [...loaded.entries, { account: stored, raw: {} }],
  })
  return withoutSecret(stored)
}

/** Change one known account, keeping everything else in the file as it was. */
function change(id: string, fn: (a: StoredAccount) => StoredAccount): StoredAccount | null {
  const loaded = load()
  const i = loaded.entries.findIndex((e) => e.account?.id === id)
  const entry = loaded.entries[i]
  if (!entry?.account) return null
  const next = fn(entry.account)
  loaded.entries[i] = { account: next, raw: entry.raw as Record<string, unknown> }
  save(loaded)
  return next
}

/** Change an account's label or colour. Null if there's no such account. */
export function updateStoredAccount(
  id: string,
  patch: Partial<Pick<MailAccount, 'label' | 'color'>>,
): MailAccount | null {
  const next = change(id, (a) => ({ ...a, ...patch }))
  return next ? withoutSecret(next) : null
}

/** Replace an account's secret (a new app-specific password). */
export function setSecret(id: string, secret: string): boolean {
  const encrypted = encrypt(secret)
  return change(id, (a) => ({ ...a, secret: encrypted })) !== null
}

/**
 * Forget an account and its secret. If it was Calendar's, Calendar keeps pointing at it (now gone)
 * rather than quietly using another iCloud account's password.
 */
export function removeStoredAccount(id: string): void {
  const loaded = load()
  const rest = loaded.entries.filter((e) => e.account?.id !== id)
  if (rest.length === loaded.entries.length) return
  save({
    ...loaded,
    top: { ...loaded.top, lastId: Math.max(Number(loaded.top['lastId']) || 0, idNumber(id)) },
    entries: rest,
  })
}

/** Record when an account's inbox scan last finished. Never fails a scan. */
export function recordScan(at: Date, id: string = FIRST_ACCOUNT_ID): void {
  try {
    change(id, (a) => ({ ...a, lastScan: at.toISOString() }))
  } catch {
    // A newer Ordo's file, or a disk that won't take it: only the time is lost.
  }
}

// Calendar (iCloud's CalDAV), and single-account helpers for the tests written before accounts.

/**
 * The iCloud account Calendar uses, by id: the one it was set up with, which stays its account
 * until it's removed. Then Calendar has none (its iCloud calendars are cleared) until you add an
 * iCloud account again; it never switches to another account's password by itself. A profile that
 * has never chosen one takes its first iCloud account.
 */
export function calendarAccountId(): string | null {
  const loaded = load()
  const chosen = loaded.top['calendarAccount']
  if (typeof chosen === 'string') return loaded.entries.some((e) => e.account?.id === chosen) ? chosen : null
  const first = loaded.entries.find(
    (e) => e.account?.provider === 'icloud' && e.account.auth.kind === 'password',
  )
  if (!first?.account) return null
  try {
    save({ ...loaded, top: { ...loaded.top, calendarAccount: first.account.id } })
  } catch {
    // Can't record the choice (a newer Ordo's file): use it for now anyway.
  }
  return first.account.id
}

/** Calendar's iCloud account, decrypted, or null when it has none. */
export function loadAccount(): {
  id: string
  email: string
  password: string
  lastScan: string | null
} | null {
  const id = calendarAccountId()
  const a = id ? storedAccounts().find((x) => x.id === id) : undefined
  if (!a) return null
  const password = readSecret(a.id)
  return password === null ? null : { id: a.id, email: a.email, password, lastScan: a.lastScan }
}

/** Replace every account with one iCloud account (FIRST_ACCOUNT_ID). For tests and set-up scripts. */
export function saveAccount(email: string, password: string): void {
  const icloud = PROVIDERS.icloud
  writeDurably(
    file(),
    JSON.stringify({
      version: ACCOUNTS_FILE_VERSION,
      lastId: 1,
      calendarAccount: FIRST_ACCOUNT_ID,
      accounts: [
        {
          id: FIRST_ACCOUNT_ID,
          label: icloud.name,
          email,
          color: 'blue',
          provider: 'icloud',
          imap: { ...icloud.imap! },
          smtp: { ...icloud.smtp! },
          auth: { kind: 'password' },
          lastScan: null,
          secret: encrypt(password),
        },
      ],
    } satisfies AccountsFile),
  )
}

/** Forget every account. */
export function deleteAccount(): void {
  for (const f of [file(), legacyFile(), migratedFile()]) rmSync(f, { force: true })
}
