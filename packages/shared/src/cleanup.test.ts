import { describe, expect, it } from 'vitest'
import { CleanupIdSchema, CleanupRequestSchema } from './cleanup'

describe('CleanupRequestSchema', () => {
  it('accepts per-sender choices', () => {
    const req = { senders: [{ address: ' deals@shop.example ', unsubscribe: true, trash: false }] }
    expect(CleanupRequestSchema.parse(req).senders[0]!.address).toBe('deals@shop.example')
  })
  it('rejects empty or malformed requests', () => {
    expect(CleanupRequestSchema.safeParse({ senders: [] }).success).toBe(false)
    expect(CleanupRequestSchema.safeParse({ senders: [{ address: 'a@b.c', trash: 'yes' }] }).success).toBe(
      false,
    )
    expect(CleanupRequestSchema.safeParse(null).success).toBe(false)
  })
})

describe('CleanupIdSchema', () => {
  it('only takes positive integers', () => {
    expect(CleanupIdSchema.safeParse(3).success).toBe(true)
    expect(CleanupIdSchema.safeParse(0).success).toBe(false)
    expect(CleanupIdSchema.safeParse('3').success).toBe(false)
  })
})
