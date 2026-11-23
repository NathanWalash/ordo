import { describe, expect, it } from 'vitest'
import { backoffMs, SYNC_BACKOFF, SyncSchedule } from './schedule'

const MIN = 60_000

describe('per-account sync backoff', () => {
  it('waits a minute after a failure, doubling, at most half an hour', () => {
    expect(backoffMs(0, 'network')).toBe(0)
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => backoffMs(n, 'network') / MIN)).toEqual([1, 2, 4, 8, 16, 30, 30])
  })

  it('waits the longest at once after a wrong password', () => {
    expect(backoffMs(1, 'auth')).toBe(SYNC_BACKOFF.maxMs)
  })

  it('one failing account never holds up the others', () => {
    const s = new SyncSchedule()
    const accounts = ['icloud', 'work', 'gmail']
    expect(s.due(accounts, 0)).toEqual(accounts)
    s.failed('work', 'network', 'Couldn’t reach Gmail.', 0)
    expect(s.due(accounts, 30_000)).toEqual(['icloud', 'gmail'])
    expect(s.due(accounts, MIN)).toEqual(accounts)
    s.failed('work', 'network', 'Couldn’t reach Gmail.', MIN)
    expect(s.get('work')).toEqual({
      failures: 2,
      retryAt: 3 * MIN,
      last: { kind: 'network', message: 'Couldn’t reach Gmail.', at: MIN },
    })
    expect(s.due(accounts, 2 * MIN)).toEqual(['icloud', 'gmail'])
  })

  it('a manual refresh checks every account, backing off or not', () => {
    const s = new SyncSchedule()
    s.failed('work', 'auth', 'Wrong password', 0)
    expect(s.due(['icloud', 'work'], 1, true)).toEqual(['icloud', 'work'])
  })

  it('a success or a new password starts afresh', () => {
    const s = new SyncSchedule()
    s.failed('work', 'network', 'x', 0)
    s.succeeded('work')
    expect(s.get('work')).toEqual({ failures: 0, retryAt: null, last: null })
    s.failed('work', 'auth', 'x', 0)
    s.reset('work')
    expect(s.due(['work'], 1)).toEqual(['work'])
  })
})
