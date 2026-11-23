import type { UnsubscribeOutcome } from './unsubscribe-run'

export type Category =
  'promotions' | 'newsletters' | 'notifications' | 'receipts' | 'people' | 'uncategorised'

export const CATEGORIES: readonly Category[] = [
  'promotions',
  'newsletters',
  'notifications',
  'receipts',
  'people',
  'uncategorised',
]

/** An email address with an optional display name. */
export interface Address {
  address: string
  name?: string
}

/** Header-only view of a message, as fetched during a scan. */
export interface MessageHeader {
  uid: number
  mailbox: string
  /** The account it belongs to (its id). Set on headers read from the cache. */
  account?: string
  date: Date
  seen: boolean
  from: Address
  subject: string
  listId?: string
  listUnsubscribe?: string
  listUnsubscribePost?: string
  precedence?: string
  autoSubmitted?: string
  /** Flagged (\Flagged). Missing on headers cached before the mail client existed. */
  flagged?: boolean
  /** Replied to (\Answered). */
  answered?: boolean
  to?: Address[]
  cc?: Address[]
  messageId?: string
  /** The message probably has attachments (multipart/mixed). A hint for the list, not a promise. */
  hasAttachments?: boolean
}

/**
 * What a mailbox is for, from its SPECIAL-USE flag (or its name, when the server has none).
 * `all` is Gmail's All Mail (`\All`): every message, whatever its labels. Archiving on Gmail moves
 * a message there (which takes it out of the Inbox).
 */
export type MailboxRole = 'inbox' | 'drafts' | 'sent' | 'archive' | 'all' | 'junk' | 'trash'

export const MAILBOX_ROLES: readonly MailboxRole[] = [
  'inbox',
  'drafts',
  'sent',
  'archive',
  'all',
  'junk',
  'trash',
]

/** A folder on the server. */
export interface MailboxInfo {
  /** The full IMAP path, e.g. `INBOX` or `Projects/2026`. */
  path: string
  /** The last part of the path, for display. */
  name: string
  role: MailboxRole | null
  delimiter: string
  /** Messages and unread messages, from STATUS when the list was fetched. */
  total: number
  unread: number
}

/** A file attached to a message (or an inline image). */
export interface AttachmentInfo {
  /** IMAP body part number, e.g. `2` or `1.2`. */
  part: string
  filename: string
  contentType: string
  /** Encoded size reported by the server, in bytes (roughly a third more than the file). */
  size: number
  /** Content-ID, for inline images the HTML refers to as `cid:`. */
  contentId?: string
  /** Shown inside the message rather than listed as a file. */
  inline: boolean
}

/** A message read from the server: headers, body text and attachment list. */
export interface MessageContent {
  mailbox: string
  uid: number
  date: Date
  subject: string
  from: Address | null
  to: Address[]
  cc: Address[]
  /** Only ever set on your own drafts and sent copies. */
  bcc: Address[]
  replyTo: Address[]
  messageId: string | null
  /** The In-Reply-To header: the message this one answers, if it says. */
  inReplyTo: string | null
  /** In-Reply-To and References, oldest first, for threading a reply. */
  references: string[]
  seen: boolean
  flagged: boolean
  answered: boolean
  draft: boolean
  /** The plain-text body, if the message has one. */
  text: string | null
  /** The HTML body, untouched. Never show it without sanitising it first. */
  html: string | null
  /** The body was cut short at Ordo's size limit. */
  truncated: boolean
  /** Files and inline images. */
  attachments: AttachmentInfo[]
  /** Inline images the HTML refers to, as data: URIs by Content-ID (without angle brackets). */
  inlineImages: Record<string, string>
}

export type UnsubscribeMethod =
  /** RFC 8058: an HTTPS POST does it, no browser needed. */
  | { kind: 'one-click'; url: string }
  /** A web page to finish in the browser. May be plain http, which the review sheet spells out. */
  | { kind: 'link'; url: string }
  /** An email to send. `url` is the full mailto: URL, including any subject= and body=. */
  | { kind: 'mailto'; address: string; url: string }
  | { kind: 'none' }

export interface SenderSummary {
  address: string
  name?: string
  domain: string
  listId?: string
  count: number
  unread: number
  firstSeen: Date
  lastSeen: Date
  sampleSubjects: string[]
  unsubscribe: UnsubscribeMethod
  /** Sent through a mailing list (List-Id, List-Unsubscribe or Precedence: bulk/list). */
  bulk: boolean
  /** Machine-sent: an Auto-Submitted header or a no-reply style address. */
  automated: boolean
}

export interface MailboxStatus {
  messages: number
  uidNext: number
  /** Changes when the server renumbers the mailbox; cached UIDs are then invalid. */
  uidValidity: string
}

export type SpecialMailbox = '\\Sent' | '\\Trash' | '\\Junk' | '\\Drafts' | '\\Archive'

/** Where moved messages ended up. */
export interface MoveResult {
  /** UIDVALIDITY of the destination, when the server reported it (UIDPLUS COPYUID). */
  uidValidity: string | null
  /** Source UID to destination UID, or null when the server didn't report one (no UIDPLUS). */
  uidMap: Map<number, number> | null
}

/** Anything that can serve mail: iCloud IMAP first, Gmail later. */
export interface MailProvider {
  connect(): Promise<void>
  status(mailbox: string): Promise<MailboxStatus>
  /** Headers for every message with a UID of at least `fromUid`, oldest first. */
  fetchHeaders(mailbox: string, fromUid: number): AsyncIterable<MessageHeader>
  findMailbox(use: SpecialMailbox): Promise<string | null>
  /** Addresses this account has sent mail to, from the most recent `limit` messages. */
  fetchRecipients(mailbox: string, limit: number): Promise<string[]>
  /** Move messages by UID (IMAP MOVE, or COPY + delete on servers without it). Never deletes. */
  moveMessages(from: string, to: string, uids: number[]): Promise<MoveResult>
  /** The subset of `uids` that still exists in `mailbox`. */
  existingUids(mailbox: string, uids: number[]): Promise<number[]>
  close(): Promise<void>
}

export interface ScanProgress {
  phase: 'inbox' | 'sent' | 'done'
  checked: number
  total: number
}

export interface ScanResult {
  added: number
  total: number
  stopped: boolean
}

/** What happened to one sender in a clean-up. */
export interface CleanupSenderResult {
  address: string
  name?: string
  category: Category
  /** The user asked to move this sender's emails to Trash. */
  trash: boolean
  /** Emails actually moved to Trash. */
  moved: number
  /** Null when the user didn't ask to unsubscribe (or there was no way to). */
  unsubscribe: UnsubscribeOutcome | null
}

/** A past clean-up, as the History view shows it. */
export interface CleanupSummary {
  id: number
  /** The account it cleaned up (its id). */
  account: string
  at: Date
  /** Where the emails came from (INBOX). */
  mailbox: string
  trashMailbox: string | null
  moved: number
  senders: CleanupSenderResult[]
  /** Set when moving stopped part-way; everything moved before that is recorded. */
  error: string | null
  /** The server reported where each email went, and the move hasn't been undone yet. */
  canUndo: boolean
  undoneAt: Date | null
  /** How many emails Undo put back. */
  restored: number | null
}

/** The stored clean-up, including what Undo needs. Stays in the main process. */
export interface CleanupRecord extends CleanupSummary {
  trashUidValidity: string | null
  /** [source UID, Trash UID] pairs from UIDPLUS COPYUID; null when the server didn't report them. */
  uidMap: [number, number][] | null
}

export interface CleanupProgress {
  phase: 'unsubscribe' | 'move' | 'done'
  done: number
  total: number
}

export interface UndoResult {
  restored: number
  /** Emails that couldn't be put back (deleted from Trash, or Trash was renumbered). */
  missing: number
  /** Why nothing could be restored, when that's the case. */
  reason?: 'already-undone' | 'no-map' | 'trash-renumbered'
}
