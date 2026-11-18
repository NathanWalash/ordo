import { describe, expect, it } from 'vitest'
import { nearEnd } from './paging'

describe('nearEnd', () => {
  it('is true at or near the bottom, and when the list doesn’t fill its box', () => {
    expect(nearEnd({ scrollHeight: 10_000, scrollTop: 9_400, clientHeight: 600 })).toBe(true)
    expect(nearEnd({ scrollHeight: 10_000, scrollTop: 9_100, clientHeight: 600 })).toBe(true)
    // Short list: nothing to scroll, so no scroll event would ever ask for the next page.
    expect(nearEnd({ scrollHeight: 300, scrollTop: 0, clientHeight: 600 })).toBe(true)
  })

  it('is false well above the bottom', () => {
    expect(nearEnd({ scrollHeight: 10_000, scrollTop: 0, clientHeight: 600 })).toBe(false)
    expect(nearEnd({ scrollHeight: 10_000, scrollTop: 8_000, clientHeight: 600 })).toBe(false)
  })
})
