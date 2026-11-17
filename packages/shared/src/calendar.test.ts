import { describe, expect, it } from 'vitest'
import { CALENDAR_IPC, DateRangeSchema, SetVisibleSchema } from './calendar'
import { IPC, MODULES } from './index'

describe('calendar contract', () => {
  it('is part of the IPC map and the module list', () => {
    for (const channel of Object.values(CALENDAR_IPC)) expect(Object.values(IPC)).toContain(channel)
    expect(MODULES.map((m) => m.id)).toContain('calendar')
  })

  it('validates ranges and visibility changes from the renderer', () => {
    const start = new Date(2026, 10, 1)
    const end = new Date(2026, 11, 1)
    expect(DateRangeSchema.parse({ start, end })).toEqual({ start, end })
    expect(DateRangeSchema.safeParse({ start: end, end: start }).success).toBe(false)
    expect(DateRangeSchema.safeParse({ start: '2026-11-01', end }).success).toBe(false)
    expect(SetVisibleSchema.safeParse({ calendarId: 'home', visible: false }).success).toBe(true)
    expect(SetVisibleSchema.safeParse({ calendarId: '', visible: false }).success).toBe(false)
  })
})
