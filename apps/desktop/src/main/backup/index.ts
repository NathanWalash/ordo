/**
 * Settings → Backup in the main process: where backups go, the passphrase, backing up (now, once
 * a day, and on quit), pruning, and restoring. The file format and the file moves are in
 * format.ts and snapshot.ts; this adds Electron (dialogs, safeStorage, Trash, relaunch).
 *
 * Credentials are never backed up: the iCloud app password in account.json is encrypted with
 * this Mac's keychain and couldn't be decrypted anywhere else. After restoring on another Mac (or
 * for another account) you connect again.
 */
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import { z } from 'zod'
import {
  BACKUP_IPC,
  BackupRunSchema,
  BackupUpdateSchema,
  RestoreConfirmSchema,
  RestoreOpenSchema,
  SetBackupPassphraseSchema,
  type BackupActionResult,
  type BackupLast,
  type BackupRunResult,
  type BackupStatus,
  type RestoreConfirmResult,
  type RestoreOpenResult,
  type RestorePickResult,
} from '@ordo/shared'
import { pathProblem } from '../paths'
import { closeMail } from '../mail'
import { closeMailClient } from '../mail-client'
import { closeCalendar } from '../calendar'
import { closeMoney } from '../money'
import { stopAsk } from '../money-memory'
import { closeBoards } from '../boards'
import { stop as stopAssistant } from '../assistant'
import { Locked, lockHolder, withWriteLock } from '../writes'
import { busyMessage } from '../lock'
import {
  BackupError,
  PassphraseCheckSchema,
  makePassphraseCheck,
  openBackup,
  passphraseMatches,
  readHeader,
  writeBackup,
  type Manifest,
} from './format'
import {
  BACKUP_EXTENSION,
  DAY_MS,
  DEFAULT_KEEP,
  backupDue,
  backupFileName,
  backupsToPrune,
  beforeRestoreName,
  compareVersions,
  isOrdoBackupName,
} from './policy'
import { accountEmail, applyRestore, snapshotProfile } from './snapshot'

const profile = () => app.getPath('userData')
const configFile = () => join(profile(), 'backup.json')
const stagingDir = () => join(profile(), 'restore-staging')
const WORK_PREFIX = 'backup-work-'

// ---------------------------------------------------------------------------------------------
// Config: backup.json in the profile. Never backed up itself (it's about this Mac).

const LastSchema = z.discriminatedUnion('ok', [
  z.object({
    at: z.string(),
    ok: z.literal(true),
    file: z.string(),
    size: z.number(),
    automatic: z.boolean(),
  }),
  z.object({ at: z.string(), ok: z.literal(false), message: z.string(), automatic: z.boolean() }),
])

const DEFAULTS = {
  folder: null,
  auto: true,
  keep: DEFAULT_KEEP,
  check: null,
  remembered: null,
  last: null,
  lastSuccessAt: null,
}

const ConfigSchema = z
  .object({
    folder: z.string().nullable().catch(null),
    auto: z.boolean().catch(true),
    keep: z.int().min(1).max(100).catch(DEFAULT_KEEP),
    /** A salted scrypt hash, to check a typed passphrase is the one that was set. */
    check: PassphraseCheckSchema.nullable().catch(null),
    /** The passphrase encrypted with this Mac's keychain (safeStorage), base64, if remembered. */
    remembered: z.string().nullable().catch(null),
    last: LastSchema.nullable().catch(null),
    lastSuccessAt: z.string().nullable().catch(null),
  })
  .catch(() => ({ ...DEFAULTS }))
type Config = z.infer<typeof ConfigSchema>

function readConfig(): Config {
  try {
    return ConfigSchema.parse(JSON.parse(readFileSync(configFile(), 'utf8')))
  } catch {
    return { ...DEFAULTS }
  }
}

function writeConfig(patch: Partial<Config>): Config {
  const next = { ...readConfig(), ...patch }
  const file = configFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  renameSync(`${file}.tmp`, file)
  return next
}

// ---------------------------------------------------------------------------------------------
// The passphrase: typed this session (memory only), or remembered in the keychain.

let sessionPassphrase: string | null = null
const canRemember = () => safeStorage.isEncryptionAvailable()

function availablePassphrase(config: Config): string | null {
  if (sessionPassphrase) return sessionPassphrase
  if (!config.remembered || !canRemember()) return null
  try {
    sessionPassphrase = safeStorage.decryptString(Buffer.from(config.remembered, 'base64'))
    return sessionPassphrase
  } catch {
    return null
  }
}

let running: Promise<BackupRunResult> | null = null

export function status(): BackupStatus {
  const c = readConfig()
  return {
    folder: c.folder,
    passphraseSet: c.check !== null,
    remembered: c.remembered !== null,
    canRemember: canRemember(),
    unlocked: c.check !== null && availablePassphrase(c) !== null,
    auto: c.auto,
    keep: c.keep,
    running: running !== null,
    last: c.last,
    lastSuccessAt: c.lastSuccessAt,
  }
}

const ok = (): BackupActionResult => ({ ok: true, status: status() })
const firstIssue = (e: z.ZodError) => e.issues[0]?.message ?? 'Check the details.'

/** Inside (or the same as) another folder, following links. */
function isInside(child: string, parent: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p)
    } catch {
      return p
    }
  }
  const rel = relative(real(parent), real(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Why a folder can't hold backups, or null. */
function folderProblem(folder: string): string | null {
  const problem = pathProblem(folder, { requireAbsolute: true })
  if (problem) return problem
  try {
    if (!statSync(folder).isDirectory()) return 'Choose a folder, not a file.'
  } catch {
    return 'That folder isn’t there any more. If it’s on a drive, connect it, or choose the folder again.'
  }
  if (isInside(folder, profile()) || isInside(profile(), folder))
    return 'Choose a folder outside Ordo’s own data folder.'
  return null
}

export async function chooseFolder(win: BrowserWindow | null): Promise<BackupActionResult> {
  const options: Electron.OpenDialogOptions = {
    title: 'Choose a folder for backups',
    message: 'Choose a folder iCloud Drive, Google Drive or Dropbox syncs to keep a copy in the cloud.',
    buttonLabel: 'Choose',
    properties: ['openDirectory', 'createDirectory'],
  }
  const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  const folder = r.filePaths[0]
  if (r.canceled || !folder) return ok()
  const problem = folderProblem(folder)
  if (problem) return { ok: false, message: problem }
  writeConfig({ folder })
  return ok()
}

export async function setPassphrase(raw: unknown): Promise<BackupActionResult> {
  const parsed = SetBackupPassphraseSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) }
  const { passphrase, remember } = parsed.data
  if (remember && !canRemember())
    return { ok: false, message: 'This computer can’t keep secrets securely, so Ordo can’t remember it.' }
  const check = await makePassphraseCheck(passphrase)
  const remembered = remember ? safeStorage.encryptString(passphrase).toString('base64') : null
  sessionPassphrase = passphrase
  writeConfig({ check, remembered })
  return ok()
}

export function forgetPassphrase(): BackupActionResult {
  writeConfig({ remembered: null })
  return ok()
}

export function update(raw: unknown): BackupActionResult {
  const parsed = BackupUpdateSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) }
  const patch: Partial<Config> = {}
  if (parsed.data.auto !== undefined) patch.auto = parsed.data.auto
  if (parsed.data.keep !== undefined) patch.keep = parsed.data.keep
  writeConfig(patch)
  return ok()
}

// ---------------------------------------------------------------------------------------------
// Backing up

function friendly(err: unknown): string {
  if (err instanceof BackupError) return err.message
  const code = (err as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOSPC') return 'There isn’t enough space for the backup. Free some space, then try again.'
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
    return 'Ordo can’t write to the backup folder. Check its permissions, or choose another folder.'
  if (code === 'ENOENT') return 'The backup folder isn’t there any more. Choose it again.'
  return `The backup didn’t finish: ${err instanceof Error ? err.message : String(err)}`
}

/** Old backups Ordo made in this folder, beyond the newest `keep`, go to the Trash. */
async function prune(folder: string, keep: number, made: string): Promise<number> {
  let pruned = 0
  for (const name of backupsToPrune(readdirSync(folder), keep)) {
    if (name === made) continue
    const path = join(folder, name)
    try {
      if (!lstatSync(path).isFile()) continue
      // Named like ours is not enough: it must also start like an Ordo backup.
      await readHeader(path).catch((err: unknown) => {
        if (!(err instanceof BackupError) || err.code !== 'newer-version') throw err
      })
      await shell.trashItem(path)
      pruned++
    } catch {
      // Leave anything Ordo can't check or move; it'll be looked at again next time.
    }
  }
  // A half-written backup left by a crash or a forced quit, once it's a day old.
  for (const name of readdirSync(folder)) {
    if (!name.endsWith('.partial') || !isOrdoBackupName(name.slice(0, -'.partial'.length))) continue
    const path = join(folder, name)
    try {
      const s = lstatSync(path)
      if (s.isFile() && Date.now() - s.mtimeMs > DAY_MS) await shell.trashItem(path)
    } catch {
      // As above.
    }
  }
  return pruned
}

async function backUp(passphrase: string, automatic: boolean): Promise<BackupRunResult> {
  const config = readConfig()
  const folder = config.folder!
  const problem = folderProblem(folder)
  const now = new Date()
  const record = (last: BackupLast) => writeConfig({ last, ...(last.ok ? { lastSuccessAt: last.at } : {}) })
  if (problem) {
    record({ at: now.toISOString(), ok: false, message: problem, automatic })
    return { ok: false, error: 'failed', message: problem }
  }
  const work = join(profile(), `${WORK_PREFIX}${randomUUID()}`)
  try {
    // Snapshots under the write lock, so no scan, sync or import is part way through a change.
    const files = await withWriteLock('backing up', async () => snapshotProfile(profile(), work))
    if (files instanceof Locked) {
      record({ at: now.toISOString(), ok: false, message: files.message, automatic })
      return { ok: false, error: 'locked', message: files.message }
    }
    const name = backupFileName(now, new Set(readdirSync(folder)))
    const email = accountEmail(profile())
    const { size } = await writeBackup({
      sourceDir: work,
      files,
      out: join(folder, name),
      passphrase,
      appVersion: app.getVersion(),
      createdAt: now,
      account: email ? { email } : null,
      excluded: ['account.json: passwords stay in this computer’s keychain'],
    })
    const pruned = await prune(folder, config.keep, name)
    record({ at: now.toISOString(), ok: true, file: name, size, automatic })
    return { ok: true, file: name, size, at: now.toISOString(), pruned }
  } catch (err) {
    const message = friendly(err)
    record({ at: now.toISOString(), ok: false, message, automatic })
    return { ok: false, error: 'failed', message }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

export async function run(raw: unknown, automatic = false): Promise<BackupRunResult> {
  const parsed = BackupRunSchema.safeParse(raw ?? {})
  if (!parsed.success) return { ok: false, error: 'invalid', message: firstIssue(parsed.error) }
  if (running) return running
  const config = readConfig()
  if (!config.folder || !config.check)
    return {
      ok: false,
      error: 'not-set-up',
      message: 'Choose a backup folder and set a passphrase first.',
    }
  const typed = parsed.data.passphrase
  if (typed !== undefined && !(await passphraseMatches(typed, config.check)))
    return { ok: false, error: 'wrong-passphrase', message: 'That isn’t your backup passphrase.' }
  if (typed !== undefined) sessionPassphrase = typed
  const passphrase = availablePassphrase(config)
  if (!passphrase)
    return { ok: false, error: 'needs-passphrase', message: 'Enter your backup passphrase to back up.' }
  if (running) return running
  running = backUp(passphrase, automatic).finally(() => {
    running = null
  })
  return running
}

const HOUR_MS = 60 * 60 * 1000

/** Whether an automatic backup should run now. A failed one waits an hour before trying again. */
function automaticDue(now = new Date()): boolean {
  const c = readConfig()
  if (!c.auto || !c.folder || !c.check || running || restoring) return false
  if (!availablePassphrase(c)) return false
  if (c.last && !c.last.ok && now.getTime() - Date.parse(c.last.at) < HOUR_MS) return false
  return backupDue(c.lastSuccessAt ? new Date(c.lastSuccessAt) : null, now)
}

async function tick(): Promise<void> {
  if (automaticDue()) await run({}, true)
}

// ---------------------------------------------------------------------------------------------
// Restoring

let picked: string | null = null
let pending: { id: string; manifest: Manifest; keepsAccount: boolean } | null = null
let restoring = false

function clearStaging(): void {
  pending = null
  rmSync(stagingDir(), { recursive: true, force: true })
}

export async function restorePick(win: BrowserWindow | null): Promise<RestorePickResult> {
  const options: Electron.OpenDialogOptions = {
    title: 'Choose a backup to restore',
    buttonLabel: 'Choose',
    properties: ['openFile'],
    filters: [{ name: 'Ordo backup', extensions: [BACKUP_EXTENSION.slice(1)] }],
    ...(readConfig().folder ? { defaultPath: readConfig().folder! } : {}),
  }
  const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  const file = r.filePaths[0]
  if (r.canceled || !file) return { ok: false, cancelled: true }
  clearStaging()
  picked = file
  return { ok: true, fileName: file.split(/[\\/]/).pop() ?? file }
}

const LABELS: Record<Manifest['files'][number]['name'], string> = {
  'mail.sqlite': 'Mail: downloaded messages and clean-up history',
  'calendar.sqlite': 'Calendar: calendars and events',
  'money.sqlite': 'Money: transactions, bills and what Ordo has learned',
  'boards.sqlite': 'Boards: boards and cards',
  'settings.json': 'Settings: appearance and AI',
  'assistant.json': 'Assistant settings',
}

export async function restoreOpen(raw: unknown): Promise<RestoreOpenResult> {
  const parsed = RestoreOpenSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'invalid', message: firstIssue(parsed.error) }
  if (!picked) return { ok: false, error: 'no-file', message: 'Choose a backup file first.' }
  const problem = pathProblem(picked, { requireAbsolute: true })
  if (problem) return { ok: false, error: 'invalid', message: problem }
  clearStaging()
  let manifest: Manifest
  try {
    manifest = await openBackup(picked, parsed.data.passphrase, { into: stagingDir() })
  } catch (err) {
    clearStaging()
    if (err instanceof BackupError) return { ok: false, error: err.code, message: err.message }
    return { ok: false, error: 'failed', message: friendly(err) }
  }
  if (compareVersions(manifest.appVersion, app.getVersion()) > 0) {
    clearStaging()
    return {
      ok: false,
      error: 'newer-version',
      message: `This backup was made by Ordo ${manifest.appVersion}. Update Ordo to ${manifest.appVersion} or later, then restore it.`,
    }
  }
  const current = accountEmail(profile())
  const keepsAccount =
    current !== null && (!manifest.account || manifest.account.email.toLowerCase() === current.toLowerCase())
  const id = randomUUID()
  pending = { id, manifest, keepsAccount }
  return {
    ok: true,
    preview: {
      id,
      fileName: picked.split(/[\\/]/).pop() ?? picked,
      createdAt: manifest.createdAt,
      appVersion: manifest.appVersion,
      files: manifest.files.map((f) => ({ name: f.name, label: LABELS[f.name], size: f.size })),
      account: manifest.account?.email ?? null,
      keepsAccount,
      asideFolder: join(profile(), beforeRestoreName(new Date())),
    },
  }
}

export function restoreCancel(): void {
  clearStaging()
  picked = null
}

/** Close every store and stop anything running, so no database is open while files move. */
function closeEverything(): void {
  stopAssistant()
  stopAsk()
  closeMailClient()
  closeMail()
  closeCalendar()
  closeMoney()
  closeBoards()
}

export async function restoreConfirm(raw: unknown): Promise<RestoreConfirmResult> {
  const parsed = RestoreConfirmSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, message: 'Type “restore” to confirm.' }
  if (!pending || pending.id !== parsed.data.id)
    return { ok: false, message: 'Open the backup again, then confirm.' }
  if (running) return { ok: false, message: 'A backup is running. Try again when it finishes.' }
  // Refuse while anything (in this window or another Ordo process) is writing.
  const holder = lockHolder()
  if (holder) return { ok: false, message: busyMessage(holder) }
  const { manifest, keepsAccount } = pending
  restoring = true
  let asideDir = ''
  const result = await withWriteLock('restoring a backup', async () => {
    // Synchronous from here: nothing else in this process can reopen a database part way.
    closeEverything()
    asideDir = join(profile(), beforeRestoreName(new Date()))
    applyRestore({
      profileDir: profile(),
      stagingDir: stagingDir(),
      manifest,
      asideDir,
      keepAccount: keepsAccount,
    })
  }).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))))
  if (result instanceof Locked) {
    restoring = false
    return { ok: false, message: result.message }
  }
  if (result instanceof Error) {
    restoring = false
    return {
      ok: false,
      message: `Ordo couldn’t restore the backup, and your data is unchanged: ${result.message}`,
    }
  }
  pending = null
  picked = null
  console.info(`Restored a backup; the previous data is in ${asideDir}`)
  app.relaunch()
  app.exit(0)
  return { ok: false, message: 'Restarting…' }
}

// ---------------------------------------------------------------------------------------------
// Wiring

/** Leftovers from a backup or restore that was cut short. */
function tidy(): void {
  try {
    for (const name of readdirSync(profile()))
      if (name.startsWith(WORK_PREFIX)) rmSync(join(profile(), name), { recursive: true, force: true })
  } catch {
    // No profile yet.
  }
  if (existsSync(stagingDir())) rmSync(stagingDir(), { recursive: true, force: true })
}

let quitBackupDone = false

/** Register the IPC handlers, the daily schedule and the backup on quit. Windowed app only. */
export function registerBackup(): void {
  const win = (e: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender)
  ipcMain.handle(BACKUP_IPC.status, () => status())
  ipcMain.handle(BACKUP_IPC.chooseFolder, (e) => chooseFolder(win(e)))
  ipcMain.handle(BACKUP_IPC.setPassphrase, (_e, input: unknown) => setPassphrase(input))
  ipcMain.handle(BACKUP_IPC.forgetPassphrase, () => forgetPassphrase())
  ipcMain.handle(BACKUP_IPC.update, (_e, input: unknown) => update(input))
  ipcMain.handle(BACKUP_IPC.run, (_e, input: unknown) => run(input))
  ipcMain.handle(BACKUP_IPC.restorePick, (e) => restorePick(win(e)))
  ipcMain.handle(BACKUP_IPC.restoreOpen, (_e, input: unknown) => restoreOpen(input))
  ipcMain.handle(BACKUP_IPC.restoreCancel, () => restoreCancel())
  ipcMain.handle(BACKUP_IPC.restoreConfirm, (_e, input: unknown) => restoreConfirm(input))

  void app.whenReady().then(() => {
    tidy()
    // A couple of minutes after opening, then every half hour: back up once a day.
    setTimeout(() => void tick(), 2 * 60 * 1000).unref()
    setInterval(() => void tick(), 30 * 60 * 1000).unref()
  })

  // On quit, back up first if the last one is more than a day old (at most two minutes).
  app.on('before-quit', (e) => {
    if (quitBackupDone || restoring || !automaticDue()) return
    e.preventDefault()
    quitBackupDone = true
    const limit = new Promise((resolve) => setTimeout(resolve, 2 * 60 * 1000).unref())
    void Promise.race([run({}, true), limit]).finally(() => app.quit())
  })
}
