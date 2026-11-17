import { describe, expect, it } from 'vitest'
import { parseMailto, parseUnsubscribe, planMailto, unsubscribeRank } from './unsubscribe'

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
  it('reads one recipient, subject and body', () => {
    expect(parseMailto('mailto:Leave@X.example?subject=Remove%20me&body=list%3Dweekly')).toEqual({
      to: 'leave@x.example',
      subject: 'Remove me',
      body: 'list=weekly',
    })
  })
  it('keeps a literal plus', () => {
    expect(parseMailto('MAILTO:unsub+abc@x.example')).toEqual({ to: 'unsub+abc@x.example' })
  })
  it.each([
    ['two addresses in the path', 'mailto:leave@x.example,boss@y.example'],
    ['an encoded comma', 'mailto:leave@x.example%2Cboss@y.example'],
    ['a to= field', 'mailto:leave@x.example?to=boss@y.example'],
    ['a cc= field', 'mailto:leave@x.example?cc=boss@y.example'],
    ['a bcc= field', 'mailto:leave@x.example?BCC=spy@z.example'],
    ['CRLF in the address', 'mailto:leave@x.example%0D%0ABcc:spy@z.example'],
    ['a repeated subject', 'mailto:leave@x.example?subject=a&subject=b'],
    ['no address', 'mailto:?subject=hi'],
    ['a malformed address', 'mailto:not-an-address'],
    ['another scheme', 'https://x.example'],
  ])('refuses %s', (_why, url) => {
    expect(parseMailto(url)).toBeNull()
  })
  it('drops other header fields', () => {
    expect(parseMailto('mailto:leave@x.example?in-reply-to=%3Cx%3E&X-Evil=1')).toEqual({
      to: 'leave@x.example',
    })
  })
})

describe('planMailto', () => {
  const shop = { domain: 'shop.example', listId: 'Deals <deals.lists.shop.example>' }

  it('builds the message for an address on the sender’s domain', () => {
    expect(
      planMailto('mailto:unsub@bounce.shop.example?subject=Unsubscribe%20123&body=Remove%20me', shop),
    ).toEqual({
      message: { to: 'unsub@bounce.shop.example', subject: 'Unsubscribe 123', body: 'Remove me' },
      offDomain: false,
    })
  })

  it('accepts the List-Id domain and compares registrable domains with the public suffix list', () => {
    const uk = { domain: 'news.co.uk', listId: '<weekly.mailer.co.uk>' }
    expect(planMailto('mailto:leave@lists.mailer.co.uk', uk)?.offDomain).toBe(false)
    expect(planMailto('mailto:leave@other.co.uk', uk)?.offDomain).toBe(true)
    // github.io is a public suffix: two Pages sites are different owners.
    expect(planMailto('mailto:leave@b.github.io', { domain: 'a.github.io' })?.offDomain).toBe(true)
  })

  it('flags an address on another domain', () => {
    expect(planMailto('mailto:someone@y.com', shop)).toMatchObject({
      message: { to: 'someone@y.com' },
      offDomain: true,
    })
  })

  it('falls back to "unsubscribe" for a CRLF-injected subject', () => {
    const plan = planMailto('mailto:leave@shop.example?subject=hi%0D%0ABcc:%20spy@z.example', shop)
    expect(plan?.message.subject).toBe('unsubscribe')
  })

  it('falls back to "unsubscribe" for a long subject', () => {
    expect(planMailto(`mailto:leave@shop.example?subject=${'a'.repeat(201)}`, shop)?.message.subject).toBe(
      'unsubscribe',
    )
    expect(
      planMailto(`mailto:leave@shop.example?subject=${'a'.repeat(200)}`, shop)?.message.subject,
    ).toHaveLength(200)
  })

  it('uses a fixed body unless the header’s is short plain text linking only to the list', () => {
    const body = (b: string) =>
      planMailto(`mailto:leave@shop.example?body=${encodeURIComponent(b)}`, shop)?.message.body
    expect(body('unsubscribe id=42 https://shop.example/u')).toBe('unsubscribe id=42 https://shop.example/u')
    expect(body('Visit https://evil.example/win')).toBe('unsubscribe')
    expect(body('see www.evil.example')).toBe('unsubscribe')
    expect(body('<a href="https://shop.example">x</a>')).toBe('unsubscribe')
    expect(body('x'.repeat(501))).toBe('unsubscribe')
    expect(body('line one\r\nline two')).toBe('unsubscribe')
    expect(planMailto('mailto:leave@shop.example', shop)?.message).toEqual({
      to: 'leave@shop.example',
      subject: 'unsubscribe',
      body: 'unsubscribe',
    })
  })
})
