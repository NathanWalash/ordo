// Keeps live calendars (Google) near up to date while Ordo is open: a sync every few minutes with
// jitter, backing off after failures and never before a Retry-After, and soon after the window
// comes back into focus, the computer wakes, or Ordo changes an event. No Electron here.
import { nextPollDelay } from '@ordo/calendar-core/node'

export interface PollResult {
  /** Failed syncs in a row (0 when the last one worked). */
  failures: number
  retryAfterMs?: number
}

export type PokeReason = 'focus' | 'resume' | 'write' | 'shown'

export interface PollerOptions {
  run: () => Promise<PollResult>
  /** Focus and wake don't sync again within this long of the last sync. */
  minGapMs?: number
  /** After a change, wait this long (more changes reset it) before syncing. */
  writeDelayMs?: number
  delay?: (r: PollResult) => number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

export class Poller {
  private timer: unknown = null
  private running: Promise<void> | null = null
  private last = 0
  private stopped = true
  private result: PollResult = { failures: 0 }
  private again = false

  constructor(private o: PollerOptions) {}

  private get now() {
    return (this.o.now ?? Date.now)()
  }

  start(firstInMs = 0): void {
    if (!this.stopped) return
    this.stopped = false
    this.schedule(firstInMs)
  }

  stop(): void {
    this.stopped = true
    this.clear()
  }

  /** When the next sync was last due, for tests and status. */
  get lastRun(): number {
    return this.last
  }

  /** Something happened that makes a sync worth doing soon. */
  poke(reason: PokeReason): void {
    if (this.stopped) return
    if (reason === 'write' || reason === 'shown') return this.schedule(this.o.writeDelayMs ?? 1500)
    // Focus and wake: only if the last sync wasn't just now, and not before a Retry-After.
    if (this.now - this.last < (this.o.minGapMs ?? 30_000)) return
    if (this.result.retryAfterMs && this.now - this.last < this.result.retryAfterMs) return
    this.schedule(0)
  }

  private clear(): void {
    if (this.timer !== null) (this.o.clearTimer ?? clearTimeout)(this.timer as ReturnType<typeof setTimeout>)
    this.timer = null
  }

  private schedule(ms: number): void {
    this.clear()
    if (this.stopped) return
    this.timer = (this.o.setTimer ?? setTimeout)(() => {
      this.timer = null
      void this.tick()
    }, ms)
  }

  private async tick(): Promise<void> {
    if (this.running) {
      // One at a time: run again once this one is done.
      this.again = true
      return
    }
    this.running = (async () => {
      try {
        this.result = await this.o.run()
      } catch {
        this.result = { failures: this.result.failures + 1 }
      } finally {
        this.last = this.now
      }
    })()
    await this.running
    this.running = null
    if (this.stopped) return
    if (this.again) {
      this.again = false
      return this.schedule(this.o.writeDelayMs ?? 1500)
    }
    this.schedule((this.o.delay ?? ((r) => nextPollDelay(r)))(this.result))
  }
}
