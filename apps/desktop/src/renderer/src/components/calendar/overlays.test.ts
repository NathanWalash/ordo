import { describe, expect, it } from 'vitest'
import type { CalendarOverlayItem } from '@ordo/shared'
import { formatAmount, loadOverlays, OVERLAY_SOURCES, type CalendarOverlaySource } from './overlays'

const item = (id: string, day: number, kind: CalendarOverlayItem['kind'] = 'bill'): CalendarOverlayItem => ({
  id,
  date: new Date(2026, 10, day),
  title: id,
  kind,
})
const range = { start: new Date(2026, 10, 1), end: new Date(2026, 11, 1) }

describe('loadOverlays', () => {
  it('ships with Money and Boards as sources', () => {
    expect(OVERLAY_SOURCES.map((s) => s.id)).toEqual(['money', 'boards'])
  })

  it('keeps a date range that started before the view', async () => {
    const card: CalendarOverlayItem = {
      ...item('trip', 1, 'card'),
      date: new Date(2026, 9, 28),
      until: new Date(2026, 10, 2),
    }
    const ended: CalendarOverlayItem = { ...card, id: 'ended', until: new Date(2026, 9, 30) }
    const sources = [{ id: 'b', name: 'B', load: async () => [card, ended] }]
    expect((await loadOverlays(range, sources)).map((i) => i.id)).toEqual(['trip'])
  })

  it('keeps a range whose last day is the first day of the view', async () => {
    const edge: CalendarOverlayItem = {
      ...item('edge', 1, 'card'),
      date: new Date(2026, 9, 29),
      until: range.start,
    }
    const before: CalendarOverlayItem = { ...edge, id: 'before', until: new Date(2026, 9, 31) }
    const sources = [{ id: 'b', name: 'B', load: async () => [edge, before] }]
    expect((await loadOverlays(range, sources)).map((i) => i.id)).toEqual(['edge'])
  })

  it('returns nothing when there are no sources', async () => {
    expect(await loadOverlays(range, [])).toEqual([])
  })

  it('merges sources by date, drops items outside the range and skips failing sources', async () => {
    const sources: CalendarOverlaySource[] = [
      {
        id: 'a',
        name: 'A',
        load: async () => [
          item('rent', 28),
          item('old', 1),
          { ...item('dec', 1), date: new Date(2026, 11, 1) },
        ],
      },
      {
        id: 'b',
        name: 'B',
        load: async () => {
          throw new Error('offline')
        },
      },
      { id: 'c', name: 'C', load: async () => [item('netflix', 3, 'renewal')] },
    ]
    expect((await loadOverlays(range, sources)).map((i) => i.id)).toEqual(['old', 'netflix', 'rent'])
  })
})

describe('formatAmount', () => {
  it('formats money in its currency', () => {
    expect(formatAmount({ value: 12.5, currency: 'GBP' })).toMatch(/12\.50/)
    expect(formatAmount(undefined)).toBeNull()
  })
})
