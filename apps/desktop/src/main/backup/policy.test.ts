import { describe, expect, it } from 'vitest'
import {
  DAY_MS,
  backupDue,
  backupFileName,
  backupsToPrune,
  beforeRestoreName,
  compareVersions,
  isOrdoBackupName,
} from './policy'

describe('backup names', () => {
  it('names a backup by its local date and time', () => {
    const at = new Date(2026, 10, 3, 9, 5)
    expect(backupFileName(at)).toBe('Ordo-backup-2026-11-03-0905.ordobackup')
  })

  it('adds a number when that minute is taken', () => {
    const at = new Date(2026, 10, 3, 9, 5)
    const taken = new Set([
      'Ordo-backup-2026-11-03-0905.ordobackup',
      'Ordo-backup-2026-11-03-0905-2.ordobackup',
    ])
    expect(backupFileName(at, taken)).toBe('Ordo-backup-2026-11-03-0905-3.ordobackup')
  })

  it('recognises only the names Ordo gives its backups', () => {
    expect(isOrdoBackupName('Ordo-backup-2026-11-03-0905.ordobackup')).toBe(true)
    expect(isOrdoBackupName('Ordo-backup-2026-11-03-0905-12.ordobackup')).toBe(true)
    for (const name of [
      'Ordo-backup-2026-11-03-0905.ordobackup.partial',
      'Ordo-backup-2026-11-03-0905 copy.ordobackup',
      'ordo-backup-2026-11-03-0905.ordobackup',
      'Ordo-backup-2026-11-03.ordobackup',
      'my-backup.ordobackup',
      'Ordo-backup-2026-11-03-0905.zip',
      '../Ordo-backup-2026-11-03-0905.ordobackup',
      'Tax return 2025.pdf',
    ])
      expect(isOrdoBackupName(name)).toBe(false)
  })

  it('names the folder a restore moves the old data into', () => {
    expect(beforeRestoreName(new Date(2026, 0, 2, 3, 4, 5))).toBe('before-restore-2026-01-02-030405')
  })
})

describe('pruning', () => {
  const ours = (d: number, suffix = '') =>
    `Ordo-backup-2026-11-${String(d).padStart(2, '0')}-1200${suffix}.ordobackup`

  it('keeps the newest N and lists the rest, oldest last', () => {
    const names = [1, 5, 3, 2, 4].map((d) => ours(d))
    expect(backupsToPrune(names, 3)).toEqual([ours(2), ours(1)])
  })

  it('never lists files Ordo did not name, however old they look', () => {
    const names = [
      ours(1),
      ours(2),
      ours(3),
      'Ordo-backup-2020-01-01-0000 copy.ordobackup',
      'Ordo-backup-2020-01-01-0000.ordobackup.partial',
      'holiday.jpg',
      'Ordo-backup-2020-01-01-0000.txt',
    ]
    expect(backupsToPrune(names, 1)).toEqual([ours(2), ours(1)])
  })

  it('orders same-minute backups by their number', () => {
    const names = [ours(1), ours(1, '-2'), ours(1, '-10')]
    expect(backupsToPrune(names, 1)).toEqual([ours(1, '-2'), ours(1)])
  })

  it('always keeps at least one, and nothing to do under the limit', () => {
    expect(backupsToPrune([ours(1), ours(2)], 0)).toEqual([ours(1)])
    expect(backupsToPrune([ours(1), ours(2)], 7)).toEqual([])
    expect(backupsToPrune([], 7)).toEqual([])
  })
})

describe('when a backup is due', () => {
  const now = new Date('2026-11-23T12:00:00Z')
  it('is due with no backup yet, or after a day', () => {
    expect(backupDue(null, now)).toBe(true)
    expect(backupDue(new Date(now.getTime() - DAY_MS), now)).toBe(true)
    expect(backupDue(new Date(now.getTime() - DAY_MS + 60_000), now)).toBe(false)
  })
  it('is due if the last backup is in the future (the clock was wrong)', () => {
    expect(backupDue(new Date(now.getTime() + DAY_MS), now)).toBe(true)
  })
})

describe('compareVersions', () => {
  it('compares x.y.z numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(0)
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0)
  })
})
