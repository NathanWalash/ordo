import { describe, expect, it } from 'vitest'
import type { CalendarEvent, EventDraft } from '@ordo/calendar-core'
import type { CalendarListItem } from '@ordo/shared'
import {
  alertLabel,
  calendarGroups,
  canonicalZone,
  clampDays,
  defaultUntil,
  deleteNote,
  moveDraft,
  newDraft,
  nudged,
  nudgeFor,
  optimisticCreate,
  optimisticDelete,
  optimisticUpdate,
  readOnlyReason,
  snap,
  timeZones,
  toggleAllDay,
  withStart,
  writable,
  zoneCity,
  zoneLabel,
} from './editing'

const RANGE = { start: new Date(2026, 9, 1), end: new Date(2027, 0, 1) }
const draft = (o: Partial<EventDraft> = {}): EventDraft => ({
  title: 'Standup',
  allDay: false,
  start: '2026-11-02T09:00',
  end: '2026-11-02T09:30',
  timeZone: 'Europe/London',
  location: '',
  notes: '',
  repeat: null,
  alert: null,
  ...o,
})
const ev = (o: Partial<CalendarEvent>): CalendarEvent => ({
  uid: 'a',
  calendarId: 'home',
  title: 'A',
  start: new Date('2026-11-02T09:00:00Z'),
  end: new Date('2026-11-02T09:30:00Z'),
  allDay: false,
  ...o,
})
const cal = (o: Partial<CalendarListItem>): CalendarListItem => ({
  id: 'home',
  name: 'Home',
  readOnly: false,
  visible: true,
  source: 'icloud',
  ...o,
})

describe('which calendars can be changed', () => {
  it('only writable iCloud calendars, and says why not', () => {
    expect(writable(cal({}))).toBe(true)
    expect(writable(cal({ readOnly: true }))).toBe(false)
    expect(writable(cal({ source: 'link', readOnly: true }))).toBe(false)
    expect(readOnlyReason(cal({}))).toBeNull()
    expect(readOnlyReason(cal({ source: 'link' }))).toBe(
      'Added by link, so Ordo can’t change its events. Change them where the calendar is published.',
    )
    expect(readOnlyReason(cal({ source: 'file' }))).toMatch(/^Imported from a file/)
    expect(readOnlyReason(cal({ readOnly: true }))).toMatch(/^Shared with you read-only/)
  })

  it('also writable Google calendars, unless shared read-only', () => {
    expect(writable(cal({ source: 'google', account: 'me@work.example' }))).toBe(true)
    expect(writable(cal({ source: 'google', readOnly: true }))).toBe(false)
    expect(readOnlyReason(cal({ source: 'google', readOnly: true }))).toMatch(/^Shared with you read-only/)
  })

  it('says where a delete goes', () => {
    expect(deleteNote(cal({}))).toMatch(/iCloud and all your devices/)
    expect(deleteNote(cal({ source: 'google', account: 'me@work.example' }))).toBe(
      'This deletes it from Google Calendar (me@work.example), everywhere that calendar shows. You can’t undo this.',
    )
  })

  it('groups calendars by account for the editor’s picker, unlabelled when there’s one', () => {
    const home = cal({})
    const work = cal({ id: 'g1', name: 'Work', source: 'google', account: 'me@work.example' })
    const team = cal({ id: 'g2', name: 'Team', source: 'google', account: 'me@work.example' })
    expect(calendarGroups([home, work, team])).toEqual([
      { label: 'iCloud', calendars: [home] },
      { label: 'me@work.example', calendars: [work, team] },
    ])
    expect(calendarGroups([work, team])).toEqual([{ label: '', calendars: [work, team] }])
  })
})

describe('newDraft', () => {
  const now = new Date(2026, 10, 18, 14, 20)
  it('starts at 09:00 on another day and at the next hour today, for an hour', () => {
    expect(newDraft(new Date(2026, 10, 20), { now })).toMatchObject({
      start: '2026-11-20T09:00',
      end: '2026-11-20T10:00',
      allDay: false,
    })
    expect(newDraft(new Date(2026, 10, 18), { now })).toMatchObject({
      start: '2026-11-18T15:00',
      end: '2026-11-18T16:00',
    })
    expect(newDraft(new Date(2026, 10, 18, 23, 0), { now: new Date(2026, 10, 18, 23, 40) })).toMatchObject({
      start: '2026-11-18T23:00',
      end: '2026-11-19T00:00',
    })
  })
  it('uses an exact time slot, or a whole day', () => {
    expect(newDraft(new Date(2026, 10, 20, 13, 30), { exact: true, now })).toMatchObject({
      start: '2026-11-20T13:30',
      end: '2026-11-20T14:30',
    })
    expect(newDraft(new Date(2026, 10, 20), { allDay: true, now })).toMatchObject({
      allDay: true,
      start: '2026-11-20',
      end: '2026-11-20',
      timeZone: null,
    })
  })
})

describe('editor helpers', () => {
  it('keeps the length when the start changes', () => {
    expect(withStart(draft(), '2026-11-03T14:00')).toMatchObject({
      start: '2026-11-03T14:00',
      end: '2026-11-03T14:30',
    })
    const allDay = draft({ allDay: true, start: '2026-11-02', end: '2026-11-04', timeZone: null })
    expect(withStart(allDay, '2026-11-10')).toMatchObject({ start: '2026-11-10', end: '2026-11-12' })
    expect(withStart(draft(), '')).toMatchObject({ start: '', end: '2026-11-02T09:30' })
  })
  it('switches all-day on and back off, keeping the days, times, zone and alert', () => {
    const timed = draft({
      start: '2026-11-02T14:15',
      end: '2026-11-02T15:00',
      alert: 30,
      timeZone: 'Asia/Tokyo',
    })
    const on = toggleAllDay(timed, true, null)
    expect(on.draft).toMatchObject({ allDay: true, start: '2026-11-02', end: '2026-11-02', timeZone: null })
    // An alert stays an alert: the all-day one closest to it.
    expect(on.draft.alert).toBe(900)
    const off = toggleAllDay({ ...on.draft, start: '2026-11-05', end: '2026-11-05' }, false, on.memory, 'UTC')
    expect(off.draft).toMatchObject({
      allDay: false,
      start: '2026-11-05T14:15',
      end: '2026-11-05T15:00',
      timeZone: 'Asia/Tokyo',
      alert: 30,
    })
    // None stays none; without a memory, 09:00 to 10:00 here.
    const fresh = toggleAllDay(
      draft({ allDay: true, start: '2026-11-02', end: '2026-11-03', timeZone: null }),
      false,
      null,
      'Asia/Tokyo',
    )
    expect(fresh.draft).toMatchObject({
      start: '2026-11-02T09:00',
      end: '2026-11-03T10:00',
      timeZone: 'Asia/Tokyo',
      alert: null,
    })
    const allDayAlert = draft({
      allDay: true,
      start: '2026-11-02',
      end: '2026-11-02',
      timeZone: null,
      alert: -540,
    })
    expect(toggleAllDay(allDayAlert, false, null).draft.alert).toBe(1440)
  })
  it('ends a repeat a month on for daily and weekly events, a year on for monthly and yearly', () => {
    expect(defaultUntil('2026-11-02T09:00', 'weekly')).toBe('2026-12-02')
    expect(defaultUntil('2026-11-02', 'daily')).toBe('2026-12-02')
    expect(defaultUntil('2026-01-31', 'daily')).toBe('2026-02-28')
    expect(defaultUntil('2026-11-02T09:00', 'monthly')).toBe('2027-11-02')
    expect(defaultUntil('2028-02-29', 'yearly')).toBe('2029-02-28')
  })
  it('describes any alert in days, hours and minutes', () => {
    expect(alertLabel(15)).toBe('15 minutes before')
    expect(alertLabel(4320)).toBe('3 days before')
    expect(alertLabel(90)).toBe('1 hour 30 minutes before')
    expect(alertLabel(-120)).toBe('2 hours after the start')
    expect(alertLabel(1)).toBe('1 minute before')
  })
  it('names time zones by city and their current names', () => {
    expect(zoneCity('America/Los_Angeles')).toBe('Los Angeles')
    expect(canonicalZone('Asia/Calcutta')).toBe('Asia/Kolkata')
    expect(zoneCity('Asia/Saigon')).toBe('Ho Chi Minh')
    expect(zoneLabel('Europe/London', new Date('2026-11-02T12:00:00Z'))).toMatch(/^London \(.+\)$/)
    const zones = timeZones('Asia/Calcutta')
    expect(zones[0]).toBe('Asia/Kolkata')
    expect(zones).not.toContain('Asia/Calcutta')
    expect(zones).not.toContain('Europe/Kiev')
  })
  it('writes moved instants as wall-clock times in the event’s own zone', () => {
    const moved = moveDraft(
      draft({ timeZone: 'America/New_York' }),
      new Date('2026-11-03T15:00:00Z'),
      new Date('2026-11-03T16:15:00Z'),
    )
    expect(moved).toMatchObject({
      start: '2026-11-03T10:00',
      end: '2026-11-03T11:15',
      timeZone: 'America/New_York',
    })
    const allDay = moveDraft(
      draft({ allDay: true, start: '2026-11-02', end: '2026-11-02', timeZone: null }),
      new Date(2026, 10, 5),
      new Date(2026, 10, 7),
    )
    expect(allDay).toMatchObject({ start: '2026-11-05', end: '2026-11-06' })
  })
  it('lists the zones in use first', () => {
    const zones = timeZones('Asia/Tokyo', null, 'Asia/Tokyo')
    expect(zones[0]).toBe('Asia/Tokyo')
    expect(zones.filter((z) => z === 'Asia/Tokyo')).toHaveLength(1)
    expect(zones).toContain('Europe/London')
  })
})

describe('optimistic changes', () => {
  it('shows a new event at once', () => {
    const shown = optimisticCreate('home', draft({ repeat: { frequency: 'daily', count: 2 } }), RANGE)([])
    expect(shown.map((e) => e.start.toISOString())).toEqual([
      '2026-11-02T09:00:00.000Z',
      '2026-11-03T09:00:00.000Z',
    ])
  })

  it('changes one occurrence, or moves them all by as much', () => {
    const events = [
      ev({
        recurrenceId: '1',
        start: new Date('2026-11-02T09:00:00Z'),
        end: new Date('2026-11-02T09:30:00Z'),
      }),
      ev({
        recurrenceId: '2',
        start: new Date('2026-11-09T09:00:00Z'),
        end: new Date('2026-11-09T09:30:00Z'),
      }),
      ev({ uid: 'b', title: 'B' }),
    ]
    const ref = { calendarId: 'home', uid: 'a', recurrenceId: '2' }
    const later = draft({
      title: 'Late',
      start: '2026-11-09T10:00',
      end: '2026-11-09T11:00',
      repeat: { frequency: 'weekly' },
    })
    const one = optimisticUpdate(ref, later, 'this', RANGE)(events)
    expect(one.map((e) => [e.title, e.start.toISOString()])).toEqual([
      ['A', '2026-11-02T09:00:00.000Z'],
      ['Late', '2026-11-09T10:00:00.000Z'],
      ['B', '2026-11-02T09:00:00.000Z'],
    ])
    const all = optimisticUpdate(ref, later, 'all', RANGE)(events)
    expect(
      all.filter((e) => e.uid === 'a').map((e) => [e.title, e.start.toISOString(), e.end.toISOString()]),
    ).toEqual([
      ['Late', '2026-11-02T10:00:00.000Z', '2026-11-02T11:00:00.000Z'],
      ['Late', '2026-11-09T10:00:00.000Z', '2026-11-09T11:00:00.000Z'],
    ])
    expect(all.find((e) => e.uid === 'b')!.title).toBe('B')
  })

  it('redraws a single event from its draft', () => {
    const r = optimisticUpdate(
      { calendarId: 'home', uid: 'a' },
      draft({ title: 'Moved', start: '2026-11-05T12:00', end: '2026-11-05T13:00' }),
      'all',
      RANGE,
    )([ev({})])
    expect(r).toMatchObject([{ uid: 'a', title: 'Moved', start: new Date('2026-11-05T12:00:00Z') }])
  })

  it('removes one occurrence or all of them', () => {
    const events = [ev({ recurrenceId: '1' }), ev({ recurrenceId: '2' }), ev({ uid: 'b' })]
    const ref = { calendarId: 'home', uid: 'a', recurrenceId: '1' }
    expect(optimisticDelete(ref, 'this')(events).map((e) => `${e.uid}${e.recurrenceId ?? ''}`)).toEqual([
      'a2',
      'b',
    ])
    expect(optimisticDelete(ref, 'all')(events).map((e) => e.uid)).toEqual(['b'])
  })
})

describe('moving in the week view', () => {
  const span = { start: new Date(2026, 10, 2, 9), end: new Date(2026, 10, 2, 10) }
  it('moves by days and minutes, and resizes the end without going under 15 minutes', () => {
    expect(nudged(span, { days: 1, minutes: 30 })).toEqual({
      start: new Date(2026, 10, 3, 9, 30),
      end: new Date(2026, 10, 3, 10, 30),
    })
    expect(nudged(span, { resize: 45 })).toEqual({ start: span.start, end: new Date(2026, 10, 2, 10, 45) })
    expect(nudged(span, { resize: -120 })).toEqual({ start: span.start, end: new Date(2026, 10, 2, 9, 15) })
  })
  it('snaps to quarter hours', () => {
    expect([snap(7), snap(8), snap(-22), snap(0)]).toEqual([0, 15, -15, 0])
  })
  it('keeps a move inside the week shown, and says when it hit the edge', () => {
    expect(clampDays(6, 1)).toEqual({ days: 0, clamped: true })
    expect(clampDays(0, -3)).toEqual({ days: 0, clamped: true })
    expect(clampDays(2, 9)).toEqual({ days: 4, clamped: true })
    expect(clampDays(3, -2)).toEqual({ days: -2, clamped: false })
  })
  it('maps Option-arrow keys to moves and Option-Shift to resizing', () => {
    const k = (key: string, altKey = true, shiftKey = false) => nudgeFor({ key, altKey, shiftKey })
    expect(k('ArrowUp')).toEqual({ minutes: -15 })
    expect(k('ArrowRight')).toEqual({ days: 1 })
    expect(k('ArrowDown', true, true)).toEqual({ resize: 15 })
    expect(k('ArrowLeft', true, true)).toBeNull()
    expect(k('ArrowUp', false)).toBeNull()
  })
})
