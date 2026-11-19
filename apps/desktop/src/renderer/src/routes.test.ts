import { describe, expect, it } from 'vitest'
import { routeFromHash } from './routes'

describe('routeFromHash', () => {
  it('reads known routes', () => {
    expect(routeFromHash('#/mail/unclutter')).toBe('mail/unclutter')
    expect(routeFromHash('#mail/inbox')).toBe('mail/inbox')
    expect(routeFromHash('#/money/finances')).toBe('money/finances')
    expect(routeFromHash('#/money/bills')).toBe('money/bills')
    expect(routeFromHash('#/money/ask')).toBe('money/ask')
    expect(routeFromHash('#/calendar')).toBe('calendar')
    expect(routeFromHash('#/settings')).toBe('settings')
    expect(routeFromHash('#/mail/history')).toBe('mail/history')
    expect(routeFromHash('#/boards')).toBe('boards')
  })
  it('ignores options after a question mark', () => {
    expect(routeFromHash('#/boards?card=abc')).toBe('boards')
    expect(routeFromHash('#/nope?card=abc')).toBe('home')
  })
  it('falls back to home for empty or unknown hashes', () => {
    expect(routeFromHash('')).toBe('home')
    expect(routeFromHash('#/nope')).toBe('home')
    expect(routeFromHash('#/finance')).toBe('home')
  })
})
