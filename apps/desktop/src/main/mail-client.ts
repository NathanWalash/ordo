import { randomUUID } from 'node:crypto'
import { readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron'
import {
  archiveMailbox,
  bodyText,
  PROVIDERS,
  checkLink,
  COMPOSE_LIMITS,
  hasControlChars,
  recipientList,
  referencesFor,
  safeFilename,
  type AttachmentInfo,
  type MailboxInfo,
  type MessageContent,
  type MessageHeader,
} from '@ordo/mail-core'
import type { ImapMailProvider } from '@ordo/mail-core/node'
import {
  buildMessage,
  checkOutgoing,
  createGuardedFetch,
  loadRemoteImages,
  MailAuthError,
  RecipientsRefused,
  reconcileFolder,
  scanMailbox,
  sendMessage,
  syncFolder,
  type ImageFetch,
  type OutgoingMessage,
} from '@ordo/mail-core/node'
import {
  AttachmentRefSchema,
  ComposeSchema,
  fromAccount,
  LoadImagesSchema,
  MAIL_IPC,
  MailboxesInputSchema,
  MailboxRefSchema,
  MessageListQuerySchema,
  MessageRefSchema,
  MailMoveSchema,
  OpenLinkSchema,
  SearchQuerySchema,
  ServerSearchSchema,
  SetFlagsSchema,
  UndoMoveSchema,
  type AttachmentRef,
  type ComposeInput,
  type LastMove,
  type MailError,
  type MailFailure,
  type MailOutcome,
  type MailRefreshProgress,
  type MessageRef,
  type MailAccount,
  type MessageSummary,
  type MoveTarget,
  type PickedFile,
  type RefreshOutcome,
} from '@ordo/shared'
import { listAccounts } from './account'
import {
  accountIds,
  accountStore,
  allowLoopbackHttp,
  explain,
  connectImap,
  INBOX,
  mailStore,
  onAccountRemoved,
  resolveAccount,
  scan,
  withSmtp,
  syncSchedule,
  trackMailWork,
} from './mail'
import { SignInAgainError } from './auth'
import { closeImapSession, NotConnected, withImap } from './mail-session'
import { markAsDownloaded } from './quarantine'
import { Locked, toRenderer, withWriteLock } from './writes'

/**
 * The mail client: folders, the message list, reading, search, flags, moves with undo,
 * attachments, links, remote images, and writing mail, for every account. Every input from the
 * window is checked with zod here; text from emails is data and never more.
 *
 * Inputs name an account by id; left out, it's the first account (what callers from before
 * several accounts mean). Every message the window sees carries its account, and every change goes
 * to that account's own server, on its own connection.
 */

const fail = (error: MailError, message: string): MailFailure => ({ ok: false, error, message })
const NO_ACCOUNT = fail('auth', 'Connect your iCloud account first.')
const INVALID = fail('invalid', 'That request isn’t valid.')
const STOPPED = fail('busy', 'Stopped.')
const NO_SUCH_ACCOUNT = fail('not-found', 'There’s no such account. Check Settings → Accounts.')
const UNKNOWN_MAILBOX = fail('not-found', 'That mailbox isn’t there any more. Refresh and try again.')

/** A failure the window can show, from anything a mail call threw. */
function failure(err: unknown, account?: MailAccount | null): MailFailure {
  if (err instanceof NotConnected) return NO_ACCOUNT
  if (err instanceof Locked) return fail('locked', err.message)
  const e = explain(err, undefined, account)
  return fail(e.error === 'auth' || e.error === 'network' ? e.error : 'unknown', e.message)
}

/** The account an input names (the first when it names none), or why there isn't one. */
function accountFor(id: string | undefined): MailAccount | MailFailure {
  const a = resolveAccount(id)
  if (a) return a
  return id ? NO_SUCH_ACCOUNT : NO_ACCOUNT
}
const isFailure = (a: MailAccount | MailFailure): a is MailFailure => 'ok' in a

/** Run a change under the shared write lock; a lock held elsewhere becomes a `locked` failure. */
async function changing<T extends object>(
  task: string,
  fn: () => Promise<MailOutcome<T>>,
  account?: MailAccount,
): Promise<MailOutcome<T>> {
  try {
    const r = await withWriteLock(task, fn)
    return r instanceof Locked ? fail('locked', r.message) : r
  } catch (err) {
    return failure(err, account)
  }
}

/** Only folders the account's server listed (or INBOX) can be named by the window. */
function knownMailbox(account: string, path: string): MailboxInfo | null {
  const boxes = accountStore(account).mailboxes()
  return (
    boxes.find((m) => m.path === path) ??
    (path === INBOX
      ? { path: INBOX, name: 'Inbox', role: 'inbox', delimiter: '/', total: 0, unread: 0 }
      : null)
  )
}

/**
 * An account's folder for a role, from its cached list. Archive is the Archive folder, or Gmail's
 * All Mail (moving there takes a message out of the Inbox and keeps its labels). Bin is the
 * `\\Trash` folder whatever it's called: iCloud's Deleted Messages, Gmail's [Gmail]/Bin.
 */
function mailboxFor(account: string, role: MoveTarget | 'sent' | 'drafts'): string | null {
  if (role === 'inbox') return INBOX
  const boxes = accountStore(account).mailboxes()
  if (role === 'archive') return archiveMailbox(boxes)?.path ?? null
  return boxes.find((m) => m.role === role)?.path ?? null
}

const SPECIAL_USE = { sent: '\\Sent', drafts: '\\Drafts' } as const

/**
 * Sent or Drafts: from the cached folder list, or, before the first list has arrived (a big
 * first inbox scan), asked of the server.
 */
async function specialMailbox(
  account: string,
  p: ImapMailProvider,
  role: 'sent' | 'drafts',
): Promise<string | null> {
  return mailboxFor(account, role) ?? (await p.findMailbox(SPECIAL_USE[role]).catch(() => null))
}

const summary = (h: MessageHeader, account?: string): MessageSummary => ({
  account: h.account ?? account ?? '',
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

/** One account's folders from the cache (the first account's when none is named). */
export function mailboxes(input?: unknown): MailboxInfo[] {
  const parsed = MailboxesInputSchema.safeParse(input ?? {})
  if (!parsed.success) return []
  const a = resolveAccount(parsed.data.account)
  return a ? accountStore(a.id).mailboxes() : []
}

let refreshing = new Set<string>()

type Counts = { added: number; removed: number; changed: number }

/** Refresh the folder list and one folder's messages from the server into the cache. */
export async function refresh(
  input: unknown,
  onProgress?: (p: MailRefreshProgress) => void,
  options: { manual?: boolean } = {},
): Promise<RefreshOutcome> {
  const parsed = MailboxRefSchema.safeParse(input)
  if (!parsed.success) return INVALID
  const { mailbox } = parsed.data
  if (parsed.data.account === 'all') {
    if (mailbox !== INBOX) return INVALID
    return refreshAll(onProgress, options.manual ?? true)
  }
  const account = accountFor(parsed.data.account)
  if (isFailure(account)) return account
  return refreshOne(account, mailbox, onProgress)
}

/**
 * Every account's inbox at once, each on its own connection. An account that's backing off after
 * failing is skipped unless the check is `manual` (the user asked). The outcome is ok when any
 * account was checked; the others are listed in `failed`, each with its own message.
 */
async function refreshAll(
  onProgress: ((p: MailRefreshProgress) => void) | undefined,
  manual: boolean,
): Promise<RefreshOutcome> {
  const accounts = listAccounts()
  if (!accounts.length) return NO_ACCOUNT
  const due = new Set(
    syncSchedule.due(
      accounts.map((a) => a.id),
      Date.now(),
      manual,
    ),
  )
  const results = await Promise.all(
    accounts.map(async (a) => {
      if (!due.has(a.id)) {
        const last = syncSchedule.get(a.id).last
        return { account: a, outcome: fail('busy', last?.message ?? 'Waiting before trying again.') }
      }
      return { account: a, outcome: await refreshOne(a, INBOX, onProgress) }
    }),
  )
  const total: Counts = { added: 0, removed: 0, changed: 0 }
  const failed: { account: string; error: MailError; message: string }[] = []
  for (const { account, outcome } of results) {
    if (outcome.ok) {
      total.added += outcome.added
      total.removed += outcome.removed
      total.changed += outcome.changed
    } else failed.push({ account: account.id, error: outcome.error, message: outcome.message })
  }
  if (failed.length === accounts.length && accounts.length === 1) {
    const only = failed[0]!
    return fail(only.error, only.message)
  }
  return { ok: true, ...total, ...(failed.length && { failed }) }
}

async function refreshOne(
  account: MailAccount,
  mailbox: string,
  onProgress?: (p: MailRefreshProgress) => void,
): Promise<RefreshOutcome> {
  const key = `${account.id}\u0000${mailbox}`
  if (refreshing.has(key)) return fail('busy', 'Already checking for new mail.')
  refreshing.add(key)
  const store = accountStore(account.id)
  const progress = (checked: number, total: number) =>
    onProgress?.({ account: account.id, mailbox, checked, total })
  try {
    if (mailbox === INBOX) {
      // The folder list first, so Drafts, Sent and the rest work while a big first scan runs.
      if (!store.mailboxes().length)
        await trackMailWork(
          account.id,
          withImap(account.id, (p) => p.listMailboxes()),
        )
          .then((list) => resolveAccount(account.id) && store.saveMailboxes(list))
          .catch(() => {})
      // The inbox goes through the same scan as Unclutter, so its cache stays complete.
      let removed = 0
      let changed = 0
      const r = await scan(
        (p) => progress(p.checked, p.total),
        async (provider) => {
          store.saveMailboxes(await provider.listMailboxes())
          ;({ removed, changed } = await reconcileFolder(provider, store, INBOX))
        },
        account.id,
      )
      if (!r.ok) {
        const known = ['locked', 'busy', 'auth', 'network'] as const
        return fail(known.find((k) => k === r.error) ?? 'unknown', r.message)
      }
      return { ok: true, added: r.added, removed, changed }
    }
    const ctrl = new AbortController()
    return await trackMailWork(
      account.id,
      changing(
        'checking for new mail',
        async () => {
          const provider = await connectImap(account)
          try {
            const list = await provider.listMailboxes()
            if (ctrl.signal.aborted) return STOPPED
            store.saveMailboxes(list)
            if (!list.some((m) => m.path === mailbox)) return UNKNOWN_MAILBOX
            // Other folders fetch a few hundred headers at most, so progress is just "done".
            const res = await syncFolder(provider, store, mailbox, { signal: ctrl.signal })
            progress(res.total, res.total)
            return { ok: true, added: res.added, removed: res.removed, changed: res.changed }
          } finally {
            await provider.close().catch(() => {})
          }
        },
        account,
      ),
      () => ctrl.abort(),
    )
  } catch (err) {
    return failure(err, account)
  } finally {
    refreshing.delete(key)
  }
}

// Reading

/** One page of a folder in one account, or of every account's inbox (`account: 'all'`). */
export function messages(input: unknown): { total: number; messages: MessageSummary[] } {
  const parsed = MessageListQuerySchema.safeParse(input)
  if (!parsed.success) return { total: 0, messages: [] }
  const { mailbox, account, ...q } = parsed.data
  const one = account === 'all' ? null : resolveAccount(account)
  const ids = account === 'all' ? accountIds() : one ? [one.id] : []
  if (!ids.length) return { total: 0, messages: [] }
  const page = mailStore().messagesAcross(ids, mailbox, q)
  return { total: page.total, messages: page.messages.map((h) => summary(h)) }
}

/** One message's headers from the cache, or null. No network: for previews of changes. */
export function cached(input: unknown): MessageSummary | null {
  const parsed = MessageRefSchema.safeParse(input)
  if (!parsed.success) return null
  const a = resolveAccount(parsed.data.account)
  if (!a) return null
  const h = accountStore(a.id).message(parsed.data.mailbox, parsed.data.uid)
  return h ? summary(h, a.id) : null
}

/** Search the cache: one account, or every account when none is named. */
export function search(input: unknown): MessageSummary[] {
  const parsed = SearchQuerySchema.safeParse(input)
  if (!parsed.success) return []
  const { query, account, ...q } = parsed.data
  const ids = accountIds(account)
  if (!ids.length) return []
  return mailStore()
    .searchAcross(ids, query, q)
    .map((h) => summary(h))
}

/** IMAP SEARCH in one folder, for mail older than the cache. Results are cached so they can be opened. */
export async function searchServer(input: unknown): Promise<MailOutcome<{ messages: MessageSummary[] }>> {
  const parsed = ServerSearchSchema.safeParse(input)
  if (!parsed.success) return INVALID
  const account = accountFor(parsed.data.account)
  if (isFailure(account)) return account
  const { mailbox, query, limit } = parsed.data
  if (!knownMailbox(account.id, mailbox)) return UNKNOWN_MAILBOX
  const words = query.split(/\s+/).filter(Boolean).slice(0, 8)
  try {
    const found = await withImap(account.id, (p) => p.search(mailbox, words, limit))
    const store = accountStore(account.id)
    // Only cache headers we don't have: never overwrite fresher flags.
    store.saveHeaders(found.filter((h) => !store.message(mailbox, h.uid)))
    return {
      ok: true,
      messages: found.sort((a, b) => b.date.getTime() - a.date.getTime()).map((h) => summary(h, account.id)),
    }
  } catch (err) {
    return failure(err, account)
  }
}

/** Bodies bigger than this aren't kept in the cache (they're fetched again when opened). */
const BODY_CACHE_MAX = 4 * 1024 * 1024
const SEARCH_TEXT_MAX = 200_000

async function fetchContent(
  account: string,
  ref: { mailbox: string; uid: number },
): Promise<MessageContent | null> {
  const store = accountStore(account)
  const cached = store.body(ref.mailbox, ref.uid)
  if (cached) return cached
  const content = await withImap(account, (p) => p.fetchMessage(ref.mailbox, ref.uid))
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
  const account = accountFor(parsed.data.account)
  if (isFailure(account)) return account
  if (!knownMailbox(account.id, parsed.data.mailbox)) return UNKNOWN_MAILBOX
  try {
    const message = await fetchContent(account.id, parsed.data)
    return message ? { ok: true, message } : fail('not-found', 'This message isn’t there any more.')
  } catch (err) {
    return failure(err, account)
  }
}

// Changing mail

async function updateCounts(account: string, provider: ImapMailProvider, mailbox: string): Promise<void> {
  const s = await provider.status(mailbox)
  accountStore(account).setMailboxCounts(mailbox, { total: s.messages, unread: s.unseen })
}

export async function setFlags(input: unknown): Promise<MailOutcome> {
  const parsed = SetFlagsSchema.safeParse(input)
  if (!parsed.success) return INVALID
  const account = accountFor(parsed.data.account)
  if (isFailure(account)) return account
  const { mailbox, uids, seen, flagged } = parsed.data
  if (!knownMailbox(account.id, mailbox)) return UNKNOWN_MAILBOX
  return changing(
    'changing mail',
    () =>
      withImap(account.id, async (p) => {
        const store = accountStore(account.id)
        if (seen !== undefined) {
          await p.setFlag(mailbox, uids, '\\Seen', seen)
          store.setFlag(mailbox, uids, 'seen', seen)
        }
        if (flagged !== undefined) {
          await p.setFlag(mailbox, uids, '\\Flagged', flagged)
          store.setFlag(mailbox, uids, 'flagged', flagged)
        }
        await updateCounts(account.id, p, mailbox).catch(() => {})
        return { ok: true }
      }),
    account,
  )
}

interface MoveRecord {
  account: string
  from: string
  to: string
  toUidValidity: string | null
  /** [UID in `from`, UID in `to`] */
  pairs: [number, number][]
  /** The messages as they were in the cache before the move, to say what an undo puts back. */
  messages: MessageSummary[]
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

/** A move's destination in an account as a folder path and a name to show, or why it can't be one. */
export function moveDestination(
  to: MoveTarget | { folder: string },
  account?: string,
): { ok: true; path: string; name: string } | MailFailure {
  const a = resolveAccount(account)
  if (!a) return NO_ACCOUNT
  if (typeof to === 'string') {
    const path = mailboxFor(a.id, to)
    return path
      ? { ok: true, path, name: TARGET_NAMES[to] }
      : fail('unavailable', `This account has no ${TARGET_NAMES[to]} mailbox.`)
  }
  // Only a folder the server listed, and never Drafts: a draft is made by saving one.
  const box = knownMailbox(a.id, to.folder)
  if (!box) return fail('not-found', 'There’s no folder by that name. Check for new mail to update the list.')
  if (box.role === 'drafts') return fail('invalid', 'Messages can’t be moved into Drafts.')
  return {
    ok: true,
    path: box.path,
    name: box.role ? (TARGET_NAMES[box.role as MoveTarget] ?? box.name) : box.name,
  }
}

/**
 * Move messages to Archive, Bin, Inbox, Junk or one of the account's folders. Nothing is ever
 * deleted: on Gmail too, Bin is a MOVE to the `\\Trash` folder and Archive a MOVE to All Mail.
 */
export async function move(input: unknown): Promise<MailOutcome<{ moved: number; undoId: number | null }>> {
  const parsed = MailMoveSchema.safeParse(input)
  if (!parsed.success) return INVALID
  const account = accountFor(parsed.data.account)
  if (isFailure(account)) return account
  const { mailbox, uids, to } = parsed.data
  if (!knownMailbox(account.id, mailbox)) return UNKNOWN_MAILBOX
  const dest = moveDestination(to, account.id)
  if (!dest.ok) return dest
  const target = dest.path
  if (target === mailbox) return fail('invalid', `These messages are already in ${dest.name}.`)
  return changing(
    'moving mail',
    () =>
      withImap(account.id, async (p) => {
        const store = accountStore(account.id)
        const before = uids.flatMap((uid) => {
          const h = store.message(mailbox, uid)
          return h ? [summary(h, account.id)] : []
        })
        const res = await p.moveMessages(mailbox, target, uids)
        store.deleteMessages(mailbox, uids)
        const moved = res.uidMap ? res.uidMap.size : uids.length
        let undoId: number | null = null
        if (res.uidMap?.size) {
          undoId = nextMoveId++
          moves.set(undoId, {
            account: account.id,
            from: mailbox,
            to: target,
            toUidValidity: res.uidValidity,
            pairs: [...res.uidMap],
            messages: before.slice(0, 20),
          })
          for (const id of moves.keys()) if (moves.size > MOVES_KEPT) moves.delete(id)
        }
        await updateCounts(account.id, p, mailbox).catch(() => {})
        await updateCounts(account.id, p, target).catch(() => {})
        return { ok: true, moved, undoId }
      }),
    account,
  )
}

/** The newest move that can still be undone (by the window or the assistant), or null. */
export function lastMove(): LastMove | null {
  const id = [...moves.keys()].at(-1)
  const record = id === undefined ? undefined : moves.get(id)
  if (id === undefined || !record) return null
  return {
    undoId: id,
    account: record.account,
    from: record.from,
    to: record.to,
    count: record.pairs.length,
    messages: record.messages,
  }
}

/** Put moved messages back where they were, if they're still where they went. */
export async function undoMove(input: unknown): Promise<MailOutcome<{ restored: number }>> {
  const id = UndoMoveSchema.safeParse(input)
  if (!id.success) return INVALID
  if (!listAccounts().length) return NO_ACCOUNT
  const record = moves.get(id.data)
  if (!record) return fail('not-found', 'That can’t be undone any more.')
  const account = resolveAccount(record.account)
  if (!account) {
    moves.delete(id.data)
    return fail('not-found', 'That can’t be undone any more.')
  }
  return changing(
    'undoing a move',
    () =>
      withImap(account.id, async (p) => {
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
        const store = accountStore(account.id)
        store.deleteMessages(record.to, present)
        // The messages have new UIDs back where they came from; fetch them into the cache. The
        // inbox goes through the full scan so Unclutter's cache stays complete.
        if (record.from === INBOX) await scanMailbox(p, store, { mailbox: INBOX }).catch(() => {})
        else if (store.mailboxState(record.from)) await syncFolder(p, store, record.from).catch(() => {})
        await updateCounts(account.id, p, record.from).catch(() => {})
        await updateCounts(account.id, p, record.to).catch(() => {})
        return { ok: true, restored: res.uidMap ? res.uidMap.size : present.length }
      }),
    account,
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
  const account = accountFor(parsed.data.account)
  if (isFailure(account)) return account
  const ref: AttachmentRef = parsed.data
  if (!knownMailbox(account.id, ref.mailbox)) return UNKNOWN_MAILBOX
  try {
    const content = await fetchContent(account.id, ref)
    const info = content && attachmentOf(content, ref.part)
    if (!info) return fail('not-found', 'That attachment isn’t there any more.')
    const options = { defaultPath: join(app.getPath('downloads'), safeFilename(info.filename)) }
    const choice = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (choice.canceled || !choice.filePath) return { ok: true, saved: false }
    const file = await withImap(account.id, (p) => p.downloadPart(ref.mailbox, ref.uid, ref.part))
    if (!file) return fail('unavailable', 'Ordo couldn’t download that attachment. It may be too big.')
    await writeFile(choice.filePath, file.content)
    // Like a browser download: the system warns before opening a file that came by email.
    await markAsDownloaded(choice.filePath)
    return { ok: true, saved: true }
  } catch (err) {
    return failure(err, account)
  }
}

/** A path in `folder` for `name` that doesn't overwrite anything: `notes.txt`, `notes 2.txt`… */
async function freePath(folder: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, '']
  for (let n = 1; n < 1000; n++) {
    const candidate = join(folder, n === 1 ? name : `${stem} ${n}${ext}`)
    try {
      await stat(candidate)
    } catch {
      return candidate
    }
  }
  return join(folder, `${stem} ${randomUUID()}${ext}`)
}

/** Save every attachment of a message into a folder the user chooses. Nothing is overwritten. */
export async function saveAllAttachments(
  input: unknown,
  win?: BrowserWindow | null,
): Promise<MailOutcome<{ saved: number }>> {
  const parsed = MessageRefSchema.safeParse(input)
  if (!parsed.success) return INVALID
  const account = accountFor(parsed.data.account)
  if (isFailure(account)) return account
  const ref = parsed.data
  if (!knownMailbox(account.id, ref.mailbox)) return UNKNOWN_MAILBOX
  try {
    const content = await fetchContent(account.id, ref)
    const files = content?.attachments.filter((a) => !a.inline) ?? []
    if (!files.length) return fail('not-found', 'This message has no attachments any more.')
    const options: OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Save here',
      defaultPath: app.getPath('downloads'),
    }
    const choice = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const folder = choice.filePaths[0]
    if (choice.canceled || !folder) return { ok: true, saved: 0 }
    let saved = 0
    for (const a of files) {
      const file = await withImap(account.id, (p) => p.downloadPart(ref.mailbox, ref.uid, a.part))
      if (!file) continue
      const path = await freePath(folder, safeFilename(a.filename))
      await writeFile(path, file.content, { flag: 'wx' })
      await markAsDownloaded(path)
      saved++
    }
    return { ok: true, saved }
  } catch (err) {
    return failure(err, account)
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

/** The account a message ref is in: its own, or the first account's when it names none. */
const refAccount = (ref: { account?: string } | undefined, fallback: string) => ref?.account ?? fallback

/**
 * The account a message is written from. A reply goes from the account the original arrived in,
 * and a draft is finished where it was saved: asking for another is refused, never silently
 * changed. A new message goes from the account picked, else the first.
 */
function writingAccount(input: ComposeInput): MailAccount | MailFailure {
  const accounts = listAccounts()
  const first = accounts[0]
  if (!first) return NO_ACCOUNT
  // An account asked for by name must be there: never quietly another one.
  if (input.account && !accounts.some((a) => a.id === input.account)) return NO_SUCH_ACCOUNT
  const original = input.replyTo
    ? refAccount(input.replyTo, first.id)
    : input.draft
      ? refAccount(input.draft, first.id)
      : undefined
  if (original && input.account && input.account !== original)
    return fail(
      'invalid',
      input.replyTo
        ? 'A reply is sent from the account the message arrived in.'
        : 'A draft is sent from the account it was saved in.',
    )
  const id = fromAccount(accounts, { original, picked: input.account })
  const account = id ? resolveAccount(id) : null
  return account ?? NO_SUCH_ACCOUNT
}

/** Turn the compose sheet's fields into a checked message, fetching what the main process needs. */
async function compose(input: ComposeInput, account: MailAccount, needRecipients: boolean): Promise<Built> {
  const fields = {
    to: recipientList(input.to),
    cc: recipientList(input.cc),
    bcc: recipientList(input.bcc),
  }
  const bad = [...fields.to.invalid, ...fields.cc.invalid, ...fields.bcc.invalid]
  if (bad.length) return fail('invalid', `Check this address: ${bad[0]!.slice(0, 80)}`)
  if (hasControlChars(input.subject)) return fail('invalid', 'The subject can’t contain line breaks.')
  for (const ref of [input.replyTo, input.forward, input.draft]) {
    if (!ref) continue
    const where = refAccount(ref, listAccounts()[0]?.id ?? account.id)
    if (!resolveAccount(where)) return NO_SUCH_ACCOUNT
    if (!knownMailbox(where, ref.mailbox)) return UNKNOWN_MAILBOX
  }

  let original: MessageContent | null = null
  let thread: { inReplyTo: string; references: string[] } | null = null
  if (input.replyTo) {
    original = await fetchContent(account.id, input.replyTo)
    if (!original) return fail('not-found', 'The message you’re replying to isn’t there any more.')
    if (original.messageId) thread = { inReplyTo: original.messageId, references: referencesFor(original) }
  } else if (input.draft) {
    // A reply saved as a draft keeps its place in the thread when it's finished and sent.
    const draft = await fetchContent(account.id, input.draft)
    if (draft?.inReplyTo && /^<[^<>\s]+>$/.test(draft.inReplyTo) && !hasControlChars(draft.inReplyTo))
      thread = {
        inReplyTo: draft.inReplyTo,
        references: referencesFor({ references: draft.references, messageId: null }),
      }
  }
  const attachments: OutgoingMessage['attachments'] = []
  if (input.forward) {
    // A forward may go from another account: the original's files come from its own.
    const source = refAccount(input.forward, listAccounts()[0]?.id ?? account.id)
    const content = await fetchContent(source, input.forward)
    if (!content) return fail('not-found', 'The message’s attachments aren’t there any more.')
    for (const part of input.forward.parts) {
      const info = attachmentOf(content, part)
      if (!info) return fail('not-found', 'One of the attachments isn’t there any more.')
      const file = await withImap(source, (p) =>
        p.downloadPart(content.mailbox, content.uid, part, COMPOSE_LIMITS.attachmentBytes),
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
    from: { address: account.email },
    to: fields.to.addresses,
    cc: fields.cc.addresses,
    bcc: fields.bcc.addresses,
    subject: input.subject.trim(),
    text: input.body.replace(/\r\n?/g, '\n'),
    attachments,
    ...(thread && { inReplyTo: thread.inReplyTo, references: thread.references }),
  }
  const problem = checkOutgoing(message, { needRecipients })
  return problem ? fail('invalid', problem) : { message, original }
}

/** Remove the draft a sent or re-saved message replaces, if it really is a draft in this account's Drafts. */
async function removeOldDraft(
  account: MailAccount,
  p: ImapMailProvider,
  draft: MessageRef | undefined,
): Promise<void> {
  const drafts = await specialMailbox(account.id, p, 'drafts')
  if (!draft || !drafts || draft.mailbox !== drafts) return
  if (refAccount(draft, account.id) !== account.id) return
  if (await p.deleteDraft(drafts, draft.uid)) accountStore(account.id).deleteMessages(drafts, [draft.uid])
}

const listed = (addresses: string[]) =>
  addresses.length > 3
    ? `${addresses.slice(0, 3).join(', ')} and ${addresses.length - 3} more`
    : addresses.join(', ')

/** What the user calls an account's mail service in a message: "iCloud", "Gmail", the server. */
const serviceName = (a: MailAccount) => (a.provider === 'other' ? a.smtp.host : PROVIDERS[a.provider].name)

/**
 * Send a message through the From account's SMTP server, then keep a copy in its Sent, mark the
 * original answered and remove the draft it came from. Only the compose sheet's Send button calls
 * this (the preload refuses a call without a click), and the assistant after the user pressed Send
 * on its card; never headless mode or MCP.
 */
export async function send(input: unknown): Promise<MailOutcome<{ warning?: string }>> {
  const parsed = ComposeSchema.safeParse(input)
  if (!parsed.success) return INVALID
  const data = parsed.data
  const account = writingAccount(data)
  if (isFailure(account)) return account
  const name = serviceName(account)
  return changing(
    'sending an email',
    async () => {
      const built = await compose(data, account, true)
      if ('ok' in built) return built
      let sent: { sentCopy: Buffer; rejected: string[] }
      try {
        sent = await withSmtp(account, (cfg) => sendMessage(cfg, built.message))
      } catch (err) {
        if (err instanceof RecipientsRefused)
          return fail(
            'invalid',
            err.recipients.length
              ? `${name} refused ${listed(err.recipients)}. Check the addresses. Nothing was sent.`
              : `${name} refused the recipients. Check the addresses. Nothing was sent.`,
          )
        const e = err as { code?: string; message?: string }
        if (err instanceof SignInAgainError) return fail('auth', `${err.message} Nothing was sent.`)
        if (err instanceof MailAuthError || e.code === 'EAUTH' || /\b(535|534)\b/.test(String(e.message)))
          return fail(
            'auth',
            account.auth.kind === 'oauth'
              ? 'Gmail didn’t accept Ordo’s Google sign-in for sending. Choose Sign in again in Settings → Accounts and try again. Nothing was sent.'
              : account.provider === 'icloud'
                ? 'iCloud didn’t accept your app-specific password for sending. Reconnect your account and try again.'
                : `${name} didn’t accept your password for sending. Enter it again in Settings → Accounts and try again.`,
          )
        return fail(
          'network',
          'Couldn’t send the message. Check your internet connection and try again. It hasn’t been sent.',
        )
      }
      for (const id of data.attachments) picked.delete(id)
      // Sent. Everything after this is tidying up: report problems as a warning, never as a failure.
      const warnings: string[] = []
      if (sent.rejected.length)
        warnings.push(`${name} refused ${listed(sent.rejected)}, so they won’t get it.`)
      await withImap(account.id, async (p) => {
        const sentBox = await specialMailbox(account.id, p, 'sent')
        if (!sentBox) warnings.push('There’s no Sent mailbox, so no copy was kept.')
        else
          await p.append(sentBox, sent.sentCopy, ['\\Seen']).catch(() => {
            warnings.push('Ordo couldn’t keep a copy in Sent.')
          })
        if (data.replyTo) {
          await p.setFlag(data.replyTo.mailbox, [data.replyTo.uid], '\\Answered', true).catch(() => {})
          accountStore(account.id).setFlag(data.replyTo.mailbox, [data.replyTo.uid], 'answered', true)
        }
        await removeOldDraft(account, p, data.draft).catch(() => {})
      }).catch(() => warnings.push('Ordo couldn’t keep a copy in Sent.'))
      return { ok: true, ...(warnings.length && { warning: `Sent. ${warnings.join(' ')}` }) }
    },
    account,
  )
}

/** Save the message to the From account's Drafts, replacing the version saved before. */
export async function saveDraft(
  input: unknown,
): Promise<MailOutcome<{ draft: MessageRef | null; attachments: AttachmentInfo[] }>> {
  const parsed = ComposeSchema.safeParse(input)
  if (!parsed.success) return INVALID
  const data = parsed.data
  const account = writingAccount(data)
  if (isFailure(account)) return account
  return changing(
    'saving a draft',
    async () => {
      const drafts = await withImap(account.id, (p) => specialMailbox(account.id, p, 'drafts'))
      if (!drafts) return fail('unavailable', 'This account has no Drafts mailbox.')
      const built = await compose(data, account, false)
      if ('ok' in built) return built
      const { raw } = await buildMessage(built.message, { keepBcc: true })
      const saved = await withImap(account.id, async (p) => {
        const s = await p.append(drafts, raw, ['\\Draft', '\\Seen'])
        // Its attachments now live in the new draft: only then can the old one go.
        if (s.uid) await removeOldDraft(account, p, data.draft).catch(() => {})
        return s
      })
      // Without a UID the window keeps its own copies of the files and the old draft stays.
      if (!saved.uid) return { ok: true, draft: null, attachments: [] }
      for (const id of data.attachments) picked.delete(id)
      const draft = { account: account.id, mailbox: drafts, uid: saved.uid }
      // The window carries the attachments on from the new draft, so a second save or a send finds them.
      const content = await withImap(account.id, (p) => p.fetchMessage(drafts, saved.uid!)).catch(() => null)
      return { ok: true, draft, attachments: content?.attachments.filter((a) => !a.inline) ?? [] }
    },
    account,
  )
}

/** Forget everything the mail client holds in memory (disconnecting, quitting). */
export function closeMailClient(): void {
  closeImapSession()
  moves.clear()
  picked.clear()
  refreshing = new Set()
}

// A removed account's undo records go with it.
onAccountRemoved((account) => {
  for (const [id, m] of moves) if (m.account === account) moves.delete(id)
})

export function registerMailIpc(): void {
  const win = (e: Electron.IpcMainInvokeEvent) => BrowserWindow.fromWebContents(e.sender)
  ipcMain.handle(MAIL_IPC.mailboxes, (_e, input: unknown) => mailboxes(input))
  ipcMain.handle(MAIL_IPC.refresh, (e, input: unknown, auto?: unknown) =>
    // The window's timer passes `auto`: accounts backing off after a failure are skipped then.
    refresh(input, toRenderer(e.sender, MAIL_IPC.refreshProgress), { manual: auto !== true }),
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
  ipcMain.handle(MAIL_IPC.saveAllAttachments, (e, ref: unknown) => saveAllAttachments(ref, win(e)))
  ipcMain.handle(MAIL_IPC.pickAttachments, (e) => pickAttachments(win(e)))
  ipcMain.handle(MAIL_IPC.send, (_e, input: unknown) => send(input))
  ipcMain.handle(MAIL_IPC.saveDraft, (_e, input: unknown) => saveDraft(input))
}
