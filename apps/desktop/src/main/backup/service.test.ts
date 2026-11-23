import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import type * as Fs from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { MessageHeader } from '@ordo/mail-core'

// The Backup service as the IPC handlers call it, with Electron replaced by a temp profile, a
// fake keychain, a fake Trash and scripted dialogs. Synthetic data only.
const env = vi.hoisted(() => ({
  profile: '',
  trash: '',
  pick: [] as string[],
  freeBytes: null as number | null,
}))
// Free disk space, when a test wants to pretend the disk is nearly full.
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>()
  const statfsSync = ((path: string) =>
    env.freeBytes === null
      ? fs.statfsSync(path)
      : { ...fs.statfsSync(path), bavail: env.freeBytes, bsize: 1 }) as typeof Fs.statfsSync
  return { ...fs, default: { ...fs, statfsSync }, statfsSync }
})
const electron = vi.hoisted(() => ({
  relaunch: vi.fn(),
  exit: vi.fn(),
}))
vi.mock('electron', () => ({
  app: {
    getPath: () => env.profile,
    getVersion: () => '0.1.0',
    isPackaged: true,
    on: vi.fn(),
    whenReady: () => new Promise(() => {}),
    relaunch: electron.relaunch,
    exit: electron.exit,
  },
  ipcMain: { handle: vi.fn() },
  shell: {
    openExternal: vi.fn(),
    trashItem: vi.fn(async (path: string) => renameSync(path, join(env.trash, basename(path)))),
  },
  dialog: {
    showOpenDialog: vi.fn(async () => ({ canceled: env.pick.length === 0, filePaths: env.pick })),
  },
  BrowserWindow: { fromWebContents: () => null },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().slice('enc:'.length),
  },
}))

const root = mkdtempSync(join(tmpdir(), 'ordo-backup-service-'))
env.profile = join(root, 'profile')
env.trash = join(root, 'trash')
const folder = join(root, 'Cloud Drive', 'Ordo backups')
for (const d of [env.profile, env.trash, folder]) mkdirSync(d, { recursive: true })

const backup = await import('./index')
const mail = await import('../mail')
const { saveAccount } = await import('../account')

afterAll(() => {
  mail.closeMail()
  rmSync(root, { recursive: true, force: true })
})

const PASS = 'synthetic passphrase for tests'
const header = (uid: number): MessageHeader => ({
  uid,
  mailbox: 'INBOX',
  date: new Date(1_790_000_000_000 + uid),
  seen: false,
  from: { address: `sender${uid}@news.example` },
  subject: `Subject ${uid}`,
})
const inboxCount = () => mail.mailStore().count('INBOX')

describe('setting up', () => {
  it('needs a folder and a passphrase before it backs up', async () => {
    expect(backup.status()).toMatchObject({ folder: null, passphraseSet: false, auto: true, keep: 7 })
    expect(await backup.run({})).toMatchObject({ ok: false, error: 'not-set-up' })
  })

  it('refuses a folder inside Ordo’s own data folder', async () => {
    env.pick = [join(env.profile)]
    expect(await backup.chooseFolder(null)).toMatchObject({ ok: false })
    env.pick = [join(root, 'does not exist')]
    expect(await backup.chooseFolder(null)).toMatchObject({ ok: false })
    expect(backup.status().folder).toBeNull()
  })

  it('saves the chosen folder; cancelling changes nothing', async () => {
    env.pick = [folder]
    expect(await backup.chooseFolder(null)).toMatchObject({ ok: true, status: { folder } })
    env.pick = []
    expect(await backup.chooseFolder(null)).toMatchObject({ ok: true, status: { folder } })
  })

  it('refuses a short passphrase, and never saves one in plain text', async () => {
    expect(await backup.setPassphrase({ passphrase: 'short', remember: true })).toMatchObject({ ok: false })
    expect(await backup.setPassphrase({ passphrase: PASS, remember: true, extra: 1 })).toMatchObject({
      ok: false,
    })
    const r = await backup.setPassphrase({ passphrase: PASS, remember: true })
    expect(r).toMatchObject({ ok: true, status: { passphraseSet: true, remembered: true, unlocked: true } })
    const saved = readFileSync(join(env.profile, 'backup.json'), 'utf8')
    expect(saved).not.toContain(PASS)
    expect(JSON.parse(saved)).toMatchObject({ check: { logN: 17, r: 8, p: 1 } })
  })

  it('changes the passphrase only with the current one, and writes nothing otherwise', async () => {
    const file = join(env.profile, 'backup.json')
    const before = readFileSync(file, 'utf8')
    const next = { passphrase: 'another synthetic passphrase', remember: true }
    expect(await backup.setPassphrase(next)).toEqual({
      ok: false,
      message: 'Enter your current passphrase to change it.',
    })
    expect(await backup.setPassphrase({ ...next, current: 'not the current one' })).toEqual({
      ok: false,
      message: 'That isn’t your current passphrase.',
    })
    expect(readFileSync(file, 'utf8')).toBe(before)

    expect(await backup.setPassphrase({ ...next, current: PASS })).toMatchObject({ ok: true })
    expect(readFileSync(file, 'utf8')).not.toBe(before)
    // Back to PASS, which now needs the new one as the current passphrase.
    expect(await backup.setPassphrase({ passphrase: PASS, remember: true, current: PASS })).toMatchObject({
      ok: false,
    })
    expect(
      await backup.setPassphrase({ passphrase: PASS, remember: true, current: next.passphrase }),
    ).toMatchObject({ ok: true })
  })

  it('validates settings changes', () => {
    expect(backup.update({ keep: 5 })).toMatchObject({ ok: false })
    expect(backup.update({ auto: 'yes' })).toMatchObject({ ok: false })
    expect(backup.update({ keep: 3, auto: false })).toMatchObject({
      ok: true,
      status: { keep: 3, auto: false },
    })
    expect(backup.update({ keep: 7, auto: true })).toMatchObject({ ok: true })
  })
})

let firstBackup = ''

describe('backing up', () => {
  it('backs up the stores (WAL included) and settings, but never the account password', async () => {
    mail.mailStore().saveHeaders([header(1), header(2), header(3)])
    writeFileSync(join(env.profile, 'settings.json'), JSON.stringify({ theme: 'dark' }))
    saveAccount('someone@ordo.test', 'abcd-efgh-ijkl-mnop')
    expect(existsSync(join(env.profile, 'mail.sqlite-wal'))).toBe(true)

    const r = await backup.run({})
    expect(r).toMatchObject({ ok: true, pruned: 0 })
    if (!r.ok) return
    firstBackup = join(folder, r.file)
    expect(r.file).toMatch(/^Ordo-backup-\d{4}-\d{2}-\d{2}-\d{4}\.ordobackup$/)
    expect(readdirSync(folder)).toEqual([r.file])
    const raw = readFileSync(firstBackup)
    expect(raw.includes(Buffer.from('abcd-efgh-ijkl-mnop'))).toBe(false)
    expect(raw.includes(Buffer.from('someone@ordo.test'))).toBe(false)
    // No snapshot is left in the profile.
    expect(readdirSync(env.profile).filter((n) => n.startsWith('backup-work-'))).toEqual([])
    expect(backup.status()).toMatchObject({ last: { ok: true, file: r.file, automatic: false } })
    expect(backup.status().lastSuccessAt).toBe(r.at)
  })

  it('checks a typed passphrase against the one that was set', async () => {
    expect(await backup.run({ passphrase: 'not my passphrase' })).toMatchObject({
      ok: false,
      error: 'wrong-passphrase',
    })
    expect(await backup.run({ bogus: true })).toMatchObject({ ok: false, error: 'invalid' })
  })

  it('waits while another Ordo process is writing', async () => {
    const lock = join(env.profile, 'ordo-write.lock')
    writeFileSync(
      lock,
      JSON.stringify({ pid: process.ppid, owner: 'mcp', task: 'syncing', since: new Date().toISOString() }),
    )
    try {
      expect(await backup.run({})).toMatchObject({ ok: false, error: 'locked' })
      expect(backup.status().last).toMatchObject({ ok: false })
    } finally {
      rmSync(lock, { force: true })
    }
  })

  it('keeps the newest N, moving only older Ordo backups to the Trash', async () => {
    const older = [
      'Ordo-backup-2020-01-01-0900.ordobackup',
      'Ordo-backup-2020-01-02-0900.ordobackup',
      'Ordo-backup-2020-01-03-0900.ordobackup',
    ]
    for (const name of older) copyFileSync(firstBackup, join(folder, name))
    // Named like an Ordo backup but isn't one: never touched.
    writeFileSync(join(folder, 'Ordo-backup-2019-01-01-0900.ordobackup'), 'my own file')
    const yours = ['notes.txt', 'Ordo-backup-2018-01-01-0900 copy.ordobackup']
    for (const name of yours) writeFileSync(join(folder, name), 'yours')

    backup.update({ keep: 3 })
    const r = await backup.run({})
    expect(r).toMatchObject({ ok: true, pruned: 2 })
    expect(readdirSync(env.trash).sort()).toEqual(older.slice(0, 2))
    const left = readdirSync(folder)
    for (const name of [...yours, older[2]!, basename(firstBackup), 'Ordo-backup-2019-01-01-0900.ordobackup'])
      expect(left).toContain(name)
    backup.update({ keep: 7 })
  })
})

describe('restoring', () => {
  it('needs a file, and the right passphrase', async () => {
    expect(await backup.restoreOpen({ passphrase: PASS })).toMatchObject({ ok: false, error: 'no-file' })
    env.pick = [firstBackup]
    expect(await backup.restorePick(null)).toEqual({ ok: true, fileName: basename(firstBackup) })
    expect(await backup.restoreOpen({ passphrase: 'wrong passphrase' })).toMatchObject({
      ok: false,
      error: 'wrong-passphrase',
    })
    expect(existsSync(join(env.profile, 'restore-staging', 'mail.sqlite'))).toBe(false)
  })

  it('refuses a damaged file with a clear message', async () => {
    const bad = join(root, 'damaged.ordobackup')
    const raw = readFileSync(firstBackup)
    raw[200]! ^= 1
    writeFileSync(bad, raw)
    env.pick = [bad]
    await backup.restorePick(null)
    expect(await backup.restoreOpen({ passphrase: PASS })).toMatchObject({ ok: false, error: 'damaged' })
  })

  it('previews, then needs the typed word, then swaps the data in and restarts', async () => {
    // Changes since the backup, which the restore will replace.
    mail.mailStore().saveHeaders([header(4), header(5)])
    expect(inboxCount()).toBe(5)

    env.pick = [firstBackup]
    await backup.restorePick(null)
    const opened = await backup.restoreOpen({ passphrase: PASS })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    const { preview } = opened
    expect(preview).toMatchObject({ appVersion: '0.1.0', account: 'someone@ordo.test', keepsAccount: true })
    expect(preview.files.map((f) => f.name)).toEqual(['mail.sqlite', 'settings.json'])
    // Opening changed nothing.
    expect(inboxCount()).toBe(5)

    expect(await backup.restoreConfirm({ id: preview.id, confirm: 'yes' })).toMatchObject({ ok: false })
    expect(await backup.restoreConfirm({ id: 'other', confirm: 'restore' })).toMatchObject({ ok: false })
    expect(electron.exit).not.toHaveBeenCalled()

    await backup.restoreConfirm({ id: preview.id, confirm: 'restore' })
    expect(electron.relaunch).toHaveBeenCalledOnce()
    expect(electron.exit).toHaveBeenCalledWith(0)

    // The store reopens on the restored file.
    expect(inboxCount()).toBe(3)
    const aside = readdirSync(env.profile).filter((n) => n.startsWith('before-restore-'))
    expect(aside).toHaveLength(1)
    const asideFiles = readdirSync(join(env.profile, aside[0]!))
    expect(asideFiles).toContain('mail.sqlite')
    expect(asideFiles).toContain('settings.json')
    // This Mac's account (same email) and backup settings stay.
    expect(JSON.parse(readFileSync(join(env.profile, 'account.json'), 'utf8')).email).toBe(
      'someone@ordo.test',
    )
    expect(backup.status()).toMatchObject({ folder, passphraseSet: true })
    expect(existsSync(join(env.profile, 'restore-staging'))).toBe(false)
  })
})

describe('hardening', () => {
  it('refuses to restore a backup bigger than the free disk space, writing nothing', async () => {
    const copy = join(root, 'copy.ordobackup')
    copyFileSync(firstBackup, copy)
    env.pick = [copy]
    await backup.restorePick(null)
    env.freeBytes = 256 * 1024 * 1024 + 1000 // a 1,000-byte margin over Ordo's reserve
    try {
      expect(await backup.restoreOpen({ passphrase: PASS })).toMatchObject({ ok: false, error: 'no-space' })
    } finally {
      env.freeBytes = null
    }
    expect(existsSync(join(env.profile, 'restore-staging', 'mail.sqlite'))).toBe(false)
    expect(await backup.restoreOpen({ passphrase: PASS })).toMatchObject({ ok: true })
    backup.restoreCancel()
  })

  it('opens one backup at a time: a second open while one runs is refused', async () => {
    env.pick = [join(root, 'copy.ordobackup')]
    await backup.restorePick(null)
    const first = backup.restoreOpen({ passphrase: PASS })
    const second = await backup.restoreOpen({ passphrase: PASS })
    expect(second).toEqual({
      ok: false,
      error: 'busy',
      message: 'Ordo is already opening a backup. Wait for it to finish.',
    })
    // Picking another file can't swap the staging folder out from under it either.
    expect(await backup.restorePick(null)).toEqual({ ok: false, cancelled: true })
    expect(await first).toMatchObject({ ok: true })
    backup.restoreCancel()
  })

  it('cancelling while a backup is opening throws the result away', async () => {
    env.pick = [join(root, 'copy.ordobackup')]
    await backup.restorePick(null)
    const opening = backup.restoreOpen({ passphrase: PASS })
    backup.restoreCancel()
    expect(await opening).toMatchObject({ ok: false, message: 'Cancelled.' })
    expect(existsSync(join(env.profile, 'restore-staging'))).toBe(false)
  })

  it('says a restore happened until you dismiss it', async () => {
    expect(backup.status().notice).toMatch(
      /^Restored the backup from .+ Your data from before is in .+before-restore-/,
    )
    expect(backup.dismissNotice()).toMatchObject({ ok: true, status: { notice: null } })
  })

  it('at launch, puts back a restore that was cut short, and says so', () => {
    expect(backup.recoverInterruptedRestore()).toBeNull()
    // As left by a crash after settings.json was moved aside, before the restored one went in.
    const settings = join(env.profile, 'settings.json')
    const current = readFileSync(settings, 'utf8')
    mkdirSync(join(env.profile, 'before-restore-crash'))
    renameSync(settings, join(env.profile, 'before-restore-crash', 'settings.json'))
    mkdirSync(join(env.profile, 'restore-staging'))
    writeFileSync(join(env.profile, 'restore-staging', 'settings.json'), '{"theme":"light"}')
    writeFileSync(
      join(env.profile, 'restore-in-progress.json'),
      JSON.stringify({
        version: 1,
        startedAt: new Date().toISOString(),
        aside: 'before-restore-crash',
        staging: 'restore-staging',
        moving: ['settings.json'],
        restoring: ['settings.json'],
      }),
    )

    const message = backup.recoverInterruptedRestore()
    expect(message).toMatch(/^A restore was interrupted .+ put your data back as it was before/)
    expect(readFileSync(settings, 'utf8')).toBe(current)
    expect(existsSync(join(env.profile, 'restore-in-progress.json'))).toBe(false)
    expect(existsSync(join(env.profile, 'restore-staging'))).toBe(false)
    expect(backup.status().notice).toBe(message)
    backup.dismissNotice()
  })

  it('records a backup as made even if tidying old ones fails', async () => {
    const { shell } = await import('electron')
    backup.update({ keep: 3 })
    // The folder vanishes while old backups are being moved to the Trash (a drive unplugged).
    vi.mocked(shell.trashItem).mockImplementationOnce(async () => {
      rmSync(folder, { recursive: true, force: true })
      throw new Error('gone')
    })
    const r = await backup.run({})
    expect(r).toMatchObject({ ok: true, note: expect.stringMatching(/^Older backups weren’t tidied up/) })
    if (!r.ok) return
    expect(backup.status()).toMatchObject({ lastSuccessAt: r.at, last: { ok: true, note: r.note } })
    mkdirSync(folder, { recursive: true })
    backup.update({ keep: 7 })
  })
})
