import { describe, expect, it } from 'vitest'
import { agendaTime, formatTime } from './model'

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
