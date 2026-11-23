import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
const money = await import('./money')
const calendar = await import('./calendar')

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
      accounts: [
        {
          id: 'acc-1',
          label: 'iCloud',
          email: 'me@icloud.example',
          color: 'blue',
          provider: 'icloud',
          imap: { host: 'imap.mail.me.com', port: 993, secure: true },
          smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, requireTLS: true },
          auth: { kind: 'password' },
          lastScan: null,
        },
      ],
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

describe('the write lock', () => {
  const lockFile = () => join(dir.path, 'ordo-write.lock')
  beforeAll(() => saveAccount('me@icloud.example', 'abcd-efgh-ijkl-mnop'))
  afterAll(() => {
    rmSync(lockFile(), { force: true })
    deleteAccount()
  })

  it('every write refuses while another live Ordo process holds it, and leaves its lock alone', async () => {
    // Our parent process is alive and isn't us: it stands in for the app or an agent.
    writeFileSync(
      lockFile(),
      JSON.stringify({
        pid: process.ppid,
        owner: 'mcp',
        task: 'clearing senders',
        since: new Date().toISOString(),
      }),
    )
    const locked = {
      ok: false,
      error: 'locked',
      message: 'Ordo is busy in an AI agent using Ordo (clearing senders). Try again when it finishes.',
    }
    expect(await mail.scan()).toEqual(locked)
    expect(await cleanup.run(request(DIGEST))).toEqual(locked)
    expect(await cleanup.undo(1)).toMatchObject({ ok: false }) // unknown id is checked first
    expect(await calendar.sync()).toEqual(locked)
    expect(await money.importStatement({ fileName: 'a.csv', text: 'Date,Description,Amount\n' })).toEqual(
      locked,
    )
    expect(existsSync(lockFile())).toBe(true)
    // Reads don't need the lock.
    expect(cleanup.plan(request(DIGEST))).toMatchObject({ ok: true })
  })

  it('a lock left by a process that has gone is taken over', async () => {
    writeFileSync(
      lockFile(),
      JSON.stringify({ pid: 2 ** 22 + 12345, owner: 'headless', task: 'x', since: new Date().toISOString() }),
    )
    const out = await money.importStatement({ fileName: 'a.csv', text: 'nothing useful' })
    expect(out).toMatchObject({ ok: false })
    expect(out).not.toHaveProperty('error', 'locked')
    // Released afterwards.
    expect(existsSync(lockFile())).toBe(false)
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

describe('importing a calendar file', () => {
  it('accepts a file saved with a byte order mark, as Windows Notepad does', async () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:bom-1',
      `DTSTART:${new Date().getUTCFullYear()}1201T090000Z`,
      'SUMMARY:Dentist',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n')
    const r = await calendar.addIcsText(`${String.fromCharCode(0xfeff)}${ics}`, 'dentist.ics')
    expect(r).toMatchObject({ ok: true })
  })
})

describe('importing a statement file', () => {
  const CSV = 'Date,Description,Amount\r\n13/11/2026,TESCO STORES,-£3.41\r\n'

  it('reads Excel’s UTF-16 “Unicode text” export', async () => {
    const file = join(dir.path, 'unicode.csv')
    writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(CSV, 'utf16le')]))
    expect(await money.importStatementFile(file, 'Unicode')).toMatchObject({ ok: true, added: 1 })
  })

  it('reads a Windows code page export, where £ is one byte', async () => {
    const file = join(dir.path, 'cp1252.csv')
    writeFileSync(file, Buffer.from(CSV.replace('TESCO', 'ALDI'), 'latin1'))
    expect(await money.importStatementFile(file, 'Windows')).toMatchObject({ ok: true, added: 1 })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'says a file it can’t open can’t be read, instead of failing inside Ordo',
    async () => {
      const file = join(dir.path, 'locked.csv')
      writeFileSync(file, CSV)
      chmodSync(file, 0o000)
      try {
        expect(await money.importStatementFile(file)).toEqual({
          ok: false,
          message: expect.stringContaining('couldn’t read that file'),
        })
      } finally {
        chmodSync(file, 0o600)
      }
    },
  )
})

describe('what connecting to iCloud says when it fails', () => {
  const coded = (code: string, extra: object = {}) =>
    Object.assign(new Error('Command failed'), { code, ...extra })
  const refused = (extra: object = {}) =>
    Object.assign(new Error('x'), { authenticationFailed: true, ...extra })

  it('a refused password says to use an app-specific password and check iCloud Mail is on', () => {
    const r = mail.explain(refused(), 'me@icloud.com')
    expect(r.error).toBe('auth')
    expect(r.message).toContain("iCloud didn't accept")
    expect(r.message).toContain('Apple ID password won’t work')
    expect(r.message).toContain('iCloud Mail is turned on')
    expect(r.message).not.toContain('@icloud.com address instead')
  })

  it('an Apple ID that is not an iCloud address gets a hint to use the iCloud one', () => {
    expect(mail.explain(refused(), 'me@gmail.example').message).toContain(
      'sign in with your @icloud.com address instead',
    )
  })

  it('throttling says iCloud is turning connections away, with what it said', () => {
    const r = mail.explain(refused({ serverResponseCode: 'UNAVAILABLE', responseText: 'Maintenance' }))
    expect(r.error).toBe('unavailable')
    expect(r.message).toContain('turning connections away')
    expect(r.message).toContain('“Maintenance”')
    expect(r.message).not.toContain("didn't accept")
  })

  it('a timeout is not described as being offline', () => {
    const r = mail.explain(coded('GREETING_TIMEOUT'))
    expect(r.error).toBe('network')
    expect(r.message).toContain("didn't answer in time")
  })

  it('offline, TLS and dropped connections each get their own next step', () => {
    expect(mail.explain(coded('ENOTFOUND')).message).toContain("Check you're online")
    expect(mail.explain(coded('CERT_HAS_EXPIRED')).message).toContain('secure connection')
    expect(mail.explain(coded('ECONNRESET')).message).toContain('closed part way')
  })

  it('a busy iCloud Calendar is not described as a wrong password or being offline', async () => {
    const { CalendarUnavailableError } = await import('@ordo/calendar-core/node')
    const r = calendar.explain(new CalendarUnavailableError('cannot find principalUrl (HTTP 503)'))
    expect(r.message).toContain('busy or limiting requests')
  })

  it('anything else names what happened, so it can be reported', () => {
    const r = mail.explain(coded('WEIRD_THING'))
    expect(r.error).toBe('unknown')
    expect(r.message).toContain('(WEIRD_THING)')
  })

  it('cleans what an unknown error says before showing it', () => {
    const rlo = String.fromCharCode(0x202e)
    const r = mail.explain(new Error(`Server said\r\n${rlo}evil`))
    expect(r.message).toContain('(Server said evil)')
  })
})
