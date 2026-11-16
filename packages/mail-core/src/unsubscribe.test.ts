import { describe, expect, it } from 'vitest'
import { parseUnsubscribe } from './unsubscribe'

describe('parseUnsubscribe', () => {
  it('prefers RFC 8058 one-click over a plain link', () => {
    expect(
      parseUnsubscribe('<mailto:u@x.example>, <https://x.example/u?id=1>', 'List-Unsubscribe=One-Click'),
    ).toEqual({ kind: 'one-click', url: 'https://x.example/u?id=1' })
  })
  it('falls back to a link without the post header', () => {
    expect(parseUnsubscribe('<https://x.example/u>')).toEqual({ kind: 'link', url: 'https://x.example/u' })
  })
  it('rejects plain http', () => {
    expect(parseUnsubscribe('<http://x.example/u>')).toEqual({ kind: 'none' })
  })
  it('parses mailto without query', () => {
    expect(parseUnsubscribe('<mailto:leave@x.example?subject=unsub>')).toEqual({
      kind: 'mailto',
      address: 'leave@x.example',
    })
  })
})
