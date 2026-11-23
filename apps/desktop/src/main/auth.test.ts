import { describe, expect, it, vi, beforeEach } from 'vitest'
import { MailAuthError, MailConnectionError, type MailCredentials } from '@ordo/mail-core/node'
import { PROVIDERS } from '@ordo/mail-core'
import type { MailAccount } from '@ordo/shared'
import { GoogleReauthError, GoogleScopeError } from './google/auth'
import { OAuthError } from './google/oauth'

// The sign-in seam on its own: which credentials each kind of account gets, how Google's refusals
// become "Sign in again", and the one retry with a refreshed token. The Google module and the
// accounts file are replaced by stubs.

const google = vi.hoisted(() => ({ token: vi.fn() }))
vi.mock('./google', async () => ({
  ...(await import('./google/oauth')),
  GoogleReauthError: (await import('./google/auth')).GoogleReauthError,
  GoogleScopeError: (await import('./google/auth')).GoogleScopeError,
  getGoogleAccessToken: google.token,
}))
const secrets = vi.hoisted(() => new Map<string, string>())
vi.mock('./account', () => ({ readSecret: (id: string) => secrets.get(id) ?? null }))

const { getCredentials, isAuthFailure, SignInAgainError, withCredentials } = await import('./auth')

const gmail = PROVIDERS.gmail
const oauth: MailAccount = {
  id: 'acc-2',
  label: 'Work',
  email: 'jo@gmail.example',
  color: 'red',
  provider: 'gmail',
  imap: { ...gmail.imap! },
  smtp: { ...gmail.smtp! },
  auth: { kind: 'oauth', provider: 'google', googleAccountId: '1234' },
  lastScan: null,
}
const password: MailAccount = { ...oauth, id: 'acc-1', auth: { kind: 'password' } }

/** imapflow's error for NO [AUTHENTICATIONFAILED]. */
const imapRefused = () =>
  Object.assign(new Error('Command failed'), {
    authenticationFailed: true,
    serverResponseCode: 'AUTHENTICATIONFAILED',
  })
/** nodemailer's error for 535 after AUTH XOAUTH2. */
const smtpRefused = () => Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 })

beforeEach(() => {
  google.token.mockReset()
  secrets.clear()
})

describe('credentials for each kind of account', () => {
  it('gives a password account its saved password, and refuses when it can’t be read', async () => {
    secrets.set('acc-1', 'abcd efgh ijkl mnop')
    expect(await getCredentials(password)).toEqual({ user: oauth.email, pass: 'abcd efgh ijkl mnop' })
    secrets.clear()
    await expect(getCredentials(password)).rejects.toBeInstanceOf(MailAuthError)
    expect(google.token).not.toHaveBeenCalled()
  })

  it('gives a Google sign-in an access token for the mail scope, never a password', async () => {
    secrets.set('acc-2', 'should never be used')
    google.token.mockResolvedValue('ya29.token')
    expect(await getCredentials(oauth)).toEqual({ user: oauth.email, accessToken: 'ya29.token' })
    expect(google.token).toHaveBeenCalledWith('1234', ['https://mail.google.com/'], { refresh: false })
    await getCredentials(oauth, { refresh: true })
    expect(google.token).toHaveBeenLastCalledWith('1234', ['https://mail.google.com/'], { refresh: true })
  })

  it('only hands a Google token to Gmail’s own servers', async () => {
    google.token.mockResolvedValue('ya29.token')
    for (const bad of [
      { ...oauth, imap: { host: 'imap.evil.example', port: 993, secure: true } },
      { ...oauth, smtp: { host: 'smtp.evil.example', port: 465, secure: true, requireTLS: false } },
    ])
      await expect(getCredentials(bad)).rejects.toBeInstanceOf(MailAuthError)
    expect(google.token).not.toHaveBeenCalled()
  })

  it('turns Google’s refusals into Sign in again, and an offline token server into a connection error', async () => {
    const cases: [Error, string][] = [
      [new GoogleReauthError(oauth.email), 'reauth'],
      [new GoogleScopeError(oauth.email, ['https://mail.google.com/']), 'scope'],
      [new OAuthError('invalid-grant', 'That Google account isn’t connected to Ordo.'), 'gone'],
    ]
    for (const [err, reason] of cases) {
      google.token.mockRejectedValueOnce(err)
      const thrown = await getCredentials(oauth).catch((e: unknown) => e)
      expect(thrown).toBeInstanceOf(SignInAgainError)
      expect(thrown).toBeInstanceOf(MailAuthError)
      expect(thrown).toMatchObject({ reason, message: expect.stringContaining('Sign in again') })
    }
    google.token.mockRejectedValueOnce(new OAuthError('network', 'Couldn’t reach Google.'))
    await expect(getCredentials(oauth)).rejects.toBeInstanceOf(MailConnectionError)
  })
})

describe('signing in with one retry', () => {
  it('refreshes a refused Google token once and tries again (IMAP and SMTP)', async () => {
    for (const refused of [imapRefused, smtpRefused]) {
      google.token.mockReset()
      google.token.mockResolvedValueOnce('old').mockResolvedValueOnce('new')
      const fn = vi.fn(async (c: MailCredentials) => {
        if ('accessToken' in c && c.accessToken === 'old') throw refused()
        return 'signed in'
      })
      expect(await withCredentials(oauth, fn)).toBe('signed in')
      expect(fn).toHaveBeenCalledTimes(2)
      expect(google.token.mock.calls.map((c) => c[2])).toEqual([{ refresh: false }, { refresh: true }])
    }
  })

  it('tries no more than twice', async () => {
    google.token.mockResolvedValue('any')
    const fn = vi.fn(async () => {
      throw imapRefused()
    })
    await expect(withCredentials(oauth, fn)).rejects.toMatchObject({ authenticationFailed: true })
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('doesn’t retry a password, a network failure or Google asking to sign in again', async () => {
    secrets.set('acc-1', 'pw')
    const refusedPassword = vi.fn(async () => {
      throw imapRefused()
    })
    await expect(withCredentials(password, refusedPassword)).rejects.toBeTruthy()
    expect(refusedPassword).toHaveBeenCalledTimes(1)

    google.token.mockResolvedValue('t')
    const offline = vi.fn(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    })
    await expect(withCredentials(oauth, offline)).rejects.toBeTruthy()
    expect(offline).toHaveBeenCalledTimes(1)

    google.token.mockReset()
    google.token.mockResolvedValueOnce('t').mockRejectedValueOnce(new GoogleReauthError(oauth.email))
    const fn = vi.fn(async () => {
      throw imapRefused()
    })
    await expect(withCredentials(oauth, fn)).rejects.toBeInstanceOf(SignInAgainError)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('knows a refused sign-in when it sees one', () => {
    expect(isAuthFailure(imapRefused())).toBe(true)
    expect(isAuthFailure(smtpRefused())).toBe(true)
    expect(isAuthFailure(new MailAuthError('Authentication failed'))).toBe(true)
    expect(isAuthFailure(new SignInAgainError('again', 'reauth'))).toBe(false)
    expect(isAuthFailure(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe(false)
  })
})
