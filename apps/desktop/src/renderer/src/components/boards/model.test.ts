import { describe, expect, it } from 'vitest'
import type { Column } from '@ordo/boards-core'
import {
  byColumn,
  chipStyle,
  datesLabel,
  suggestTitle,
  toneStyle,
  dayLabel,
  focusTarget,
  fullIndex,
  moveLocally,
  reorder,
  stepTarget,
} from './model'

const col = (id: string): Column => ({ id, boardId: 'b', name: id, rank: id, wipLimit: null, done: false })
const card = (id: string, columnId: string) => ({ id, columnId })

describe('byColumn', () => {
  it('groups in order and keeps empty columns', () => {
    const map = byColumn([col('a'), col('b'), col('c')], [card('1', 'a'), card('2', 'b'), card('3', 'a')])
    expect([...map].map(([k, v]) => [k, v.map((c) => c.id)])).toEqual([
      ['a', ['1', '3']],
      ['b', ['2']],
      ['c', []],
    ])
  })
})

describe('moveLocally', () => {
  const cards = [card('1', 'a'), card('2', 'a'), card('3', 'b'), card('4', 'b')]
  const cols = [col('a'), col('b'), col('c')]
  const view = (list: { id: string; columnId: string }[]) =>
    [...byColumn(cols, list)].map(([k, v]) => `${k}:${v.map((c) => c.id).join('')}`).join(' ')

  it('moves within a column', () => {
    expect(view(moveLocally(cards, '1', 'a', 1))).toBe('a:21 b:34 c:')
    expect(view(moveLocally(cards, '4', 'b', 0))).toBe('a:12 b:43 c:')
  })

  it('moves between columns, including to an empty one and to the end', () => {
    expect(view(moveLocally(cards, '1', 'b', 1))).toBe('a:2 b:314 c:')
    expect(view(moveLocally(cards, '1', 'b', 9))).toBe('a:2 b:341 c:')
    expect(view(moveLocally(cards, '3', 'c', 0))).toBe('a:12 b:4 c:3')
    expect(view(moveLocally(cards, 'nope', 'c', 0))).toBe('a:12 b:34 c:')
  })
})

describe('reorder', () => {
  it('moves an item to an index among the others', () => {
    const items = ['a', 'b', 'c'].map((id) => ({ id }))
    expect(reorder(items, 'a', 2).map((i) => i.id)).toEqual(['b', 'c', 'a'])
    expect(reorder(items, 'c', 0).map((i) => i.id)).toEqual(['c', 'a', 'b'])
    expect(reorder(items, 'b', 99).map((i) => i.id)).toEqual(['a', 'c', 'b'])
  })
})

describe('fullIndex', () => {
  const all = ['a', 'b', 'c', 'd', 'e']
  it('maps a drop among visible cards onto all of them', () => {
    expect(fullIndex(all, ['b', 'd'], 0)).toBe(1)
    expect(fullIndex(all, ['b', 'd'], 1)).toBe(3)
    expect(fullIndex(all, ['b', 'd'], 2)).toBe(4)
    expect(fullIndex(all, all, 5)).toBe(5)
    expect(fullIndex(all, [], 0)).toBe(5)
    expect(fullIndex([], [], 0)).toBe(0)
  })
})

describe('keyboard', () => {
  const columns = [
    { id: 'a', cards: ['1', '2', '3'] },
    { id: 'b', cards: [] },
    { id: 'c', cards: ['4'] },
  ]

  it('steps a card up, down, left and right, stopping at the edges', () => {
    expect(stepTarget(columns, '2', 'up')).toEqual({ columnId: 'a', index: 0 })
    expect(stepTarget(columns, '1', 'up')).toBeNull()
    expect(stepTarget(columns, '3', 'down')).toBeNull()
    expect(stepTarget(columns, '3', 'right')).toEqual({ columnId: 'b', index: 0 })
    expect(stepTarget(columns, '4', 'left')).toEqual({ columnId: 'b', index: 0 })
    expect(stepTarget(columns, '4', 'right')).toBeNull()
    expect(stepTarget(columns, '1', 'left')).toBeNull()
    expect(stepTarget(columns, 'x', 'up')).toBeNull()
  })

  it('moves focus across empty columns', () => {
    expect(focusTarget(columns, '3', 'right')).toBe('4')
    expect(focusTarget(columns, '4', 'left')).toBe('1')
    expect(focusTarget(columns, '1', 'down')).toBe('2')
    expect(focusTarget(columns, '1', 'up')).toBeNull()
  })
})

describe('dates', () => {
  const today = '2026-11-18'
  it('says days the way people do', () => {
    expect(dayLabel(today, today)).toBe('Today')
    expect(dayLabel('2026-11-19', today)).toBe('Tomorrow')
    expect(dayLabel('2026-11-17', today)).toBe('Yesterday')
    expect(dayLabel('2026-11-20', today)).toBe('Friday')
    expect(dayLabel('2026-12-20', today)).toBe('20 Dec')
    expect(dayLabel('2027-02-03', today)).toBe('3 Feb 2027')
  })

  it('shows ranges compactly', () => {
    expect(datesLabel({ start: '2026-11-18', due: '2026-11-20' }, today)).toBe('18 – 20 Nov')
    expect(datesLabel({ start: '2026-11-28', due: '2026-12-02' }, today)).toBe('28 Nov – 2 Dec')
    expect(datesLabel({ start: null, due: null }, today)).toBeNull()
  })
})

describe('colours', () => {
  it('mixes coloured text towards the ink by a per-theme amount, for contrast', () => {
    expect(chipStyle('red').color).toBe('color-mix(in srgb, var(--label-red) var(--chip-mix), var(--ink))')
    expect(toneStyle('var(--danger)').color).toBe(
      'color-mix(in srgb, var(--danger) var(--chip-mix), var(--ink))',
    )
    expect(toneStyle('var(--danger)', 12).background).toContain('12%')
  })
})

describe('suggestTitle', () => {
  const local = { label: 'LM Studio', kind: 'local' as const }
  const cloud = { label: 'Claude Code CLI', kind: 'cloud' as const, vendor: 'Anthropic' }

  it('says what goes where before anything is sent', () => {
    expect(suggestTitle({ ready: true, provider: local, sends: ['event', 'card'] })).toBe(
      'Asks LM Studio on this computer about this card, with related upcoming events and other cards.',
    )
    expect(suggestTitle({ ready: true, provider: cloud, sends: ['event', 'bill', 'email', 'card'] })).toBe(
      'Sends this card, with related upcoming events, bills, email subjects and other cards, to Anthropic through Claude Code CLI.',
    )
  })

  it("says why it can't run", () => {
    expect(
      suggestTitle({
        ready: false,
        error: 'off',
        message: 'Turn on AI for Boards in Settings → AI first.',
        provider: local,
        sends: [],
      }),
    ).toBe('Turn on AI for Boards in Settings → AI first.')
    expect(suggestTitle(null)).toMatch(/Suggest/)
  })
})
