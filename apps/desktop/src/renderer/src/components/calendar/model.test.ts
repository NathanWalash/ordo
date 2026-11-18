import { describe, expect, it } from 'vitest'
import { viewTitle } from './model'

describe('viewTitle', () => {
  const nov = new Date(2026, 10, 18)
  const month = { start: new Date(2026, 9, 26), end: new Date(2026, 11, 7) }
  const week = { start: new Date(2026, 10, 16), end: new Date(2026, 10, 23) }

  it('uses the short month when the window is narrow', () => {
    const long = new Date(2026, 10, 1).toLocaleDateString(undefined, { month: 'long' })
    const short = new Date(2026, 10, 1).toLocaleDateString(undefined, { month: 'short' })
    expect(viewTitle('month', nov, month)).toEqual({ month: long, year: '2026' })
    expect(viewTitle('month', nov, month, { short: true })).toEqual({ month: short, year: '2026' })
    expect(viewTitle('week', nov, week, { short: true })).toEqual({ month: short, year: '2026' })
  })
})
