import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageHeader } from '@ordo/mail-core'
import { MailStore } from '@ordo/mail-core/node'

// Several mail accounts in the main process: the accounts file and its migration from one
// account, adding, testing, renaming and removing accounts, and the mail client reading them side
// by side. Electron is a temp profile and a fake keychain; signing in is faked, so nothing connects.

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

/** Sign-ins: only these passwords work. Every login is recorded, never sent anywhere. */
const logins = vi.hoisted(() => ({ good: new Set<string>(), seen: [] as Record<string, unknown>[] }))
vi.mock('@ordo/mail-core/node', async (importOriginal) => {
  const real = await importOriginal<{ MailAuthError: new (message: string) => Error }>()
  return {
    ...real,
    testImapLogin: vi.fn(async (cfg: Record<string, unknown>) => {
      logins.seen.push(cfg)
      if (!logins.good.has(String(cfg['pass']))) throw new real.MailAuthError('Authentication failed')
    }),
  }
})

dir.path = mkdtempSync(join(tmpdir(), 'ordo-accounts-'))
const account = await import('./account')
const accounts = await import('./accounts')
const mail = await import('./mail')
const client = await import('./mail-client')

const header = (uid: number, extra: Partial<MessageHeader> = {}): MessageHeader => ({
  uid,
  mailbox: 'INBOX',
  date: new Date(1_790_000_000_000 + uid * 1000),
  seen: false,
  from: { address: `sender${uid}@shop.example` },
  subject: `Subject ${uid}`,
  ...extra,
})

const ICLOUD_PASSWORD = 'abcd-efgh-ijkl-mnop'
const GMAIL_PASSWORD = 'qwer tyui opas dfgh'

beforeEach(async () => {
  account.deleteAccount()
  await mail.disconnect()
  logins.good = new Set([ICLOUD_PASSWORD, GMAIL_PASSWORD])
  logins.seen = []
})
afterAll(() => mail.closeMail())

describe('moving a single-account install to the accounts list', () => {
  it('turns account.json into account #1, copying the encrypted password as it is', () => {
    const encrypted = Buffer.from(`enc:${ICLOUD_PASSWORD}`).toString('base64')
    writeFileSync(
      join(dir.path, 'account.json'),
      JSON.stringify({ email: 'me@icloud.com', password: encrypted, lastScan: '2026-11-01T10:00:00.000Z' }),
    )
    expect(account.listAccounts()).toEqual([
      {
        id: 'acc-1',
        label: 'iCloud',
        email: 'me@icloud.com',
        color: 'blue',
        provider: 'icloud',
        imap: { host: 'imap.mail.me.com', port: 993, secure: true },
        smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, requireTLS: true },
        auth: { kind: 'password' },
        lastScan: '2026-11-01T10:00:00.000Z',
      },
    ])
    const file = join(dir.path, 'accounts.json')
    expect(JSON.parse(readFileSync(file, 'utf8')).accounts[0].secret).toBe(encrypted)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(existsSync(join(dir.path, 'account.json'))).toBe(false)
    expect(existsSync(join(dir.path, 'account.json.migrated'))).toBe(true)
    expect(account.readSecret('acc-1')).toBe(ICLOUD_PASSWORD)
    // Calendar still finds its iCloud account, and reading again changes nothing.
    expect(account.loadAccount()).toMatchObject({
      id: 'acc-1',
      email: 'me@icloud.com',
      password: ICLOUD_PASSWORD,
    })
    const once = readFileSync(file, 'utf8')
    account.listAccounts()
    expect(readFileSync(file, 'utf8')).toBe(once)
  })

  it('ignores a left-over account.json once the list exists, and a damaged one', () => {
    account.saveAccount('me@icloud.com', ICLOUD_PASSWORD)
    writeFileSync(join(dir.path, 'account.json'), JSON.stringify({ email: 'old@icloud.com', password: 'x' }))
    expect(account.listAccounts().map((a) => a.email)).toEqual(['me@icloud.com'])
    account.deleteAccount()
    writeFileSync(join(dir.path, 'account.json'), '{ not json')
    expect(account.listAccounts()).toEqual([])
  })

  it('leaves out damaged entries in the list instead of failing it', () => {
    const good = account.fromLegacy({ email: 'me@icloud.com', password: 'abc', lastScan: null })!.accounts[0]!
    expect(
      account.parseAccountsFile({
        version: 1,
        accounts: [good, { ...good, id: 'BAD ID' }, { ...good, provider: 'aol' }, good, null],
      }),
    ).toEqual([good])
    // A server without TLS from the start always requires STARTTLS.
    expect(
      account.parseAccountsFile({ accounts: [{ ...good, smtp: { ...good.smtp, requireTLS: false } }] })[0]!
        .smtp.requireTLS,
    ).toBe(true)
  })

  const legacyJson = () =>
    JSON.stringify({
      email: 'me@icloud.com',
      password: Buffer.from(`enc:${ICLOUD_PASSWORD}`).toString('base64'),
      lastScan: null,
    })
  const at = (name: string) => join(dir.path, name)

  it('keeps account.json as account.json.migrated until a later launch has read the list back', async () => {
    writeFileSync(at('account.json'), legacyJson())
    expect(account.listAccounts()).toHaveLength(1)
    expect(existsSync(at('account.json'))).toBe(false)
    expect(existsSync(at('account.json.migrated'))).toBe(true)
    // Still there for the rest of this run.
    account.listAccounts()
    expect(existsSync(at('account.json.migrated'))).toBe(true)
    // A later launch reads the list back, valid, and only then removes the copy.
    vi.resetModules()
    const later = await import('./account')
    expect(later.listAccounts().map((a) => a.email)).toEqual(['me@icloud.com'])
    expect(existsSync(at('account.json.migrated'))).toBe(false)
  })

  it('a damaged list is set aside, never overwritten, and the old account comes back from its copy', () => {
    writeFileSync(at('account.json.migrated'), legacyJson())
    writeFileSync(at('accounts.json'), '{"version":1,"accounts":[{"id":')
    expect(account.listAccounts().map((a) => [a.id, a.email])).toEqual([['acc-1', 'me@icloud.com']])
    const aside = readdirSync(dir.path).filter((f) => f.startsWith('accounts.json.bak-'))
    expect(aside).toHaveLength(1)
    expect(readFileSync(at(aside[0]!), 'utf8')).toBe('{"version":1,"accounts":[{"id":')
    for (const f of aside) rmSync(at(f))
    // No accounts array at all, and no old account to fall back to: set aside, list empty.
    account.deleteAccount()
    writeFileSync(at('accounts.json'), '{"version":1,"accounts":"oops"}')
    expect(account.listAccounts()).toEqual([])
    const again = readdirSync(dir.path).filter((f) => f.startsWith('accounts.json.bak-'))
    expect(again).toHaveLength(1)
    for (const f of again) rmSync(at(f))
    // An empty list is a real list (every account removed), not damage: nothing comes back.
    writeFileSync(at('accounts.json'), '{"version":1,"accounts":[]}')
    writeFileSync(at('account.json.migrated'), legacyJson())
    expect(account.listAccounts()).toEqual([])
  })

  it('keeps entries and fields it doesn’t understand, and writes them back untouched', async () => {
    const good = account.fromLegacy({ email: 'me@icloud.com', password: 'abc', lastScan: null })!.accounts[0]!
    const oauth = {
      id: 'acc-2',
      label: 'Work',
      email: 'jo@corp.example',
      provider: 'gmail',
      auth: { kind: 'oauth', provider: 'google' },
      secret: 'refresh',
    }
    const weird = { id: 'acc-7', provider: 'aol', future: { x: 1 } }
    writeFileSync(
      at('accounts.json'),
      JSON.stringify({
        version: 1,
        lastId: 2,
        somethingNew: 'kept',
        accounts: [{ ...good, nickname: 'future field' }, oauth, weird, 'not even an object'],
      }),
    )
    expect(account.listAccounts().map((a) => a.id)).toEqual(['acc-1'])
    expect(accounts.update({ id: 'acc-1', label: 'Home' })).toMatchObject({ ok: true })
    const written = JSON.parse(readFileSync(at('accounts.json'), 'utf8'))
    expect(written.somethingNew).toBe('kept')
    expect(written.accounts[0]).toMatchObject({ id: 'acc-1', label: 'Home', nickname: 'future field' })
    expect(written.accounts.slice(1)).toEqual([oauth, weird, 'not even an object'])
    // A new account never takes an id an unknown entry has.
    const added = await accounts.add({ provider: 'gmail', email: 'x@gmail.com', password: GMAIL_PASSWORD })
    expect(added.ok && added.account.id).toBe('acc-8')
  })

  it('reads a list written by a newer Ordo, but never writes it', async () => {
    const good = account.fromLegacy({ email: 'me@icloud.com', password: 'abc', lastScan: null })!.accounts[0]!
    const newer = JSON.stringify({ version: 99, accounts: [good] })
    writeFileSync(at('accounts.json'), newer)
    expect(account.listAccounts().map((a) => a.id)).toEqual(['acc-1'])
    expect(accounts.update({ id: 'acc-1', label: 'Home' })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/newer version of Ordo/),
    })
    expect(
      await accounts.add({ provider: 'gmail', email: 'x@gmail.com', password: GMAIL_PASSWORD }),
    ).toMatchObject({
      ok: false,
    })
    account.recordScan(new Date(), 'acc-1')
    mail.accountStore('acc-1').saveHeaders([header(1)])
    await expect(accounts.remove('acc-1')).rejects.toThrow(/newer version of Ordo/)
    // Refused before anything was stopped or cleared.
    expect(mail.accountStore('acc-1').count('INBOX')).toBe(1)
    expect(readFileSync(at('accounts.json'), 'utf8')).toBe(newer)
    rmSync(at('accounts.json'))
  })
})

describe('account ids and Calendar’s account', () => {
  it('never reuses an id, even after the account is removed or its mail is still cached', async () => {
    const a = await accounts.add({ provider: 'gmail', email: 'a@gmail.com', password: GMAIL_PASSWORD })
    const b = await accounts.add({ provider: 'gmail', email: 'b@gmail.com', password: GMAIL_PASSWORD })
    expect([a.ok && a.account.id, b.ok && b.account.id]).toEqual(['acc-1', 'acc-2'])
    await accounts.remove('acc-2')
    const c = await accounts.add({ provider: 'gmail', email: 'c@gmail.com', password: GMAIL_PASSWORD })
    expect(c.ok && c.account.id).toBe('acc-3')
    // Rows left in the cache under an id the list has forgotten are never inherited.
    mail.accountStore('acc-9').saveHeaders([header(1)])
    const d = await accounts.add({ provider: 'gmail', email: 'd@gmail.com', password: GMAIL_PASSWORD })
    expect(d.ok && d.account.id).toBe('acc-10')
    expect(mail.accountStore('acc-10').count('INBOX')).toBe(0)
    mail.accountStore('acc-9').clear()
  })

  it('removing clears the cache before the list, so a crash in between loses nothing to anyone', async () => {
    const a = await accounts.add({ provider: 'gmail', email: 'a@gmail.com', password: GMAIL_PASSWORD })
    const id = a.ok ? a.account.id : ''
    mail.accountStore(id).saveHeaders([header(1)])
    const order: string[] = []
    const clear = vi.spyOn(MailStore.prototype, 'clear').mockImplementation(function (this: {
      accountId: string
    }) {
      order.push(`clear ${this.accountId} listed=${account.listAccounts().some((x) => x.id === id)}`)
    })
    await accounts.remove(id)
    clear.mockRestore()
    expect(order[0]).toBe(`clear ${id} listed=true`)
    expect(account.listAccounts()).toEqual([])
  })

  it('Calendar keeps its iCloud account, and never switches to another one’s password by itself', async () => {
    const first = await accounts.add({
      provider: 'icloud',
      email: 'me@icloud.com',
      password: ICLOUD_PASSWORD,
    })
    logins.good.add('wxyz-wxyz-wxyz-wxyz')
    const second = await accounts.add({
      provider: 'icloud',
      email: 'partner@icloud.com',
      password: 'wxyz-wxyz-wxyz-wxyz',
    })
    const [i1, i2] = [first.ok ? first.account.id : '', second.ok ? second.account.id : '']
    expect(account.loadAccount()).toMatchObject({ id: i1, email: 'me@icloud.com' })
    expect(accounts.list().map((a) => a.calendar ?? false)).toEqual([true, false])
    await accounts.remove(i1)
    // Calendar's account is gone: no iCloud calendar, rather than the partner's.
    expect(account.loadAccount()).toBeNull()
    expect(accounts.list().find((a) => a.id === i2)?.calendar).toBeUndefined()
    // Adding an iCloud account again gives Calendar one, deliberately.
    const third = await accounts.add({
      provider: 'icloud',
      email: 'new@icloud.com',
      password: ICLOUD_PASSWORD,
    })
    expect(account.loadAccount()).toMatchObject({
      id: third.ok ? third.account.id : '',
      email: 'new@icloud.com',
    })
  })
})

describe('adding accounts', () => {
  const gmail = { provider: 'gmail', email: 'jo.work@gmail.com', password: GMAIL_PASSWORD } as const

  it('signs in with the preset’s servers, then saves it with a name and colour', async () => {
    const r = await accounts.add(gmail)
    expect(r).toMatchObject({
      ok: true,
      account: {
        label: 'Gmail',
        email: 'jo.work@gmail.com',
        provider: 'gmail',
        imap: { host: 'imap.gmail.com', port: 993, secure: true },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
        auth: { kind: 'password' },
      },
    })
    // The first account in an empty profile gets the id an old cache's rows belong to.
    expect(r.ok && r.account.id).toBe('acc-1')
    expect(logins.seen[0]).toMatchObject({
      host: 'imap.gmail.com',
      user: 'jo.work@gmail.com',
      requireTLS: false,
    })
    const second = await accounts.add({ ...gmail, email: 'jo.home@gmail.com', label: '  ' })
    expect(second).toMatchObject({ ok: true, account: { label: 'Gmail 2', color: 'purple' } })
    expect(JSON.stringify(accounts.list())).not.toContain(GMAIL_PASSWORD)
  })

  it('refuses what can’t work before signing in', async () => {
    const refused = async (input: unknown) => {
      const r = await accounts.add(input)
      expect(r.ok, JSON.stringify(input)).toBe(false)
      return r.ok ? '' : r.message
    }
    expect(await refused({ ...gmail, email: 'nope' })).toMatch(/email address/)
    expect(await refused({ provider: 'icloud', email: 'me@icloud.com', password: 'my apple id pw' })).toMatch(
      /abcd-efgh-ijkl-mnop/,
    )
    expect(await refused({ provider: 'outlook', email: 'me@outlook.com', password: 'x' })).toMatch(
      /Microsoft sign-in/,
    )
    expect(await refused({ provider: 'other', email: 'me@example.org', password: 'x' })).toMatch(
      /IMAP server/,
    )
    expect(
      await refused({
        provider: 'other',
        email: 'me@example.org',
        password: 'x',
        imap: { host: 'mail.example.org', port: 993, secure: true },
        smtp: { host: 'mail.example.org', port: 25, secure: false, requireTLS: false },
      }),
    ).toMatch(/encrypted/)
    expect(await refused({ ...gmail, extra: 'field' })).toBeTruthy()
    expect(logins.seen).toEqual([])
  })

  it('says what a wrong Gmail app password usually means, and saves nothing', async () => {
    const r = await accounts.add({ ...gmail, password: 'wrong' })
    expect(r).toMatchObject({ ok: false, error: 'auth' })
    expect(r.ok ? '' : r.message).toMatch(/app password .*2-Step Verification.*admin/)
    expect(accounts.list()).toEqual([])
  })

  it('adds an Other account with the servers typed in, requiring STARTTLS without TLS', async () => {
    const r = await accounts.add({
      provider: 'other',
      email: 'me@example.org',
      password: GMAIL_PASSWORD,
      imap: { host: 'mail.example.org', port: 143, secure: false },
      smtp: { host: 'mail.example.org', port: 587, secure: false, requireTLS: true },
    })
    expect(r).toMatchObject({ ok: true, account: { label: 'Other', imap: { port: 143, secure: false } } })
    expect(logins.seen[0]).toMatchObject({ host: 'mail.example.org', port: 143, requireTLS: true })
  })

  it('refuses the same account twice', async () => {
    await accounts.add(gmail)
    expect(await accounts.add({ ...gmail, email: 'JO.WORK@gmail.com' })).toMatchObject({
      ok: false,
      error: 'invalid',
    })
  })

  it('tests details or a saved account without saving anything', async () => {
    expect(await accounts.test(gmail)).toMatchObject({ ok: true })
    expect(accounts.list()).toEqual([])
    const added = await accounts.add(gmail)
    expect(await accounts.test({ id: added.ok ? added.account.id : '' })).toMatchObject({ ok: true })
    expect(await accounts.test({ id: 'acc-none' })).toMatchObject({ ok: false, error: 'invalid' })
  })
})

describe('changing and removing accounts', () => {
  it('renames and recolours, and checks a new password by signing in with it', async () => {
    const a = await accounts.add({ provider: 'gmail', email: 'jo@gmail.com', password: GMAIL_PASSWORD })
    const id = a.ok ? a.account.id : ''
    expect(accounts.update({ id, label: 'Work', color: 'green' })).toMatchObject({
      ok: true,
      account: { label: 'Work', color: 'green' },
    })
    expect(accounts.update({ id, color: 'chartreuse' })).toMatchObject({ ok: false })
    expect(accounts.update({ id, label: 'x\ny' })).toMatchObject({ ok: false })
    expect(await accounts.setPassword({ id, password: 'wrong' })).toMatchObject({ ok: false, error: 'auth' })
    expect(account.readSecret(id)).toBe(GMAIL_PASSWORD)
    logins.good.add('newpasswordabcd')
    expect(await accounts.setPassword({ id, password: 'newpasswordabcd' })).toMatchObject({ ok: true })
    expect(account.readSecret(id)).toBe('newpasswordabcd')
  })

  it('removing one account forgets only its password and mail; the last one clears everything', async () => {
    const icloud = await accounts.add({
      provider: 'icloud',
      email: 'me@icloud.com',
      password: ICLOUD_PASSWORD,
    })
    const work = await accounts.add({ provider: 'gmail', email: 'jo@gmail.com', password: GMAIL_PASSWORD })
    const [i, w] = [icloud.ok ? icloud.account.id : '', work.ok ? work.account.id : '']
    mail.accountStore(i).saveHeaders([header(1), header(2)])
    mail.accountStore(w).saveHeaders([header(1, { subject: 'Standup' })])
    mail
      .mailStore()
      .saveAiCategories(
        'm',
        new Map([['a@x.example', { category: 'promotions', confidence: 1, fingerprint: 'f' }]]),
      )
    expect(accounts.list().map((a) => [a.label, a.messageCount])).toEqual([
      ['iCloud', 2],
      ['Gmail', 1],
    ])
    await accounts.remove(w)
    expect(accounts.list().map((a) => a.id)).toEqual([i])
    expect(mail.accountStore(i).count('INBOX')).toBe(2)
    expect(mail.accountStore(w).count('INBOX')).toBe(0)
    expect(mail.mailStore().getAiCategories('m', ['a@x.example']).size).toBe(1)
    await accounts.remove(i)
    expect(mail.mailStore().cachedAccounts()).toEqual([])
    expect(mail.mailStore().getAiCategories('m', ['a@x.example']).size).toBe(0)
    expect(mail.status()).toEqual({ connected: false })
  })
})

describe('the mail client with several accounts', () => {
  const two = async () => {
    const icloud = await accounts.add({
      provider: 'icloud',
      email: 'me@icloud.com',
      password: ICLOUD_PASSWORD,
    })
    const work = await accounts.add({ provider: 'gmail', email: 'jo@gmail.com', password: GMAIL_PASSWORD })
    const i = icloud.ok ? icloud.account.id : ''
    const w = work.ok ? work.account.id : ''
    mail.accountStore(i).saveHeaders([header(1, { subject: 'Dinner pineapple' }), header(3)])
    mail.accountStore(i).saveMailboxes([
      { path: 'INBOX', name: 'Inbox', role: 'inbox', delimiter: '/', total: 2, unread: 2 },
      { path: 'Archive', name: 'Archive', role: 'archive', delimiter: '/', total: 0, unread: 0 },
    ])
    mail.accountStore(w).saveHeaders([header(2, { subject: 'Standup pineapple' }), header(1)])
    mail.accountStore(w).saveMailboxes([
      { path: 'INBOX', name: 'Inbox', role: 'inbox', delimiter: '/', total: 2, unread: 2 },
      { path: '[Gmail]/All Mail', name: 'All Mail', role: 'all', delimiter: '/', total: 9, unread: 0 },
      { path: '[Gmail]/Bin', name: 'Bin', role: 'trash', delimiter: '/', total: 0, unread: 0 },
    ])
    return { i, w }
  }

  it('lists every account’s inbox together, newest first, each row with its account', async () => {
    const { i, w } = await two()
    const all = client.messages({ account: 'all', mailbox: 'INBOX' })
    expect(all.total).toBe(4)
    expect(all.messages.map((m) => [m.account, m.uid])).toEqual([
      [i, 3],
      [w, 2],
      [i, 1],
      [w, 1],
    ])
    expect(client.messages({ account: w, mailbox: 'INBOX' }).messages.map((m) => m.uid)).toEqual([2, 1])
    // No account named: the first one, as callers from before several accounts meant.
    expect(client.messages({ mailbox: 'INBOX' }).messages.every((m) => m.account === i)).toBe(true)
    expect(client.messages({ account: 'acc-gone', mailbox: 'INBOX' })).toEqual({ total: 0, messages: [] })
  })

  it('searches every account, or one', async () => {
    const { w } = await two()
    expect(client.search({ query: 'pineapple' }).map((m) => m.subject)).toEqual([
      'Standup pineapple',
      'Dinner pineapple',
    ])
    expect(client.search({ query: 'pineapple', account: w }).map((m) => m.subject)).toEqual([
      'Standup pineapple',
    ])
  })

  it('keeps folders apart: Gmail archives to All Mail and bins to its \\Trash folder', async () => {
    const { i, w } = await two()
    expect(client.mailboxes({ account: w }).map((m) => m.path)).toEqual([
      'INBOX',
      '[Gmail]/All Mail',
      '[Gmail]/Bin',
    ])
    expect(client.mailboxes().map((m) => m.path)).toEqual(['INBOX', 'Archive'])
    expect(client.moveDestination('archive', w)).toMatchObject({ ok: true, path: '[Gmail]/All Mail' })
    expect(client.moveDestination('trash', w)).toMatchObject({ ok: true, path: '[Gmail]/Bin', name: 'Bin' })
    expect(client.moveDestination('archive', i)).toMatchObject({ ok: true, path: 'Archive' })
    // A folder of one account can't be named in another.
    expect(client.moveDestination({ folder: '[Gmail]/All Mail' }, i)).toMatchObject({ ok: false })
    expect(client.cached({ account: w, mailbox: 'INBOX', uid: 2 })).toMatchObject({
      subject: 'Standup pineapple',
    })
    expect(client.cached({ account: i, mailbox: 'INBOX', uid: 2 })).toBeNull()
  })

  it('replies only from the account the message arrived in', async () => {
    const { i, w } = await two()
    const r = await client.send({
      account: i,
      to: 'sam@friend.example',
      cc: '',
      bcc: '',
      subject: 'Re: Standup',
      body: 'Hi',
      attachments: [],
      replyTo: { account: w, mailbox: 'INBOX', uid: 2 },
    })
    expect(r).toEqual({
      ok: false,
      error: 'invalid',
      message: 'A reply is sent from the account the message arrived in.',
    })
    expect(
      await client.saveDraft({
        account: w,
        to: '',
        cc: '',
        bcc: '',
        subject: 'x',
        body: 'x',
        attachments: [],
        draft: { account: i, mailbox: 'Drafts', uid: 9 },
      }),
    ).toMatchObject({ ok: false, message: 'A draft is sent from the account it was saved in.' })
    expect(
      await client.send({
        account: 'acc-none',
        to: 'a@b.example',
        cc: '',
        bcc: '',
        subject: 'x',
        body: 'x',
        attachments: [],
      }),
    ).toMatchObject({
      ok: false,
      error: 'not-found',
    })
  })

  it('checking every inbox reports each account that failed, without stopping the others', async () => {
    await two()
    // Nothing can connect here (no server, fake keychain): both fail, each with its own message.
    const r = await client.refresh({ account: 'all', mailbox: 'INBOX' })
    expect(r).toMatchObject({ ok: true, added: 0 })
    expect(r.ok && r.failed?.map((f) => f.error)).toHaveLength(2)
    expect(accounts.list().every((a) => a.sync.message && a.sync.retryAt)).toBe(true)
    // The window's own timer skips accounts backing off; pressing refresh tries them again.
    const auto = await client.refresh({ account: 'all', mailbox: 'INBOX' }, undefined, { manual: false })
    expect(auto.ok && auto.failed?.every((f) => f.error === 'busy')).toBe(true)
    expect(await client.refresh({ account: 'all', mailbox: 'Archive' })).toMatchObject({
      ok: false,
      error: 'invalid',
    })
  })
})
