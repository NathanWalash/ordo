import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MessageContent, MessageHeader } from '@ordo/mail-core'

// The mail client's main-process checks, without a window or a server: everything here is
// refused (or answered from the cache) before any connection would be made.
const dir = vi.hoisted(() => ({ path: '' }))
const openExternal = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({
  app: { getPath: () => dir.path, isPackaged: true, on: vi.fn() },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal },
  dialog: {},
  BrowserWindow: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().slice('enc:'.length),
  },
}))

dir.path = mkdtempSync(join(tmpdir(), 'ordo-mail-client-'))
const { saveAccount, deleteAccount } = await import('./account')
const mail = await import('./mail')
const client = await import('./mail-client')

const header = (uid: number, extra: Partial<MessageHeader> = {}): MessageHeader => ({
  uid,
  mailbox: 'INBOX',
  date: new Date(1_790_000_000_000 + uid * 1000),
  seen: uid !== 2,
  from: { address: `sender${uid}@x.example`, name: `Sender ${uid}` },
  subject: `Subject ${uid} pineapple`,
  ...extra,
})

const compose = (o: Record<string, unknown> = {}) => ({
  to: 'sam@friend.example',
  cc: '',
  bcc: '',
  subject: 'Hi',
  body: 'Hello',
  attachments: [],
  ...o,
})

afterAll(() => {
  client.closeMailClient()
  mail.closeMail()
})

describe('without an account', () => {
  it('lists nothing and asks you to connect', async () => {
    expect(client.mailboxes()).toEqual([])
    expect(client.messages({ mailbox: 'INBOX' })).toEqual({ total: 0, messages: [] })
    expect(await client.open({ mailbox: 'INBOX', uid: 1 })).toMatchObject({ ok: false, error: 'auth' })
    expect(await client.send(compose())).toMatchObject({ ok: false, error: 'auth' })
    expect(await client.refresh({ mailbox: 'INBOX' })).toMatchObject({ ok: false, error: 'auth' })
  })
})

describe('with a cached mailbox', () => {
  beforeAll(() => {
    saveAccount('me@icloud.example', 'abcd-efgh-ijkl-mnop')
    const store = mail.mailStore()
    store.saveMailboxes([
      { path: 'INBOX', name: 'Inbox', role: 'inbox', delimiter: '/', total: 3, unread: 1 },
      { path: 'Sent Messages', name: 'Sent Messages', role: 'sent', delimiter: '/', total: 0, unread: 0 },
    ])
    store.saveHeaders([header(1), header(2, { flagged: true }), header(3)])
    const body: MessageContent = {
      mailbox: 'INBOX',
      uid: 3,
      date: new Date(1_790_000_003_000),
      subject: 'Subject 3 pineapple',
      from: { address: 'sender3@x.example' },
      to: [],
      cc: [],
      bcc: [],
      replyTo: [],
      messageId: '<m3@x.example>',
      inReplyTo: null,
      references: [],
      seen: true,
      flagged: false,
      answered: false,
      draft: false,
      text: 'The secret word is kumquat.',
      html: null,
      truncated: false,
      attachments: [],
      inlineImages: {},
    }
    store.saveBody(body, body.text!)
  })
  afterAll(() => deleteAccount())

  it('pages a folder newest first, with flags', () => {
    const page = client.messages({ mailbox: 'INBOX', limit: 2 })
    expect(page.total).toBe(3)
    expect(page.messages.map((m) => m.uid)).toEqual([3, 2])
    expect(page.messages[1]).toMatchObject({ seen: false, flagged: true })
    expect(client.messages({ mailbox: 'INBOX', unread: true }).messages.map((m) => m.uid)).toEqual([2])
  })

  it('searches headers and opened bodies locally', () => {
    expect(client.search({ query: 'pineapple' }).map((m) => m.uid)).toEqual([3, 2, 1])
    expect(client.search({ query: 'kumquat' }).map((m) => m.uid)).toEqual([3])
    expect(client.search({ query: '' })).toEqual([])
  })

  it('opens a message from the cache without a connection', async () => {
    expect(await client.open({ mailbox: 'INBOX', uid: 3 })).toMatchObject({
      ok: true,
      message: { text: 'The secret word is kumquat.' },
    })
  })

  it('refuses malformed input and mailboxes it doesn’t know', async () => {
    expect(await client.open({ mailbox: 'INBOX', uid: -1 })).toMatchObject({ error: 'invalid' })
    expect(await client.open({ mailbox: 'INBOX\r\nA1 DELETE INBOX', uid: 1 })).toMatchObject({
      error: 'invalid',
    })
    expect(await client.open({ mailbox: 'Secret', uid: 1 })).toMatchObject({ error: 'not-found' })
    expect(await client.setFlags({ mailbox: 'INBOX', uids: [1] })).toMatchObject({ error: 'invalid' })
    expect(await client.setFlags({ mailbox: 'Nope', uids: [1], seen: true })).toMatchObject({
      error: 'not-found',
    })
    expect(await client.move({ mailbox: 'INBOX', uids: [1], to: 'delete' })).toMatchObject({
      error: 'invalid',
    })
    expect(await client.saveAttachment({ mailbox: 'INBOX', uid: 1, part: '../1' })).toMatchObject({
      error: 'invalid',
    })
  })

  it('won’t move to a folder the account doesn’t have, or to where it already is', async () => {
    expect(await client.move({ mailbox: 'INBOX', uids: [1], to: 'archive' })).toEqual({
      ok: false,
      error: 'unavailable',
      message: 'This account has no Archive mailbox.',
    })
    expect(await client.move({ mailbox: 'INBOX', uids: [1], to: 'inbox' })).toMatchObject({
      error: 'invalid',
    })
    expect(await client.undoMove(99)).toMatchObject({ ok: false, error: 'not-found' })
  })

  it('only opens web links, checked again here', async () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://bank.example@evil.example/',
      'x-apple.systempreferences:',
    ])
      expect(await client.openLink(url)).toMatchObject({ ok: false, error: 'invalid' })
    expect(openExternal).not.toHaveBeenCalled()
    expect(await client.openLink('https://shop.example/sale')).toEqual({ ok: true })
    expect(openExternal).toHaveBeenCalledWith('https://shop.example/sale')
  })

  it('checks a message before sending: addresses, header injection, attachments', async () => {
    expect(await client.send(compose({ to: 'not an address' }))).toMatchObject({
      ok: false,
      error: 'invalid',
      message: 'Check this address: not an address',
    })
    expect(await client.send(compose({ to: '' }))).toMatchObject({
      error: 'invalid',
      message: 'Add at least one recipient.',
    })
    expect(await client.send(compose({ subject: 'Hi\r\nBcc: spy@evil.example' }))).toMatchObject({
      error: 'invalid',
    })
    expect(
      await client.send(compose({ attachments: ['3f0e8c1a-2b4d-4e6f-8a9b-0c1d2e3f4a5b'] })),
    ).toMatchObject({
      error: 'invalid',
      message: 'One of the attached files isn’t available any more. Attach it again.',
    })
    expect(await client.send(compose({ replyTo: { mailbox: 'Elsewhere', uid: 1 } }))).toMatchObject({
      error: 'not-found',
    })
    const many = Array.from({ length: 51 }, (_, i) => `p${i}@x.example`).join(', ')
    expect(await client.send(compose({ to: many }))).toMatchObject({ error: 'invalid' })
  })

  it('needs a Drafts mailbox to save a draft', async () => {
    expect(await client.saveDraft(compose())).toMatchObject({ ok: false, error: 'unavailable' })
  })

  it('refuses remote images that aren’t https, without fetching', async () => {
    expect(await client.loadImages({ urls: ['http://img.example/a.png', 'file:///x.png'] })).toEqual({
      images: {},
      failed: 2,
    })
  })
})
