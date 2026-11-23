/**
 * Mail providers Ordo knows how to reach, and what each needs. Pure data and functions: the main
 * process turns a preset into IMAP and SMTP settings for an account, and the window shows the
 * notes when you add one.
 */

export type ProviderId = 'icloud' | 'gmail' | 'yahoo' | 'fastmail' | 'outlook' | 'other'

export const PROVIDER_IDS: readonly ProviderId[] = [
  'icloud',
  'gmail',
  'yahoo',
  'fastmail',
  'outlook',
  'other',
]

export interface ImapServer {
  host: string
  port: number
  /** TLS from the start (993). When false, Ordo insists on STARTTLS before signing in. */
  secure: boolean
}

export interface SmtpServer {
  host: string
  port: number
  /** TLS from the start (465). */
  secure: boolean
  /** Refuse to send unless the server upgrades to TLS with STARTTLS (587). */
  requireTLS: boolean
}

export interface ProviderPreset {
  id: ProviderId
  /** What the window calls it: "iCloud", "Gmail". */
  name: string
  /** Null for Other, where you type the servers yourself. */
  imap: ImapServer | null
  smtp: SmtpServer | null
  /** False when Ordo can't sign in to it yet (Outlook.com: Microsoft turned off passwords for IMAP). */
  supported: boolean
  /** What the password field asks for. */
  passwordLabel: string
  /** Placeholder for the password field (iCloud's app-specific passwords have a fixed shape). */
  passwordHint: string
  /** Where to get an app password, as plain words for the window. */
  help: string
  /** Things to know before adding it, one per line. */
  notes: string[]
  /** Address domains that usually mean this provider, for a first guess. */
  domains: readonly string[]
}

export const PROVIDERS: Record<ProviderId, ProviderPreset> = {
  icloud: {
    id: 'icloud',
    name: 'iCloud',
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false, requireTLS: true },
    supported: true,
    passwordLabel: 'App-specific password',
    passwordHint: 'abcd-efgh-ijkl-mnop',
    help: 'Create one at account.apple.com, under Sign-In and Security. Your Apple ID password won’t work.',
    notes: ['iCloud also gives Ordo your calendars.'],
    domains: ['icloud.com', 'me.com', 'mac.com'],
  },
  gmail: {
    id: 'gmail',
    name: 'Gmail',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true, requireTLS: false },
    supported: true,
    passwordLabel: 'App password',
    passwordHint: '16 letters',
    help: 'Create one at myaccount.google.com/apppasswords. Your Google password won’t work.',
    notes: [
      'App passwords need 2-Step Verification turned on for your Google Account.',
      'Work and school accounts (Google Workspace) may not allow app passwords or IMAP: ask your admin. Sign in with Google is coming, and will work for those too.',
    ],
    domains: ['gmail.com', 'googlemail.com'],
  },
  yahoo: {
    id: 'yahoo',
    name: 'Yahoo Mail',
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true, requireTLS: false },
    supported: true,
    passwordLabel: 'App password',
    passwordHint: '16 letters',
    help: 'Create one in Yahoo Account Security, under “Generate app password”.',
    notes: [],
    domains: ['yahoo.com', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com'],
  },
  fastmail: {
    id: 'fastmail',
    name: 'Fastmail',
    imap: { host: 'imap.fastmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.fastmail.com', port: 465, secure: true, requireTLS: false },
    supported: true,
    passwordLabel: 'App password',
    passwordHint: 'xxxx xxxx xxxx xxxx',
    help: 'Create one in Fastmail Settings → Privacy & Security → Manage app passwords, with IMAP and SMTP access.',
    notes: [],
    domains: ['fastmail.com', 'fastmail.fm'],
  },
  outlook: {
    id: 'outlook',
    name: 'Outlook.com',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false, requireTLS: true },
    supported: false,
    passwordLabel: 'Password',
    passwordHint: '',
    help: '',
    notes: [
      'Not supported yet: Microsoft has turned off password sign-in for IMAP. Ordo needs Microsoft sign-in for Outlook.com, Hotmail and Live, which is coming later.',
    ],
    domains: ['outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'live.co.uk', 'msn.com'],
  },
  other: {
    id: 'other',
    name: 'Other',
    imap: null,
    smtp: null,
    supported: true,
    passwordLabel: 'Password',
    passwordHint: '',
    help: 'Use an app password if your provider has them. Ordo always uses an encrypted connection.',
    notes: ['Ask your provider for its IMAP and SMTP servers. Test the connection before you add it.'],
    domains: [],
  },
}

/** The provider an address most likely belongs to, or `other`. */
export function guessProvider(email: string): ProviderId {
  const domain = email.trim().toLowerCase().split('@')[1] ?? ''
  for (const p of PROVIDER_IDS) if (PROVIDERS[p].domains.includes(domain)) return p
  return 'other'
}

/**
 * The servers for an account: the preset's, or for Other the ones typed in. Null when Other has
 * none, or the provider isn't supported.
 */
export function serversFor(
  provider: ProviderId,
  manual?: { imap: ImapServer; smtp: SmtpServer },
): { imap: ImapServer; smtp: SmtpServer } | null {
  const p = PROVIDERS[provider]
  if (!p.supported) return null
  if (p.imap && p.smtp) return { imap: { ...p.imap }, smtp: { ...p.smtp } }
  return manual ? { imap: { ...manual.imap }, smtp: { ...manual.smtp } } : null
}

/**
 * Typical SMTP security for a port: 465 is TLS from the start, anything else (587, 25) must
 * upgrade with STARTTLS. Ordo never sends a password over a connection that isn't encrypted.
 */
export function smtpSecurityFor(port: number): Pick<SmtpServer, 'secure' | 'requireTLS'> {
  return port === 465 ? { secure: true, requireTLS: false } : { secure: false, requireTLS: true }
}

/** Typical IMAP security for a port: 993 is TLS from the start, 143 must upgrade with STARTTLS. */
export function imapSecureFor(port: number): boolean {
  return port !== 143
}
