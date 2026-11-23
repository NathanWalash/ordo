// OAuth 2.0 for a desktop app, as Google describes it for installed apps: the authorization code
// flow with PKCE (S256), the consent page opened in the system browser, and the code brought back
// to a one-time listener on http://127.0.0.1:<random port>/callback that checks `state`. No
// Electron here, so it's tested on its own against a fake Google.
// https://developers.google.com/identity/protocols/oauth2/native-app
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface GoogleEndpoints {
  /** The consent page, opened in the browser. */
  auth: string
  token: string
  revoke: string
  /** Origin of the Calendar API (and later Gmail's). */
  api: string
}

/** The only Google hosts a packaged Ordo uses. */
export const GOOGLE_ENDPOINTS: GoogleEndpoints = Object.freeze({
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  api: 'https://www.googleapis.com',
})

/** The same endpoints on a local fake Google (tests and development only). */
export function endpointsAt(base: string): GoogleEndpoints {
  const b = base.replace(/\/+$/, '')
  return { auth: `${b}/o/oauth2/v2/auth`, token: `${b}/token`, revoke: `${b}/revoke`, api: b }
}

export const SCOPES = {
  openid: 'openid',
  email: 'email',
  /** See the list of calendars (not their events). */
  calendarList: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  /** See and change events on every calendar the account can change. */
  calendarEvents: 'https://www.googleapis.com/auth/calendar.events',
  /** IMAP and SMTP with XOAUTH2 (restricted): Gmail accounts that sign in with Google. */
  mail: 'https://mail.google.com/',
} as const

/**
 * The least that lets Ordo list your calendars and change events on the ones you can write to:
 * calendar.events alone can't list calendars, and the full `calendar` scope would also let Ordo
 * change calendars themselves and their sharing.
 */
export const CALENDAR_SCOPES: readonly string[] = [
  SCOPES.openid,
  SCOPES.email,
  SCOPES.calendarList,
  SCOPES.calendarEvents,
]

/**
 * Gmail over IMAP and SMTP (XOAUTH2) needs Google's one mail scope, which is restricted: there's
 * no narrower one for IMAP. A Gmail account added with Sign in with Google asks for just this (and
 * who you are); Calendar is connected separately.
 */
export const MAIL_SCOPES: readonly string[] = [SCOPES.openid, SCOPES.email, SCOPES.mail]

/** Whether an account's grant covers Calendar (one added for Mail only doesn't). */
export const hasCalendarScopes = (scopes: readonly string[]) =>
  scopes.includes(SCOPES.calendarList) && scopes.includes(SCOPES.calendarEvents)

export type OAuthErrorCode =
  | 'timeout'
  | 'cancelled'
  | 'denied'
  | 'admin-blocked'
  | 'scopes'
  | 'invalid-grant'
  | 'invalid-client'
  | 'network'
  | 'server'

export class OAuthError extends Error {
  override name = 'OAuthError'
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>

const b64url = (b: Buffer) => b.toString('base64url')

/** A PKCE verifier (43 characters from 32 random bytes) and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32))
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }
}

export const randomState = () => b64url(randomBytes(24))

export function authUrl(
  endpoints: GoogleEndpoints,
  o: {
    clientId: string
    redirectUri: string
    scopes: readonly string[]
    challenge: string
    state: string
    loginHint?: string
  },
): string {
  const url = new URL(endpoints.auth)
  const q = url.searchParams
  q.set('client_id', o.clientId)
  q.set('redirect_uri', o.redirectUri)
  q.set('response_type', 'code')
  q.set('scope', o.scopes.join(' '))
  q.set('code_challenge', o.challenge)
  q.set('code_challenge_method', 'S256')
  q.set('state', o.state)
  q.set('access_type', 'offline')
  // Always show the account picker and consent, so a refresh token comes back and the right
  // (work) account is chosen.
  q.set('prompt', 'select_account consent')
  if (o.loginHint) q.set('login_hint', o.loginHint)
  return url.href
}

const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  '<meta name="viewport" content="width=device-width">' +
  '<body style="font:15px -apple-system,system-ui,sans-serif;max-width:32em;margin:15vh auto;padding:0 1em;color:#222">' +
  `<h1 style="font-size:20px">${title}</h1><p>${text}</p></body>`

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function errorFor(code: string): OAuthError {
  if (code === 'access_denied')
    return new OAuthError('denied', 'You didn’t allow Ordo to use your Google account.')
  if (code === 'admin_policy_enforced' || code === 'org_internal')
    return new OAuthError(
      'admin-blocked',
      'Your Google Workspace administrator doesn’t allow this app. Ask them to trust your OAuth client, or create it inside your Workspace as an Internal app (see docs/google.md).',
    )
  return new OAuthError('server', `Google sign-in didn’t finish (${code.slice(0, 60)}).`)
}

export interface LoopbackListener {
  /** `http://127.0.0.1:<port>/callback`, to send as redirect_uri. */
  redirectUri: string
  /** The authorization code, once the browser comes back with the right `state`. */
  code: Promise<string>
  close(): void
}

/**
 * Listen once on 127.0.0.1 for Google's redirect. A request with the wrong `state` (or the wrong
 * Host, as a web page might send) is refused and the listener keeps waiting; the first right one
 * settles it and the listener closes, so a code is accepted only once. Gives up after `timeoutMs`
 * or when `signal` aborts.
 */
export async function listenForCode(o: {
  state: string
  timeoutMs?: number
  signal?: AbortSignal
}): Promise<LoopbackListener> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  const redirectUri = `http://127.0.0.1:${port}/callback`
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const close = () => {
    if (timer) clearTimeout(timer)
    server.close()
    server.closeAllConnections()
  }
  const code = new Promise<string>((resolve, reject) => {
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
      // Let the browser get its page before the connection goes.
      setImmediate(close)
    }
    const reply = (res: ServerResponse, status: number, html: string) => {
      res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
        'referrer-policy': 'no-referrer',
        connection: 'close',
      })
      res.end(html)
    }
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', redirectUri)
      if (req.method !== 'GET' || url.pathname !== '/callback' || settled)
        return reply(res, 404, page('Not found', 'Nothing here.'))
      if (req.headers.host !== `127.0.0.1:${port}`)
        return reply(res, 400, page('Not allowed', 'Wrong address.'))
      if (!equal(url.searchParams.get('state') ?? '', o.state))
        return reply(
          res,
          400,
          page('This sign-in link isn’t Ordo’s', 'Go back to Ordo and choose Connect Google account again.'),
        )
      const error = url.searchParams.get('error')
      const got = url.searchParams.get('code')
      if (error) {
        reply(
          res,
          200,
          page('Not connected', 'Ordo wasn’t given access. You can close this tab and go back to Ordo.'),
        )
        return settle(() => reject(errorFor(error)))
      }
      if (!got) return reply(res, 400, page('Something’s missing', 'Go back to Ordo and try again.'))
      reply(res, 200, page('You’re signed in', 'You can close this tab and go back to Ordo.'))
      settle(() => resolve(got))
    })
    timer = setTimeout(
      () => settle(() => reject(new OAuthError('timeout', 'Google sign-in took too long. Try again.'))),
      o.timeoutMs ?? 5 * 60_000,
    )
    const cancel = () => settle(() => reject(new OAuthError('cancelled', 'Sign-in was cancelled.')))
    // Cancelled while the listener was starting: give up now, not when the timeout runs out.
    if (o.signal?.aborted) cancel()
    else o.signal?.addEventListener('abort', cancel, { once: true })
  })
  code.catch(() => {})
  return {
    redirectUri,
    code,
    close: () => {
      settled = true
      close()
    },
  }
}

export interface TokenResponse {
  accessToken: string
  /** Seconds. */
  expiresIn: number
  refreshToken?: string
  scopes: string[]
  idToken?: string
}

async function tokenRequest(
  fetchFn: FetchFn,
  url: string,
  form: Record<string, string | undefined>,
): Promise<TokenResponse> {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(form)) if (v !== undefined && v !== '') body.set(k, v)
  let res: Response
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err) {
    throw new OAuthError(
      'network',
      `Couldn’t reach Google (${err instanceof Error ? err.message : String(err)}).`,
    )
  }
  let data: Record<string, unknown> = {}
  try {
    data = (await res.json()) as Record<string, unknown>
  } catch {
    // Not JSON: handled below by the status.
  }
  if (!res.ok) {
    const code = typeof data['error'] === 'string' ? data['error'] : ''
    if (code === 'invalid_grant')
      throw new OAuthError('invalid-grant', 'Google no longer accepts Ordo’s sign-in for this account.')
    if (code === 'invalid_client' || code === 'unauthorized_client')
      throw new OAuthError(
        'invalid-client',
        'Google didn’t recognise the OAuth client ID or secret in Settings.',
      )
    throw new OAuthError(
      res.status >= 500 ? 'network' : 'server',
      `Google refused the sign-in (${code || res.status}).`,
    )
  }
  const access = data['access_token']
  if (typeof access !== 'string' || !access)
    throw new OAuthError('server', 'Google didn’t send an access token.')
  return {
    accessToken: access,
    expiresIn: Number(data['expires_in']) || 3600,
    ...(typeof data['refresh_token'] === 'string' && { refreshToken: data['refresh_token'] }),
    scopes: typeof data['scope'] === 'string' ? data['scope'].split(/\s+/).filter(Boolean) : [],
    ...(typeof data['id_token'] === 'string' && { idToken: data['id_token'] }),
  }
}

export function exchangeCode(
  endpoints: GoogleEndpoints,
  fetchFn: FetchFn,
  o: { clientId: string; clientSecret?: string; code: string; verifier: string; redirectUri: string },
): Promise<TokenResponse> {
  return tokenRequest(fetchFn, endpoints.token, {
    grant_type: 'authorization_code',
    code: o.code,
    code_verifier: o.verifier,
    redirect_uri: o.redirectUri,
    client_id: o.clientId,
    client_secret: o.clientSecret,
  })
}

export function refreshAccessToken(
  endpoints: GoogleEndpoints,
  fetchFn: FetchFn,
  o: { clientId: string; clientSecret?: string; refreshToken: string },
): Promise<TokenResponse> {
  return tokenRequest(fetchFn, endpoints.token, {
    grant_type: 'refresh_token',
    refresh_token: o.refreshToken,
    client_id: o.clientId,
    client_secret: o.clientSecret,
  })
}

/** Ask Google to forget a token (and every token from the same grant). Best effort. */
export async function revokeToken(
  endpoints: GoogleEndpoints,
  fetchFn: FetchFn,
  token: string,
): Promise<boolean> {
  try {
    const res = await fetchFn(endpoints.revoke, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Who signed in, from the ID token. It came straight from Google's token endpoint over TLS in
 * answer to Ordo's own request, so (as OpenID Connect allows) its signature isn't checked here.
 */
export function readIdToken(idToken: string | undefined): { sub: string; email: string } | null {
  const payload = idToken?.split('.')[1]
  if (!payload) return null
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    const sub = typeof p['sub'] === 'string' ? p['sub'] : ''
    const email = typeof p['email'] === 'string' ? p['email'] : ''
    return /^[\w-]{1,255}$/.test(sub) && email ? { sub, email: email.slice(0, 320) } : null
  } catch {
    return null
  }
}
