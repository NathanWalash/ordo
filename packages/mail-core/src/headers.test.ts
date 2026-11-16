import { describe, expect, it } from 'vitest'
import { parseHeaderBlock, toMessageHeader } from './headers'

describe('parseHeaderBlock', () => {
  it('lower-cases names, unfolds lines and keeps the first value', () => {
    const raw =
      'List-Unsubscribe: <https://x.example/u>,\r\n <mailto:u@x.example>\r\nPrecedence: bulk\r\nprecedence: list\r\n\r\n'
    expect(parseHeaderBlock(raw)).toEqual({
      'list-unsubscribe': '<https://x.example/u>, <mailto:u@x.example>',
      precedence: 'bulk',
    })
  })
})

describe('toMessageHeader', () => {
  it('maps an IMAP fetch result', () => {
    const msg = {
      uid: 7,
      flags: new Set(['\\Seen']),
      envelope: {
        date: new Date('2026-03-01T10:00:00Z'),
        subject: 'Hi',
        from: [{ name: ' Shop ', address: 'news@shop.example' }],
      },
      headers: Buffer.from(
        'List-Id: <news.shop.example>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n',
      ),
    }
    expect(toMessageHeader(msg, 'INBOX')).toEqual({
      uid: 7,
      mailbox: 'INBOX',
      date: new Date('2026-03-01T10:00:00Z'),
      seen: true,
      from: { address: 'news@shop.example', name: 'Shop' },
      subject: 'Hi',
      listId: '<news.shop.example>',
      listUnsubscribe: undefined,
      listUnsubscribePost: 'List-Unsubscribe=One-Click',
      precedence: undefined,
      autoSubmitted: undefined,
    })
  })

  it('skips messages without a sender and tolerates bad dates', () => {
    expect(toMessageHeader({ uid: 1, envelope: { from: [] } }, 'INBOX')).toBeNull()
    const m = toMessageHeader(
      { uid: 2, internalDate: 'nonsense', envelope: { from: [{ address: 'a@b.example' }] } },
      'INBOX',
    )
    expect(m?.date.getTime()).toBe(0)
    expect(m?.seen).toBe(false)
  })
})
