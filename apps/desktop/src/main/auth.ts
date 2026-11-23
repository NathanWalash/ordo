import {
  classifyImapError,
  MailAuthError,
  MailConnectionError,
  type MailCredentials,
} from '@ordo/mail-core/node'
import { PROVIDERS } from '@ordo/mail-core'
import type { AccountAuth, AuthKind, MailAccount } from '@ordo/shared'
import { readSecret } from './account'
import { getGoogleAccessToken, GoogleReauthError, GoogleScopeError, OAuthError, SCOPES } from './google'

/**
 * How Ordo signs in to an account's IMAP and SMTP servers: the one seam every connection goes
 * through. Each auth kind has a provider that turns the account into credentials for this
 * connection: a password (from `accounts.json`), or an access token (from the Google module).
 *
 * Everything that connects goes through `withCredentials` (mail.ts's `connectImap` and
 * `withSmtp`), which retries once with a freshly refreshed token when the server refuses one.
 */

/** What signing in needs to know about an account: a saved one, or one about to be added. */
export type AccountToSignIn = Omit<MailAccount, 'id' | 'lastScan'> & Partial<Pick<MailAccount, 'id'>>

export interface AuthProvider<K extends AuthKind = AuthKind> {
  kind: K
  /** Credentials for one connection right now. `refresh`: the server refused the last ones. */
  getCredentials(
    account: AccountToSignIn & { auth: Extract<AccountAuth, { kind: K }> },
    options: { refresh: boolean },
  ): Promise<MailCredentials>
}

/**
 * The account's Google sign-in no longer works, or never covered mail: the user must sign in to
 * Google again (Settings → Accounts → Sign in again). An auth error, so everything that treats a
 * wrong password as "ask the user" does the same here; nothing falls back to anything else.
 */
export class SignInAgainError extends MailAuthError {
  override name = 'SignInAgainError'
  constructor(
    message: string,
    /** `reauth`: Google refused the refresh token. `scope`: no mail access. `gone`: signed out. */
    readonly reason: 'reauth' | 'scope' | 'gone',
  ) {
    super(message)
  }
}

/** An app-specific password, sent as a plain login over TLS. */
const passwordAuth: AuthProvider<'password'> = {
  kind: 'password',
  getCredentials: async (account) => {
    const secret = account.id ? readSecret(account.id) : null
    if (secret === null)
      throw new MailAuthError('Ordo can’t read the saved password for this account. Enter it again.')
    return { user: account.email, pass: secret }
  },
}

const AGAIN = 'Choose Sign in again in Settings → Accounts.'

/**
 * Sign in with Google: an access token for the account's Google sign-in covering Gmail's IMAP and
 * SMTP scope, sent with XOAUTH2. Google's refusals become SignInAgainError.
 */
const googleAuth: AuthProvider<'oauth'> = {
  kind: 'oauth',
  getCredentials: async (account, { refresh }) => {
    // The token is for Gmail's own servers only (accounts.json can't point it anywhere else
    // either: an oauth account always gets the Gmail preset).
    const gmail = PROVIDERS.gmail
    if (account.imap.host !== gmail.imap!.host || account.smtp.host !== gmail.smtp!.host)
      throw new MailAuthError('Ordo only signs in to Gmail’s own servers with a Google sign-in.')
    try {
      const accessToken = await getGoogleAccessToken(account.auth.googleAccountId, [SCOPES.mail], { refresh })
      return { user: account.email, accessToken }
    } catch (err) {
      if (err instanceof GoogleReauthError)
        throw new SignInAgainError(
          `Google stopped accepting Ordo’s sign-in for ${account.email}: it was revoked, your password changed, or (with a Google Cloud app in Testing) a week has passed. ${AGAIN}`,
          'reauth',
        )
      if (err instanceof GoogleScopeError)
        throw new SignInAgainError(
          `${account.email} hasn’t given Ordo permission to read and send mail. ${AGAIN} Leave every box ticked on Google’s screen.`,
          'scope',
        )
      if (err instanceof OAuthError && err.code === 'invalid-grant')
        throw new SignInAgainError(
          `${account.email} isn’t signed in to Google in Ordo any more. ${AGAIN}`,
          'gone',
        )
      if (err instanceof OAuthError && err.code === 'network')
        throw new MailConnectionError(err.message, 'offline')
      throw err
    }
  },
}

const AUTH: { [K in AuthKind]: AuthProvider<K> } = { password: passwordAuth, oauth: googleAuth }

/**
 * Credentials to sign in to this account now. Throws MailAuthError when there are none (a password
 * that can't be read, a Google sign-in that needs signing in again), so the window asks.
 */
export async function getCredentials(
  account: AccountToSignIn,
  { refresh = false }: { refresh?: boolean } = {},
): Promise<MailCredentials> {
  const provider = AUTH[account.auth.kind] as AuthProvider
  return provider.getCredentials(account as never, { refresh })
}

/** The server refused to sign in (IMAP NO [AUTHENTICATIONFAILED], SMTP 535 / EAUTH). */
export function isAuthFailure(err: unknown): boolean {
  if (err instanceof SignInAgainError) return false
  if (classifyImapError(err) instanceof MailAuthError) return true
  const e = err as { code?: unknown; responseCode?: unknown } | null
  return e?.code === 'EAUTH' || e?.responseCode === 535
}

/**
 * Run `fn` with the account's credentials. With a Google sign-in, a server that refuses the access
 * token (revoked early, or expired between being handed out and used) gets one more try with a
 * freshly refreshed token, once; a password is never retried (servers lock out accounts that keep
 * failing). A second refusal is thrown as it is.
 */
export async function withCredentials<T>(
  account: AccountToSignIn,
  fn: (credentials: MailCredentials) => Promise<T>,
): Promise<T> {
  const first = await getCredentials(account)
  try {
    return await fn(first)
  } catch (err) {
    if (account.auth.kind !== 'oauth' || !isAuthFailure(err)) throw err
    return fn(await getCredentials(account, { refresh: true }))
  }
}
