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

/** Anything that can serve mail: iCloud IMAP first, Gmail later. */
export interface MailProvider {
  connect(): Promise<void>
  status(mailbox: string): Promise<MailboxStatus>
  /** Headers for every message with a UID of at least `fromUid`, oldest first. */
  fetchHeaders(mailbox: string, fromUid: number): AsyncIterable<MessageHeader>
  findMailbox(use: SpecialMailbox): Promise<string | null>
  /** Addresses this account has sent mail to, from the most recent `limit` messages. */
  fetchRecipients(mailbox: string, limit: number): Promise<string[]>
  moveToTrash(mailbox: string, uids: number[]): Promise<void>
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
