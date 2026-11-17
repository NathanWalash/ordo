import { describe, expect, it } from 'vitest'
import { parseMailto, parseUnsubscribe, unsubscribeRank } from './unsubscribe'

describe('parseUnsubscribe', () => {
  it('prefers RFC 8058 one-click over a plain link', () => {
    expect(
      parseUnsubscribe('<mailto:u@x.example>, <https://x.example/u?id=1>', 'List-Unsubscribe=One-Click'),
    ).toEqual({ kind: 'one-click', url: 'https://x.example/u?id=1' })
  })
  it('falls back to a link without the post header', () => {
    expect(parseUnsubscribe('<https://x.example/u>')).toEqual({ kind: 'link', url: 'https://x.example/u' })
  })
  it('never treats plain http as one-click, and ranks it below mailto', () => {
    expect(parseUnsubscribe('<http://x.example/u>', 'List-Unsubscribe=One-Click')).toEqual({
      kind: 'link',
      url: 'http://x.example/u',
    })
    expect(parseUnsubscribe('<http://x.example/u>, <mailto:leave@x.example>').kind).toBe('mailto')
  })
  it('keeps the whole mailto URL so subject and body can be honoured', () => {
    expect(parseUnsubscribe('<mailto:leave@x.example?subject=unsub>')).toEqual({
      kind: 'mailto',
      address: 'leave@x.example',
      url: 'mailto:leave@x.example?subject=unsub',
    })
  })
  it('allows loopback http as one-click only when asked (unpackaged tests)', () => {
    const header = '<http://127.0.0.1:4000/u>'
    const post = 'List-Unsubscribe=One-Click'
    expect(parseUnsubscribe(header, post).kind).toBe('link')
    expect(parseUnsubscribe(header, post, { allowLoopbackHttp: true })).toEqual({
      kind: 'one-click',
      url: 'http://127.0.0.1:4000/u',
    })
    expect(
      parseUnsubscribe('<http://127.0.0.1.evil.example/u>', post, { allowLoopbackHttp: true }).kind,
    ).toBe('link')
  })
})

describe('unsubscribeRank', () => {
  it('orders one-click, https link, mailto, http link, none', () => {
    const ranks = [
      { kind: 'one-click', url: 'https://a' },
      { kind: 'link', url: 'https://a' },
      { kind: 'mailto', address: 'a@b.c', url: 'mailto:a@b.c' },
      { kind: 'link', url: 'http://a' },
      { kind: 'none' },
    ].map((m) => unsubscribeRank(m as Parameters<typeof unsubscribeRank>[0]))
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a))
    expect(new Set(ranks).size).toBe(5)
  })
})

describe('parseMailto', () => {
  it('reads recipients, subject and body', () => {
    expect(parseMailto('mailto:leave@x.example?subject=Remove%20me&body=list%3Dweekly')).toEqual({
      to: ['leave@x.example'],
      subject: 'Remove me',
      body: 'list=weekly',
    })
  })
  it('defaults subject and body to "unsubscribe"', () => {
    expect(parseMailto('mailto:leave@x.example')).toEqual({
      to: ['leave@x.example'],
      subject: 'unsubscribe',
      body: 'unsubscribe',
    })
  })
  it('keeps a literal plus and accepts to= recipients', () => {
    expect(parseMailto('MAILTO:unsub+abc@x.example?to=second@x.example')?.to).toEqual([
      'unsub+abc@x.example',
      'second@x.example',
    ])
  })
  it('ignores cc, bcc and other headers', () => {
    const m = parseMailto('mailto:leave@x.example?cc=boss@y.example&bcc=spy@z.example&in-reply-to=x')
    expect(m?.to).toEqual(['leave@x.example'])
  })
  it('rejects URLs without a valid address', () => {
    expect(parseMailto('mailto:?subject=hi')).toBeNull()
    expect(parseMailto('mailto:not-an-address')).toBeNull()
    expect(parseMailto('https://x.example')).toBeNull()
  })
})
