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
  it('ships with no sources', async () => {
    expect(OVERLAY_SOURCES).toEqual([])
    expect(await loadOverlays(range)).toEqual([])
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
