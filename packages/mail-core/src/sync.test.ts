import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MailStore, type FlagUpdate } from './store'
import { reconcileFolder, syncFolder, toUidSet, type FolderSource } from './sync'
import type { MessageHeader } from './types'

const msg = (uid: number, o: Partial<MessageHeader> = {}): MessageHeader => ({
  uid,
  mailbox: 'Archive',
  date: new Date(uid * 1000),
  seen: false,
  from: { address: 'a@x.example' },
  subject: `m${uid}`,
  ...o,
})

class FakeFolder implements FolderSource {
  constructor(
    public messages: MessageHeader[],
    public uidValidity = '1',
  ) {}
  async status() {
    return {
      messages: this.messages.length,
      uidNext: Math.max(0, ...this.messages.map((m) => m.uid)) + 1,
      uidValidity: this.uidValidity,
    }
  }
  async *fetchHeaders(_mb: string, fromUid: number) {
    for (const m of this.messages) if (m.uid >= fromUid) yield m
  }
  async fetchRecentHeaders(_mb: string, count: number) {
    return this.messages.slice(-count)
  }
  async allUids() {
    return this.messages.map((m) => m.uid)
  }
  async fetchFlags(_mb: string, uids: readonly number[]): Promise<FlagUpdate[]> {
    return this.messages
      .filter((m) => uids.includes(m.uid))
      .map((m) => ({ uid: m.uid, seen: m.seen, flagged: m.flagged ?? false, answered: m.answered ?? false }))
  }
}

let store: MailStore
beforeEach(() => {
  store = new MailStore(':memory:')
})
afterEach(() => store.close())

describe('syncFolder', () => {
  it('fetches only the newest messages the first time', async () => {
    const folder = new FakeFolder([1, 2, 3, 4, 5].map((u) => msg(u)))
    expect(await syncFolder(folder, store, 'Archive', { initialLimit: 2 })).toEqual({
      added: 2,
      removed: 0,
      changed: 0,
      total: 2,
    })
    expect(store.cachedUids('Archive')).toEqual([4, 5])
    expect(store.mailboxState('Archive')).toEqual({ uidValidity: '1', lastUid: 5 })
  })

  it('then adds new mail, forgets what has gone and refreshes flags', async () => {
    const folder = new FakeFolder([1, 2, 3].map((u) => msg(u)))
    await syncFolder(folder, store, 'Archive')
    folder.messages = [msg(1, { seen: true, flagged: true }), msg(3), msg(4), msg(5)]
    expect(await syncFolder(folder, store, 'Archive', { batchSize: 1 })).toEqual({
      added: 2,
      removed: 1,
      changed: 1,
      total: 4,
    })
    expect(store.cachedUids('Archive')).toEqual([1, 3, 4, 5])
    expect(store.message('Archive', 1)).toMatchObject({ seen: true, flagged: true })
  })

  it('starts again when the folder is renumbered', async () => {
    const folder = new FakeFolder([1, 2].map((u) => msg(u)))
    await syncFolder(folder, store, 'Archive')
    folder.uidValidity = '2'
    folder.messages = [msg(7)]
    await syncFolder(folder, store, 'Archive')
    expect(store.cachedUids('Archive')).toEqual([7])
  })

  it('stops early when aborted, keeping what it has', async () => {
    const folder = new FakeFolder([1].map((u) => msg(u)))
    await syncFolder(folder, store, 'Archive')
    folder.messages = [msg(1), msg(2), msg(3)]
    const ctrl = new AbortController()
    ctrl.abort()
    expect(await syncFolder(folder, store, 'Archive', { signal: ctrl.signal })).toMatchObject({ added: 0 })
  })
})

describe('reconcileFolder', () => {
  it('only refreshes flags for the newest cached messages', async () => {
    const folder = new FakeFolder([1, 2, 3].map((u) => msg(u)))
    await syncFolder(folder, store, 'Archive')
    folder.messages = [1, 2, 3].map((u) => msg(u, { seen: true }))
    expect(await reconcileFolder(folder, store, 'Archive', { flagWindow: 2 })).toEqual({
      removed: 0,
      changed: 2,
    })
    expect(store.headers('Archive').map((m) => m.seen)).toEqual([false, true, true])
  })
})

describe('toUidSet', () => {
  it('compresses runs into ranges', () => {
    expect(toUidSet([5, 1, 2, 3, 9, 7, 8, 3])).toBe('1:3,5,7:9')
    expect(toUidSet([])).toBe('')
    expect(toUidSet([0, -1, 1.5, 4])).toBe('4')
  })
})
