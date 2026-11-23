/**
 * Consistent copies of the profile's files to back up, and putting restored files in place.
 * Pure Node (fs, node:sqlite): no Electron, so it's tested against temporary folders.
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
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

/** Written before a restore moves anything and removed when it's done, so a crash part way is noticed. */
export const RESTORE_MARKER = 'restore-in-progress.json'

/** Only a plain folder name inside the profile, never a path. */
const folderName = z.string().regex(/^[\w.-]{1,100}$/)
const movable = z.enum(['account.json', ...replacedFiles()] as [string, ...string[]])
const MarkerSchema = z.strictObject({
  version: z.literal(1),
  startedAt: z.string(),
  /** The before-restore folder, inside the profile. */
  aside: folderName,
  /** The staging folder the restored files come from, inside the profile. */
  staging: folderName,
  /** Current files being moved aside. */
  moving: z.array(movable).max(50),
  /** Restored files being moved in. */
  restoring: z.array(z.enum(BACKUP_FILES)).max(BACKUP_FILES.length),
})
type Marker = z.infer<typeof MarkerSchema>

function writeMarker(profileDir: string, marker: Marker): void {
  const file = join(profileDir, RESTORE_MARKER)
  writeFileSync(`${file}.tmp`, JSON.stringify(marker, null, 2), { mode: 0o600, flush: true })
  renameSync(`${file}.tmp`, file)
}

/**
 * Swap restored files in: move the current ones into `asideDir` (never deleted), then move the
 * restored ones from staging into the profile. Synchronous, so nothing else in the process can
 * open a database half way. If any step fails, every move made so far is undone. A marker file
 * lists the moves while they happen; if Ordo dies part way, `recoverRestore` puts things right
 * at the next launch.
 */
export function applyRestore(options: ApplyRestoreOptions): { moved: string[]; restored: string[] } {
  const { profileDir, stagingDir, manifest, asideDir } = options
  if (existsSync(asideDir)) throw new Error(`${asideDir} already exists`)
  if (dirname(asideDir) !== profileDir || dirname(stagingDir) !== profileDir)
    throw new Error('The staging and before-restore folders must be inside the profile')
  for (const f of manifest.files)
    if (!isPlainFile(join(stagingDir, f.name))) throw new Error(`${f.name} is missing from the restore`)

  const rename = options.rename ?? renameSync
  const undo: { from: string; to: string }[] = []
  const move = (from: string, to: string) => {
    rename(from, to)
    undo.push({ from, to })
  }
  const toMove = [...replacedFiles(), ...(options.keepAccount ? [] : ['account.json'])].filter((name) =>
    existsSync(join(profileDir, name)),
  )
  const moved: string[] = []
  writeMarker(profileDir, {
    version: 1,
    startedAt: new Date().toISOString(),
    aside: basename(asideDir),
    staging: basename(stagingDir),
    moving: toMove,
    restoring: manifest.files.map((f) => f.name),
  })
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
    let undone = true
    for (const { from, to } of undo.reverse()) {
      try {
        rename(to, from)
      } catch {
        // Keep undoing the rest; the marker stays, so the next launch tries again.
        undone = false
      }
    }
    if (undone) {
      rmSync(join(profileDir, RESTORE_MARKER), { force: true })
      removeIfEmpty(asideDir)
    }
    throw err
  }
  rmSync(stagingDir, { recursive: true, force: true })
  rmSync(join(profileDir, RESTORE_MARKER), { force: true })
  return { moved, restored: manifest.files.map((f) => f.name) }
}

function removeIfEmpty(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true })
  } catch {
    // Not there, or not empty: leave it.
  }
}

export type RecoveryOutcome =
  /** Every move had happened: the restore is complete. */
  | { outcome: 'finished'; aside: string }
  /** It stopped part way: everything is back where it was before the restore. */
  | { outcome: 'rolled-back'; aside: string }
  /** The marker couldn't be read, so nothing was moved. It's kept beside it as `.unreadable`. */
  | { outcome: 'unreadable' }

/**
 * After a crash during a restore: finish it if every move had happened, otherwise put the
 * current data back from the before-restore folder (the restored copies go back to staging,
 * and the backup file is untouched, so you can restore again). Null when there was no restore in
 * progress. Run before any database is opened.
 */
export function recoverRestore(profileDir: string): RecoveryOutcome | null {
  const markerFile = join(profileDir, RESTORE_MARKER)
  if (!existsSync(markerFile)) return null
  let marker: Marker
  try {
    marker = MarkerSchema.parse(JSON.parse(readFileSync(markerFile, 'utf8')))
  } catch {
    renameSync(markerFile, `${markerFile}.unreadable`)
    return { outcome: 'unreadable' }
  }
  const aside = join(profileDir, marker.aside)
  const staging = join(profileDir, marker.staging)
  const inProfile = (name: string) => existsSync(join(profileDir, name))
  const complete =
    marker.restoring.every((n) => inProfile(n) && !existsSync(join(staging, n))) &&
    marker.moving.every((n) => existsSync(join(aside, n)))
  if (complete) {
    rmSync(staging, { recursive: true, force: true })
    rmSync(markerFile, { force: true })
    return { outcome: 'finished', aside }
  }
  // A restored file that has left staging is in the profile: send it back first.
  for (const name of marker.restoring) {
    if (existsSync(join(staging, name)) || !inProfile(name)) continue
    mkdirSync(staging, { recursive: true, mode: 0o700 })
    renameSync(join(profileDir, name), join(staging, name))
  }
  // Then the current data comes back from the before-restore folder.
  for (const name of marker.moving)
    if (existsSync(join(aside, name)) && !inProfile(name))
      renameSync(join(aside, name), join(profileDir, name))
  rmSync(staging, { recursive: true, force: true })
  removeIfEmpty(aside)
  rmSync(markerFile, { force: true })
  return { outcome: 'rolled-back', aside }
}
