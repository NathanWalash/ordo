import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, safeStorage } from 'electron'

interface StoredAccount {
  email: string
  /** App-specific password, encrypted with the OS keychain (safeStorage), base64. */
  password: string
  lastScan: string | null
}

const file = () => join(app.getPath('userData'), 'account.json')

function read(): StoredAccount | null {
  if (!existsSync(file())) return null
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as StoredAccount
  } catch {
    return null
  }
}

export const canStoreSecrets = () => safeStorage.isEncryptionAvailable()

export function loadAccount(): { email: string; password: string; lastScan: string | null } | null {
  const a = read()
  if (!a || !canStoreSecrets()) return null
  try {
    return {
      email: a.email,
      password: safeStorage.decryptString(Buffer.from(a.password, 'base64')),
      lastScan: a.lastScan,
    }
  } catch {
    return null
  }
}

export function saveAccount(email: string, password: string): void {
  if (!canStoreSecrets()) throw new Error('Secure storage is not available on this system')
  const enc = safeStorage.encryptString(password).toString('base64')
  writeFileSync(file(), JSON.stringify({ email, password: enc, lastScan: null } satisfies StoredAccount), {
    mode: 0o600,
  })
}

export function recordScan(at: Date): void {
  const a = read()
  if (a) writeFileSync(file(), JSON.stringify({ ...a, lastScan: at.toISOString() }), { mode: 0o600 })
}

export function deleteAccount(): void {
  rmSync(file(), { force: true })
}
