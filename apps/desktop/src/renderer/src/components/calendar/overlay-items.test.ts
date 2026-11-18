import { afterEach, describe, expect, it } from 'vitest'
import type { CalendarOverlayItem } from '@ordo/shared'
import { toItems } from './model'

// The tests run in Node, which reads TZ afresh; the renderer's types don't know process.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env
const zone = env['TZ']
afterEach(() => {
  if (zone === undefined) delete env['TZ']
  else env['TZ'] = zone
})

const overlay = (extra: Partial<CalendarOverlayItem> = {}): CalendarOverlayItem => ({
  id: 'boards:c1',
  date: new Date(2026, 10, 18),
  title: 'Fix the gate',
  kind: 'card',
  ...extra,
})

describe('toItems', () => {
  it('draws a single day from its midnight to the next', () => {
    const [item] = toItems([], [overlay()], [])
    expect(item).toMatchObject({ type: 'overlay', allDay: true, key: 'overlay|boards:c1' })
    expect(item!.start).toEqual(new Date(2026, 10, 18))
    expect(item!.end).toEqual(new Date(2026, 10, 19))
  })

  it('draws a range to the day after its last day, like an all-day event', () => {
    const [item] = toItems([], [overlay({ until: new Date(2026, 10, 20) })], [])
    expect(item!.start).toEqual(new Date(2026, 10, 18))
    expect(item!.end).toEqual(new Date(2026, 10, 21))
  })

  it('ignores an end before the start', () => {
    const [item] = toItems([], [overlay({ until: new Date(2026, 10, 10) })], [])
    expect(item!.end).toEqual(new Date(2026, 10, 19))
  })

  it.each(['Pacific/Auckland', 'America/Los_Angeles', 'UTC'])('keeps whole local days in %s', (tz) => {
    env['TZ'] = tz
    const [item] = toItems(
      [],
      [overlay({ date: new Date(2026, 2, 28), until: new Date(2026, 2, 30) })], // across a DST change
      [],
    )
    expect([item!.start.getDate(), item!.start.getHours()]).toEqual([28, 0])
    expect([item!.end.getDate(), item!.end.getHours()]).toEqual([31, 0])
  })
})
