/** Backup file names, when one is due, which old ones to remove. Pure: no disk access. */

export const BACKUP_EXTENSION = '.ordobackup'
export const DAY_MS = 24 * 60 * 60 * 1000
export const DEFAULT_KEEP = 7

const pad = (n: number) => String(n).padStart(2, '0')

/** `Ordo-backup-2026-11-23-1402.ordobackup`, in local time; `-2`, `-3`… if that name is taken. */
export function backupFileName(at: Date, taken: ReadonlySet<string> = new Set()): string {
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`
  const base = `Ordo-backup-${stamp}`
  let name = `${base}${BACKUP_EXTENSION}`
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}${BACKUP_EXTENSION}`
  return name
}

const ORDO_NAME = /^Ordo-backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(?:-(\d{1,4}))?\.ordobackup$/

/** Whether a file name is one Ordo gives its backups. Only these are ever pruned. */
export function isOrdoBackupName(name: string): boolean {
  return ORDO_NAME.test(name)
}

/** Sort key: the time in the name, then the `-n` suffix. */
function sortKey(name: string): string {
  const m = ORDO_NAME.exec(name)!
  return `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}-${(m[6] ?? '1').padStart(4, '0')}`
}

/**
 * Which backups to remove so that only the newest `keep` remain. Anything not named like an Ordo
 * backup (your own files, other apps', a renamed copy) is never on the list.
 */
export function backupsToPrune(names: readonly string[], keep: number): string[] {
  const ours = names.filter(isOrdoBackupName).sort((a, b) => sortKey(b).localeCompare(sortKey(a)))
  return ours.slice(Math.max(1, Math.floor(keep)))
}

/** An automatic backup is due when there's never been one, or the last is a day old. */
export function backupDue(lastSuccess: Date | null, now: Date): boolean {
  return !lastSuccess || now.getTime() - lastSuccess.getTime() >= DAY_MS || lastSuccess > now
}

/** Compare `x.y.z` versions (any pre-release suffix ignored): negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .split(/[-+]/)[0]!
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0)
  const [pa, pb] = [parts(a), parts(b)]
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** `before-restore-2026-11-23-140215`: where the data a restore replaced is kept. */
export function beforeRestoreName(at: Date): string {
  return `before-restore-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
}
