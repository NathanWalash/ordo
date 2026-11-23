/**
 * Consistent copies of the profile's files to back up, and putting restored files in place.
 * Pure Node (fs, node:sqlite): no Electron, so it's tested against temporary folders.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BACKUP_FILES, type BackupFileName, type Manifest } from './format'

const isSqlite = (name: string) => name.endsWith('.sqlite')

/**
 * Copy one database with `VACUUM INTO`. It reads a single consistent snapshot through SQLite,
 * so rows still in the write-ahead log are included and a write in progress elsewhere is either
 * wholly in or wholly out. The source isn't changed (no checkpoint).
 */
export function snapshotDatabase(source: string, target: string): void {
  const db = new DatabaseSync(source)
  try {
    db.exec('PRAGMA busy_timeout = 5000;')
    db.prepare('VACUUM INTO ?').run(target)
  } finally {
    db.close()
  }
}

/** A regular file (not a folder or a link to somewhere else). */
const isPlainFile = (path: string) => {
  try {
    return lstatSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Snapshot every backup file the profile has into `workDir` (which must be empty or missing).
 * Returns the names copied, in a fixed order. Missing files (a module never used) are skipped.
 */
export function snapshotProfile(profileDir: string, workDir: string): BackupFileName[] {
  mkdirSync(workDir, { recursive: true, mode: 0o700 })
  const copied: BackupFileName[] = []
  for (const name of BACKUP_FILES) {
    const source = join(profileDir, name)
    if (!isPlainFile(source)) continue
    if (isSqlite(name)) snapshotDatabase(source, join(workDir, name))
    else copyFileSync(source, join(workDir, name))
    copied.push(name)
  }
  return copied
}

/** The email of the account in `account.json`, never the password; null if there's none. */
export function accountEmail(profileDir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(profileDir, 'account.json'), 'utf8')) as { email?: unknown }
    return typeof parsed.email === 'string' ? parsed.email : null
  } catch {
    return null
  }
}

/** Every file a restore replaces: each backup file and, for databases, their WAL and shared memory. */
function replacedFiles(): string[] {
  return BACKUP_FILES.flatMap((name) => (isSqlite(name) ? [name, `${name}-wal`, `${name}-shm`] : [name]))
}

export interface ApplyRestoreOptions {
  profileDir: string
  /** Where `openBackup` decrypted and checked the files. */
  stagingDir: string
  manifest: Manifest
  /** Folder to move the current data into. Must not exist yet. */
  asideDir: string
  /**
   * Keep this Mac's `account.json` (its keychain-encrypted password) in place. False when the
   * backup's mail belongs to another account: then it's moved aside too and you sign in again.
   */
  keepAccount: boolean
  /** For tests: the rename to use. */
  rename?: (from: string, to: string) => void
}

/**
 * Swap restored files in: move the current ones into `asideDir` (never deleted), then move the
 * restored ones from staging into the profile. Synchronous, so nothing else in the process can
 * open a database half way. If any step fails, every move made so far is undone.
 */
export function applyRestore(options: ApplyRestoreOptions): { moved: string[]; restored: string[] } {
  const { profileDir, stagingDir, manifest, asideDir } = options
  if (existsSync(asideDir)) throw new Error(`${asideDir} already exists`)
  for (const f of manifest.files)
    if (!isPlainFile(join(stagingDir, f.name))) throw new Error(`${f.name} is missing from the restore`)

  const rename = options.rename ?? renameSync
  const undo: { from: string; to: string }[] = []
  const move = (from: string, to: string) => {
    rename(from, to)
    undo.push({ from, to })
  }
  const toMove = [...replacedFiles(), ...(options.keepAccount ? [] : ['account.json'])]
  const moved: string[] = []
  try {
    mkdirSync(asideDir, { recursive: true, mode: 0o700 })
    for (const name of toMove) {
      const path = join(profileDir, name)
      if (!existsSync(path)) continue
      move(path, join(asideDir, name))
      moved.push(name)
    }
    for (const f of manifest.files) move(join(stagingDir, f.name), join(profileDir, f.name))
  } catch (err) {
    for (const { from, to } of undo.reverse()) {
      try {
        renameSync(to, from)
      } catch {
        // Keep undoing the rest; whatever couldn't move back is still in asideDir or staging.
      }
    }
    throw err
  }
  rmSync(stagingDir, { recursive: true, force: true })
  return { moved, restored: manifest.files.map((f) => f.name) }
}
