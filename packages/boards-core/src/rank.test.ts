import { describe, expect, it } from 'vitest'
import {
  MAX_RANK_LENGTH,
  evenRanks,
  isRank,
  planMove,
  rankAfter,
  rankBetween,
  sortByRank,
  type Ranked,
} from './rank'

/** A tiny seeded generator, so a failing random case can be replayed. */
function random(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const sorted = (xs: string[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

describe('rankBetween', () => {
  it('gives a middle rank for an empty list', () => {
    expect(rankBetween(null, null)).toBe('V')
  })

  it('finds a rank strictly between two ranks', () => {
    for (const [a, b] of [
      ['A', 'B'],
      ['A', 'A1'],
      ['1', '2'],
      ['V', 'W'],
      ['z', 'zz'],
      ['0V', '1'],
      ['abc', 'abd'],
      ['y', 'z'],
    ] as const) {
      const r = rankBetween(a, b)
      expect(isRank(r)).toBe(true)
      expect(a < r && r < b, `${a} < ${r} < ${b}`).toBe(true)
    }
  })

  it('finds room at both ends', () => {
    expect(rankBetween(null, '1') < '1').toBe(true)
    expect(rankBetween('z', null) > 'z').toBe(true)
    expect(rankBetween(null, '01') < '01').toBe(true)
    expect(rankAfter('zzz') > 'zzz').toBe(true)
    expect(rankAfter(null)).toBe('V')
  })

  it('never ends in the zero digit, so there is always room again', () => {
    let lo: string | null = null
    let hi: string | null = '1'
    for (let i = 0; i < 200; i++) {
      const r = rankBetween(lo, hi)
      expect(r.endsWith('0')).toBe(false)
      if (i % 2) lo = r
      else hi = r
    }
  })

  it('refuses bad or out-of-order input', () => {
    expect(() => rankBetween('B', 'A')).toThrow(RangeError)
    expect(() => rankBetween('A', 'A')).toThrow(RangeError)
    expect(() => rankBetween('A0', null)).toThrow(RangeError)
    expect(() => rankBetween('a-b', null)).toThrow(RangeError)
    expect(() => rankBetween('', null)).toThrow(RangeError)
  })

  it('stays short when always adding at the end or the start', () => {
    const appended: string[] = []
    for (let i = 0; i < 1000; i++) appended.push(rankBetween(appended.at(-1) ?? null, null))
    expect(Math.max(...appended.map((r) => r.length))).toBeLessThanOrEqual(2)
    expect(sorted(appended)).toEqual(appended)
    const prepended: string[] = []
    for (let i = 0; i < 1000; i++) prepended.unshift(rankBetween(null, prepended[0] ?? null))
    expect(Math.max(...prepended.map((r) => r.length))).toBeLessThanOrEqual(2)
    expect(sorted(prepended)).toEqual(prepended)
    // Far past the end of the alphabet it still works, just longer.
    let last: string | null = 'zz'
    for (let i = 0; i < 100; i++) {
      const r = rankBetween(last, null)
      expect(r > last!).toBe(true)
      last = r
    }
    let first: string | null = '01'
    for (let i = 0; i < 100; i++) {
      const r = rankBetween(null, first)
      expect(r < first! && isRank(r)).toBe(true)
      first = r
    }
    expect(first!.length).toBeLessThanOrEqual(MAX_RANK_LENGTH)
  })

  it('keeps a list in order through thousands of random inserts', () => {
    const next = random(42)
    const list: string[] = []
    for (let i = 0; i < 3000; i++) {
      const at = Math.floor(next() * (list.length + 1))
      const r = rankBetween(list[at - 1] ?? null, list[at] ?? null)
      list.splice(at, 0, r)
    }
    expect(sorted(list)).toEqual(list)
    expect(new Set(list).size).toBe(list.length)
  })
})

describe('evenRanks', () => {
  it('spaces ranks evenly in ascending order, with no zero at the end', () => {
    for (const n of [1, 2, 5, 61, 62, 100, 4000]) {
      const r = evenRanks(n)
      expect(r).toHaveLength(n)
      expect(sorted(r)).toEqual(r)
      expect(new Set(r).size).toBe(n)
      for (const x of r) expect(isRank(x)).toBe(true)
    }
  })

  it('uses one digit for small lists', () => {
    expect(evenRanks(3).every((r) => r.length === 1)).toBe(true)
    expect(evenRanks(0)).toEqual([])
    expect(evenRanks(-1)).toEqual([])
  })
})

describe('planMove', () => {
  const items = (...ranks: string[]): Ranked[] => ranks.map((rank, i) => ({ id: `i${i}`, rank }))
  const order = (list: Ranked[], plan: { updates: Ranked[] }, extra?: Ranked) => {
    const map = new Map(list.map((i) => [i.id, i.rank]))
    if (extra) map.set(extra.id, extra.rank)
    for (const u of plan.updates) map.set(u.id, u.rank)
    return sortByRank([...map].map(([id, rank]) => ({ id, rank }))).map((i) => i.id)
  }

  it('moves an item within a list by changing only that item', () => {
    const list = items('A', 'B', 'C', 'D')
    const plan = planMove(list, 'i0', 2)
    expect(plan.updates).toHaveLength(1)
    expect(order(list, plan)).toEqual(['i1', 'i2', 'i0', 'i3'])
  })

  it('moves to the start and the end, clamping the index', () => {
    const list = items('A', 'B', 'C')
    expect(order(list, planMove(list, 'i2', 0))).toEqual(['i2', 'i0', 'i1'])
    expect(order(list, planMove(list, 'i0', 99))).toEqual(['i1', 'i2', 'i0'])
    expect(order(list, planMove(list, 'i1', -5))).toEqual(['i1', 'i0', 'i2'])
    expect(order(list, planMove(list, 'i1', Number.NaN))).toEqual(['i0', 'i2', 'i1'])
  })

  it('places an item coming from another list', () => {
    const list = items('A', 'B')
    const plan = planMove(list, 'new', 1)
    expect(order(list, plan, { id: 'new', rank: plan.rank })).toEqual(['i0', 'new', 'i1'])
    expect(planMove([], 'new', 0).rank).toBe('V')
  })

  it('renumbers a list whose ranks are broken', () => {
    const list = [
      { id: 'a', rank: 'B' },
      { id: 'b', rank: 'B' },
      { id: 'c', rank: 'not a rank!' },
    ]
    const plan = planMove(list, 'x', 1)
    const final = order(list, plan, { id: 'x', rank: plan.rank })
    expect(final[1]).toBe('x')
    expect(plan.updates.length).toBeGreaterThan(1)
    for (const u of plan.updates) expect(isRank(u.rank)).toBe(true)
  })

  it('renumbers once ranks grow too long', () => {
    // Squeeze 300 items between the same two neighbours.
    let list: Ranked[] = [
      { id: 'top', rank: 'A' },
      { id: 'bottom', rank: 'B' },
    ]
    let renumbered = false
    for (let i = 0; i < 300; i++) {
      const plan = planMove(list, `n${i}`, 1)
      if (plan.updates.length > 1) renumbered = true
      const map = new Map(list.map((x) => [x.id, x.rank]))
      map.set(`n${i}`, plan.rank)
      for (const u of plan.updates) map.set(u.id, u.rank)
      list = sortByRank([...map].map(([id, rank]) => ({ id, rank })))
      expect(list[1]!.id).toBe(`n${i}`)
      for (const x of list) expect(x.rank.length).toBeLessThanOrEqual(MAX_RANK_LENGTH)
    }
    expect(renumbered).toBe(true)
    expect(list[0]!.id).toBe('top')
    expect(list.at(-1)!.id).toBe('bottom')
  })

  it('matches a plain array move for random moves', () => {
    const next = random(7)
    let list: Ranked[] = evenRanks(20).map((rank, i) => ({ id: `c${i}`, rank }))
    let model = list.map((i) => i.id)
    for (let step = 0; step < 2000; step++) {
      const id = model[Math.floor(next() * model.length)]!
      const to = Math.floor(next() * model.length)
      const plan = planMove(list, id, to)
      const map = new Map(list.map((x) => [x.id, x.rank]))
      for (const u of plan.updates) map.set(u.id, u.rank)
      list = sortByRank([...map].map(([i, rank]) => ({ id: i, rank })))
      model = model.filter((x) => x !== id)
      model.splice(to, 0, id)
      expect(list.map((x) => x.id)).toEqual(model)
    }
  })
})
