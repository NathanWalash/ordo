import { describe, expect, it } from 'vitest'
import { agendaTime, formatTime, viewTitle } from './model'

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

const at = (day: number, hour = 0) => new Date(2026, 10, day, hour)

describe('agendaTime', () => {
  const trip = { start: at(16, 10), end: at(18, 15), allDay: false }

  it('shows a multi-day event’s start, then All day, then when it ends', () => {
    expect(agendaTime(trip, at(16))).toBe(formatTime(trip.start))
    expect(agendaTime(trip, at(17))).toBe('All day')
    expect(agendaTime(trip, at(18))).toBe(`Until ${formatTime(trip.end)}`)
  })

  it('an event ending at midnight ends on the day before', () => {
    const late = { start: at(16, 22), end: at(18), allDay: false }
    expect(agendaTime(late, at(17))).toBe(`Until ${formatTime(late.end)}`)
  })

  it('all-day events are All day', () => {
    expect(agendaTime({ start: at(16), end: at(17), allDay: true }, at(16))).toBe('All day')
  })
})
