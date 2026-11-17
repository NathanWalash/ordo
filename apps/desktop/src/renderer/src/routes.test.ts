import { describe, expect, it } from 'vitest'
import { routeFromHash } from './routes'

describe('routeFromHash', () => {
  it('reads known routes', () => {
    expect(routeFromHash('#/mail/unclutter')).toBe('mail/unclutter')
    expect(routeFromHash('#mail/inbox')).toBe('mail/inbox')
    expect(routeFromHash('#/settings')).toBe('settings')
    expect(routeFromHash('#/mail/history')).toBe('mail/history')
  })
  it('falls back to home for empty or unknown hashes', () => {
    expect(routeFromHash('')).toBe('home')
    expect(routeFromHash('#/nope')).toBe('home')
  })
})
