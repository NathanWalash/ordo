import { describe, expect, it } from 'vitest'
import { cardsToCalendarItems } from './calendar'
import { dueState, filterCards, isFiltering, matchesFilter, type FilterContext } from './filter'
import type { Card, FieldDef, Label } from './types'

const today = '2026-11-18'

const card = (id: string, extra: Partial<Card> = {}): Card => ({
  id,
  boardId: 'b',
  columnId: 'todo',
  rank: 'V',
  title: id,
  notes: '',
  start: null,
  due: null,
  labelIds: [],
  fields: {},
  archivedAt: null,
  createdAt: '',
  updatedAt: '',
  checklist: { done: 0, total: 0 },
  links: 0,
  ...extra,
})

const labels: Label[] = [
  { id: 'red', boardId: 'b', name: 'Urgent', color: 'red', rank: 'A' },
  { id: 'green', boardId: 'b', name: 'Garden', color: 'green', rank: 'B' },
]
const fields: FieldDef[] = [
  {
    id: 'prio',
    boardId: 'b',
    name: 'Priority',
    type: 'select',
    options: [{ id: 'hi', name: 'High', color: 'red' }],
    showOnCard: true,
    rank: 'A',
  },
  { id: 'who', boardId: 'b', name: 'Owner', type: 'person', options: [], showOnCard: true, rank: 'B' },
]
const ctx: FilterContext = { labels, fields, today, doneColumns: new Set(['done']) }

describe('dueState', () => {
  it('says how urgent a due date is', () => {
    expect(dueState(card('a', { due: '2026-11-17' }), today)).toBe('overdue')
    expect(dueState(card('a', { due: today }), today)).toBe('today')
    expect(dueState(card('a', { due: '2026-11-20' }), today)).toBe('soon')
    expect(dueState(card('a', { due: '2026-12-20' }), today)).toBe('later')
    expect(dueState(card('a'), today)).toBeNull()
    expect(dueState(card('a', { due: '2026-11-01' }), today, true)).toBeNull()
  })
})

describe('matchesFilter', () => {
  const cards = [
    card('Prune roses', { labelIds: ['green'], due: '2026-11-17', notes: 'Use the **secateurs**' }),
    card('Fix gate', { labelIds: ['red'], due: today, fields: { who: 'Sam', prio: 'hi' } }),
    card('Paint shed', { due: '2026-11-24' }),
    card('Café visit', { columnId: 'done', due: '2026-11-01' }),
    card('Someday'),
  ]
  const names = (f: Parameters<typeof filterCards>[1]) => filterCards(cards, f, ctx).map((c) => c.id)

  it('searches title, notes, labels and field values, ignoring case and accents', () => {
    expect(names({ query: 'SECATEURS' })).toEqual(['Prune roses'])
    expect(names({ query: 'garden' })).toEqual(['Prune roses'])
    expect(names({ query: 'high sam' })).toEqual(['Fix gate'])
    expect(names({ query: 'cafe' })).toEqual(['Café visit'])
    expect(names({ query: 'gate roses' })).toEqual([])
  })

  it('filters by any of several labels', () => {
    expect(names({ labelIds: ['red', 'green'] })).toEqual(['Prune roses', 'Fix gate'])
  })

  it('filters by due date, leaving done cards out of overdue', () => {
    expect(names({ due: 'overdue' })).toEqual(['Prune roses'])
    expect(names({ due: 'today' })).toEqual(['Prune roses', 'Fix gate'])
    expect(names({ due: 'week' })).toEqual(['Prune roses', 'Fix gate', 'Paint shed'])
    expect(names({ due: 'dated' })).toHaveLength(4)
    expect(names({ due: 'none' })).toEqual(['Someday'])
  })

  it('filters by a field value', () => {
    expect(names({ field: { fieldId: 'prio', value: 'hi' } })).toEqual(['Fix gate'])
    expect(names({ field: { fieldId: 'who', value: 'sam' } })).toEqual(['Fix gate'])
    expect(names({ field: { fieldId: 'gone', value: 'x' } })).toEqual([])
  })

  it('knows when nothing is filtered', () => {
    expect(isFiltering({})).toBe(false)
    expect(isFiltering({ query: '  ' })).toBe(false)
    expect(isFiltering({ due: 'none' })).toBe(true)
    expect(names({})).toHaveLength(5)
    expect(matchesFilter(cards[0]!, { query: 'roses', labelIds: ['red'] }, ctx)).toBe(false)
  })
})

describe('cardsToCalendarItems', () => {
  it('shows dated cards overlapping the range, leaving out done and archived ones', () => {
    const items = cardsToCalendarItems(
      [
        card('a', { due: '2026-11-20' }),
        card('b', { start: '2026-10-30', due: '2026-11-02' }),
        card('c', { due: '2026-12-02' }),
        card('d', { due: '2026-11-21', columnId: 'done' }),
        card('e', { due: '2026-11-21', archivedAt: '2026-11-01' }),
        card('f'),
      ],
      { boardNames: new Map([['b', 'Home']]), doneColumns: new Set(['done']) },
      { from: '2026-11-01', to: '2026-11-30' },
    )
    expect(items.map((i) => [i.cardId, i.from, i.to, i.boardName])).toEqual([
      ['b', '2026-10-30', '2026-11-02', 'Home'],
      ['a', '2026-11-20', '2026-11-20', 'Home'],
    ])
  })
})
