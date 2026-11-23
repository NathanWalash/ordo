import { ipcMain, shell } from 'electron'
import {
  analyseSenders,
  buildCleanupPlan,
  executeUnsubscribe,
  type CleanupPlan,
  type CleanupRecord,
} from '@ordo/mail-core'
import type { ImapMailProvider } from '@ordo/mail-core/node'
import {
  createGuardedFetch,
  createMailtoSender,
  runCleanup,
  scanMailbox,
  undoCleanup,
} from '@ordo/mail-core/node'
import {
  CLEANUP_IPC,
  CleanupIdSchema,
  CleanupRequestSchema,
  type CleanupError,
  type CleanupOutcome,
  type CleanupProgress,
  type CleanupRequest,
  type CleanupSummary,
  type MailAccount,
  type UndoOutcome,
} from '@ordo/shared'
import { getAccount, listAccounts } from './account'
import {
  accountIds,
  accountStore,
  allowLoopbackHttp,
  exclusively,
  explain,
  connectImap,
  INBOX,
  mailStore,
  smtpConfigFor,
} from './mail'
import { Locked, toRenderer, withWriteLock } from './writes'

/** What the renderer may see: no UID map. */
function summary({ uidMap: _uidMap, trashUidValidity: _v, ...rest }: CleanupRecord): CleanupSummary {
  return rest
}

const BUSY = { ok: false, error: 'busy', message: 'Wait for the scan or clean-up to finish.' } as const

/** The result, or why it didn't run: busy in this process (null) or in another one (Locked). */
function settled<T extends { ok: boolean }>(
  result: T | Locked | null,
): T | { ok: false; error: 'busy' | 'locked'; message: string } {
  if (result === null) return BUSY
  if (result instanceof Locked) return { ok: false, error: 'locked', message: result.message }
  return result
}

const INVALID = { ok: false, error: 'invalid', message: 'That clean-up request isn’t valid.' } as const
const NO_ACCOUNT = { ok: false, error: 'auth', message: 'Connect your iCloud account first.' } as const

/**
 * Re-check every choice against our own analysis of the cached inbox of these accounts: people
 * (anyone you've written to from any account) can never be cleared, whatever the window (or a
 * headless caller) sent.
 */
function planFor(request: CleanupRequest, accounts: readonly string[]): CleanupPlan {
  const store = mailStore()
  const repliedTo = store.repliedTo()
  const senders = analyseSenders(store.headersAcross(accounts, INBOX), repliedTo, {
    allowLoopbackHttp: allowLoopbackHttp(),
  })
  return buildCleanupPlan(senders, repliedTo, request.senders)
}

export type CleanupPlanOutcome =
  { ok: true; plan: CleanupPlan } | { ok: false; error: 'invalid' | 'auth'; message: string }

/** The accounts a request covers: the one it names, or every account (`all`, the default). */
function accountsOf(request: CleanupRequest): string[] | null {
  if (!listAccounts().length) return null
  return accountIds(request.account ?? 'all')
}

/** What `run` would do with this request, without doing it: the same checks, no network. */
export function plan(input: unknown): CleanupPlanOutcome {
  const parsed = CleanupRequestSchema.safeParse(input)
  if (!parsed.success) return INVALID
  const accounts = accountsOf(parsed.data)
  if (!accounts) return NO_ACCOUNT
  if (!accounts.length) return INVALID
  return { ok: true, plan: planFor(parsed.data, accounts) }
}

type AccountRun = { ok: true; cleanup: CleanupSummary } | { ok: false; error: CleanupError; message: string }

/**
 * Clean up one account: unsubscribe and/or move the planned senders' emails to its Trash (on
 * Gmail, its `\Trash` folder: a move, never a delete), on its own connection.
 */
async function runAccount(
  account: MailAccount,
  request: CleanupRequest,
  allowed: ReadonlySet<string>,
  onProgress?: (p: CleanupProgress) => void,
): Promise<AccountRun | null> {
  // Each account is planned against its own mail: its own unsubscribe links and messages.
  const plan = planFor(
    { ...request, senders: request.senders.filter((s) => allowed.has(s.address.trim().toLowerCase())) },
    [account.id],
  )
  if (!plan.senders.length) return null
  const result = await exclusively(account.id, () =>
    withWriteLock('clearing senders', async (): Promise<AccountRun> => {
      const store = accountStore(account.id)
      const loopback = allowLoopbackHttp()
      let provider: ImapMailProvider | null = null
      // Opened on the first mailto unsubscribe only.
      const smtp: { sender?: ReturnType<typeof createMailtoSender> } = {}
      const fetch = createGuardedFetch({ allowLoopback: loopback })
      try {
        provider = await connectImap(account)
        // The token the IMAP sign-in just used (refreshed if Gmail refused the first) is still fresh.
        const smtpConfig = await smtpConfigFor(account)
        const record = await runCleanup(provider, store, plan.senders, {
          mailbox: INBOX,
          onProgress,
          unsubscribe: (method, s) =>
            executeUnsubscribe(
              method,
              {
                fetch,
                allowLoopbackHttp: loopback,
                openExternal: (url) => shell.openExternal(url),
                sendMail: (msg) => (smtp.sender ??= createMailtoSender(smtpConfig, account.email)).send(msg),
              },
              { insecureLinkConfirmed: s.insecureLinkConfirmed, mailto: s.mailto ?? undefined },
            ),
        })
        return { ok: true, cleanup: summary(record) }
      } catch (err) {
        return { ok: false, ...explain(err, undefined, account) }
      } finally {
        smtp.sender?.close()
        await provider?.close().catch(() => {})
      }
    }),
  )
  return settled(result)
}

/**
 * Unsubscribe from and/or move the chosen senders' emails to Trash, in one account or every
 * account that has mail from them. Each account is cleared on its own and gets its own History
 * entry; one failing doesn't stop the others.
 */
export async function run(
  input: unknown,
  onProgress?: (p: CleanupProgress) => void,
): Promise<CleanupOutcome> {
  const parsed = CleanupRequestSchema.safeParse(input)
  if (!parsed.success) return INVALID
  const ids = accountsOf(parsed.data)
  if (!ids) return NO_ACCOUNT
  if (!ids.length) return INVALID
  const overall = planFor(parsed.data, ids)
  if (!overall.senders.length)
    return {
      ok: false,
      error: 'invalid',
      message: overall.rejected[0]?.reason ?? 'Choose at least one sender to clear.',
    }
  const allowed = new Set(overall.senders.map((s) => s.address))
  const cleanups: CleanupSummary[] = []
  const failed: { account: string; error: CleanupError; message: string }[] = []
  for (const id of ids) {
    const account = getAccount(id)
    if (!account) continue
    const r = await runAccount(account, parsed.data, allowed, onProgress)
    if (!r) continue
    if (r.ok) cleanups.push(r.cleanup)
    else failed.push({ account: id, error: r.error, message: r.message })
  }
  const first = cleanups[0]
  if (!first) {
    const why = failed[0]
    return why
      ? { ok: false, error: why.error, message: why.message }
      : { ok: false, error: 'invalid', message: 'Choose at least one sender to clear.' }
  }
  return {
    ok: true,
    cleanup: first,
    ...(ids.length > 1 && { cleanups }),
    ...(failed.length && { failed }),
    rejected: overall.rejected,
  }
}

/** Past clean-ups of every account, newest first, without the UID maps. */
export function history(): CleanupSummary[] {
  return mailStore().cleanups().map(summary)
}

/** Move a clean-up's emails from its account's Trash back to the inbox. */
export async function undo(input: unknown): Promise<UndoOutcome> {
  const id = CleanupIdSchema.safeParse(input)
  if (!id.success) return { ok: false, error: 'invalid', message: 'Unknown clean-up.' }
  if (!listAccounts().length) return NO_ACCOUNT
  const record = mailStore().cleanup(id.data)
  if (!record) return { ok: false, error: 'invalid', message: 'Unknown clean-up.' }
  const account = getAccount(record.account)
  if (!account)
    return { ok: false, error: 'invalid', message: 'The account this clean-up was in has been removed.' }
  const store = accountStore(account.id)

  const result = await exclusively(account.id, () =>
    withWriteLock('undoing a clean-up', async (): Promise<UndoOutcome> => {
      let provider: ImapMailProvider | null = null
      try {
        provider = await connectImap(account)
        const res = await undoCleanup(provider, store, id.data)
        // Restored emails have new UIDs in the inbox; a quick incremental scan caches them again.
        if (res.restored) await scanMailbox(provider, store, { mailbox: INBOX }).catch(() => {})
        return { ok: true, ...res }
      } catch (err) {
        return { ok: false, ...explain(err, undefined, account) }
      } finally {
        await provider?.close().catch(() => {})
      }
    }),
  )
  return settled(result)
}

export function registerCleanupIpc(): void {
  ipcMain.handle(CLEANUP_IPC.run, (e, request: unknown) =>
    run(request, toRenderer(e.sender, CLEANUP_IPC.progress)),
  )
  ipcMain.handle(CLEANUP_IPC.history, () => history())
  ipcMain.handle(CLEANUP_IPC.undo, (_e, id: unknown) => undo(id))
}
