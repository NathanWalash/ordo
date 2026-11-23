// Google accounts signed in to Ordo: the user's own OAuth client (ID and the desktop secret, which
// Google issues but says isn't really secret), and per account its email, the scopes granted and
// the refresh token, encrypted with the OS keychain (safeStorage, passed in as a SecretBox). Access
// tokens are kept in memory only and refreshed when they're about to run out. A refresh token
// Google refuses (invalid_grant: revoked, expired after 7 days in Testing, password changed) marks
// the account "needs sign-in again" instead of failing quietly. No Electron here.
//
// Other features ask for tokens with `getAccessToken(accountId, scopes)`. One that needs a scope
// the account hasn't granted (Gmail's https://mail.google.com/, say) gets a GoogleScopeError and
// calls `signIn({ scopes: [...account.scopes, ...more], loginHint: account.email })`: Google
// doesn't do incremental authorization for installed apps, so the consent asks for the whole set
// again and the new refresh token replaces the old one. See docs/google.md.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  authUrl,
  exchangeCode,
  listenForCode,
  OAuthError,
  pkcePair,
  randomState,
  readIdToken,
  refreshAccessToken,
  revokeToken,
  SCOPES,
  type FetchFn,
  type GoogleEndpoints,
} from './oauth'

/** Encrypts secrets at rest (Electron safeStorage in the app). */
export interface SecretBox {
  available(): boolean
  seal(plain: string): string
  open(sealed: string): string
}

export interface GoogleAccountInfo {
  /** Google's stable id for the account (`sub`). */
  id: string
  email: string
  scopes: string[]
  /** Google stopped accepting Ordo's sign-in: the user must sign in again. */
  needsReauth: boolean
}

interface StoredAccount {
  id: string
  email: string
  scopes: string[]
  /** Sealed refresh token. */
  refresh: string
  needsReauth?: boolean
  added: string
}

interface StoredFile {
  version: 1
  client?: { id: string; secret?: string }
  accounts: StoredAccount[]
}

/** The account must be signed in to again before Ordo can use it. */
export class GoogleReauthError extends Error {
  override name = 'GoogleReauthError'
  constructor(readonly email: string) {
    super(`Google needs you to sign in to ${email} again. Open Settings › Google and choose Sign in again.`)
  }
}

/** The account hasn't given Ordo these scopes: sign in again asking for them too. */
export class GoogleScopeError extends Error {
  override name = 'GoogleScopeError'
  constructor(
    readonly email: string,
    readonly missing: string[],
  ) {
    super(`${email} hasn’t given Ordo permission for this yet.`)
  }
}

/** Google's OAuth client ID for a desktop app ends like this. */
export const CLIENT_ID = /^[0-9]{1,30}-[0-9a-z]{1,64}\.apps\.googleusercontent\.com$/

export interface GoogleAuthOptions {
  file: string
  box: SecretBox
  endpoints: GoogleEndpoints
  fetch: FetchFn
  /** Opens the consent page in the system browser. */
  openExternal: (url: string) => Promise<void>
  /** How long to wait for the browser to come back. */
  timeoutMs?: number
  now?: () => number
}

export class GoogleAuth {
  private tokens = new Map<string, { token: string; expires: number }>()
  private refreshing = new Map<string, Promise<string>>()
  private signing: AbortController | null = null

  constructor(private o: GoogleAuthOptions) {}

  private now = () => (this.o.now ?? Date.now)()

  // ---- The file ----

  private read(): StoredFile {
    if (!existsSync(this.o.file)) return { version: 1, accounts: [] }
    try {
      const f = JSON.parse(readFileSync(this.o.file, 'utf8')) as Partial<StoredFile>
      return {
        version: 1,
        ...(f.client && typeof f.client.id === 'string' && { client: f.client }),
        accounts: Array.isArray(f.accounts)
          ? f.accounts.filter(
              (a): a is StoredAccount =>
                !!a &&
                typeof a.id === 'string' &&
                typeof a.email === 'string' &&
                typeof a.refresh === 'string',
            )
          : [],
      }
    } catch {
      return { version: 1, accounts: [] }
    }
  }

  private write(f: StoredFile): void {
    mkdirSync(dirname(this.o.file), { recursive: true })
    const tmp = `${this.o.file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(f, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, this.o.file)
  }

  private requireBox(): void {
    if (!this.o.box.available())
      throw new OAuthError('server', 'Ordo can’t store Google sign-ins securely on this computer.')
  }

  // ---- The OAuth client ----

  client(): { clientId: string; clientSecret?: string } | null {
    const c = this.read().client
    if (!c) return null
    let secret: string | undefined
    if (c.secret && this.o.box.available()) {
      try {
        secret = this.o.box.open(c.secret)
      } catch {
        secret = undefined
      }
    }
    return { clientId: c.id, ...(secret && { clientSecret: secret }) }
  }

  /**
   * Save the user's OAuth client. Refresh tokens belong to the client that issued them, so a
   * different client ID means every account must sign in again.
   */
  setClient(clientId: string, clientSecret?: string): void {
    this.requireBox()
    const id = clientId.trim()
    if (!CLIENT_ID.test(id)) throw new OAuthError('invalid-client', 'That isn’t a Google OAuth client ID.')
    const f = this.read()
    if (f.client && f.client.id !== id) {
      for (const a of f.accounts) a.needsReauth = true
      this.tokens.clear()
    }
    const secret = clientSecret?.trim()
    f.client = { id, ...(secret ? { secret: this.o.box.seal(secret) } : {}) }
    this.write(f)
  }

  // ---- Accounts ----

  accounts(): GoogleAccountInfo[] {
    return this.read().accounts.map((a) => ({
      id: a.id,
      email: a.email,
      scopes: [...a.scopes],
      needsReauth: a.needsReauth === true,
    }))
  }

  account(id: string): GoogleAccountInfo | null {
    return this.accounts().find((a) => a.id === id) ?? null
  }

  /** Stop waiting for the browser. */
  cancelSignIn(): void {
    this.signing?.abort()
  }

  /**
   * Sign in through the browser and save (or update) the account. Every scope in `scopes` must be
   * granted (Google lets people untick some), or nothing is saved. An account Ordo already has is
   * only updated when the new grant covers everything it allowed before, and with `expectAccount`
   * (Google's id of the account being signed in to again) a different account changes nothing.
   */
  async signIn({
    scopes,
    loginHint,
    expectAccount,
  }: {
    scopes: readonly string[]
    loginHint?: string
    expectAccount?: string
  }): Promise<GoogleAccountInfo> {
    this.requireBox()
    const client = this.client()
    if (!client) throw new OAuthError('invalid-client', 'Add your Google OAuth client ID in Settings first.')
    this.signing?.abort()
    const ctrl = (this.signing = new AbortController())
    const { verifier, challenge } = pkcePair()
    const state = randomState()
    const listener = await listenForCode({ state, timeoutMs: this.o.timeoutMs, signal: ctrl.signal })
    try {
      const url = authUrl(this.o.endpoints, {
        clientId: client.clientId,
        redirectUri: listener.redirectUri,
        scopes,
        challenge,
        state,
        loginHint,
      })
      // Cancelled while the listener started: don't open the browser at all.
      if (ctrl.signal.aborted) throw new OAuthError('cancelled', 'Sign-in was cancelled.')
      await this.o.openExternal(url)
      const code = await listener.code
      const t = await exchangeCode(this.o.endpoints, this.o.fetch, {
        ...client,
        code,
        verifier,
        redirectUri: listener.redirectUri,
      })
      const who = readIdToken(t.idToken)
      if (!who) throw new OAuthError('server', 'Google didn’t say which account signed in.')
      const granted = new Set(t.scopes)
      // Google writes "email" back as its full URL.
      const has = (s: string) =>
        granted.has(s) || (s === 'email' && granted.has('https://www.googleapis.com/auth/userinfo.email'))
      const missing = scopes.filter((s) => !has(s))
      const f = this.read()
      const existing = f.accounts.find((a) => a.id === who.sub)
      if (expectAccount && who.sub !== expectAccount) {
        // Signed in as someone else. An account Ordo already has keeps its sign-in exactly as it
        // was; one that's new to Ordo had nothing before, so its new grant is revoked.
        if (!existing) await revokeToken(this.o.endpoints, this.o.fetch, t.refreshToken ?? t.accessToken)
        throw new OAuthError(
          'wrong-account',
          `You signed in to Google as ${who.email}${loginHint ? `, not ${loginHint}` : ''}. Nothing changed: sign in again and choose ${loginHint ?? 'the same account'}.`,
        )
      }
      if (missing.length) {
        // Revoking any token revokes the account's whole grant to this client, so only a brand-new
        // account's is revoked. For one already connected, the new tokens are just dropped and its
        // stored sign-in carries on working as before.
        if (existing)
          throw new OAuthError(
            'scopes',
            `Nothing changed: ${existing.email} is still connected as before. To give Ordo the new permission, sign in again and leave every box ticked.`,
          )
        await revokeToken(this.o.endpoints, this.o.fetch, t.refreshToken ?? t.accessToken)
        throw new OAuthError(
          'scopes',
          scopes.includes(SCOPES.mail)
            ? 'Ordo needs every permission on Google’s screen to read and send your mail. Sign in again and leave them all ticked.'
            : 'Ordo needs every permission on Google’s screen to show and change your calendars. Connect again and leave them all ticked.',
        )
      }
      // An account Ordo already has, signed in to for less than it allows now (a sign-in for Mail
      // that picked Calendar's account, say): Google doesn't add to an installed app's grant, so
      // keeping the new token would take the other feature's access away. Keep the stored sign-in
      // exactly as it was (and revoke nothing: that would end it too).
      const lost = existing?.scopes.filter((s) => !has(s)) ?? []
      if (existing && lost.length)
        throw new OAuthError(
          'already-connected',
          scopes.includes(SCOPES.mail)
            ? `Nothing changed: ${existing.email} is already connected to Ordo. To add its mail, choose ${existing.email} in the list instead of another account.`
            : `Nothing changed: ${existing.email} is already connected to Ordo. To show its calendars, choose Add Calendar on its row in Settings → Google.`,
        )
      const refresh = t.refreshToken ? this.o.box.seal(t.refreshToken) : existing?.refresh
      if (!refresh) throw new OAuthError('server', 'Google didn’t give Ordo a lasting sign-in. Try again.')
      const account: StoredAccount = {
        id: who.sub,
        email: who.email,
        // What was asked for (the grant covers everything the account had: checked above).
        scopes: [...new Set([...scopes, ...(existing?.scopes ?? [])])],
        refresh,
        added: existing?.added ?? new Date(this.now()).toISOString(),
      }
      f.accounts = [...f.accounts.filter((a) => a.id !== who.sub), account]
      this.write(f)
      this.tokens.set(who.sub, { token: t.accessToken, expires: this.now() + t.expiresIn * 1000 })
      return { id: account.id, email: account.email, scopes: account.scopes, needsReauth: false }
    } finally {
      listener.close()
      if (this.signing === ctrl) this.signing = null
    }
  }

  /**
   * An access token for `accountId` that covers `scopes`, refreshed if it's about to expire (or
   * with `refresh`, because an API just refused it). Throws GoogleReauthError when the account
   * must sign in again and GoogleScopeError when it never granted a scope.
   */
  async getAccessToken(
    accountId: string,
    scopes: readonly string[],
    { refresh = false } = {},
  ): Promise<string> {
    const a = this.read().accounts.find((x) => x.id === accountId)
    if (!a) throw new OAuthError('invalid-grant', 'That Google account isn’t connected to Ordo.')
    if (a.needsReauth) throw new GoogleReauthError(a.email)
    const missing = scopes.filter((s) => !a.scopes.includes(s))
    if (missing.length) throw new GoogleScopeError(a.email, missing)
    const cached = this.tokens.get(accountId)
    if (!refresh && cached && cached.expires - 60_000 > this.now()) return cached.token
    const running = this.refreshing.get(accountId)
    if (running) return running
    const p = this.refresh(a).finally(() => this.refreshing.delete(accountId))
    this.refreshing.set(accountId, p)
    return p
  }

  private async refresh(a: StoredAccount): Promise<string> {
    this.requireBox()
    const client = this.client()
    if (!client) throw new GoogleReauthError(a.email)
    let refreshToken: string
    try {
      refreshToken = this.o.box.open(a.refresh)
    } catch {
      this.markReauth(a.id)
      throw new GoogleReauthError(a.email)
    }
    try {
      const t = await refreshAccessToken(this.o.endpoints, this.o.fetch, { ...client, refreshToken })
      this.tokens.set(a.id, { token: t.accessToken, expires: this.now() + t.expiresIn * 1000 })
      if (t.refreshToken && t.refreshToken !== refreshToken) {
        const f = this.read()
        const stored = f.accounts.find((x) => x.id === a.id)
        if (stored) {
          stored.refresh = this.o.box.seal(t.refreshToken)
          this.write(f)
        }
      }
      return t.accessToken
    } catch (err) {
      if (err instanceof OAuthError && (err.code === 'invalid-grant' || err.code === 'invalid-client')) {
        this.markReauth(a.id)
        throw new GoogleReauthError(a.email)
      }
      throw err
    }
  }

  private markReauth(id: string): void {
    this.tokens.delete(id)
    const f = this.read()
    const a = f.accounts.find((x) => x.id === id)
    if (a && !a.needsReauth) {
      a.needsReauth = true
      this.write(f)
    }
  }

  /** Revoke Ordo's access at Google (best effort, so it works offline too) and forget the account. */
  async signOut(accountId: string): Promise<boolean> {
    const f = this.read()
    const a = f.accounts.find((x) => x.id === accountId)
    if (!a) return false
    this.tokens.delete(accountId)
    let token: string | null
    try {
      token = this.o.box.available() ? this.o.box.open(a.refresh) : null
    } catch {
      token = null
    }
    f.accounts = f.accounts.filter((x) => x.id !== accountId)
    this.write(f)
    if (token) await revokeToken(this.o.endpoints, this.o.fetch, token)
    return true
  }
}
