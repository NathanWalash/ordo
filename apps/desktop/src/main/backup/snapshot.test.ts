import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openBackup, writeBackup, type Manifest } from './format'
import { RESTORE_MARKER, accountEmail, applyRestore, recoverRestore, snapshotProfile } from './snapshot'

const FAST = { logN: 10, r: 8, p: 1 }
const PASS = 'a long synthetic test passphrase'

let dir: string
let profile: string
const open: DatabaseSync[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ordo-backup-snapshot-'))
  profile = join(dir, 'profile')
  mkdirSync(profile)
})
afterEach(() => {
  for (const db of open.splice(0)) if (db.isOpen) db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A database in WAL mode like Ordo's stores, kept open with checkpoints off so rows stay in the WAL. */
function walDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  open.push(db)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;')
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
  return db
}

const count = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return (db.prepare('SELECT count(*) AS n FROM notes').get() as { n: number }).n
  } finally {
    db.close()
  }
}

describe('snapshots', () => {
  it('include rows still in the write-ahead log, and survive a backup and restore', async () => {
    const live = walDatabase(join(profile, 'mail.sqlite'))
    const insert = live.prepare('INSERT INTO notes (body) VALUES (?)')
    for (let i = 0; i < 500; i++) insert.run(`synthetic row ${i}`)
    expect(statSync(join(profile, 'mail.sqlite-wal')).size).toBeGreaterThan(0)

    // The main file alone doesn't have the rows yet: they're only in the WAL.
    const mainOnly = join(dir, 'main-only')
    mkdirSync(mainOnly)
    copyFileSync(join(profile, 'mail.sqlite'), join(mainOnly, 'mail.sqlite'))
    expect(() => count(join(mainOnly, 'mail.sqlite'))).toThrow(/no such table/)

    const work = join(dir, 'work')
    const files = snapshotProfile(profile, work)
    expect(files).toEqual(['mail.sqlite'])
    // The live database wasn't checkpointed by the snapshot.
    expect(statSync(join(profile, 'mail.sqlite-wal')).size).toBeGreaterThan(0)

    const out = join(dir, 'b.ordobackup')
    await writeBackup({
      sourceDir: work,
      files,
      out,
      passphrase: PASS,
      appVersion: '0.1.0',
      createdAt: new Date(),
      account: null,
      scrypt: FAST,
    })
    const restored = join(dir, 'restored')
    await openBackup(out, PASS, { into: restored })
    expect(count(join(restored, 'mail.sqlite'))).toBe(500)
    expect(existsSync(join(restored, 'mail.sqlite-wal'))).toBe(false)
  })

  it('is consistent while the app keeps writing', () => {
    const live = walDatabase(join(profile, 'money.sqlite'))
    live.exec('BEGIN')
    live.prepare('INSERT INTO notes (body) VALUES (?)').run('not committed yet')
    snapshotProfile(profile, join(dir, 'work'))
    live.exec('COMMIT')
    expect(count(join(dir, 'work', 'money.sqlite'))).toBe(0)
  })

  it('copies the settings files, skips what is missing, and never takes credentials', () => {
    writeFileSync(join(profile, 'settings.json'), '{"theme":"dark"}')
    writeFileSync(join(profile, 'assistant.json'), '{"cloudConsent":null}')
    writeFileSync(join(profile, 'account.json'), '{"email":"someone@ordo.test","password":"ZW5j"}')
    writeFileSync(join(profile, 'backup.json'), '{}')
    writeFileSync(join(profile, 'ordo-write.lock'), '{}')
    const work = join(dir, 'work')
    expect(snapshotProfile(profile, work)).toEqual(['settings.json', 'assistant.json'])
    expect(readdirSync(work).sort()).toEqual(['assistant.json', 'settings.json'])
    expect(readFileSync(join(work, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
  })

  it('does not follow a link in place of a profile file', () => {
    const secret = join(dir, 'elsewhere.json')
    writeFileSync(secret, 'not part of Ordo')
    symlinkSync(secret, join(profile, 'settings.json'))
    expect(snapshotProfile(profile, join(dir, 'work'))).toEqual([])
  })

  it('reads the account email but never the password', () => {
    expect(accountEmail(profile)).toBeNull()
    writeFileSync(join(profile, 'account.json'), '{"email":"someone@ordo.test","password":"ZW5j"}')
    expect(accountEmail(profile)).toBe('someone@ordo.test')
    writeFileSync(join(profile, 'account.json'), 'not json')
    expect(accountEmail(profile)).toBeNull()
  })
})

const manifestOf = (names: Manifest['files'][number]['name'][]): Manifest => ({
  format: 1,
  app: 'Ordo',
  appVersion: '0.1.0',
  createdAt: new Date().toISOString(),
  account: null,
  files: names.map((name) => ({ name, size: 0, sha256: '0'.repeat(64) })),
  excluded: [],
})

describe('applyRestore', () => {
  function current() {
    writeFileSync(join(profile, 'mail.sqlite'), 'old mail')
    writeFileSync(join(profile, 'mail.sqlite-wal'), 'old wal')
    writeFileSync(join(profile, 'mail.sqlite-shm'), 'old shm')
    writeFileSync(join(profile, 'calendar.sqlite'), 'old calendar')
    writeFileSync(join(profile, 'settings.json'), 'old settings')
    writeFileSync(join(profile, 'account.json'), 'this mac’s account')
    writeFileSync(join(profile, 'backup.json'), 'this mac’s backup settings')
  }
  function staged(names: string[]) {
    const staging = join(profile, 'restore-staging')
    mkdirSync(staging)
    for (const n of names) writeFileSync(join(staging, n), `restored ${n}`)
    return staging
  }

  it('moves the current data aside (with WAL files) and puts the restored files in place', () => {
    current()
    const stagingDir = staged(['mail.sqlite', 'settings.json'])
    const asideDir = join(profile, 'before-restore-x')
    const result = applyRestore({
      profileDir: profile,
      stagingDir,
      asideDir,
      manifest: manifestOf(['mail.sqlite', 'settings.json']),
      keepAccount: true,
    })
    expect(readFileSync(join(profile, 'mail.sqlite'), 'utf8')).toBe('restored mail.sqlite')
    expect(readFileSync(join(profile, 'settings.json'), 'utf8')).toBe('restored settings.json')
    // A stale WAL must never sit beside the restored database.
    expect(existsSync(join(profile, 'mail.sqlite-wal'))).toBe(false)
    expect(existsSync(join(profile, 'mail.sqlite-shm'))).toBe(false)
    // Calendar wasn't in the backup: the current one is moved aside, not mixed in.
    expect(existsSync(join(profile, 'calendar.sqlite'))).toBe(false)
    expect(readdirSync(asideDir).sort()).toEqual([
      'calendar.sqlite',
      'mail.sqlite',
      'mail.sqlite-shm',
      'mail.sqlite-wal',
      'settings.json',
    ])
    expect(readFileSync(join(asideDir, 'mail.sqlite-wal'), 'utf8')).toBe('old wal')
    // This Mac's account and backup settings stay.
    expect(readFileSync(join(profile, 'account.json'), 'utf8')).toBe('this mac’s account')
    expect(readFileSync(join(profile, 'backup.json'), 'utf8')).toBe('this mac’s backup settings')
    expect(existsSync(stagingDir)).toBe(false)
    expect(result.restored).toEqual(['mail.sqlite', 'settings.json'])
  })

  it('moves the account aside too when the backup is for another account', () => {
    current()
    const asideDir = join(profile, 'before-restore-x')
    applyRestore({
      profileDir: profile,
      stagingDir: staged(['mail.sqlite']),
      asideDir,
      manifest: manifestOf(['mail.sqlite']),
      keepAccount: false,
    })
    expect(existsSync(join(profile, 'account.json'))).toBe(false)
    expect(readFileSync(join(asideDir, 'account.json'), 'utf8')).toBe('this mac’s account')
  })

  it('changes nothing if a restored file is missing', () => {
    current()
    const asideDir = join(profile, 'before-restore-x')
    expect(() =>
      applyRestore({
        profileDir: profile,
        stagingDir: staged(['mail.sqlite']),
        asideDir,
        manifest: manifestOf(['mail.sqlite', 'money.sqlite']),
        keepAccount: true,
      }),
    ).toThrow(/money.sqlite/)
    expect(readFileSync(join(profile, 'mail.sqlite'), 'utf8')).toBe('old mail')
    expect(existsSync(asideDir)).toBe(false)
  })

  it('undoes every move if one fails part way', () => {
    current()
    const stagingDir = staged(['mail.sqlite', 'settings.json'])
    const asideDir = join(profile, 'before-restore-x')
    let calls = 0
    // The sixth rename (the first restored file going in) fails, as a full disk or a lock would.
    const rename = (from: string, to: string) => {
      if (++calls === 6) throw new Error('EIO: simulated failure')
      renameSync(from, to)
    }
    expect(() =>
      applyRestore({
        profileDir: profile,
        stagingDir,
        asideDir,
        manifest: manifestOf(['mail.sqlite', 'settings.json']),
        keepAccount: true,
        rename,
      }),
    ).toThrow(/simulated/)
    expect(readFileSync(join(profile, 'mail.sqlite'), 'utf8')).toBe('old mail')
    expect(readFileSync(join(profile, 'mail.sqlite-wal'), 'utf8')).toBe('old wal')
    expect(readFileSync(join(profile, 'calendar.sqlite'), 'utf8')).toBe('old calendar')
    expect(readFileSync(join(profile, 'settings.json'), 'utf8')).toBe('old settings')
    expect(readdirSync(stagingDir).sort()).toEqual(['mail.sqlite', 'settings.json'])
  })

  it('refuses to reuse an existing aside folder', () => {
    current()
    const asideDir = join(profile, 'before-restore-x')
    mkdirSync(asideDir)
    expect(() =>
      applyRestore({
        profileDir: profile,
        stagingDir: staged(['mail.sqlite']),
        asideDir,
        manifest: manifestOf(['mail.sqlite']),
        keepAccount: true,
      }),
    ).toThrow(/already exists/)
  })

  it('writes a marker before moving anything, and removes it when done or fully undone', () => {
    current()
    const marker = join(profile, RESTORE_MARKER)
    const seen: boolean[] = []
    const rename = (from: string, to: string) => {
      seen.push(existsSync(marker))
      renameSync(from, to)
    }
    const asideDir = join(profile, 'before-restore-x')
    applyRestore({
      profileDir: profile,
      stagingDir: staged(['mail.sqlite']),
      asideDir,
      manifest: manifestOf(['mail.sqlite']),
      keepAccount: true,
      rename,
    })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(Boolean)).toBe(true)
    expect(existsSync(marker)).toBe(false)
  })

  /**
   * Run a restore that "crashes" at the nth rename: that rename and every one after it fail, as
   * if the process had died, so nothing is undone and the marker is left behind.
   */
  function crashAt(n: number) {
    current()
    const stagingDir = staged(['mail.sqlite', 'settings.json'])
    const asideDir = join(profile, 'before-restore-x')
    let calls = 0
    const rename = (from: string, to: string) => {
      if (++calls >= n) throw new Error('process died')
      renameSync(from, to)
    }
    expect(() =>
      applyRestore({
        profileDir: profile,
        stagingDir,
        asideDir,
        manifest: manifestOf(['mail.sqlite', 'settings.json']),
        keepAccount: true,
        rename,
      }),
    ).toThrow(/process died/)
    expect(existsSync(join(profile, RESTORE_MARKER))).toBe(true)
    return { stagingDir, asideDir }
  }

  const expectAsBefore = () => {
    expect(readFileSync(join(profile, 'mail.sqlite'), 'utf8')).toBe('old mail')
    expect(readFileSync(join(profile, 'mail.sqlite-wal'), 'utf8')).toBe('old wal')
    expect(readFileSync(join(profile, 'mail.sqlite-shm'), 'utf8')).toBe('old shm')
    expect(readFileSync(join(profile, 'calendar.sqlite'), 'utf8')).toBe('old calendar')
    expect(readFileSync(join(profile, 'settings.json'), 'utf8')).toBe('old settings')
    expect(readFileSync(join(profile, 'account.json'), 'utf8')).toBe('this mac’s account')
    expect(existsSync(join(profile, RESTORE_MARKER))).toBe(false)
  }

  // Renames 1-5 move the current files aside; 6 and 7 move the restored ones in.
  it.each([
    ['while moving the current data aside', 3],
    ['before any restored file went in', 6],
    ['with some restored files in', 7],
  ])('after a crash %s, the next launch puts everything back', (_when, n) => {
    const { stagingDir, asideDir } = crashAt(n)
    expect(recoverRestore(profile)).toEqual({ outcome: 'rolled-back', aside: asideDir })
    expectAsBefore()
    // The restored copies are dropped (the backup file still has them), and the empty folder too.
    expect(existsSync(stagingDir)).toBe(false)
    expect(existsSync(asideDir)).toBe(false)
  })

  it('after a crash with every file moved, the next launch finishes the restore', () => {
    current()
    const marker = join(profile, RESTORE_MARKER)
    let saved = ''
    const rename = (from: string, to: string) => {
      saved ||= readFileSync(marker, 'utf8')
      renameSync(from, to)
    }
    const stagingDir = staged(['mail.sqlite', 'settings.json'])
    const asideDir = join(profile, 'before-restore-x')
    applyRestore({
      profileDir: profile,
      stagingDir,
      asideDir,
      manifest: manifestOf(['mail.sqlite', 'settings.json']),
      keepAccount: true,
      rename,
    })
    // As if it died just before removing the marker (and the staging folder).
    writeFileSync(marker, saved)
    mkdirSync(stagingDir)
    expect(recoverRestore(profile)).toEqual({ outcome: 'finished', aside: asideDir })
    expect(readFileSync(join(profile, 'mail.sqlite'), 'utf8')).toBe('restored mail.sqlite')
    expect(readFileSync(join(asideDir, 'mail.sqlite'), 'utf8')).toBe('old mail')
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(stagingDir)).toBe(false)
  })

  it('does nothing without a marker, and moves nothing for one it can’t read', () => {
    current()
    expect(recoverRestore(profile)).toBeNull()
    writeFileSync(join(profile, RESTORE_MARKER), '{"version":1,"aside":"../../elsewhere"}')
    expect(recoverRestore(profile)).toEqual({ outcome: 'unreadable' })
    expect(existsSync(join(profile, RESTORE_MARKER))).toBe(false)
    expect(existsSync(join(profile, `${RESTORE_MARKER}.unreadable`))).toBe(true)
    expect(readFileSync(join(profile, 'mail.sqlite'), 'utf8')).toBe('old mail')
  })
})
