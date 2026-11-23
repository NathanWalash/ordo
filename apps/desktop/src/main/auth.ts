import { MailAuthError, type MailCredentials } from '@ordo/mail-core/node'
import type { AuthKind, MailAccount } from '@ordo/shared'
import { readSecret } from './account'

/**
 * How Ordo signs in to an account's IMAP and SMTP servers: the one seam every connection goes
 * through. Each auth kind has a provider that turns the account and its stored secret into
 * credentials for this connection: a password, or an access token.
 *
 * Adding Sign in with Google (XOAUTH2):
 * 1. Add `{ kind: 'oauth'; provider: 'google' }` to `AccountAuth` in `@ordo/shared` (accounts.ts).
 * 2. Store the refresh token as the account's secret (`addStoredAccount(account, refreshToken)`).
 * 3. Add a provider here whose `getCredentials` refreshes an access token when needed and returns
 *    `{ user: account.email, accessToken }`. ImapMailProvider and the SMTP transports already
 *    send an access token with XOAUTH2 (see `authOf` in mail-core).
 * Nothing that connects needs to change: it all calls `getCredentials(account)`.
 */
export interface AuthProvider<K extends AuthKind = AuthKind> {
  kind: K
  /** Credentials for one connection right now. `secret` is the decrypted stored secret. */
  getCredentials(account: MailAccount, secret: string): Promise<MailCredentials>
}

/** An app-specific password, sent as a plain login over TLS. */
const passwordAuth: AuthProvider<'password'> = {
  kind: 'password',
  getCredentials: async (account, secret) => ({ user: account.email, pass: secret }),
}

const AUTH: { [K in AuthKind]: AuthProvider<K> } = { password: passwordAuth }

/**
 * Credentials to sign in to this account now. Throws MailAuthError when its secret can't be read
 * (the keychain changed, or it was never saved), so the window asks for the password again.
 */
export async function getCredentials(account: MailAccount): Promise<MailCredentials> {
  const secret = readSecret(account.id)
  if (secret === null)
    throw new MailAuthError('Ordo can’t read the saved password for this account. Enter it again.')
  const provider = AUTH[account.auth.kind] as AuthProvider
  return provider.getCredentials(account, secret)
}
