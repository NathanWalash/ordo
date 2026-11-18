import { randomUUID } from 'node:crypto'
import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import {
  bodyText,
  checkLink,
  COMPOSE_LIMITS,
  hasControlChars,
  parseAddressList,
  referencesFor,
  safeFilename,
  type MailboxInfo,
  type MessageContent,
  type MessageHeader,
} from '@ordo/mail-core'
import {
  buildMessage,
  checkOutgoing,
  createGuardedFetch,
  ImapMailProvider,
  loadRemoteImages,
  MailAuthError,
  reconcileFolder,
  sendMessage,
  syncFolder,
  type ImageFetch,
  type OutgoingMessage,
} from '@ordo/mail-core/node'
import {
  AttachmentRefSchema,
  ComposeSchema,
  LoadImagesSchema,
  MAIL_IPC,
  MessageListQuerySchema,
  MessageRefSchema,
  MoveSchema,
  OpenLinkSchema,
  SearchQuerySchema,
  ServerSearchSchema,
  SetFlagsSchema,
  UndoMoveSchema,
  type AttachmentRef,
  type ComposeInput,
  type MailError,
  type MailFailure,
  type MailOutcome,
  type MailRefreshProgress,
  type MessageRef,
  type MessageSummary,
  type MoveTarget,
  type PickedFile,
} from '@ordo/shared'
import { loadAccount } from './account'
import { allowLoopbackHttp, explain, imapConfig, INBOX, mailStore, scan, smtpConfig } from './mail'
import { closeImapSession, NotConnected, withImap } from './mail-session'
import { Locked, toRenderer, withWriteLock } from './writes'

/**
 * The mail client: folders, the message list, reading, search, flags, moves with undo,
 * attachments, links, remote images, and writing mail. Every input from the window is checked
 * with zod here; text from emails is data and never more.
 */

const fail = (error: MailError, message: string): MailFailure => ({ ok: false, error, message })
const NO_ACCOUNT = fail('auth', 'Connect your iCloud account first.')
const INVALID = fail('invalid', 'That request isn’t valid.')
const UNKNOWN_MAILBOX = fail('not-found', 'That mailbox isn’t there any more. Refresh and try again.')

/** A failure the window can show, from anything a mail call threw. */
function failure(err: unknown): MailFailure {
  if (err instanceof NotConnected) return NO_ACCOUNT
  if (err instanceof Locked) return fail('locked', err.message)
  const e = explain(err)
  return fail(e.error === 'auth' || e.error === 'network' ? e.error : 'unknown', e.message)
}

/** Run a change under the shared write lock; a lock held elsewhere becomes a `locked` failure. */
async function changing<T extends object>(
  task: string,
  fn: () => Promise<MailOutcome<T>>,
): Promise<MailOutcome<T>> {
  try {
    const r = await withWriteLock(task, fn)
    return r instanceof Locked ? fail('locked', r.message) : r
  } catch (err) {
    return failure(err)
  }
}

/** Only folders the server listed (or INBOX) can be named by the window. */
function knownMailbox(path: string): MailboxInfo | null {
  const boxes = mailStore().mailboxes()
  return (
    boxes.find((m) => m.path === path) ??
    (path === INBOX
      ? { path: INBOX, name: 'Inbox', role: 'inbox', delimiter: '/', total: 0, unread: 0 }
      : null)
  )
}

function mailboxFor(role: MoveTarget | 'sent' | 'drafts'): string | null {
  const target = role === 'trash' ? 'trash' : role
  if (target === 'inbox') return INBOX
  return (
    mailStore()
      .mailboxes()
      .find((m) => m.role === target)?.path ?? null
  )
}

const summary = (h: MessageHeader): MessageSummary => ({
  mailbox: h.mailbox,
  uid: h.uid,
  date: h.date,
  from: h.from,
  to: h.to ?? [],
  subject: h.subject,
  seen: h.seen,
  flagged: h.flagged ?? false,
  answered: h.answered ?? false,
  hasAttachments: h.hasAttachments ?? false,
})

// Folders

export function mailboxes(): MailboxInfo[] {
  return loadAccount() ? mailStore().mailboxes() : []
}

let refreshing = new Set<string>()

/** Refresh the folder list and one folder's messages from the server into the cache. */
export async function refresh(
  input: unknown,
  onProgress?: (p: MailRefreshProgress) => void,
): Promise<MailOutcome<{ added: number; removed: number; changed: number }>> {
  const parsed = MessageRefSchema.pick({ mailbox: true }).safeParse(input)
  if (!parsed.success) return INVALID
  const account = loadAccount()
  if (!account) return NO_ACCOUNT
  const { mailbox } = parsed.data
  if (refreshing.has(mailbox)) return fail('busy', 'Already checking for new mail.')
  refreshing.add(mailbox)
  const store = mailStore()
  try {
    if (mailbox === INBOX) {
      // The inbox goes through the same scan as Unclutter, so its cache stays complete.
      let removed = 0
      let changed = 0
      const r = await scan(
        (p) => onProgress?.({ mailbox, checked: p.checked, total: p.total }),
        async (provider) => {
          store.saveMailboxes(await provider.listMailboxes())
          ;({ removed, changed } = await reconcileFolder(provider, store, INBOX))
        },
      )
      if (!r.ok) {
        const known = ['locked', 'busy', 'auth', 'network'] as const
        return fail(known.find((k) => k === r.error) ?? 'unknown', r.message)
      }
      return { ok: true, added: r.added, removed, changed }
    }
    return await changing('checking for new mail', async () => {
      const provider = new ImapMailProvider(imapConfig(account.email, account.password))
      try {
        await provider.connect()
        const list = await provider.listMailboxes()
        store.saveMailboxes(list)
        if (!list.some((m) => m.path === mailbox)) return UNKNOWN_MAILBOX
        // Other folders fetch a few hundred headers at most, so progress is just "done".
        const res = await syncFolder(provider, store, mailbox)
        onProgress?.({ mailbox, checked: res.total, total: res.total })
        return { ok: true, added: res.added, removed: res.removed, changed: res.changed }
      } finally {
        await provider.close().catch(() => {})
      }
    })
  } catch (err) {
    return failure(err)
  } finally {
    refreshing.delete(mailbox)
  }
}

// Reading

export function messages(input: unknown): { total: number; messages: MessageSummary[] } {
  const parsed = MessageListQuerySchema.safeParse(input)
  if (!parsed.success || !loadAccount()) return { total: 0, messages: [] }
  const { mailbox, ...q } = parsed.data
  const page = mailStore().messages(mailbox, q)
  return { total: page.total, messages: page.messages.map(summary) }
}

export function search(input: unknown): MessageSummary[] {
  const parsed = SearchQuerySchema.safeParse(input)
  if (!parsed.success || !loadAccount()) return []
  const { query, ...q } = parsed.data
  return mailStore().search(query, q).map(summary)
}

/** IMAP SEARCH in one folder, for mail older than the cache. Results are cached so they can be opened. */
export async function searchServer(input: unknown): Promise<MailOutcome<{ messages: MessageSummary[] }>> {
  const parsed = ServerSearchSchema.safeParse(input)
  if (!parsed.success) return INVALID
  if (!loadAccount()) return NO_ACCOUNT
  const { mailbox, query, limit } = parsed.data
  if (!knownMailbox(mailbox)) return UNKNOWN_MAILBOX
  const words = query.split(/\s+/).filter(Boolean).slice(0, 8)
  try {
    const found = await withImap((p) => p.search(mailbox, words, limit))
    const store = mailStore()
    // Only cache headers we don't have: never overwrite fresher flags.
    store.saveHeaders(found.filter((h) => !store.message(mailbox, h.uid)))
    return { ok: true, messages: found.sort((a, b) => b.date.getTime() - a.date.getTime()).map(summary) }
  } catch (err) {
    return failure(err)
  }
}

/** Bodies bigger than this aren't kept in the cache (they're fetched again when opened). */
const BODY_CACHE_MAX = 4 * 1024 * 1024
const SEARCH_TEXT_MAX = 200_000

async function fetchContent(ref: MessageRef): Promise<MessageContent | null> {
  const store = mailStore()
  const cached = store.body(ref.mailbox, ref.uid)
  if (cached) return cached
  const content = await withImap((p) => p.fetchMessage(ref.mailbox, ref.uid))
  if (!content) {
    store.deleteMessages(ref.mailbox, [ref.uid])
    return null
  }
  // Keep the body for next time and for search, unless it's huge. Bodies never change for a UID.
  if (JSON.stringify(content).length <= BODY_CACHE_MAX && store.message(ref.mailbox, ref.uid))
    store.saveBody(content, bodyText(content).slice(0, SEARCH_TEXT_MAX))
  return content
}

/** Read a message. Never marks it read: the window does that with setFlags. */
export async function open(input: unknown): Promise<MailOutcome<{ message: MessageContent }>> {
  const parsed = MessageRefSchema.safeParse(input)
  if (!parsed.success) return INVALID
  if (!loadAccount()) return NO_ACCOUNT
  if (!knownMailbox(parsed.data.mailbox)) return UNKNOWN_MAILBOX
  try {
    const message = await fetchContent(parsed.data)
    return message ? { ok: true, message } : fail('not-found', 'This message isn’t there any more.')
  } catch (err) {
    return failure(err)
  }
}

// Changing mail

async function updateCounts(provider: ImapMailProvider, mailbox: string): Promise<void> {
  const s = await provider.status(mailbox)
  mailStore().setMailboxCounts(mailbox, { total: s.messages, unread: s.unseen })
}

export async function setFlags(input: unknown): Promise<MailOutcome> {
  const parsed = SetFlagsSchema.safeParse(input)
  if (!parsed.success) return INVALID
  if (!loadAccount()) return NO_ACCOUNT
  const { mailbox, uids, seen, flagged } = parsed.data
  if (!knownMailbox(mailbox)) return UNKNOWN_MAILBOX
  return changing('changing mail', () =>
    withImap(async (p) => {
      const store = mailStore()
      if (seen !== undefined) {
        await p.setFlag(mailbox, uids, '\\Seen', seen)
        store.setFlag(mailbox, uids, 'seen', seen)
      }
      if (flagged !== undefined) {
        await p.setFlag(mailbox, uids, '\\Flagged', flagged)
        store.setFlag(mailbox, uids, 'flagged', flagged)
      }
      await updateCounts(p, mailbox).catch(() => {})
      return { ok: true }
    }),
  )
}

interface MoveRecord {
  from: string
  to: string
  toUidValidity: string | null
  /** [UID in `from`, UID in `to`] */
  pairs: [number, number][]
}

/** Recent moves that can be undone, newest last. Kept in memory: undo is for the moment. */
const moves = new Map<number, MoveRecord>()
let nextMoveId = 1
const MOVES_KEPT = 20

const TARGET_NAMES: Record<MoveTarget, string> = {
  archive: 'Archive',
  trash: 'Bin',
  inbox: 'Inbox',
  junk: 'Junk',
}

/** Move messages to Archive, Bin, Inbox or Junk. Nothing is ever deleted. */
export async function move(input: unknown): Promise<MailOutcome<{ moved: number; undoId: number | null }>> {
  const parsed = MoveSchema.safeParse(input)
  if (!parsed.success) return INVALID
  if (!loadAccount()) return NO_ACCOUNT
  const { mailbox, uids, to } = parsed.data
  if (!knownMailbox(mailbox)) return UNKNOWN_MAILBOX
  const target = mailboxFor(to)
  if (!target) return fail('unavailable', `This account has no ${TARGET_NAMES[to]} mailbox.`)
  if (target === mailbox) return fail('invalid', `These messages are already in ${TARGET_NAMES[to]}.`)
  return changing('moving mail', () =>
    withImap(async (p) => {
      const res = await p.moveMessages(mailbox, target, uids)
      const store = mailStore()
      store.deleteMessages(mailbox, uids)
      const moved = res.uidMap ? res.uidMap.size : uids.length
      let undoId: number | null = null
      if (res.uidMap?.size) {
        undoId = nextMoveId++
        moves.set(undoId, {
          from: mailbox,
          to: target,
          toUidValidity: res.uidValidity,
          pairs: [...res.uidMap],
        })
        for (const id of moves.keys()) if (moves.size > MOVES_KEPT) moves.delete(id)
      }
      await updateCounts(p, mailbox).catch(() => {})
      await updateCounts(p, target).catch(() => {})
      return { ok: true, moved, undoId }
    }),
  )
}

/** Put moved messages back where they were, if they're still where they went. */
export async function undoMove(input: unknown): Promise<MailOutcome<{ restored: number }>> {
  const id = UndoMoveSchema.safeParse(input)
  if (!id.success) return INVALID
  if (!loadAccount()) return NO_ACCOUNT
  const record = moves.get(id.data)
  if (!record) return fail('not-found', 'That can’t be undone any more.')
  return changing('undoing a move', () =>
    withImap(async (p) => {
      const status = await p.status(record.to)
      if (record.toUidValidity && status.uidValidity !== record.toUidValidity) {
        moves.delete(id.data)
        return fail(
          'not-found',
          'Those messages have been renumbered on the server, so they can’t be put back.',
        )
      }
      const present = await p.existingUids(
        record.to,
        record.pairs.map(([, dst]) => dst),
      )
      const res = await p.moveMessages(record.to, record.from, present)
      moves.delete(id.data)
      const store = mailStore()
      store.deleteMessages(record.to, present)
      // The messages have new UIDs back where they came from; fetch them into the cache.
      if (store.mailboxState(record.from)) await syncFolder(p, store, record.from).catch(() => {})
      await updateCounts(p, record.from).catch(() => {})
      await updateCounts(p, record.to).catch(() => {})
      return { ok: true, restored: res.uidMap ? res.uidMap.size : present.length }
    }),
  )
}

// Links, images and attachments

const imageFetch = (): ImageFetch =>
  createGuardedFetch({ allowLoopback: allowLoopbackHttp() }) as unknown as ImageFetch

/** Fetch remote images the user asked to see, through the guarded fetch, as data: URLs. */
export async function loadImages(
  input: unknown,
): Promise<{ images: Record<string, string>; failed: number }> {
  const parsed = LoadImagesSchema.safeParse(input)
  if (!parsed.success) return { images: {}, failed: 0 }
  return loadRemoteImages(parsed.data.urls, { fetch: imageFetch(), allowLoopbackHttp: allowLoopbackHttp() })
}

/** Open a link from a message in the browser. The window has already shown it; this checks it again. */
export async function openLink(input: unknown): Promise<MailOutcome> {
  const parsed = OpenLinkSchema.safeParse(input)
  if (!parsed.success) return INVALID
  const link = checkLink(parsed.data)
  if (link.kind !== 'web') return fail('invalid', link.kind === 'refused' ? link.reason : 'Not a web link.')
  await shell.openExternal(link.url)
  return { ok: true }
}

function attachmentOf(content: MessageContent, part: string) {
  return content.attachments.find((a) => a.part === part) ?? null
}

/** Save an attachment where the user chooses, with the save dialog. */
export async function saveAttachment(
  input: unknown,
  win?: BrowserWindow | null,
): Promise<MailOutcome<{ saved: boolean }>> {
  const parsed = AttachmentRefSchema.safeParse(input)
  if (!parsed.success) return INVALID
  if (!loadAccount()) return NO_ACCOUNT
  const ref: AttachmentRef = parsed.data
  if (!knownMailbox(ref.mailbox)) return UNKNOWN_MAILBOX
  try {
    const content = await fetchContent(ref)
    const info = content && attachmentOf(content, ref.part)
    if (!info) return fail('not-found', 'That attachment isn’t there any more.')
    const options = { defaultPath: join(app.getPath('downloads'), safeFilename(info.filename)) }
    const choice = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (choice.canceled || !choice.filePath) return { ok: true, saved: false }
    const file = await withImap((p) => p.downloadPart(ref.mailbox, ref.uid, ref.part))
    if (!file) return fail('unavailable', 'Ordo couldn’t download that attachment. It may be too big.')
    await writeFile(choice.filePath, file.content)
    return { ok: true, saved: true }
  } catch (err) {
    return failure(err)
  }
}

/** Files picked to attach, by id. The window never sees the paths. */
const picked = new Map<string, { path: string; name: string; size: number }>()
const PICKED_KEPT = 200

export async function pickAttachments(win?: BrowserWindow | null): Promise<PickedFile[]> {
  const options: OpenDialogOptions = { properties: ['openFile', 'multiSelections'], buttonLabel: 'Attach' }
  const r = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
  if (r.canceled) return []
  const out: PickedFile[] = []
  for (const chosen of r.filePaths.slice(0, COMPOSE_LIMITS.attachments)) {
    try {
      const path = await realpath(chosen)
      const s = await stat(path)
      if (!s.isFile()) continue
      const id = randomUUID()
      const file = { path, name: safeFilename(basename(path)), size: s.size }
      picked.set(id, file)
      out.push({ id, name: file.name, size: file.size })
    } catch {
      // Gone or unreadable: leave it out.
    }
  }
  for (const id of picked.keys()) if (picked.size > PICKED_KEPT) picked.delete(id)
  return out
}

// Writing

type Built = { message: OutgoingMessage; original: MessageContent | null } | MailFailure

/** Turn the compose sheet's fields into a checked message, fetching what the main process needs. */
async function compose(input: ComposeInput, from: string, needRecipients: boolean): Promise<Built> {
  const fields = {
    to: parseAddressList(input.to),
    cc: parseAddressList(input.cc),
    bcc: parseAddressList(input.bcc),
  }
  const bad = [...fields.to.invalid, ...fields.cc.invalid, ...fields.bcc.invalid]
  if (bad.length) return fail('invalid', `Check this address: ${bad[0]!.slice(0, 80)}`)
  if (hasControlChars(input.subject)) return fail('invalid', 'The subject can’t contain line breaks.')
  for (const ref of [input.replyTo, input.forward, input.draft])
    if (ref && !knownMailbox(ref.mailbox)) return UNKNOWN_MAILBOX

  let original: MessageContent | null = null
  if (input.replyTo) {
    original = await fetchContent(input.replyTo)
    if (!original) return fail('not-found', 'The message you’re replying to isn’t there any more.')
  }
  const attachments: OutgoingMessage['attachments'] = []
  if (input.forward) {
    const source = await fetchContent(input.forward)
    if (!source) return fail('not-found', 'The message’s attachments aren’t there any more.')
    for (const part of input.forward.parts) {
      const info = attachmentOf(source, part)
      if (!info) return fail('not-found', 'One of the attachments isn’t there any more.')
      const file = await withImap((p) =>
        p.downloadPart(source.mailbox, source.uid, part, COMPOSE_LIMITS.attachmentBytes),
      )
      if (!file) return fail('invalid', `${info.filename} is too big to send by email.`)
      attachments.push({ filename: info.filename, contentType: info.contentType, content: file.content })
    }
  }
  for (const id of input.attachments) {
    const file = picked.get(id)
    if (!file) return fail('invalid', 'One of the attached files isn’t available any more. Attach it again.')
    if (file.size > COMPOSE_LIMITS.attachmentBytes)
      return fail('invalid', `${file.name} is too big to send by email.`)
    attachments.push({ filename: file.name, content: await readFile(file.path) })
  }

  const message: OutgoingMessage = {
    from: { address: from },
    to: fields.to.addresses,
    cc: fields.cc.addresses,
    bcc: fields.bcc.addresses,
    subject: input.subject.trim(),
    text: input.body.replace(/\r\n?/g, '\n'),
    attachments,
    ...(original?.messageId && { inReplyTo: original.messageId, references: referencesFor(original) }),
  }
  const problem = checkOutgoing(message, { needRecipients })
  return problem ? fail('invalid', problem) : { message, original }
}

/** Remove the draft a sent or re-saved message replaces, if it really is a draft in Drafts. */
async function removeOldDraft(p: ImapMailProvider, draft: MessageRef | undefined): Promise<void> {
  const drafts = mailboxFor('drafts')
  if (!draft || draft.mailbox !== drafts) return
  if (await p.deleteDraft(drafts, draft.uid)) mailStore().deleteMessages(drafts, [draft.uid])
}

/**
 * Send a message through iCloud SMTP, then keep a copy in Sent, mark the original answered and
 * remove the draft it came from. Only the compose sheet's Send button calls this (the preload
 * refuses a call without a click), never headless mode or MCP.
 */
export async function send(input: unknown): Promise<MailOutcome<{ warning?: string }>> {
  const parsed = ComposeSchema.safeParse(input)
  if (!parsed.success) return INVALID
  const account = loadAccount()
  if (!account) return NO_ACCOUNT
  const data = parsed.data
  return changing('sending an email', async () => {
    const built = await compose(data, account.email, true)
    if ('ok' in built) return built
    let sent: { sentCopy: Buffer }
    try {
      sent = await sendMessage(smtpConfig(account.email, account.password), built.message)
    } catch (err) {
      if (err instanceof MailAuthError || /auth|535|534/i.test(String((err as Error).message)))
        return fail(
          'auth',
          'iCloud didn’t accept your app-specific password for sending. Reconnect your account and try again.',
        )
      return fail(
        'network',
        'Couldn’t send the message. Check your internet connection and try again. It hasn’t been sent.',
      )
    }
    for (const id of data.attachments) picked.delete(id)
    // Sent. Everything after this is tidying up: report problems as a warning, never as a failure.
    const warnings: string[] = []
    await withImap(async (p) => {
      const sentBox = mailboxFor('sent')
      if (!sentBox) warnings.push('There’s no Sent mailbox, so no copy was kept.')
      else
        await p.append(sentBox, sent.sentCopy, ['\\Seen']).catch(() => {
          warnings.push('Ordo couldn’t keep a copy in Sent.')
        })
      if (data.replyTo) {
        await p.setFlag(data.replyTo.mailbox, [data.replyTo.uid], '\\Answered', true).catch(() => {})
        mailStore().setFlag(data.replyTo.mailbox, [data.replyTo.uid], 'answered', true)
      }
      await removeOldDraft(p, data.draft).catch(() => {})
    }).catch(() => warnings.push('Ordo couldn’t keep a copy in Sent.'))
    return { ok: true, ...(warnings.length && { warning: `Sent. ${warnings[0]}` }) }
  })
}

/** Save the message to Drafts, replacing the version saved before. */
export async function saveDraft(input: unknown): Promise<MailOutcome<{ draft: MessageRef | null }>> {
  const parsed = ComposeSchema.safeParse(input)
  if (!parsed.success) return INVALID
  const account = loadAccount()
  if (!account) return NO_ACCOUNT
  const drafts = mailboxFor('drafts')
  if (!drafts) return fail('unavailable', 'This account has no Drafts mailbox.')
  const data = parsed.data
  return changing('saving a draft', async () => {
    const built = await compose(data, account.email, false)
    if ('ok' in built) return built
    const { raw } = await buildMessage(built.message, { keepBcc: true })
    return withImap(async (p) => {
      const saved = await p.append(drafts, raw, ['\\Draft', '\\Seen'])
      await removeOldDraft(p, data.draft).catch(() => {})
      return { ok: true, draft: saved.uid ? { mailbox: drafts, uid: saved.uid } : null }
    })
  })
}

/** Forget everything the mail client holds in memory (disconnecting, quitting). */
export function closeMailClient(): void {
  closeImapSession()
  moves.clear()
  picked.clear()
  refreshing = new Set()
}

export function registerMailIpc(): void {
  const win = (e: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender)
  ipcMain.handle(MAIL_IPC.mailboxes, () => mailboxes())
  ipcMain.handle(MAIL_IPC.refresh, (e, input: unknown) =>
    refresh(input, toRenderer(e.sender, MAIL_IPC.refreshProgress)),
  )
  ipcMain.handle(MAIL_IPC.messages, (_e, q: unknown) => messages(q))
  ipcMain.handle(MAIL_IPC.search, (_e, q: unknown) => search(q))
  ipcMain.handle(MAIL_IPC.searchServer, (_e, q: unknown) => searchServer(q))
  ipcMain.handle(MAIL_IPC.open, (_e, ref: unknown) => open(ref))
  ipcMain.handle(MAIL_IPC.setFlags, (_e, input: unknown) => setFlags(input))
  ipcMain.handle(MAIL_IPC.move, (_e, input: unknown) => move(input))
  ipcMain.handle(MAIL_IPC.undoMove, (_e, id: unknown) => undoMove(id))
  ipcMain.handle(MAIL_IPC.loadImages, (_e, input: unknown) => loadImages(input))
  ipcMain.handle(MAIL_IPC.openLink, (_e, url: unknown) => openLink(url))
  ipcMain.handle(MAIL_IPC.saveAttachment, (e, ref: unknown) => saveAttachment(ref, win(e)))
  ipcMain.handle(MAIL_IPC.pickAttachments, (e) => pickAttachments(win(e)))
  ipcMain.handle(MAIL_IPC.send, (_e, input: unknown) => send(input))
  ipcMain.handle(MAIL_IPC.saveDraft, (_e, input: unknown) => saveDraft(input))
}
