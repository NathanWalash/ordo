import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakeGoogle, type FakeGoogle } from '../../../../../test/fake-google'
import { GoogleAuth, GoogleReauthError, GoogleScopeError, type SecretBox } from './auth'
import { googleFetch } from './fetch'
import { CALENDAR_SCOPES, endpointsAt, SCOPES } from './oauth'

/** Stands in for safeStorage: reversible, but nothing readable is left in the file. */
const box: SecretBox = {
  available: () => true,
  seal: (s) => `sealed:${Buffer.from(s).toString('base64').split('').reverse().join('')}`,
  open: (s) => Buffer.from(s.slice(7).split('').reverse().join(''), 'base64').toString(),
}

let fake: FakeGoogle
let dir: string
let auth: GoogleAuth
let opened: string[]
let now: number

/** The browser: open the consent page, which (in the fake) approves and redirects to Ordo. */
async function browser(url: string) {
  opened.push(url)
  const consent = await fetch(url, { redirect: 'manual' })
  void fetch(consent.headers.get('location')!).catch(() => {})
}

beforeEach(async () => {
  fake = await startFakeGoogle()
  dir = mkdtempSync(join(tmpdir(), 'ordo-google-'))
  opened = []
  now = Date.UTC(2026, 10, 23)
  const endpoints = endpointsAt(fake.base)
  auth = new GoogleAuth({
    file: join(dir, 'google.json'),
    box,
    endpoints,
    fetch: googleFetch(endpoints, (u, i) => fetch(u, i)),
    openExternal: browser,
    now: () => now,
  })
  auth.setClient(fake.clientId, fake.clientSecret)
})

afterEach(async () => {
  await fake.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('GoogleAuth', () => {
  it('signs in through the browser and keeps the refresh token encrypted', async () => {
    const a = await auth.signIn({ scopes: CALENDAR_SCOPES })
    expect(a).toEqual({
      id: fake.account.sub,
      email: fake.account.email,
      scopes: [...CALENDAR_SCOPES],
      needsReauth: false,
    })
    expect(opened[0]).toContain('code_challenge_method=S256')
    const file = readFileSync(join(dir, 'google.json'), 'utf8')
    expect(file).not.toMatch(/rt-|test-secret|at-/)
    expect(statSync(join(dir, 'google.json')).mode & 0o777).toBe(0o600)
    expect(auth.accounts()).toHaveLength(1)
    expect(auth.client()).toEqual({ clientId: fake.clientId, clientSecret: fake.clientSecret })
  })

  it('reuses the access token until it nearly expires, then refreshes it once for many callers', async () => {
    const a = await auth.signIn({ scopes: CALENDAR_SCOPES })
    const first = await auth.getAccessToken(a.id, [SCOPES.calendarEvents])
    expect(await auth.getAccessToken(a.id, [SCOPES.calendarEvents])).toBe(first)
    now += 3600_000
    const [x, y] = await Promise.all([
      auth.getAccessToken(a.id, [SCOPES.calendarEvents]),
      auth.getAccessToken(a.id, [SCOPES.calendarEvents]),
    ])
    expect(x).toBe(y)
    expect(x).not.toBe(first)
    expect(
      fake.requests.filter(
        (r) => r.path === '/token' && (r.body as Record<string, string>)['grant_type'] === 'refresh_token',
      ),
    ).toHaveLength(1)
    // An API refused it: a forced refresh.
    expect(await auth.getAccessToken(a.id, [], { refresh: true })).not.toBe(x)
  })

  it('marks the account as needing sign-in when Google refuses the refresh token', async () => {
    const a = await auth.signIn({ scopes: CALENDAR_SCOPES })
    fake.refreshTokens.clear()
    now += 3600_000
    await expect(auth.getAccessToken(a.id, [])).rejects.toBeInstanceOf(GoogleReauthError)
    expect(auth.account(a.id)?.needsReauth).toBe(true)
    // And stays that way, without asking Google again, until the user signs in again.
    const before = fake.requests.length
    await expect(auth.getAccessToken(a.id, [])).rejects.toBeInstanceOf(GoogleReauthError)
    expect(fake.requests.length).toBe(before)
    await auth.signIn({ scopes: CALENDAR_SCOPES, loginHint: a.email })
    expect(auth.account(a.id)?.needsReauth).toBe(false)
    expect(opened[1]).toContain(`login_hint=${encodeURIComponent(a.email)}`)
  })

  it('says which scopes are missing, so a feature can ask for them (Gmail later)', async () => {
    const a = await auth.signIn({ scopes: CALENDAR_SCOPES })
    const err = await auth.getAccessToken(a.id, [SCOPES.mail]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GoogleScopeError)
    expect((err as GoogleScopeError).missing).toEqual([SCOPES.mail])
    // Asking again for everything, as installed apps must, replaces the grant.
    const more = await auth.signIn({ scopes: [...a.scopes, SCOPES.mail], loginHint: a.email })
    expect(more.scopes).toContain(SCOPES.mail)
    await expect(auth.getAccessToken(a.id, [SCOPES.mail])).resolves.toMatch(/^at-/)
    expect(auth.accounts()).toHaveLength(1)
  })

  it('saves nothing when a permission was unticked on Google’s screen', async () => {
    const ep = endpointsAt(fake.base)
    const partial = new GoogleAuth({
      file: join(dir, 'partial.json'),
      box,
      endpoints: ep,
      fetch: googleFetch(ep, (u, i) => fetch(u, i)),
      openExternal: async (url) => {
        const u = new URL(url)
        u.searchParams.set('scope', 'openid email')
        await browser(u.href)
      },
    })
    partial.setClient(fake.clientId)
    await expect(partial.signIn({ scopes: CALENDAR_SCOPES })).rejects.toMatchObject({ code: 'scopes' })
    expect(partial.accounts()).toEqual([])
    expect(fake.revoked).toHaveLength(1)
  })

  it('keeps an account’s working sign-in when signing in again comes back short of a permission', async () => {
    const a = await auth.signIn({ scopes: CALENDAR_SCOPES })
    const ep = endpointsAt(fake.base)
    // The same profile, with the user unticking the new permission on Google's screen.
    const unticked = new GoogleAuth({
      file: join(dir, 'google.json'),
      box,
      endpoints: ep,
      fetch: googleFetch(ep, (u, i) => fetch(u, i)),
      openExternal: async (url) => {
        const u = new URL(url)
        u.searchParams.set('scope', CALENDAR_SCOPES.join(' '))
        await browser(u.href)
      },
    })
    const err = await unticked
      .signIn({ scopes: [...a.scopes, SCOPES.mail], loginHint: a.email })
      .catch((e: unknown) => e)
    expect(err).toMatchObject({
      code: 'scopes',
      message: expect.stringMatching(/Nothing changed: .* still connected/),
    })
    // Nothing revoked (that would end the stored grant), nothing saved, and the old sign-in works.
    expect(fake.revoked).toEqual([])
    expect(auth.account(a.id)).toEqual({ ...a, needsReauth: false })
    await expect(auth.getAccessToken(a.id, [SCOPES.calendarEvents], { refresh: true })).resolves.toMatch(
      /^at-/,
    )
  })

  it('stops at once, without opening the browser, when cancelled while the listener starts', async () => {
    const started = Date.now()
    const p = auth.signIn({ scopes: CALENDAR_SCOPES })
    auth.cancelSignIn()
    await expect(p).rejects.toMatchObject({ code: 'cancelled' })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(opened).toEqual([])
  })

  it('reports a cancelled consent, and a Workspace admin block', async () => {
    fake.consent = { error: 'access_denied' }
    await expect(auth.signIn({ scopes: CALENDAR_SCOPES })).rejects.toMatchObject({ code: 'denied' })
    fake.consent = { error: 'admin_policy_enforced' }
    await expect(auth.signIn({ scopes: CALENDAR_SCOPES })).rejects.toMatchObject({ code: 'admin-blocked' })
    expect(auth.accounts()).toEqual([])
  })

  it('signs out by revoking at Google and forgetting the account, even offline', async () => {
    const a = await auth.signIn({ scopes: CALENDAR_SCOPES })
    expect(await auth.signOut(a.id)).toBe(true)
    expect(fake.revoked).toHaveLength(1)
    expect(auth.accounts()).toEqual([])
    const b = await auth.signIn({ scopes: CALENDAR_SCOPES })
    await fake.stop()
    expect(await auth.signOut(b.id)).toBe(true)
    expect(auth.accounts()).toEqual([])
    fake = await startFakeGoogle()
  })

  it('needs every account to sign in again after the client ID changes, and refuses odd IDs', async () => {
    const a = await auth.signIn({ scopes: CALENDAR_SCOPES })
    auth.setClient(fake.clientId, 'new-secret')
    expect(auth.account(a.id)?.needsReauth).toBe(false)
    auth.setClient('999-other.apps.googleusercontent.com')
    expect(auth.account(a.id)?.needsReauth).toBe(true)
    expect(() => auth.setClient('https://evil.example')).toThrow(/client ID/)
  })

  it('won’t store anything without secure storage', async () => {
    const plain = new GoogleAuth({
      file: join(dir, 'x.json'),
      box: { ...box, available: () => false },
      endpoints: endpointsAt(fake.base),
      fetch: (u, i) => fetch(u, i),
      openExternal: browser,
    })
    expect(() => plain.setClient(fake.clientId)).toThrow(/securely/)
  })
})
