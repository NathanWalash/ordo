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

/** Header-only view of a message, as fetched during a scan. */
export interface MessageHeader {
  uid: number
  mailbox: string
  date: Date
  seen: boolean
  from: { address: string; name?: string }
  subject: string
  listId?: string
  listUnsubscribe?: string
  listUnsubscribePost?: string
  precedence?: string
  autoSubmitted?: string
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

export type SpecialMailbox = '\\Sent' | '\\Trash' | '\\Junk'

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
