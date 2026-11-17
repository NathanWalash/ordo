import { join } from 'node:path'
import { app, type WebContents } from 'electron'
import { busyMessage, WriteLock } from './lock'

export type WriteOwner = 'app' | 'headless' | 'mcp'

let lock: WriteLock | null = null
let owner: WriteOwner = 'app'

/** Say which front end this process is. Call once at start-up, before any write. */
export function setWriteOwner(o: WriteOwner): void {
  owner = o
}

const writeLock = () => (lock ??= new WriteLock(join(app.getPath('userData'), 'ordo-write.lock'), { owner }))

/** Returned instead of running a write when another Ordo process is writing. */
export class Locked {
  constructor(readonly message: string) {}
}

/**
 * Run a write (scan, sync, clean-up, undo, import, AI sort) while holding the cross-process
 * lock, so the app and a headless Ordo never change the same data at once.
 */
export async function withWriteLock<T>(task: string, fn: () => Promise<T>): Promise<T | Locked> {
  const got = writeLock().tryAcquire(task)
  if (!got.ok) return new Locked(busyMessage(got.holder))
  try {
    return await fn()
  } finally {
    got.release()
  }
}

/** Drop the lock on the way out, even if a write was interrupted. */
export function releaseWriteLock(): void {
  lock?.releaseAll()
}

/** A progress callback that forwards to a window, for the IPC adapters. */
export function toRenderer<T>(sender: WebContents, channel: string): (p: T) => void {
  return (p) => {
    if (!sender.isDestroyed()) sender.send(channel, p)
  }
}
