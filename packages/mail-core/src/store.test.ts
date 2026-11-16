import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MailStore } from './store'
import type { MessageHeader } from './types'

const h = (uid: number, o: Partial<MessageHeader> = {}): MessageHeader => ({
  uid,
  mailbox: 'INBOX',
  date: new Date(1_700_000_000_000 + uid),
  seen: false,
  from: { address: 'a@x.example', name: 'A' },
  subject: `s${uid}`,
  ...o,
})

let store: MailStore
beforeEach(() => {
  store = new MailStore(':memory:')
})
afterEach(() => store.close())

describe('MailStore', () => {
  it('round-trips headers', () => {
    const original = h(1, { listId: '<l>', listUnsubscribePost: 'List-Unsubscribe=One-Click', seen: true })
    store.saveHeaders([original])
    expect(store.headers('INBOX')).toEqual([
      { ...original, listUnsubscribe: undefined, precedence: undefined, autoSubmitted: undefined },
    ])
  })

  it('upserts by mailbox and uid', () => {
    store.saveHeaders([h(1), h(2)])
    store.saveHeaders([h(2, { seen: true })])
    expect(store.count('INBOX')).toBe(2)
    expect(store.headers('INBOX')[1]?.seen).toBe(true)
  })

  it('tracks mailbox state and resets it', () => {
    store.setMailboxState('INBOX', { uidValidity: '1', lastUid: 2 })
    store.saveHeaders([h(1)])
    expect(store.mailboxState('INBOX')).toEqual({ uidValidity: '1', lastUid: 2 })
    store.resetMailbox('INBOX')
    expect(store.mailboxState('INBOX')).toBeNull()
    expect(store.count('INBOX')).toBe(0)
  })

  it('stores replied-to addresses normalised', () => {
    store.setRepliedTo(['Sam@iCloud.com ', 'sam@icloud.com'])
    expect(store.repliedTo()).toEqual(new Set(['sam@icloud.com']))
  })
})
