import { describe, expect, it } from 'vitest'
import { daysIn, layoutDay, onDay, segments, startOfWeek, step, visibleRange, type Span } from './grid'

const d = (month: number, day: number, hour = 0, minute = 0) => new Date(2026, month - 1, day, hour, minute)
const timed = (id: string, start: Date, end: Date) => ({ id, start, end, allDay: false })
const allDay = (id: string, start: Date, end: Date) => ({ id, start, end, allDay: true })
const ids = (xs: { id: string }[]) => xs.map((x) => x.id)

describe('startOfWeek', () => {
  it('honours the locale’s first day of the week', () => {
    // Tuesday 17 November 2026.
    expect(startOfWeek(d(11, 17, 15), 1)).toEqual(d(11, 16))
    expect(startOfWeek(d(11, 17, 15), 0)).toEqual(d(11, 15))
    expect(startOfWeek(d(11, 16), 1)).toEqual(d(11, 16))
    expect(startOfWeek(d(11, 15), 1)).toEqual(d(11, 9))
  })
})

describe('visibleRange', () => {
  it('covers whole weeks around the month', () => {
    // November 2026 starts on a Sunday and ends on a Monday.
    expect(visibleRange('month', d(11, 17), 1)).toEqual({ start: d(10, 26), end: d(12, 7) })
    expect(daysIn(visibleRange('month', d(11, 17), 1))).toHaveLength(42)
    expect(visibleRange('month', d(11, 17), 0)).toEqual({ start: d(11, 1), end: d(12, 6) })
    // February 2026 fits exactly in four Sunday-first weeks.
    expect(daysIn(visibleRange('month', d(2, 10), 0))).toHaveLength(28)
  })

  it('gives the week containing the cursor, or the month for the agenda', () => {
    expect(visibleRange('week', d(11, 17), 1)).toEqual({ start: d(11, 16), end: d(11, 23) })
    expect(visibleRange('agenda', d(11, 17), 1)).toEqual({ start: d(11, 1), end: d(12, 1) })
  })
})

describe('step', () => {
  it('moves by a week or a month without skipping short months', () => {
    expect(step('week', d(11, 17), 1)).toEqual(d(11, 24))
    expect(step('month', new Date(2026, 0, 31), 1)).toEqual(d(2, 1))
    expect(step('agenda', d(1, 15), -1)).toEqual(new Date(2025, 11, 1))
  })
})

describe('daysIn', () => {
  it('lists local days, including across a DST change', () => {
    const days = daysIn({ start: d(3, 28), end: d(4, 1) })
    expect(days.map((x) => x.getDate())).toEqual([28, 29, 30, 31])
    expect(days.every((x) => x.getHours() === 0)).toBe(true)
  })
})

describe('onDay', () => {
  it('finds items touching a day, all-day first', () => {
    const items = [
      timed('late', d(11, 17, 20), d(11, 17, 21)),
      allDay('trip', d(11, 16), d(11, 19)),
      timed('overnight', d(11, 16, 22), d(11, 17, 1)),
      timed('tomorrow', d(11, 18, 0), d(11, 18, 1)),
    ]
    expect(ids(onDay(items, d(11, 17)))).toEqual(['trip', 'overnight', 'late'])
  })
})

describe('segments', () => {
  const week = d(11, 16)
  it('places multi-day bars in shared lanes and marks clipped ends', () => {
    const items: (Span & { id: string })[] = [
      allDay('trip', d(11, 13), d(11, 18)), // Fri 13 to Tue 17 inclusive: starts before this row
      allDay('conf', d(11, 18), d(11, 20)), // Wed-Thu
      timed('lunch', d(11, 17, 12), d(11, 17, 13)),
      allDay('holiday', d(11, 22), d(11, 24)), // Sun 22 - Mon 23: carries on into next week
    ]
    const segs = segments(items, week)
    const by = Object.fromEntries(segs.map((s) => [s.item.id, s]))
    expect(by['trip']).toMatchObject({
      col: 0,
      span: 2,
      lane: 0,
      continuesBefore: true,
      continuesAfter: false,
    })
    expect(by['conf']).toMatchObject({ col: 2, span: 2, lane: 0 })
    expect(by['lunch']).toMatchObject({ col: 1, span: 1, lane: 1 })
    expect(by['holiday']).toMatchObject({ col: 6, span: 1, lane: 0, continuesAfter: true })
  })

  it('treats an end at midnight as not covering the next day', () => {
    const [s] = segments([allDay('one', d(11, 17), d(11, 18))], week)
    expect(s).toMatchObject({ col: 1, span: 1 })
  })
})

describe('layoutDay', () => {
  it('positions items in minutes and splits overlapping ones into columns', () => {
    const blocks = layoutDay(
      [
        timed('a', d(11, 17, 9), d(11, 17, 10)),
        timed('b', d(11, 17, 9, 30), d(11, 17, 11)),
        timed('c', d(11, 17, 10), d(11, 17, 10, 30)),
        timed('d', d(11, 17, 14), d(11, 17, 14, 5)),
      ],
      d(11, 17),
    )
    const by = Object.fromEntries(blocks.map((b) => [b.item.id, b]))
    expect(by['a']).toMatchObject({ top: 540, height: 60, column: 0, columns: 2 })
    expect(by['b']).toMatchObject({ top: 570, height: 90, column: 1, columns: 2 })
    // c starts when a ends, so it reuses a's column.
    expect(by['c']).toMatchObject({ top: 600, column: 0, columns: 2 })
    // Short items get a minimum height; separate groups have their own column count.
    expect(by['d']).toMatchObject({ top: 840, height: 15, column: 0, columns: 1 })
  })

  it('clips items that cross midnight', () => {
    const items = [timed('overnight', d(11, 16, 22), d(11, 17, 1))]
    expect(layoutDay(items, d(11, 16))[0]).toMatchObject({ top: 1320, height: 120 })
    expect(layoutDay(items, d(11, 17))[0]).toMatchObject({ top: 0, height: 60 })
  })

  it.each([
    ['Europe/London', 3, 29], // clocks go forward
    ['Europe/London', 10, 25], // and back
    ['America/New_York', 3, 8],
    ['Pacific/Auckland', 4, 5],
  ])('puts events at their clock time on the day the clocks change (%s, %i/%i)', (zone, month, day) => {
    const tz = process.env['TZ']
    process.env['TZ'] = zone
    try {
      const items = [
        timed('a', d(month, day, 9), d(month, day, 10)),
        timed('b', d(month, day, 23), d(month, day + 1)),
      ]
      const [a, b] = layoutDay(items, d(month, day))
      expect(a).toMatchObject({ top: 540, height: 60 })
      expect(b!.top + b!.height).toBe(1440)
    } finally {
      if (tz === undefined) delete process.env['TZ']
      else process.env['TZ'] = tz
    }
  })
})
