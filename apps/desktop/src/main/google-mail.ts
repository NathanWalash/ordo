import { PROVIDERS } from '@ordo/mail-core'
import {
  AddGoogleAccountSchema,
  defaultLabel,
  nextColor,
  SignInAgainSchema,
  type AccountResult,
  type GoogleMailOptions,
  type MailAccount,
} from '@ordo/shared'
import {
  addStoredAccount,
  assertAccountsWritable,
  canStoreSecrets,
  getAccount,
  listAccounts,
} from './account'
import {
  googleAuth,
  MAIL_SCOPES,
  OAuthError,
  requestGoogleScopes,
  SCOPES,
  type GoogleAccountInfo,
} from './google'
import { explain, mailStore, syncSchedule, testAccountLogin } from './mail'

/**
 * Gmail with Sign in with Google: adding an account, and signing in again when Google stops
 * accepting Ordo's sign-in. The Google module keeps the tokens (google.json, keychain-encrypted);
 * the mail account only names its Google account (`auth.googleAccountId`). Ordo signs in to Gmail
 * with the new token before saving anything, as with a password.
 *
 * Scopes: a new sign-in asks for `MAIL_SCOPES` only (who you are, and https://mail.google.com/).
 * A Google account already connected for Calendar is asked for mail too: Google doesn't do
 * incremental authorization for installed apps, so `requestGoogleScopes` shows consent for
 * everything it has plus mail, for that account.
 */

const invalid = (message: string): AccountResult => ({ ok: false, error: 'invalid', message })
const refused = (err: unknown): AccountResult => ({
  ok: false,
  error: 'unavailable',
  message: err instanceof Error ? err.message : String(err),
})

/** A browser sign-in that didn't finish, in the Accounts sheet's words. */
function signInFailure(err: unknown): AccountResult {
  if (err instanceof OAuthError) {
    if (err.code === 'cancelled') return { ok: false, error: 'cancelled', message: err.message }
    if (err.code === 'network') return { ok: false, error: 'network', message: err.message }
    if (err.code === 'timeout') return { ok: false, error: 'unknown', message: err.message }
    if (err.code === 'server') return { ok: false, error: 'unknown', message: err.message }
    // denied, admin-blocked, scopes, invalid-client, invalid-grant: Google's answer, as it said it.
    return { ok: false, error: 'auth', message: err.message }
  }
  return { ok: false, error: 'unknown', message: 'Google sign-in didn’t finish. Try again.' }
}

const usesGoogle = (a: MailAccount, googleId: string) =>
  a.auth.kind === 'oauth' && a.auth.googleAccountId === googleId

/** What the Add account sheet offers: whether Google sign-in is set up, and connected accounts. */
export function googleMailOptions(): GoogleMailOptions {
  let accounts: GoogleAccountInfo[] = []
  let configured = false
  try {
    configured = googleAuth().client() !== null
    accounts = googleAuth().accounts()
  } catch {
    // An unreadable google.json: nothing to offer.
  }
  const mail = listAccounts()
  return {
    secureStorage: canStoreSecrets(),
    configured,
    accounts: accounts.map((g) => ({
      id: g.id,
      email: g.email,
      hasMail: g.scopes.includes(SCOPES.mail),
      needsReauth: g.needsReauth,
      inUse: mail.some((a) => usesGoogle(a, g.id)),
    })),
  }
}

/**
 * Sign in to Google in the browser for mail: `googleId`'s account again (asking it for mail access
 * too), or any account. Returns the account that signed in and whether it's new to Ordo.
 */
async function signInForMail(
  googleId: string | undefined,
  loginHint?: string,
): Promise<{ g: GoogleAccountInfo; isNew: boolean }> {
  const auth = googleAuth()
  const before = new Set(auth.accounts().map((a) => a.id))
  const known = googleId ? auth.account(googleId) : null
  const g = known
    ? await requestGoogleScopes(known.id, [SCOPES.mail])
    : await auth.signIn({ scopes: MAIL_SCOPES, ...(loginHint && { loginHint }) })
  return { g, isNew: !before.has(g.id) }
}

/** Forget a Google sign-in made just now that Ordo isn't keeping (it was new: nothing else uses it). */
async function discard(g: GoogleAccountInfo, isNew: boolean): Promise<void> {
  if (isNew) await googleAuth().signOut(g.id)
}

/**
 * Add a Gmail account that signs in with Google: with a connected Google account (asked for mail
 * access if it hasn't given it) or a new browser sign-in. The address is the Google account's.
 */
export async function addGoogle(input: unknown): Promise<AccountResult> {
  if (!canStoreSecrets())
    return {
      ok: false,
      error: 'unavailable',
      message: "This computer can't store sign-ins securely, so Ordo won't save yours.",
    }
  const parsed = AddGoogleAccountSchema.safeParse(input)
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message || 'Check the details.')
  try {
    assertAccountsWritable()
  } catch (err) {
    return refused(err)
  }
  const auth = googleAuth()
  if (!auth.client())
    return invalid(
      'Set up Sign in with Google first: add your OAuth client in Settings → Google (see the guide).',
    )
  const { googleAccountId } = parsed.data
  if (googleAccountId) {
    if (!auth.account(googleAccountId)) return invalid('That Google account isn’t connected to Ordo.')
    if (listAccounts().some((a) => usesGoogle(a, googleAccountId)))
      return invalid('That Google account’s mail is already in Ordo.')
  }

  let signedIn: { g: GoogleAccountInfo; isNew: boolean }
  const chosen = googleAccountId ? auth.account(googleAccountId) : null
  try {
    signedIn =
      chosen && chosen.scopes.includes(SCOPES.mail) && !chosen.needsReauth
        ? { g: chosen, isNew: false }
        : await signInForMail(googleAccountId)
  } catch (err) {
    return signInFailure(err)
  }
  const { g, isNew } = signedIn
  if (googleAccountId && g.id !== googleAccountId) {
    await discard(g, isNew)
    return invalid(`You signed in to Google as ${g.email}. Choose that account in the list, or try again.`)
  }

  const others = listAccounts()
  const email = g.email.toLowerCase()
  if (others.some((a) => usesGoogle(a, g.id))) return invalid(`${g.email}’s mail is already in Ordo.`)
  if (others.some((a) => a.email.toLowerCase() === email && a.imap.host === PROVIDERS.gmail.imap!.host)) {
    await discard(g, isNew)
    return invalid(
      `${g.email} is already in Ordo with an app password. To sign in with Google instead, remove it first, then add it again.`,
    )
  }

  const gmail = PROVIDERS.gmail
  const draft: Omit<MailAccount, 'id' | 'lastScan'> = {
    label:
      parsed.data.label?.trim() ||
      defaultLabel(
        'gmail',
        others.map((a) => a.label),
      ),
    email: g.email,
    color: parsed.data.color ?? nextColor(others.map((a) => a.color)),
    provider: 'gmail',
    imap: { ...gmail.imap! },
    smtp: { ...gmail.smtp! },
    auth: { kind: 'oauth', provider: 'google', googleAccountId: g.id },
  }
  try {
    await testAccountLogin(draft)
  } catch (err) {
    // Nothing is kept that doesn't work. A Google account that was already connected keeps its
    // sign-in (Calendar may use it), with mail access it doesn't need yet.
    await discard(g, isNew)
    return { ok: false, ...explain(err, g.email, draft) }
  }
  try {
    // A fresh id, never one that still has mail in the cache.
    return { ok: true, account: addStoredAccount(draft, null, mailStore().cachedAccounts()) }
  } catch (err) {
    await discard(g, isNew)
    return refused(err)
  }
}

/**
 * Sign in to Google again for a mail account that signs in with Google (revoked, expired after a
 * week in Testing, no mail access, or signed out of Google): the same Google account only.
 */
export async function signInAgain(input: unknown): Promise<AccountResult> {
  if (!canStoreSecrets())
    return {
      ok: false,
      error: 'unavailable',
      message: "This computer can't store sign-ins securely, so Ordo won't save yours.",
    }
  const parsed = SignInAgainSchema.safeParse(input)
  if (!parsed.success) return invalid('There’s no such account.')
  const account = getAccount(parsed.data.id)
  if (!account) return invalid('There’s no such account.')
  if (account.auth.kind !== 'oauth')
    return invalid('This account signs in with a password. Enter it again from Edit… instead.')
  if (!googleAuth().client())
    return invalid('Add your Google OAuth client in Settings → Google first (see the guide).')
  const googleId = account.auth.googleAccountId
  let signedIn: { g: GoogleAccountInfo; isNew: boolean }
  try {
    signedIn = await signInForMail(googleAuth().account(googleId) ? googleId : undefined, account.email)
  } catch (err) {
    return signInFailure(err)
  }
  if (signedIn.g.id !== googleId) {
    await discard(signedIn.g, signedIn.isNew)
    return invalid(
      `You signed in to Google as ${signedIn.g.email}, but this account is ${account.email}. Sign in again and choose ${account.email}.`,
    )
  }
  try {
    await testAccountLogin(account)
  } catch (err) {
    return { ok: false, ...explain(err, account.email, account) }
  }
  // Signed in: check it again straight away, not after the back-off.
  syncSchedule.reset(account.id)
  return { ok: true, account }
}

/** Stop waiting for the browser to come back from Google. */
export function cancelGoogleSignIn(): void {
  try {
    googleAuth().cancelSignIn()
  } catch {
    // No Google sign-in to cancel.
  }
}
