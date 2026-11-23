import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendMessage } from '@ordo/mail-core/node'
import { startFakeGoogle } from '../../../../test/fake-google'
import { startFakeXoauth2Mail } from '../../../../test/fake-xoauth2'

// Gmail with Sign in with Google, in the main process, against a fake Google (consent, tokens,
// revoke) and a fake Gmail on 127.0.0.1 that signs in only with SASL XOAUTH2, through the real
// imapflow and nodemailer: adding an account, refreshing a refused token once, Google refusing the
// sign-in, signing in again, and signing out of Google with mail accounts linked. Electron is a
// temp profile and a fake keychain. Nothing reaches Google or Gmail.

const dir = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => dir.path, isPackaged: false, on: vi.fn() },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  powerMonitor: { on: vi.fn() },
  dialog: {},
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().slice('enc:'.length),
  },
}))

dir.path = mkdtempSync(join(tmpdir(), 'ordo-gmail-oauth-'))
const MAIL = 'https://mail.google.com/'
const google = await startFakeGoogle()
/** Gmail accepts a live access token with mail access, for the account it belongs to. */
let gmailUp = true
const gmail = await startFakeXoauth2Mail((user, token) => {
  const t = google.accessTokens.get(token)
  return gmailUp && !!t && t.scope.split(' ').includes(MAIL) && t.account.email === user
})
process.env['ORDO_GOOGLE_BASE_URL'] = google.base
process.env['ORDO_TEST_GOOGLE_AUTO_CONSENT'] = '1'
process.env['ORDO_IMAP_HOST'] = '127.0.0.1'
process.env['ORDO_IMAP_PORT'] = String(gmail.imapPort)
process.env['ORDO_SMTP_HOST'] = '127.0.0.1'
process.env['ORDO_SMTP_PORT'] = String(gmail.smtpPort)

const account = await import('./account')
const accounts = await import('./accounts')
const mail = await import('./mail')
const calendar = await import('./calendar')
const { googleAuth } = await import('./google')
const { openExternal } = (await import('electron')).shell

const ME = google.account
const OTHER = { sub: '2222222222', email: 'someone.else@gmail.example' }

/** The scopes the last consent page asked for. */
const consentScopes = () =>
  google.requests
    .filter((r) => r.path === '/o/oauth2/v2/auth')
    .at(-1)
    ?.query['scope']?.split(' ')
    .sort()

beforeEach(async () => {
  account.deleteAccount()
  await mail.disconnect()
  for (const g of googleAuth().accounts()) await googleAuth().signOut(g.id)
  google.account = { ...ME }
  gmail.attempts = []
  gmail.sent = []
  gmailUp = true
})
afterAll(async () => {
  calendar.closeCalendar()
  mail.closeMail()
  await gmail.stop()
  await google.stop()
})

describe('adding Gmail with Sign in with Google', () => {
  it('asks for an OAuth client in Settings → Google first', async () => {
    expect(accounts.list()).toEqual([])
    const { googleMailOptions } = await import('./google-mail')
    expect(googleMailOptions()).toEqual({ secureStorage: true, configured: false, accounts: [] })
    expect(await import('./google-mail').then((m) => m.addGoogle({}))).toMatchObject({
      ok: false,
      error: 'invalid',
      message: expect.stringContaining('Settings → Google'),
    })
    expect(
      calendar.setGoogleClient({ clientId: google.clientId, clientSecret: google.clientSecret }),
    ).toEqual({
      ok: true,
    })
  })

  it('signs in for mail only, checks Gmail takes the token with XOAUTH2, then saves the account', async () => {
    const { addGoogle, googleMailOptions } = await import('./google-mail')
    const r = await addGoogle({ label: 'Work' })
    expect(r).toMatchObject({
      ok: true,
      account: {
        label: 'Work',
        email: ME.email,
        provider: 'gmail',
        imap: { host: 'imap.gmail.com', port: 993, secure: true },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
        auth: { kind: 'oauth', provider: 'google', googleAccountId: ME.sub },
      },
    })
    // The browser was never opened (the test hook followed the fake's consent).
    expect(openExternal).not.toHaveBeenCalled()
    // Least privilege: who you are and mail, not Calendar.
    expect(consentScopes()).toEqual(['email', MAIL, 'openid'].sort())
    // Gmail saw the account's own address and a token Google issued, in XOAUTH2's exact format.
    expect(gmail.malformed).toEqual([])
    expect(gmail.attempts).toEqual([
      { protocol: 'imap', user: ME.email, token: expect.any(String), ok: true },
    ])
    // No secret in accounts.json: the tokens stay in the Google module's file.
    const file = readFileSync(join(dir.path, 'accounts.json'), 'utf8')
    expect(file).not.toMatch(/"secret"|rt-|at-/)
    expect(JSON.parse(file).accounts[0].auth).toEqual({
      kind: 'oauth',
      provider: 'google',
      googleAccountId: ME.sub,
    })
    expect(googleMailOptions().accounts).toEqual([
      { id: ME.sub, email: ME.email, hasMail: true, needsReauth: false, inUse: true },
    ])
    // Settings → Google shows it as Mail's, not Calendar's; Calendar leaves it alone.
    expect(calendar.googleStatus().accounts).toEqual([
      {
        id: ME.sub,
        email: ME.email,
        needsReauth: false,
        calendars: 0,
        calendar: false,
        mailAccounts: [{ id: r.ok ? r.account.id : '', label: 'Work', email: ME.email }],
      },
    ])
    expect(calendar.status()).toMatchObject({ google: 0 })
  })

  it('refuses the same Google account twice, and an address already added with an app password', async () => {
    const { addGoogle } = await import('./google-mail')
    expect(await addGoogle({})).toMatchObject({ ok: true })
    expect(await addGoogle({ googleAccountId: ME.sub })).toMatchObject({ ok: false, error: 'invalid' })
    expect(await addGoogle({})).toMatchObject({
      ok: false,
      message: expect.stringContaining('already in Ordo'),
    })
    expect(accounts.list()).toHaveLength(1)
  })

  it('saves nothing when Gmail refuses, and forgets a Google sign-in made just for it', async () => {
    const { addGoogle } = await import('./google-mail')
    gmailUp = false
    const r = await addGoogle({})
    expect(r).toMatchObject({ ok: false, error: 'auth', message: expect.stringContaining('admin') })
    expect(accounts.list()).toEqual([])
    expect(googleAuth().accounts()).toEqual([])
    expect(google.revoked.length).toBeGreaterThan(0)
    // The new token was refused, so a refreshed one was tried once more, and no more than that.
    expect(gmail.attempts.map((a) => a.ok)).toEqual([false, false])
    expect(gmail.attempts[0]!.token).not.toBe(gmail.attempts[1]!.token)
  })

  it('asks a Google account connected for Calendar for mail too, keeping Calendar', async () => {
    const { addGoogle, googleMailOptions } = await import('./google-mail')
    expect(await calendar.connectGoogle(undefined)).toMatchObject({ ok: true })
    expect(googleMailOptions().accounts).toEqual([
      { id: ME.sub, email: ME.email, hasMail: false, needsReauth: false, inUse: false },
    ])
    const r = await addGoogle({ googleAccountId: ME.sub })
    expect(r).toMatchObject({ ok: true, account: { auth: { googleAccountId: ME.sub } } })
    // One consent for everything the account had plus mail (no incremental auth for desktop apps).
    expect(consentScopes()).toContain(MAIL)
    expect(consentScopes()).toContain('https://www.googleapis.com/auth/calendar.events')
    const g = googleAuth().account(ME.sub)!
    expect(g.scopes).toEqual(
      expect.arrayContaining([MAIL, 'https://www.googleapis.com/auth/calendar.events']),
    )
    expect(calendar.googleStatus().accounts[0]).toMatchObject({ calendar: true, mailAccounts: [{}] })
  })

  it('refuses a sign-in to a different Google account than the one picked', async () => {
    const { addGoogle } = await import('./google-mail')
    expect(await calendar.connectGoogle(undefined)).toMatchObject({ ok: true })
    google.account = { ...OTHER }
    const r = await addGoogle({ googleAccountId: ME.sub })
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining(OTHER.email) })
    expect(
      googleAuth()
        .accounts()
        .map((a) => a.id),
    ).toEqual([ME.sub])
    expect(accounts.list()).toEqual([])
  })
})

describe('signing in to Gmail with a Google token', () => {
  async function added() {
    const { addGoogle } = await import('./google-mail')
    const r = await addGoogle({})
    if (!r.ok) throw new Error(r.message)
    gmail.attempts = []
    return r.account
  }

  it('refreshes a token Gmail refuses, once, then carries on', async () => {
    const a = await added()
    // Google's access tokens stop working (Ordo's cached one is still "valid" to it).
    google.expireAccessTokens()
    expect(await accounts.test({ id: a.id })).toMatchObject({ ok: true })
    expect(gmail.attempts.map((x) => x.ok)).toEqual([false, true])
    expect(gmail.attempts[0]!.token).not.toBe(gmail.attempts[1]!.token)
  })

  it('sends with XOAUTH2 over SMTP, refreshing a refused token once', async () => {
    const a = await added()
    google.expireAccessTokens()
    const sent = await mail.withSmtp(a, (cfg) =>
      sendMessage(cfg, {
        from: { address: a.email },
        to: [{ address: 'friend@example.test' }],
        cc: [],
        bcc: [],
        subject: 'Hello',
        text: 'Hi there',
        attachments: [],
      }),
    )
    expect(sent.rejected).toEqual([])
    expect(gmail.attempts.map((x) => [x.protocol, x.ok])).toEqual([
      ['smtp', false],
      ['smtp', true],
    ])
    // Sent once, after the second sign-in.
    expect(gmail.sent).toHaveLength(1)
    expect(gmail.sent[0]).toMatchObject({ from: a.email, to: ['friend@example.test'] })
  })

  it('says Sign in again when Google stops accepting the sign-in, and never tries anything else', async () => {
    const a = await added()
    // Revoked at Google (or a week passed with an app in Testing).
    google.refreshTokens.clear()
    google.expireAccessTokens()
    const outcome = await mail.scan(undefined, undefined, a.id)
    expect(outcome).toMatchObject({ ok: false, error: 'auth' })
    expect(!outcome.ok && outcome.message).toContain('Google stopped accepting Ordo’s sign-in')
    expect(accounts.list()[0]!.sync).toMatchObject({ error: 'auth', retryAt: expect.any(String) })
    expect(googleAuth().account(a.auth.kind === 'oauth' ? a.auth.googleAccountId : '')?.needsReauth).toBe(
      true,
    )
    // Gmail was tried with the old token once; no password, no other mechanism.
    expect(gmail.attempts.map((x) => x.ok)).toEqual([false])

    // Sign in again: the same Google account, mail access, and the account works at once.
    const { signInAgain } = await import('./google-mail')
    expect(await signInAgain({ id: a.id })).toMatchObject({ ok: true })
    expect(consentScopes()).toContain(MAIL)
    expect(accounts.list()[0]!.sync).toEqual({})
    expect(await mail.scan(undefined, undefined, a.id)).toMatchObject({ ok: true })
  })

  it('signs in again only as the same Google account', async () => {
    const a = await added()
    google.account = { ...OTHER }
    const { signInAgain } = await import('./google-mail')
    const r = await signInAgain({ id: a.id })
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining(`choose ${ME.email}`) })
    // The other account, new to Ordo, isn't kept.
    expect(
      googleAuth()
        .accounts()
        .map((g) => g.id),
    ).toEqual([ME.sub])
  })

  it('says so when the Google account never gave mail access', async () => {
    expect(await calendar.connectGoogle(undefined)).toMatchObject({ ok: true })
    const a = account.addStoredAccount(
      {
        label: 'Gmail',
        email: ME.email,
        color: 'red',
        provider: 'gmail',
        imap: { host: 'imap.gmail.com', port: 993, secure: true },
        smtp: { host: 'smtp.gmail.com', port: 465, secure: true, requireTLS: false },
        auth: { kind: 'oauth', provider: 'google', googleAccountId: ME.sub },
      },
      null,
    )
    expect(await accounts.test({ id: a.id })).toMatchObject({
      ok: false,
      error: 'auth',
      message: expect.stringContaining('permission to read and send mail'),
    })
    expect(gmail.attempts).toEqual([])
  })

  it('refuses a password for an account that signs in with Google', async () => {
    const a = await added()
    expect(await accounts.setPassword({ id: a.id, password: 'abcd efgh ijkl mnop' })).toMatchObject({
      ok: false,
      error: 'invalid',
    })
    const { signInAgain } = await import('./google-mail')
    expect(await signInAgain({ id: 'acc-none' }).then((r) => (r.ok ? '' : r.error))).toBe('invalid')
  })
})

describe('signing out of Google with mail accounts that use it', () => {
  async function added() {
    const { addGoogle } = await import('./google-mail')
    const r = await addGoogle({ label: 'Work' })
    if (!r.ok) throw new Error(r.message)
    return r.account
  }

  it('refuses until the mail accounts are confirmed, naming them', async () => {
    const a = await added()
    const r = await calendar.signOutGoogle(ME.sub)
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining(`Work (${ME.email})`) })
    expect(await calendar.signOutGoogle(ME.sub, { removeMail: ['acc-999'] })).toMatchObject({ ok: false })
    expect(accounts.list().map((x) => x.id)).toEqual([a.id])
    expect(googleAuth().account(ME.sub)).not.toBeNull()
  })

  it('removes the confirmed mail accounts (cache cleared, nothing on the server), then signs out', async () => {
    const a = await added()
    mail.accountStore(a.id).saveHeaders([
      {
        uid: 1,
        mailbox: 'INBOX',
        date: new Date(1_790_000_000_000),
        seen: false,
        from: { address: 'shop@example.test' },
        subject: 'Hi',
      },
    ])
    const revoked = google.revoked.length
    expect(await calendar.signOutGoogle(ME.sub, { removeMail: [a.id] })).toEqual({ ok: true })
    expect(accounts.list()).toEqual([])
    expect(mail.mailStore().cachedAccounts()).not.toContain(a.id)
    expect(googleAuth().accounts()).toEqual([])
    expect(google.revoked.length).toBe(revoked + 1)
  })

  it('removing the mail account leaves the Google sign-in alone (Calendar may use it)', async () => {
    const a = await added()
    const revoked = google.revoked.length
    await accounts.remove(a.id)
    expect(accounts.list()).toEqual([])
    expect(googleAuth().account(ME.sub)).toMatchObject({ scopes: expect.arrayContaining([MAIL]) })
    expect(google.revoked.length).toBe(revoked)
    // Adding it again needs no new consent: the mail access is still granted.
    const consents = google.requests.filter((r) => r.path === '/o/oauth2/v2/auth').length
    const { addGoogle } = await import('./google-mail')
    expect(await addGoogle({ googleAccountId: ME.sub })).toMatchObject({ ok: true })
    expect(google.requests.filter((r) => r.path === '/o/oauth2/v2/auth').length).toBe(consents)
  })
})
