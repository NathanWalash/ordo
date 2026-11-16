export type Category =
  'promotions' | 'newsletters' | 'notifications' | 'receipts' | 'people' | 'uncategorised'

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
  | { kind: 'one-click'; url: string }
  | { kind: 'link'; url: string }
  | { kind: 'mailto'; address: string }
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
}

/** Anything that can serve mail: iCloud IMAP first, Gmail later. */
export interface MailProvider {
  listMailboxes(): Promise<{ path: string; specialUse?: string }[]>
  fetchHeaders(mailbox: string, sinceUid?: number): AsyncIterable<MessageHeader>
  moveToTrash(mailbox: string, uids: number[]): Promise<void>
  close(): Promise<void>
}
