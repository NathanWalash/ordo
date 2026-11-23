import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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
 * Installs from before several accounts kept one account in `account.json`. The first read moves
 * it into the list as account #1 (FIRST_ACCOUNT_ID, the id the mail cache's migration gives its
 * rows), copying the encrypted password as it is, so nothing has to be decrypted to migrate.
 */

export const ACCOUNTS_FILE_VERSION = 1

export interface StoredAccount extends MailAccount {
  /** The secret for `auth.kind`, encrypted with safeStorage, base64. */
  secret: string
}

export interface AccountsFile {
  version: typeof ACCOUNTS_FILE_VERSION
  accounts: StoredAccount[]
}

/** What `account.json` held before several accounts. */
interface LegacyAccount {
  email: string
  password: string
  lastScan: string | null
}

const dir = () => app.getPath('userData')
const file = () => join(dir(), 'accounts.json')
const legacyFile = () => join(dir(), 'account.json')

export const canStoreSecrets = () => safeStorage.isEncryptionAvailable()

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

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

/** One stored account, or null if it's damaged (it's left out rather than failing the list). */
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

/** The accounts in a parsed `accounts.json`, damaged entries and repeated ids left out. */
export function parseAccountsFile(raw: unknown): StoredAccount[] {
  if (!isObject(raw) || !Array.isArray(raw['accounts'])) return []
  const seen = new Set<string>()
  const out: StoredAccount[] = []
  for (const v of raw['accounts']) {
    const a = parseStored(v)
    if (!a || seen.has(a.id)) continue
    seen.add(a.id)
    out.push(a)
  }
  return out
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

/** Write the list in one step (a temp file renamed over the old one), readable only by you. */
function write(accounts: StoredAccount[]): void {
  const tmp = `${file()}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ version: ACCOUNTS_FILE_VERSION, accounts } satisfies AccountsFile), {
    mode: 0o600,
  })
  renameSync(tmp, file())
}

/**
 * Every stored account, migrating a single-account `account.json` first if there's no list yet.
 * Idempotent: the list wins once it exists, and the old file goes only after the list is written.
 */
export function storedAccounts(): StoredAccount[] {
  if (existsSync(file())) return parseAccountsFile(readJson(file()))
  if (!existsSync(legacyFile())) return []
  const migrated = fromLegacy(readJson(legacyFile()))
  if (!migrated) return []
  write(migrated.accounts)
  rmSync(legacyFile(), { force: true })
  return migrated.accounts
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

const newId = (taken: Set<string>) => {
  for (;;) {
    const id = `acc-${randomUUID().slice(0, 8)}`
    if (!taken.has(id)) return id
  }
}

/** Save a new account at the end of the list. */
export function addStoredAccount(
  account: Omit<MailAccount, 'id' | 'lastScan'>,
  secret: string,
  id?: string,
): MailAccount {
  const all = storedAccounts()
  const taken = new Set(all.map((a) => a.id))
  const stored: StoredAccount = {
    ...account,
    id: id && !taken.has(id) ? id : newId(taken),
    lastScan: null,
    secret: encrypt(secret),
  }
  write([...all, stored])
  return withoutSecret(stored)
}

/** Change an account's label or colour. Null if there's no such account. */
export function updateStoredAccount(
  id: string,
  patch: Partial<Pick<MailAccount, 'label' | 'color'>>,
): MailAccount | null {
  const all = storedAccounts()
  const i = all.findIndex((a) => a.id === id)
  if (i < 0) return null
  const next = { ...all[i]!, ...patch }
  all[i] = next
  write(all)
  return withoutSecret(next)
}

/** Replace an account's secret (a new app-specific password). */
export function setSecret(id: string, secret: string): boolean {
  const all = storedAccounts()
  const a = all.find((x) => x.id === id)
  if (!a) return false
  a.secret = encrypt(secret)
  write(all)
  return true
}

/** Forget an account and its secret. */
export function removeStoredAccount(id: string): void {
  const all = storedAccounts()
  const rest = all.filter((a) => a.id !== id)
  if (rest.length !== all.length) write(rest)
}

/** Record when an account's inbox scan last finished. */
export function recordScan(at: Date, id: string = FIRST_ACCOUNT_ID): void {
  const all = storedAccounts()
  const a = all.find((x) => x.id === id)
  if (!a) return
  a.lastScan = at.toISOString()
  write(all)
}

// Single-account helpers, for Calendar (iCloud's CalDAV) and the tests written before accounts.

/**
 * The first iCloud account that signs in with a password, decrypted: Calendar uses it for iCloud
 * Calendar. Null when there's none.
 */
export function loadAccount(): {
  id: string
  email: string
  password: string
  lastScan: string | null
} | null {
  const a = storedAccounts().find((x) => x.provider === 'icloud' && x.auth.kind === 'password')
  if (!a) return null
  const password = readSecret(a.id)
  return password === null ? null : { id: a.id, email: a.email, password, lastScan: a.lastScan }
}

/** Replace every account with one iCloud account (FIRST_ACCOUNT_ID). For tests and set-up scripts. */
export function saveAccount(email: string, password: string): void {
  const icloud = PROVIDERS.icloud
  write([
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
  ])
}

/** Forget every account. */
export function deleteAccount(): void {
  rmSync(file(), { force: true })
  rmSync(legacyFile(), { force: true })
}
