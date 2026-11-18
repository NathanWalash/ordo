import { z } from 'zod'
import {
  COMPOSE_LIMITS,
  hasControlChars,
  LINK_MAX,
  type Address,
  type AttachmentInfo,
  type MailboxInfo,
  type MailboxRole,
  type MessageContent,
} from '@ordo/mail-core'

/** An IMAP folder path, as listed by the server. The main process also checks it's one it knows. */
export const MailboxPathSchema = z
  .string()
  .min(1)
  .max(1000)
  .refine((p) => !hasControlChars(p), 'Not a mailbox')

const uid = z.number().int().positive().max(4_294_967_295)

export const MessageRefSchema = z.object({ mailbox: MailboxPathSchema, uid })
export type MessageRef = z.infer<typeof MessageRefSchema>

export const MessageListQuerySchema = z.object({
  mailbox: MailboxPathSchema,
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).max(1_000_000).default(0),
  unread: z.boolean().optional(),
})
export type MessageListQuery = z.input<typeof MessageListQuerySchema>

export const SearchQuerySchema = z.object({
  query: z.string().trim().min(1).max(200),
  /** Only this folder; every cached folder when missing (local search only). */
  mailbox: MailboxPathSchema.optional(),
  limit: z.number().int().min(1).max(200).default(50),
})
export type SearchQueryInput = z.input<typeof SearchQuerySchema>

export const ServerSearchSchema = SearchQuerySchema.extend({ mailbox: MailboxPathSchema })
export type ServerSearchInput = z.input<typeof ServerSearchSchema>

const uids = z.array(uid).min(1).max(500)

export const SetFlagsSchema = z
  .object({
    mailbox: MailboxPathSchema,
    uids,
    seen: z.boolean().optional(),
    flagged: z.boolean().optional(),
  })
  .refine((f) => f.seen !== undefined || f.flagged !== undefined, 'Nothing to change')
export type SetFlagsInput = z.input<typeof SetFlagsSchema>

/** Where messages can be moved from the reader. */
export const MOVE_TARGETS = ['archive', 'trash', 'inbox', 'junk'] as const
export type MoveTarget = (typeof MOVE_TARGETS)[number]

export const MoveSchema = z.object({ mailbox: MailboxPathSchema, uids, to: z.enum(MOVE_TARGETS) })
export type MoveInput = z.input<typeof MoveSchema>

export const UndoMoveSchema = z.number().int().positive()

export const LoadImagesSchema = z.object({ urls: z.array(z.string().max(LINK_MAX)).max(200) })

export const OpenLinkSchema = z.string().min(1).max(LINK_MAX)

const part = z
  .string()
  .max(40)
  .regex(/^\d+(\.\d+)*$/, 'Not a part')

export const AttachmentRefSchema = MessageRefSchema.extend({ part })
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>

/** A file picked to attach. The window only ever sees its name and size; the path stays in main. */
export interface PickedFile {
  id: string
  name: string
  size: number
}

const addressField = z.string().max(20_000)

/** A message from the compose sheet. Addresses are parsed and checked again in the main process. */
export const ComposeSchema = z.object({
  to: addressField,
  cc: addressField,
  bcc: addressField,
  subject: z.string().max(COMPOSE_LIMITS.subject),
  body: z.string().max(COMPOSE_LIMITS.body),
  /** The message being replied to: main threads the reply and marks it answered. */
  replyTo: MessageRefSchema.optional(),
  /** The message being forwarded, and which of its attachments to include. */
  forward: MessageRefSchema.extend({ parts: z.array(part).max(COMPOSE_LIMITS.attachments) }).optional(),
  /** Files from pickAttachments, by id. */
  attachments: z.array(z.string().uuid()).max(COMPOSE_LIMITS.attachments),
  /** The saved draft this replaces, if any. */
  draft: MessageRefSchema.optional(),
})
export type ComposeInput = z.input<typeof ComposeSchema>

/** A row in the message list. */
export interface MessageSummary {
  mailbox: string
  uid: number
  date: Date
  from: Address
  to: Address[]
  subject: string
  seen: boolean
  flagged: boolean
  answered: boolean
  hasAttachments: boolean
}

/** `busy`: this window is already doing that; `locked`: another Ordo process is writing. */
export type MailError =
  'invalid' | 'auth' | 'network' | 'busy' | 'locked' | 'not-found' | 'unavailable' | 'unknown'

export type MailFailure = { ok: false; error: MailError; message: string }
export type MailOutcome<T extends object = object> = ({ ok: true } & T) | MailFailure

export interface MailRefreshProgress {
  mailbox: string
  checked: number
  total: number
}

export interface MailApi {
  /** Folders from the cache, special ones first. Empty until the first refresh. */
  mailboxes(): Promise<MailboxInfo[]>
  /** Fetch the folder list and new mail in one folder from the server into the cache. */
  refresh(input: {
    mailbox: string
  }): Promise<MailOutcome<{ added: number; removed: number; changed: number }>>
  onRefreshProgress(listener: (p: MailRefreshProgress) => void): () => void
  /** One page of a folder from the cache, newest first. */
  messages(query: MessageListQuery): Promise<{ total: number; messages: MessageSummary[] }>
  /** Search the cache: subjects, people and the bodies of messages already opened. */
  search(query: SearchQueryInput): Promise<MessageSummary[]>
  /** Search one folder on the server (IMAP SEARCH), for older mail. */
  searchServer(query: ServerSearchInput): Promise<MailOutcome<{ messages: MessageSummary[] }>>
  /** Read a message (from the cache, or the server). Doesn't mark it read. */
  open(ref: MessageRef): Promise<MailOutcome<{ message: MessageContent }>>
  setFlags(input: SetFlagsInput): Promise<MailOutcome>
  /** Move to Archive, Bin, Inbox or Junk. `undoId` is null when the server can't say where they went. */
  move(input: MoveInput): Promise<MailOutcome<{ moved: number; undoId: number | null }>>
  undoMove(undoId: number): Promise<MailOutcome<{ restored: number }>>
  /** Fetch a message's remote images through Ordo, as data: URLs. */
  loadImages(input: { urls: string[] }): Promise<{ images: Record<string, string>; failed: number }>
  /** Open a web link from a message in the browser, after the window has asked. */
  openLink(url: string): Promise<MailOutcome>
  /** Save an attachment with the save dialog. `saved` is false if the dialog was cancelled. */
  saveAttachment(ref: AttachmentRef): Promise<MailOutcome<{ saved: boolean }>>
  /** Save every attachment into a folder chosen with the open dialog. `saved` is how many. */
  saveAllAttachments(ref: MessageRef): Promise<MailOutcome<{ saved: number }>>
  /** Choose files to attach with the open dialog. */
  pickAttachments(): Promise<PickedFile[]>
  /** Send a message. The preload only passes this on from a click. */
  send(input: ComposeInput): Promise<MailOutcome<{ warning?: string }>>
  /** Save to Drafts, replacing the earlier version. */
  /** Its attachments are those of the new draft, to carry on from (the old one is gone). */
  saveDraft(
    input: ComposeInput,
  ): Promise<MailOutcome<{ draft: MessageRef | null; attachments: AttachmentInfo[] }>>
}

export const MAIL_IPC = {
  mailboxes: 'mail:mailboxes',
  refresh: 'mail:refresh',
  refreshProgress: 'mail:refresh-progress',
  messages: 'mail:messages',
  search: 'mail:search',
  searchServer: 'mail:search-server',
  open: 'mail:open',
  setFlags: 'mail:set-flags',
  move: 'mail:move',
  undoMove: 'mail:undo-move',
  loadImages: 'mail:load-images',
  openLink: 'mail:open-link',
  saveAttachment: 'mail:save-attachment',
  saveAllAttachments: 'mail:save-all-attachments',
  pickAttachments: 'mail:pick-attachments',
  send: 'mail:send',
  saveDraft: 'mail:save-draft',
} as const

export type { Address, AttachmentInfo, MailboxInfo, MailboxRole, MessageContent }
