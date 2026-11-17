import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MessageHeader } from '@ordo/mail-core'

// The main-process services, run without a window: the same functions the IPC handlers and
// headless mode call. Electron is replaced by a temp profile and a fake keychain.
const dir = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => dir.path, isPackaged: true, on: vi.fn() },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: {},
  BrowserWindow: {},
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().slice('enc:'.length),
  },
}))

dir.path = mkdtempSync(join(tmpdir(), 'ordo-services-'))
const { saveAccount, deleteAccount } = await import('./account')
const mail = await import('./mail')
const cleanup = await import('./cleanup')
const ai = await import('./ai')

const SAM = 'sam@friend.example'
const DIGEST = 'digest@news.example'
const header = (uid: number, from: string, extra: Partial<MessageHeader> = {}): MessageHeader => ({
  uid,
  mailbox: 'INBOX',
  date: new Date(1_790_000_000_000 + uid),
  seen: false,
  from: { address: from },
  subject: `Subject ${uid}`,
  ...extra,
})
const request = (...addresses: string[]) => ({
  senders: addresses.map((address) => ({ address, unsubscribe: true, trash: true })),
})

beforeAll(() => {
  ai.initAi()
})
afterAll(() => mail.closeMail())

describe('without an account', () => {
  it('status says not connected', () => {
    expect(mail.status()).toEqual({ connected: false })
  })

  it('scan, plan and run ask you to connect first', async () => {
    expect(await mail.scan()).toMatchObject({ ok: false, error: 'auth' })
    expect(cleanup.plan(request(DIGEST))).toMatchObject({ ok: false, error: 'auth' })
    expect(await cleanup.run(request(DIGEST))).toMatchObject({ ok: false, error: 'auth' })
  })
})

describe('with a cached inbox', () => {
  beforeAll(() => {
    saveAccount('me@icloud.example', 'abcd-efgh-ijkl-mnop')
    const store = mail.mailStore()
    store.saveHeaders([
      header(1, DIGEST, {
        listId: '<digest.news.example>',
        listUnsubscribe: '<https://news.example/u>',
        listUnsubscribePost: 'List-Unsubscribe=One-Click',
      }),
      header(2, DIGEST, { listId: '<digest.news.example>' }),
      header(3, SAM),
    ])
    store.setRepliedTo([SAM])
  })
  afterAll(() => deleteAccount())

  it('status shows the email and never the password', () => {
    const status = mail.status()
    expect(status).toEqual({
      connected: true,
      email: 'me@icloud.example',
      lastScan: null,
      messageCount: 3,
    })
    expect(JSON.stringify(status)).not.toContain('abcd')
  })

  it('plan refuses people and plans the rest, as the review sheet does', () => {
    const out = cleanup.plan(request(SAM, DIGEST))
    expect(out).toMatchObject({
      ok: true,
      plan: {
        senders: [
          {
            address: DIGEST,
            count: 2,
            trash: true,
            unsubscribe: { kind: 'one-click', url: 'https://news.example/u' },
          },
        ],
        rejected: [{ address: SAM, reason: 'Someone you’ve written to. Never included in bulk actions.' }],
      },
    })
  })

  it('run refuses people before touching the network', async () => {
    expect(await cleanup.run(request(SAM))).toEqual({
      ok: false,
      error: 'invalid',
      message: 'Someone you’ve written to. Never included in bulk actions.',
    })
  })

  it('rejects malformed requests', async () => {
    expect(cleanup.plan({ senders: [] })).toMatchObject({ ok: false, error: 'invalid' })
    expect(await cleanup.run('everything')).toMatchObject({ ok: false, error: 'invalid' })
    expect(await cleanup.undo(-1)).toMatchObject({ ok: false, error: 'invalid' })
  })

  it('history is empty and never carries UID maps', () => {
    expect(cleanup.history()).toEqual([])
  })
})

describe('AI sort', () => {
  it('a cloud provider without saved consent is never used', async () => {
    writeFileSync(
      join(dir.path, 'settings.json'),
      JSON.stringify({
        theme: 'system',
        ai: { provider: 'claude-cli', model: null, sortSenders: true, cloudConsent: null },
      }),
    )
    // Invalid settings fall back to AI off, so nothing is sent anywhere.
    expect(ai.aiSettings().provider).toBe('none')
    expect(await ai.categoriseSenders({})).toEqual({
      ok: false,
      message: 'Choose a model in Settings → AI first.',
    })
  })
})
