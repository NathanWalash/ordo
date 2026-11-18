import { describe, expect, it } from 'vitest'
import {
  CALENDAR_IPC,
  CreateEventSchema,
  DateRangeSchema,
  DeleteEventSchema,
  EventDraftSchema,
  EventRefSchema,
  SetVisibleSchema,
  UpdateEventSchema,
} from './calendar'
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

describe('event changes from the renderer', () => {
  const draft = {
    title: 'Dentist',
    allDay: false,
    start: '2026-11-20T09:00',
    end: '2026-11-20T10:00',
    timeZone: 'Europe/London',
    location: '',
    notes: '',
    repeat: null,
    alert: 15,
  }
  const ref = { calendarId: 'https://cal.example/home/', uid: 'abc' }

  it('accepts well-formed changes', () => {
    expect(CreateEventSchema.safeParse({ calendarId: ref.calendarId, draft }).success).toBe(true)
    expect(
      UpdateEventSchema.safeParse({
        ref: { ...ref, recurrenceId: '2026-11-20T09:00:00.000Z' },
        draft: { ...draft, repeat: { frequency: 'weekly', until: '2027-01-01' } },
        scope: 'this',
      }).success,
    ).toBe(true)
    expect(DeleteEventSchema.safeParse({ ref, scope: 'all' }).success).toBe(true)
  })

  it('refuses anything else, with the editor’s own wording', () => {
    const bad = (o: object) => EventDraftSchema.safeParse({ ...draft, ...o })
    expect(bad({ end: '2026-11-20T08:00' }).error?.issues[0]?.message).toBe(
      'The event ends before it starts.',
    )
    expect(bad({ timeZone: 'Nowhere/Land' }).error?.issues[0]?.message).toBe(
      'Choose a time zone from the list.',
    )
    expect(bad({ extra: true }).success).toBe(false)
    expect(bad({ repeat: { frequency: 'hourly' } }).success).toBe(false)
    expect(bad({ alert: 99_999 }).success).toBe(false)
    expect(bad({ title: 'x'.repeat(501) }).success).toBe(false)
    expect(DeleteEventSchema.safeParse({ ref, scope: 'future' }).success).toBe(false)
    expect(DeleteEventSchema.safeParse({ ref: { ...ref, uid: '' }, scope: 'all' }).success).toBe(false)
    expect(EventRefSchema.safeParse({ ...ref, href: 'https://elsewhere' }).success).toBe(false)
  })
})
