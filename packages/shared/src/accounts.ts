import { z } from 'zod'
import {
  hasControlChars,
  PROVIDER_IDS,
  PROVIDERS,
  type ImapServer,
  type ProviderId,
  type SmtpServer,
} from '@ordo/mail-core'
import { GoogleAccountIdSchema } from './google'

/**
 * Mail accounts: several side by side (iCloud, Gmail, Yahoo, Fastmail or any IMAP server), each
 * with its own servers, sign-in, colour and label. Secrets never leave the main process: the
 * window sees accounts without them.
 */

/** Short and plain, so it's safe anywhere (file names, SQL defaults, IPC). */
export const AccountIdSchema = z
  .string()
  .regex(/^[a-z0-9-]{1,40}$/, 'Not an account')
  // `all` means every account wherever an account can be named.
  .refine((id) => id !== 'all', 'Not an account')
export type AccountId = z.infer<typeof AccountIdSchema>

/** The account a single-account install migrates to: its cache already belongs to this id. */
export const FIRST_ACCOUNT_ID = 'acc-1'

/** Colours an account can have, for its chip on message rows. Named, never free-form CSS. */
export const ACCOUNT_COLORS = [
  'blue',
  'purple',
  'pink',
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'graphite',
] as const
export type AccountColor = (typeof ACCOUNT_COLORS)[number]

/**
 * How an account signs in, without the secret. `password`: an app-specific password, sent as a
 * plain IMAP/SMTP login over TLS, kept encrypted in `accounts.json`. `oauth` (Gmail only): Sign in
 * with Google, an access token sent with XOAUTH2; the tokens live in the Google module's
 * `google.json`, under the Google account's id (`sub`), never in `accounts.json`. Everything that
 * signs in goes through the main process's `getCredentials(account)`.
 */
export type AccountAuth =
  { kind: 'password' } | { kind: 'oauth'; provider: 'google'; googleAccountId: string }
export type AuthKind = AccountAuth['kind']

/** An account as the window and the assistant see it: no password, no token. */
export interface MailAccount {
  id: AccountId
  /** What the user calls it: "Personal", "Work". Defaults to the provider's name. */
  label: string
  email: string
  color: AccountColor
  provider: ProviderId
  imap: ImapServer
  smtp: SmtpServer
  auth: AccountAuth
  /** ISO time of the last completed inbox scan. */
  lastScan: string | null
}

/** How an account's last check went, for Settings and the Mail sidebar. */
export interface AccountSyncState {
  /** ISO time of the last failed check, if the latest one failed. */
  failedAt?: string
  /** What went wrong, in the user's words. */
  message?: string
  /** `auth`: the password needs entering again (Sign in again, for a Google sign-in). */
  error?: 'auth' | 'network' | 'unavailable' | 'unknown'
  /** ISO time before which Ordo won't try again by itself (backing off). */
  retryAt?: string
}

/** An account with what Settings shows about it. */
export interface AccountSummary extends MailAccount {
  /** Cached inbox messages. */
  messageCount: number
  sync: AccountSyncState
  /** It's the iCloud account Calendar uses. */
  calendar?: boolean
}

const host = z
  .string()
  .trim()
  .min(1, 'Enter the server’s name, like imap.example.com.')
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i, 'Enter the server’s name, like imap.example.com.')
const port = z.number().int().min(1).max(65535)

export const ImapServerSchema = z.object({ host, port, secure: z.boolean() }).strict()
export const SmtpServerSchema = z
  .object({ host, port, secure: z.boolean(), requireTLS: z.boolean() })
  .strict()
  // A password is never sent over a connection that isn't encrypted.
  .refine((s) => s.secure || s.requireTLS, 'Ordo only sends mail over an encrypted connection.')

/** Apple app-specific passwords are four groups of four letters, e.g. abcd-efgh-ijkl-mnop. */
const APPLE_APP_PASSWORD = /^[a-z]{4}-?[a-z]{4}-?[a-z]{4}-?[a-z]{4}$/i

const label = z
  .string()
  .trim()
  .max(40, 'Keep the name under 40 characters.')
  .refine((l) => !hasControlChars(l), 'The name can’t contain line breaks.')

const email = z.string().trim().pipe(z.email('Enter the email address for this account.'))
const password = z
  .string()
  .trim()
  .min(1, 'Enter the password.')
  .max(1024)
  .refine((p) => !hasControlChars(p), 'That password has characters Ordo can’t send.')

/** Why a password can't be right for this provider, or null. */
export function passwordProblem(provider: ProviderId, value: string): string | null {
  if (provider === 'icloud' && !APPLE_APP_PASSWORD.test(value.trim()))
    return 'App-specific passwords look like abcd-efgh-ijkl-mnop.'
  return null
}

/** Adding an account (or testing one before adding it). */
export const AddAccountSchema = z
  .object({
    provider: z.enum(PROVIDER_IDS as unknown as [ProviderId, ...ProviderId[]]),
    email,
    password,
    label: label.optional(),
    color: z.enum(ACCOUNT_COLORS).optional(),
    /** Other only: the servers to use. */
    imap: ImapServerSchema.optional(),
    smtp: SmtpServerSchema.optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (!PROVIDERS[a.provider].supported)
      ctx.addIssue({ code: 'custom', path: ['provider'], message: PROVIDERS[a.provider].notes[0] ?? '' })
    const bad = passwordProblem(a.provider, a.password)
    if (bad) ctx.addIssue({ code: 'custom', path: ['password'], message: bad })
    if (a.provider === 'other') {
      if (!a.imap) ctx.addIssue({ code: 'custom', path: ['imap'], message: 'Enter the IMAP server.' })
      if (!a.smtp) ctx.addIssue({ code: 'custom', path: ['smtp'], message: 'Enter the SMTP server.' })
    }
  })
export type AddAccountInput = z.input<typeof AddAccountSchema>

/** Rename an account or change its colour. */
export const UpdateAccountSchema = z
  .object({ id: AccountIdSchema, label: label.optional(), color: z.enum(ACCOUNT_COLORS).optional() })
  .strict()
export type UpdateAccountInput = z.input<typeof UpdateAccountSchema>

/** Enter an account's password again (it changed, or was revoked). */
export const SetPasswordSchema = z.object({ id: AccountIdSchema, password }).strict()
export type SetPasswordInput = z.input<typeof SetPasswordSchema>

/**
 * Add a Gmail account with Sign in with Google: an already-connected Google account (by its id;
 * Ordo asks it for mail access too if it hasn't given it), or a new sign-in in the browser. No
 * password: the address comes from Google.
 */
export const AddGoogleAccountSchema = z
  .object({
    googleAccountId: GoogleAccountIdSchema.optional(),
    label: label.optional(),
    color: z.enum(ACCOUNT_COLORS).optional(),
  })
  .strict()
export type AddGoogleAccountInput = z.input<typeof AddGoogleAccountSchema>

/** Sign in to Google again for an account that signs in with Google. */
export const SignInAgainSchema = z.object({ id: AccountIdSchema }).strict()
export type SignInAgainInput = z.input<typeof SignInAgainSchema>

/** A connected Google account, as the Add account sheet offers it. */
export interface GoogleMailChoice {
  /** Google's account id (`sub`). */
  id: string
  email: string
  /** It has already given Ordo mail access (no new consent needed). */
  hasMail: boolean
  needsReauth: boolean
  /** A mail account in Ordo already uses it. */
  inUse: boolean
}

/** What Sign in with Google can do right now, for the Add account sheet. */
export interface GoogleMailOptions {
  /** The OS keychain is available, so a sign-in can be stored. */
  secureStorage: boolean
  /** An OAuth client is saved in Settings → Google (Ordo has no shared one). */
  configured: boolean
  accounts: GoogleMailChoice[]
}

/** Test a new account's details, or an account that's already saved. */
export const TestAccountSchema = z.union([z.object({ id: AccountIdSchema }).strict(), AddAccountSchema])
export type TestAccountInput = z.input<typeof TestAccountSchema>

/** `cancelled`: the user stopped a browser sign-in; nothing to show. */
export type AccountError = 'invalid' | 'auth' | 'network' | 'unavailable' | 'unknown' | 'cancelled'
export type AccountResult =
  { ok: true; account: MailAccount } | { ok: false; error: AccountError; message: string }

export interface AccountsApi {
  /** Every account, in order (the first is where new mail is written from by default). */
  list(): Promise<AccountSummary[]>
  /** Sign in and out again, without saving anything. */
  test(input: TestAccountInput): Promise<AccountResult>
  /** Check the details by signing in, then save the account with its password encrypted. */
  add(input: AddAccountInput): Promise<AccountResult>
  /** Rename or recolour. */
  update(input: UpdateAccountInput): Promise<AccountResult>
  /** Check a new password by signing in, then save it. */
  setPassword(input: SetPasswordInput): Promise<AccountResult>
  /** Forget the account, its password and everything Ordo downloaded for it. Nothing on the server changes. */
  remove(id: AccountId): Promise<void>
  /** Whether Sign in with Google is set up, and the Google accounts already connected. */
  googleOptions(): Promise<GoogleMailOptions>
  /** Sign in with Google (in the browser), check Gmail accepts it, then save the account. */
  addGoogle(input: AddGoogleAccountInput): Promise<AccountResult>
  /** Stop waiting for a browser sign-in. */
  cancelGoogle(): Promise<void>
  /** Sign in to Google again for an account whose sign-in stopped working. */
  signInAgain(input: SignInAgainInput): Promise<AccountResult>
}

export const ACCOUNTS_IPC = {
  list: 'accounts:list',
  test: 'accounts:test',
  add: 'accounts:add',
  update: 'accounts:update',
  setPassword: 'accounts:set-password',
  remove: 'accounts:remove',
  googleOptions: 'accounts:google-options',
  addGoogle: 'accounts:add-google',
  cancelGoogle: 'accounts:cancel-google',
  signInAgain: 'accounts:sign-in-again',
} as const

/** A label for an account no one has named: the provider, then a number if that's taken. */
export function defaultLabel(provider: ProviderId, taken: readonly string[]): string {
  const base = PROVIDERS[provider].name
  const used = new Set(taken.map((t) => t.toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}

/** The next colour no account has yet, so accounts start out different. */
export function nextColor(taken: readonly AccountColor[]): AccountColor {
  return (
    ACCOUNT_COLORS.find((c) => !taken.includes(c)) ?? ACCOUNT_COLORS[taken.length % ACCOUNT_COLORS.length]!
  )
}

/**
 * Which account a message is written from. A reply, or a draft being finished, always goes from
 * the account the original is in. A new message goes from the one the user picked, else the one
 * they're looking at, else the first.
 */
export function fromAccount(
  accounts: readonly Pick<MailAccount, 'id'>[],
  choice: { original?: string; picked?: string; viewing?: string },
): string | null {
  const known = (id: string | undefined) => (id && accounts.some((a) => a.id === id) ? id : undefined)
  if (choice.original) return known(choice.original) ?? null
  return known(choice.picked) ?? known(choice.viewing) ?? accounts[0]?.id ?? null
}

/** Which inbox's senders Unclutter lists: one account's, or every account's (`all`, the default). */
export const SendersInputSchema = z.object({
  account: z.union([AccountIdSchema, z.literal('all')]).optional(),
})
