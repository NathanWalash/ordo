import { describe, expect, it } from 'vitest'
import { nextPollDelay, POLL_BASE_MS, POLL_MAX_MS } from './poll'
import { CalendarStore, FEEDS } from './store'

describe('nextPollDelay', () => {
  const mid = () => 0.5
  it('polls every three minutes while syncs work', () => {
    expect(nextPollDelay({ failures: 0, random: mid })).toBe(POLL_BASE_MS)
  })
  it('spreads polls by up to 15% either side', () => {
    expect(nextPollDelay({ failures: 0, random: () => 0 })).toBe(Math.round(POLL_BASE_MS * 0.85))
    expect(nextPollDelay({ failures: 0, random: () => 1 })).toBe(Math.round(POLL_BASE_MS * 1.15))
  })
  it('doubles after each failure, up to thirty minutes', () => {
    expect([1, 2, 3, 4, 10, 1000].map((failures) => nextPollDelay({ failures, random: mid }))).toEqual([
      6 * 60_000,
      12 * 60_000,
      24 * 60_000,
      POLL_MAX_MS,
      POLL_MAX_MS,
      POLL_MAX_MS,
    ])
  })
  it('never polls before the server’s Retry-After', () => {
    expect(nextPollDelay({ failures: 1, retryAfterMs: 3_600_000, random: mid })).toBe(3_600_000)
    expect(nextPollDelay({ failures: 0, retryAfterMs: 1000, random: mid })).toBe(POLL_BASE_MS)
  })
})

describe('CalendarStore for Google calendars', () => {
  it('orders iCloud, then Google accounts, then links; keeps colours and sync state', () => {
    const s = new CalendarStore(':memory:')
    s.setCalendars([{ id: 'feed:1', name: 'Link', readOnly: true }], FEEDS)
    s.setCalendars([{ id: 'google:1:a', name: 'Work', readOnly: false, color: '#3f51b5' }], 'google:1')
    s.setCalendars(
      [
        { id: 'google:1:b', name: 'Hidden', readOnly: true, visible: false },
        { id: 'google:1:a', name: 'Work', readOnly: false, color: '#3f51b5' },
      ],
      'google:1',
    )
    s.setCalendars([{ id: 'home', name: 'Home', readOnly: false }])
    expect(s.calendars().map((c) => [c.id, c.source, c.visible])).toEqual([
      ['home', 'icloud', true],
      ['google:1:b', 'google', false],
      ['google:1:a', 'google', true],
      ['feed:1', 'icloud', true],
    ])
    // A later list doesn't undo the user's choice to show it.
    s.setVisible('google:1:b', true)
    s.setCalendars([{ id: 'google:1:b', name: 'Hidden', readOnly: true, visible: false }], 'google:1')
    expect(s.calendar('google:1:b')?.visible).toBe(true)
    s.setColor('google:1:b', '#ff0000')
    expect(s.calendar('google:1:b')?.color).toBe('#ff0000')
    s.setColor('google:1:b', null)
    s.setSyncOutcome('google:1:b', { at: new Date(5000) })
    s.setSyncOutcome('google:1:b', { error: 'Busy' })
    expect(s.calendar('google:1:b')).toMatchObject({
      syncedAt: 5000,
      syncError: 'Busy',
      provider: 'google:1',
    })
    s.setSyncOutcome('google:1:b', { at: new Date(6000) })
    expect(s.calendar('google:1:b')?.syncError).toBeUndefined()
    s.close()
  })

  it('keeps Google events by series, forgets cancelled series, and clears them with the account', () => {
    const s = new CalendarStore(':memory:')
    s.setCalendars([{ id: 'google:1:a', name: 'Work', readOnly: false }], 'google:1')
    s.applyGoogleItems('google:1:a', [
      { id: 'm', recurrence: ['RRULE:FREQ=DAILY'] },
      { id: 'm_1', recurringEventId: 'm', status: 'cancelled' },
      { id: 'single' },
    ])
    expect(s.googleGroup('google:1:a', 'm')).toMatchObject({
      master: { id: 'm' },
      exceptions: [{ id: 'm_1' }],
    })
    s.applyGoogleItems('google:1:a', [{ id: 'm', status: 'cancelled' }])
    expect(s.googleItems('google:1:a').map((e) => e.id)).toEqual(['single'])
    s.applyGoogleItems('google:1:a', [{ id: 'other' }], true)
    expect(s.googleItems('google:1:a').map((e) => e.id)).toEqual(['other'])
    s.setSyncToken('google:1:a', 'tok')
    expect(s.syncToken('google:1:a')).toBe('tok')
    s.clearProvider('google:1')
    expect(s.calendars()).toEqual([])
    expect(s.googleItems('google:1:a')).toEqual([])
    expect(s.syncToken('google:1:a')).toBeNull()
    s.close()
  })
})
