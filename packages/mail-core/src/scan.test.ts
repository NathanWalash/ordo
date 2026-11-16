import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanMailbox } from './scan'
import { MailStore } from './store'
import type { MailProvider, MessageHeader, ScanProgress } from './types'

const msg = (uid: number): MessageHeader => ({
  uid,
  mailbox: 'INBOX',
  date: new Date(uid * 1000),
  seen: false,
  from: { address: `s${uid % 3}@x.example` },
  subject: `m${uid}`,
})

class FakeProvider implements MailProvider {
  constructor(
    public inbox: MessageHeader[],
    public uidValidity = '1',
    public sent: string[] = ['friend@icloud.com'],
  ) {}
  async connect() {}
  async status() {
    return {
      messages: this.inbox.length,
      uidNext: (this.inbox.at(-1)?.uid ?? 0) + 1,
      uidValidity: this.uidValidity,
    }
  }
  async *fetchHeaders(_mb: string, fromUid: number) {
    for (const m of this.inbox) if (m.uid >= fromUid) yield m
  }
  async findMailbox() {
    return 'Sent Messages'
  }
  async fetchRecipients() {
    return this.sent
  }
  async moveToTrash() {}
  async close() {}
}

let store: MailStore
beforeEach(() => {
  store = new MailStore(':memory:')
})
afterEach(() => store.close())

describe('scanMailbox', () => {
  it('stores every header, reports progress and records replied-to addresses', async () => {
    const progress: ScanProgress[] = []
    const res = await scanMailbox(new FakeProvider([1, 2, 3, 4, 5].map(msg)), store, {
      batchSize: 2,
      onProgress: (p) => progress.push(p),
    })
    expect(res).toEqual({ added: 5, total: 5, stopped: false })
    expect(store.mailboxState('INBOX')).toEqual({ uidValidity: '1', lastUid: 5 })
    expect(store.repliedTo()).toEqual(new Set(['friend@icloud.com']))
    expect(progress.map((p) => `${p.phase}:${p.checked}`)).toEqual([
      'inbox:0',
      'inbox:2',
      'inbox:4',
      'sent:5',
      'done:5',
    ])
  })

  it('only fetches new mail on a second scan', async () => {
    const p = new FakeProvider([1, 2, 3].map(msg))
    await scanMailbox(p, store)
    p.inbox.push(msg(4), msg(5))
    expect(await scanMailbox(p, store)).toMatchObject({ added: 2, total: 5 })
  })

  it('starts again when the server renumbers the mailbox', async () => {
    await scanMailbox(new FakeProvider([1, 2, 3].map(msg), '1'), store)
    const res = await scanMailbox(new FakeProvider([10, 11].map(msg), '2'), store)
    expect(res).toMatchObject({ added: 2, total: 2 })
    expect(store.headers('INBOX').map((h) => h.uid)).toEqual([10, 11])
  })

  it('stops when aborted and resumes later', async () => {
    const p = new FakeProvider([1, 2, 3, 4].map(msg))
    const ctrl = new AbortController()
    const res = await scanMailbox(p, store, {
      batchSize: 1,
      signal: ctrl.signal,
      onProgress: (pr) => pr.checked >= 2 && ctrl.abort(),
    })
    expect(res.stopped).toBe(true)
    expect(store.count('INBOX')).toBe(2)
    expect(await scanMailbox(p, store)).toMatchObject({ added: 2, total: 4, stopped: false })
  })
})
