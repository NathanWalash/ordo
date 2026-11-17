import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'

/** What the lock file says about the process doing writes. */
export interface LockHolder {
  pid: number
  /** Which front end holds it: `app`, `headless` or `mcp`. */
  owner: string
  /** What it's doing, e.g. `scanning your inbox`. */
  task: string
  /** ISO time the lock was taken. */
  since: string
}

export type LockAttempt = { ok: true; release: () => void } | { ok: false; holder: LockHolder | null }

export interface WriteLockOptions {
  owner: string
  /** A lock older than this is treated as abandoned even if its PID is in use again. Default 6 hours. */
  maxAgeMs?: number
  /** For tests. */
  pid?: number
  isAlive?: (pid: number) => boolean
  now?: () => Date
}

/** True when a process with this PID exists (EPERM: it exists but belongs to someone else). */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A half-written lock (between create and write) is only treated as abandoned after this long. */
const UNREADABLE_GRACE_MS = 10_000

function parseHolder(raw: string): LockHolder | null {
  try {
    const h = JSON.parse(raw) as Partial<LockHolder>
    if (typeof h.pid !== 'number' || typeof h.since !== 'string') return null
    return {
      pid: h.pid,
      owner: typeof h.owner === 'string' ? h.owner : 'unknown',
      task: typeof h.task === 'string' ? h.task : '',
      since: h.since,
    }
  } catch {
    return null
  }
}

/**
 * A cross-process lock for writes, held in a file (`ordo-write.lock`) created with O_EXCL.
 *
 * Only one process at a time scans, syncs, cleans up, imports or sorts. Inside one process the
 * lock is re-entrant (a count), so the app can still sync the calendar while it scans mail; the
 * existing in-process guards keep those from overlapping with themselves. A lock whose process
 * has gone (crash, kill) or that is older than `maxAgeMs` is stale and taken over.
 */
export class WriteLock {
  private depth = 0
  private readonly pid: number
  private readonly isAlive: (pid: number) => boolean
  private readonly now: () => Date
  private readonly maxAgeMs: number

  constructor(
    readonly file: string,
    private readonly options: WriteLockOptions,
  ) {
    this.pid = options.pid ?? process.pid
    this.isAlive = options.isAlive ?? processAlive
    this.now = options.now ?? (() => new Date())
    this.maxAgeMs = options.maxAgeMs ?? 6 * 60 * 60 * 1000
  }

  /** Whether this process holds the lock right now. */
  get held(): boolean {
    return this.depth > 0
  }

  /** Who holds the lock, if anyone (including this process). */
  holder(): LockHolder | null {
    const raw = this.readRaw()
    return raw === null ? null : parseHolder(raw)
  }

  tryAcquire(task: string): LockAttempt {
    if (this.depth > 0) {
      this.depth++
      return { ok: true, release: this.releaser() }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.create(task)) {
        this.depth = 1
        return { ok: true, release: this.releaser() }
      }
      const raw = this.readRaw()
      if (raw === null) continue // released in the meantime
      const holder = parseHolder(raw)
      if (!this.isStale(holder)) return { ok: false, holder }
      // Take over an abandoned lock, unless it changed since we looked at it.
      if (this.readRaw() === raw) rmSync(this.file, { force: true })
    }
    return { ok: false, holder: this.holder() }
  }

  /** Remove the lock file if this process holds it, whatever the count. For process exit. */
  releaseAll(): void {
    if (this.depth === 0) return
    this.depth = 0
    this.removeIfOurs()
  }

  private create(task: string): boolean {
    let fd: number
    try {
      fd = openSync(this.file, 'wx', 0o600)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw err
    }
    try {
      const holder: LockHolder = {
        pid: this.pid,
        owner: this.options.owner,
        task,
        since: this.now().toISOString(),
      }
      writeSync(fd, JSON.stringify(holder))
    } finally {
      closeSync(fd)
    }
    return true
  }

  private isStale(holder: LockHolder | null): boolean {
    if (!holder) {
      // Unreadable: another process may be between creating and writing it.
      try {
        return this.now().getTime() - statSync(this.file).mtimeMs > UNREADABLE_GRACE_MS
      } catch {
        return true
      }
    }
    // Our own PID while we hold nothing: left over from an earlier process that had this PID.
    if (holder.pid === this.pid) return true
    if (!this.isAlive(holder.pid)) return true
    const since = Date.parse(holder.since)
    return !Number.isFinite(since) || this.now().getTime() - since > this.maxAgeMs
  }

  private releaser(): () => void {
    let released = false
    return () => {
      if (released || this.depth === 0) return
      released = true
      if (--this.depth === 0) this.removeIfOurs()
    }
  }

  private removeIfOurs(): void {
    if (this.holder()?.pid === this.pid) rmSync(this.file, { force: true })
  }

  private readRaw(): string | null {
    try {
      return readFileSync(this.file, 'utf8')
    } catch {
      return null
    }
  }
}

const OWNERS: Record<string, string> = {
  app: 'another Ordo window',
  headless: 'a headless Ordo command',
  mcp: 'an AI agent using Ordo',
}

/** The message shown when another process holds the lock. */
export function busyMessage(holder: LockHolder | null): string {
  const who = (holder && OWNERS[holder.owner]) ?? 'another Ordo window or agent'
  // The task is our own text, but the file is on disk: keep it short and printable.
  const task = holder?.task.replace(/[^\p{L}\p{N} '’-]/gu, '').slice(0, 60)
  return `Ordo is busy in ${who}${task ? ` (${task})` : ''}. Try again when it finishes.`
}
