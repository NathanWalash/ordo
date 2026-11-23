import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Poller, type PollResult } from './poller'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})
afterEach(() => vi.useRealTimers())

function poller(results: PollResult[] = []) {
  const runs: number[] = []
  const p = new Poller({
    run: async () => {
      runs.push(Date.now())
      return results.shift() ?? { failures: 0 }
    },
    delay: (r) => (r.retryAfterMs ?? 0) + 180_000 * 2 ** r.failures,
  })
  return { p, runs }
}

describe('Poller', () => {
  it('syncs at start, then every few minutes', async () => {
    const { p, runs } = poller()
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(180_000 * 2)
    expect(runs).toEqual([0, 180_000, 360_000])
    p.stop()
    await vi.advanceTimersByTimeAsync(10 * 180_000)
    expect(runs).toHaveLength(3)
  })

  it('backs off after failures, and honours Retry-After', async () => {
    const { p, runs } = poller([{ failures: 1 }, { failures: 2, retryAfterMs: 1000 }])
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(360_000)
    expect(runs).toEqual([0, 360_000])
    await vi.advanceTimersByTimeAsync(720_000)
    expect(runs).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(runs).toEqual([0, 360_000, 1_081_000])
  })

  it('syncs on focus or wake, but not twice within half a minute', async () => {
    const { p, runs } = poller()
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    p.poke('focus')
    await vi.advanceTimersByTimeAsync(0)
    expect(runs).toEqual([0])
    await vi.advanceTimersByTimeAsync(40_000)
    p.poke('resume')
    await vi.advanceTimersByTimeAsync(0)
    expect(runs).toEqual([0, 40_000])
    // And the regular schedule restarts from there.
    await vi.advanceTimersByTimeAsync(180_000)
    expect(runs).toEqual([0, 40_000, 220_000])
  })

  it('doesn’t sync on focus before the server’s Retry-After', async () => {
    const { p, runs } = poller([{ failures: 1, retryAfterMs: 600_000 }])
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(60_000)
    p.poke('focus')
    await vi.advanceTimersByTimeAsync(0)
    expect(runs).toEqual([0])
  })

  it('syncs shortly after a change, once for several changes', async () => {
    const { p, runs } = poller()
    p.start(60_000)
    p.poke('write')
    await vi.advanceTimersByTimeAsync(1000)
    p.poke('write')
    await vi.advanceTimersByTimeAsync(1500)
    expect(runs).toEqual([2500])
  })

  it('counts a run that throws as a failure', async () => {
    let n = 0
    const p = new Poller({
      run: async () => {
        n++
        throw new Error('boom')
      },
      delay: (r) => r.failures * 1000,
    })
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(2000)
    expect(n).toBe(3)
    p.stop()
  })
})
