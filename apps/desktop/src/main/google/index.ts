// Google sign-in for the Electron main process: the account store in the user's profile, secrets
// in safeStorage, the consent page in the system browser, and every request through the Google
// allow-list. Calendar uses it now; Gmail (IMAP/SMTP with XOAUTH2) can use the same accounts later
// through getGoogleAccessToken() and requestGoogleScopes(). See docs/google.md.
import { join } from 'node:path'
import { app, safeStorage, shell } from 'electron'
import { GoogleAuth, type GoogleAccountInfo, type SecretBox } from './auth'
import { checkEndpoints, googleFetch, isConsentUrl } from './fetch'
import { endpointsAt, GOOGLE_ENDPOINTS, OAuthError, type FetchFn, type GoogleEndpoints } from './oauth'

export { GoogleReauthError, GoogleScopeError, type GoogleAccountInfo } from './auth'
export { CALENDAR_SCOPES, OAuthError, SCOPES } from './oauth'

/**
 * Google's own endpoints. An unpackaged build (tests, development) can point at a local fake with
 * ORDO_GOOGLE_BASE_URL=http://127.0.0.1:<port>; packaged builds ignore it, and anything that isn't
 * loopback is refused.
 */
export function googleEndpoints(): GoogleEndpoints {
  const base = !app.isPackaged ? process.env['ORDO_GOOGLE_BASE_URL'] : undefined
  const endpoints = base ? endpointsAt(base) : GOOGLE_ENDPOINTS
  checkEndpoints(endpoints, { packaged: app.isPackaged })
  return endpoints
}

const box: SecretBox = {
  available: () => safeStorage.isEncryptionAvailable(),
  seal: (s) => safeStorage.encryptString(s).toString('base64'),
  open: (s) => safeStorage.decryptString(Buffer.from(s, 'base64')),
}

let fetcher: FetchFn | null = null
/** The allow-listed fetch every Google request goes through. */
export const googleFetchFn = (): FetchFn => (fetcher ??= googleFetch(googleEndpoints()))

/**
 * Open the consent page in the system browser (never in an Ordo window), after checking it really
 * is Google's. Tests of an unpackaged build can set ORDO_TEST_GOOGLE_AUTO_CONSENT=1 to have the
 * fake Google's consent followed here instead, so no browser opens.
 */
async function openConsent(url: string): Promise<void> {
  const endpoints = googleEndpoints()
  if (!isConsentUrl(url, endpoints)) throw new OAuthError('server', 'Ordo refused to open that sign-in page.')
  if (
    !app.isPackaged &&
    process.env['ORDO_TEST_GOOGLE_AUTO_CONSENT'] === '1' &&
    endpoints !== GOOGLE_ENDPOINTS
  ) {
    const consent = await fetch(url, { redirect: 'manual' })
    const back = consent.headers.get('location')
    if (back && /^http:\/\/127\.0\.0\.1:\d+\/callback\?/.test(back)) void fetch(back).catch(() => {})
    return
  }
  await shell.openExternal(url)
}

let auth: GoogleAuth | null = null

export function googleAuth(): GoogleAuth {
  return (auth ??= new GoogleAuth({
    file: join(app.getPath('userData'), 'google.json'),
    box,
    endpoints: googleEndpoints(),
    fetch: googleFetchFn(),
    openExternal: openConsent,
  }))
}

/**
 * The seam for other features (Gmail's IMAP/SMTP XOAUTH2 next): an access token for a connected
 * Google account covering `scopes`. Throws GoogleScopeError if the account never granted one of
 * them (then call requestGoogleScopes), GoogleReauthError if the user must sign in again.
 */
export function getGoogleAccessToken(
  accountId: string,
  scopes: readonly string[],
  options?: { refresh?: boolean },
): Promise<string> {
  return googleAuth().getAccessToken(accountId, scopes, options)
}

/**
 * Ask a connected account for more scopes (e.g. https://mail.google.com/). Google doesn't do
 * incremental authorization for installed apps, so this shows consent for everything the account
 * already granted plus `extra`, for that account (login_hint), and keeps the new grant.
 */
export function requestGoogleScopes(accountId: string, extra: readonly string[]): Promise<GoogleAccountInfo> {
  const a = googleAuth().account(accountId)
  if (!a)
    return Promise.reject(new OAuthError('invalid-grant', 'That Google account isn’t connected to Ordo.'))
  return googleAuth().signIn({ scopes: [...new Set([...a.scopes, ...extra])], loginHint: a.email })
}
