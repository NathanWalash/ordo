import { afterAll, describe, expect, it } from 'vitest'
import { parseXoauth2, startFakeXoauth2Mail } from '../../../test/fake-xoauth2'
import { authOf, ImapMailProvider, MailAuthError, testImapLogin } from './imap'
import { sendMessage, smtpAuth } from './smtp'

// Signing in with an OAuth access token (Gmail's Sign in with Google): the exact auth objects
// handed to imapflow and nodemailer, and the SASL XOAUTH2 exchange they produce against a local
// server that speaks it the way Google documents
// (https://developers.google.com/workspace/gmail/imap/xoauth2-protocol).

const USER = 'jo@gmail.example'
const TOKEN = 'ya29.a0-good-token'
const server = await startFakeXoauth2Mail((user, token) => user === USER && token === TOKEN)
afterAll(() => server.stop())

const imap = (accessToken: string) => ({
  host: '127.0.0.1',
  port: server.imapPort,
  secure: false,
  user: USER,
  accessToken,
})
const smtp = (accessToken: string) => ({
  host: '127.0.0.1',
  port: server.smtpPort,
  secure: false,
  requireTLS: false,
  user: USER,
  accessToken,
})
const message = {
  from: { address: USER },
  to: [{ address: 'friend@example.test' }],
  cc: [],
  bcc: [],
  subject: 'Hello',
  text: 'Hi',
  attachments: [],
}

describe('OAuth sign-in objects', () => {
  it('prefers an access token over a password, and refuses neither', () => {
    expect(authOf({ user: USER, pass: 'pw', accessToken: TOKEN })).toEqual({ user: USER, accessToken: TOKEN })
    expect(authOf({ user: USER, pass: 'pw' })).toEqual({ user: USER, pass: 'pw' })
    expect(() => authOf({ user: USER })).toThrow(MailAuthError)
  })

  it('gives nodemailer OAuth2 with the token, and no way to reuse a refused one', () => {
    const auth = smtpAuth({ ...smtp(TOKEN) })
    expect(auth).toMatchObject({ type: 'OAuth2', user: USER, accessToken: TOKEN })
    expect(auth).not.toHaveProperty('pass')
    let refused: Error | null = null
    if ('provisionCallback' in auth) auth.provisionCallback?.(USER, true, (e) => (refused = e))
    expect(refused).toBeInstanceOf(Error)
    expect(smtpAuth({ ...smtp(''), accessToken: undefined, pass: 'pw' })).toEqual({ user: USER, pass: 'pw' })
  })

  it('reads the XOAUTH2 initial response exactly as Google documents it', () => {
    const b64 = Buffer.from(`user=${USER}\x01auth=Bearer ${TOKEN}\x01\x01`).toString('base64')
    expect(parseXoauth2(b64)).toEqual({ user: USER, token: TOKEN })
    expect(
      parseXoauth2(Buffer.from(`user=${USER}\x01auth=Bearer ${TOKEN}\x01`).toString('base64')),
    ).toBeNull()
    expect(parseXoauth2(Buffer.from(`\x00${USER}\x00${TOKEN}`).toString('base64'))).toBeNull()
  })
})

describe('the XOAUTH2 exchange against a local server', () => {
  it('signs in to IMAP with AUTHENTICATE XOAUTH2', async () => {
    server.attempts = []
    await testImapLogin(imap(TOKEN))
    expect(server.malformed).toEqual([])
    expect(server.attempts).toEqual([{ protocol: 'imap', user: USER, token: TOKEN, ok: true }])
  })

  it('answers a refused token’s challenge with an empty line and reports an auth failure', async () => {
    server.attempts = []
    const p = new ImapMailProvider(imap('expired'))
    await expect(p.connect()).rejects.toBeInstanceOf(MailAuthError)
    await p.close().catch(() => {})
    expect(server.attempts).toEqual([{ protocol: 'imap', user: USER, token: 'expired', ok: false }])
  })

  it('uses OAUTHBEARER when the server offers it too (as Gmail does), failing a refused token cleanly', async () => {
    const both = await startFakeXoauth2Mail((user, token) => user === USER && token === TOKEN, {
      oauthbearer: true,
    })
    try {
      const cfg = (accessToken: string) => ({ ...imap(accessToken), port: both.imapPort })
      await testImapLogin(cfg(TOKEN))
      const p = new ImapMailProvider(cfg('expired'))
      await expect(p.connect()).rejects.toBeInstanceOf(MailAuthError)
      await p.close().catch(() => {})
      expect(both.mechanisms).toEqual(['OAUTHBEARER', 'OAUTHBEARER'])
      expect(both.malformed).toEqual([])
      expect(both.attempts.map((a) => [a.user, a.token, a.ok])).toEqual([
        [USER, TOKEN, true],
        [USER, 'expired', false],
      ])
    } finally {
      await both.stop()
    }
  })

  it('sends over SMTP with AUTH XOAUTH2', async () => {
    server.attempts = []
    server.sent = []
    await sendMessage(smtp(TOKEN), message)
    expect(server.attempts).toEqual([{ protocol: 'smtp', user: USER, token: TOKEN, ok: true }])
    expect(server.sent).toHaveLength(1)
  })

  it('fails a refused SMTP token at once with EAUTH, sending nothing and not trying it twice', async () => {
    server.attempts = []
    server.sent = []
    await expect(sendMessage(smtp('expired'), message)).rejects.toMatchObject({ code: 'EAUTH' })
    expect(server.attempts.map((a) => a.ok)).toEqual([false])
    expect(server.sent).toEqual([])
  })
})
