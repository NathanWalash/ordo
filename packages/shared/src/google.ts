import { z } from 'zod'

/** The user's own OAuth client ("Desktop app" type) from Google Cloud. See docs/google.md. */
export const GoogleClientSchema = z.strictObject({
  clientId: z
    .string()
    .trim()
    .regex(/^[0-9]{1,30}-[0-9a-z]{1,64}\.apps\.googleusercontent\.com$/, {
      message: 'Paste the client ID ending in .apps.googleusercontent.com.',
    }),
  clientSecret: z.string().trim().max(200).optional(),
})
export type GoogleClientInput = z.infer<typeof GoogleClientSchema>

/** Google's account id (`sub`). */
export const GoogleAccountIdSchema = z.string().regex(/^[\w-]{1,255}$/)

export const ConnectGoogleSchema = z
  .strictObject({
    accountId: GoogleAccountIdSchema.optional(),
    /** With `accountId`: ask that account for Calendar access too (one added for Mail only). */
    addCalendar: z.boolean().optional(),
  })
  .optional()
export type ConnectGoogleInput = z.infer<typeof ConnectGoogleSchema>

export const CalendarColorSchema = z.strictObject({
  calendarId: z.string().min(1).max(2048),
  /** `#rrggbb`, or null for the calendar's own colour. */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .transform((c) => c.toLowerCase())
    .nullable(),
})
export type CalendarColorInput = z.input<typeof CalendarColorSchema>

export const ReplaceFeedSchema = z.strictObject({ feedId: z.string().min(1).max(100) })
export type ReplaceFeedInput = z.infer<typeof ReplaceFeedSchema>

/** Signing out of Google: the mail accounts that sign in with it, which go too (the user confirmed them). */
export const SignOutGoogleOptionsSchema = z
  .strictObject({ removeMail: z.array(z.string().regex(/^[a-z0-9-]{1,40}$/)).max(100) })
  .optional()
export type SignOutGoogleOptions = z.infer<typeof SignOutGoogleOptionsSchema>

export interface GoogleAccountStatus {
  id: string
  email: string
  /** Google stopped accepting Ordo's sign-in (revoked, or 7 days passed in Testing): sign in again. */
  needsReauth: boolean
  calendars: number
  /** It gave Ordo Calendar access (an account added for Mail only hasn't). */
  calendar: boolean
  /** Mail accounts in Ordo that sign in with it. */
  mailAccounts: { id: string; label: string; email: string }[]
}

export interface GoogleStatus {
  /** The OS keychain is available, so sign-ins can be stored. */
  secureStorage: boolean
  client: { clientId: string; hasSecret: boolean } | null
  accounts: GoogleAccountStatus[]
  /** A browser sign-in is waiting to come back. */
  signingIn: boolean
}

export type GoogleConnectError =
  | 'not-configured'
  | 'cancelled'
  | 'timeout'
  | 'denied'
  | 'admin-blocked'
  | 'scopes'
  | 'invalid-client'
  | 'storage'
  | 'network'
  | 'unknown'

export type GoogleConnectOutcome =
  { ok: true; account: GoogleAccountStatus } | { ok: false; error: GoogleConnectError; message: string }

export type GoogleSimpleOutcome = { ok: true } | { ok: false; message: string }

/** A calendar added by its Google iCal link that's also in a connected Google account. */
export interface GoogleFeedMatch {
  feedId: string
  feedName: string
  calendarId: string
  calendarName: string
  email: string
}

export interface GoogleApi {
  status(): Promise<GoogleStatus>
  setClient(input: GoogleClientInput): Promise<GoogleSimpleOutcome>
  /** Sign in through the browser: a new account, or `accountId` again. */
  connect(input?: ConnectGoogleInput): Promise<GoogleConnectOutcome>
  cancelConnect(): Promise<void>
  /**
   * Revoke Ordo's access and forget the account and its calendars. Mail accounts that sign in with
   * it are removed too, but only those listed in `removeMail` (the user confirmed them); any other
   * refuses the sign-out.
   */
  signOut(accountId: string, options?: SignOutGoogleOptions): Promise<GoogleSimpleOutcome>
  setCalendarColor(input: CalendarColorInput): Promise<void>
  feedMatches(): Promise<GoogleFeedMatch[]>
  /** Remove a link calendar in favour of the same calendar from a connected account. */
  replaceFeed(input: ReplaceFeedInput): Promise<GoogleSimpleOutcome>
}

export const GOOGLE_IPC = {
  googleStatus: 'google:status',
  googleSetClient: 'google:set-client',
  googleConnect: 'google:connect',
  googleCancel: 'google:cancel',
  googleSignOut: 'google:sign-out',
  googleSetColor: 'google:set-color',
  googleFeedMatches: 'google:feed-matches',
  googleReplaceFeed: 'google:replace-feed',
} as const
