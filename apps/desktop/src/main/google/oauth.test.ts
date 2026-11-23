import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakeGoogle, type FakeGoogle } from '../../../../../test/fake-google'
import {
  authUrl,
  CALENDAR_SCOPES,
  endpointsAt,
  exchangeCode,
  GOOGLE_ENDPOINTS,
  listenForCode,
  OAuthError,
  pkcePair,
  readIdToken,
  refreshAccessToken,
  revokeToken,
  SCOPES,
} from './oauth'

/** A GET with a Host header of our choosing, as a web page in the browser might send. */
function get(url: string, host?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: host ? { host } : {} }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => (body += c.toString()))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('PKCE and the consent URL', () => {
  it('makes an S256 challenge from a 43-character verifier', () => {
    const { verifier, challenge } = pkcePair()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
    expect(pkcePair().verifier).not.toBe(verifier)
  })

  it('asks Google for a code with PKCE, offline access, and the least calendar scopes', () => {
    const url = new URL(
      authUrl(GOOGLE_ENDPOINTS, {
        clientId: 'id',
        redirectUri: 'http://127.0.0.1:5000/callback',
        scopes: CALENDAR_SCOPES,
        challenge: 'c',
        state: 's',
        loginHint: 'me@work.example',
      }),
    )
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'id',
      redirect_uri: 'http://127.0.0.1:5000/callback',
      response_type: 'code',
      scope:
        'openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events',
      code_challenge: 'c',
      code_challenge_method: 'S256',
      state: 's',
      access_type: 'offline',
      prompt: 'select_account consent',
      login_hint: 'me@work.example',
    })
    expect(CALENDAR_SCOPES).not.toContain(SCOPES.mail)
    expect(CALENDAR_SCOPES).not.toContain('https://www.googleapis.com/auth/calendar')
  })
})

describe('the loopback listener', () => {
  it('listens on 127.0.0.1 and accepts the code once, with the right state', async () => {
    const l = await listenForCode({ state: 'right' })
    expect(l.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    const ok = await get(`${l.redirectUri}?state=right&code=abc`)
    expect(ok.status).toBe(200)
    expect(ok.body).toContain('signed in')
    await expect(l.code).resolves.toBe('abc')
    // Single use: it has stopped listening.
    await expect(get(`${l.redirectUri}?state=right&code=again`)).rejects.toThrow()
  })

  it('refuses the wrong state and keeps waiting for the right one', async () => {
    const l = await listenForCode({ state: 'right' })
    const bad = await get(`${l.redirectUri}?state=wrong&code=evil`)
    expect(bad.status).toBe(400)
    const missing = await get(`${l.redirectUri}?code=evil`)
    expect(missing.status).toBe(400)
    await get(`${l.redirectUri}?state=right&code=good`)
    await expect(l.code).resolves.toBe('good')
  })

  it('refuses another Host (DNS rebinding) and other paths', async () => {
    const l = await listenForCode({ state: 's' })
    const port = new URL(l.redirectUri).port
    expect((await get(`${l.redirectUri}?state=s&code=x`, `evil.example:${port}`)).status).toBe(400)
    expect((await get(`http://127.0.0.1:${port}/other?state=s&code=x`)).status).toBe(404)
    l.close()
  })

  it('turns Google’s errors into ones people understand', async () => {
    const denied = await listenForCode({ state: 's' })
    await get(`${denied.redirectUri}?state=s&error=access_denied`)
    await expect(denied.code).rejects.toMatchObject({ code: 'denied' })
    const blocked = await listenForCode({ state: 's' })
    await get(`${blocked.redirectUri}?state=s&error=admin_policy_enforced`)
    await expect(blocked.code).rejects.toMatchObject({
      code: 'admin-blocked',
      message: /Workspace administrator/,
    })
  })

  it('gives up after the timeout, and when cancelled', async () => {
    const slow = await listenForCode({ state: 's', timeoutMs: 20 })
    await expect(slow.code).rejects.toMatchObject({ code: 'timeout' })
    await expect(get(`${slow.redirectUri}?state=s&code=late`)).rejects.toThrow()
    const ctrl = new AbortController()
    const cancelled = await listenForCode({ state: 's', signal: ctrl.signal })
    ctrl.abort()
    await expect(cancelled.code).rejects.toBeInstanceOf(OAuthError)
  })
})

describe('the token endpoint', () => {
  let fake: FakeGoogle
  beforeEach(async () => {
    fake = await startFakeGoogle()
  })
  afterEach(() => fake.stop())

  const f = (url: string, init: RequestInit) => fetch(url, init)

  it('exchanges a code with its PKCE verifier, and refuses the wrong verifier', async () => {
    const ep = endpointsAt(fake.base)
    const { verifier, challenge } = pkcePair()
    const l = await listenForCode({ state: 's' })
    const consent = await fetch(
      authUrl(ep, {
        clientId: fake.clientId,
        redirectUri: l.redirectUri,
        scopes: CALENDAR_SCOPES,
        challenge,
        state: 's',
      }),
      { redirect: 'manual' },
    )
    await fetch(consent.headers.get('location')!)
    const code = await l.code
    const t = await exchangeCode(ep, f, {
      clientId: fake.clientId,
      clientSecret: fake.clientSecret,
      code,
      verifier,
      redirectUri: l.redirectUri,
    })
    expect(t.refreshToken).toMatch(/^rt-/)
    expect(t.scopes).toEqual([...CALENDAR_SCOPES])
    expect(readIdToken(t.idToken)).toEqual({ sub: fake.account.sub, email: fake.account.email })
    // The code was used once.
    await expect(
      exchangeCode(ep, f, { clientId: fake.clientId, code, verifier, redirectUri: l.redirectUri }),
    ).rejects.toMatchObject({ code: 'invalid-grant' })
  })

  it('refreshes, and reports a revoked refresh token as invalid_grant', async () => {
    const ep = endpointsAt(fake.base)
    const { refresh } = fake.grant()
    const t = await refreshAccessToken(ep, f, { clientId: fake.clientId, refreshToken: refresh })
    expect(t.accessToken).toMatch(/^at-/)
    expect(await revokeToken(ep, f, refresh)).toBe(true)
    await expect(
      refreshAccessToken(ep, f, { clientId: fake.clientId, refreshToken: refresh }),
    ).rejects.toMatchObject({
      code: 'invalid-grant',
    })
    await expect(refreshAccessToken(ep, f, { clientId: 'wrong', refreshToken: 'x' })).rejects.toMatchObject({
      code: 'invalid-client',
    })
  })

  it('reads only well-formed ID tokens', () => {
    expect(readIdToken(undefined)).toBeNull()
    expect(readIdToken('a.b.c')).toBeNull()
    const payload = Buffer.from(JSON.stringify({ sub: '1 2', email: 'x@y.z' })).toString('base64url')
    expect(readIdToken(`h.${payload}.s`)).toBeNull()
  })
})
