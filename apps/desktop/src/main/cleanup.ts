import { app, ipcMain, shell } from 'electron'
import {
  analyseSenders,
  buildCleanupPlan,
  executeUnsubscribe,
  type CleanupPlan,
  type CleanupRecord,
} from '@ordo/mail-core'
import {
  createGuardedFetch,
  createMailtoSender,
  ICLOUD_SMTP,
  ImapMailProvider,
  runCleanup,
  scanMailbox,
  undoCleanup,
  type SmtpConfig,
} from '@ordo/mail-core/node'
import {
  CLEANUP_IPC,
  CleanupIdSchema,
  CleanupRequestSchema,
  type CleanupOutcome,
  type CleanupProgress,
  type CleanupRequest,
  type CleanupSummary,
  type UndoOutcome,
} from '@ordo/shared'
import { loadAccount } from './account'
import { allowLoopbackHttp, exclusively, explain, imapConfig, INBOX, mailStore } from './mail'
import { Locked, toRenderer, withWriteLock } from './writes'

/** iCloud SMTP by default. Tests can point an unpackaged build at a local server, like ORDO_IMAP_*. */
function smtpConfig(user: string, pass: string): SmtpConfig {
  const host = !app.isPackaged ? process.env['ORDO_SMTP_HOST'] : undefined
  if (host)
    return {
      host,
      port: Number(process.env['ORDO_SMTP_PORT'] ?? 3025),
      secure: process.env['ORDO_SMTP_SECURE'] === '1',
      requireTLS: process.env['ORDO_SMTP_REQUIRE_TLS'] === '1',
      user,
      pass,
    }
  return { ...ICLOUD_SMTP, user, pass }
}

/** What the renderer may see: no UID map. */
function summary({ uidMap: _uidMap, trashUidValidity: _v, ...rest }: CleanupRecord): CleanupSummary {
  return rest
}

const BUSY = { ok: false, error: 'busy', message: 'Wait for the scan or clean-up to finish.' } as const

/** The result, or why it didn't run: busy in this process (null) or in another one (Locked). */
function settled<T>(result: T | Locked | null) {
  if (result === null) return BUSY
  if (result instanceof Locked) return { ok: false, error: 'locked', message: result.message } as const
  return result
}

const INVALID = { ok: false, error: 'invalid', message: 'That clean-up request isn’t valid.' } as const
const NO_ACCOUNT = { ok: false, error: 'auth', message: 'Connect your iCloud account first.' } as const

/**
 * Re-check every choice against our own analysis of the cached inbox: people can never be
 * cleared, whatever the window (or a headless caller) sent.
 */
function planFor(request: CleanupRequest): CleanupPlan {
  const store = mailStore()
  const repliedTo = store.repliedTo()
  const senders = analyseSenders(store.headers(INBOX), repliedTo, { allowLoopbackHttp: allowLoopbackHttp() })
  return buildCleanupPlan(senders, repliedTo, request.senders)
}

export type CleanupPlanOutcome =
  { ok: true; plan: CleanupPlan } | { ok: false; error: 'invalid' | 'auth'; message: string }

/** What `run` would do with this request, without doing it: the same checks, no network. */
export function plan(input: unknown): CleanupPlanOutcome {
  const parsed = CleanupRequestSchema.safeParse(input)
  if (!parsed.success) return INVALID
  if (!loadAccount()) return NO_ACCOUNT
  return { ok: true, plan: planFor(parsed.data) }
}

/** Unsubscribe from and/or move the chosen senders' emails to Trash. */
export async function run(
  input: unknown,
  onProgress?: (p: CleanupProgress) => void,
): Promise<CleanupOutcome> {
  const parsed = CleanupRequestSchema.safeParse(input)
  if (!parsed.success) return INVALID
  const account = loadAccount()
  if (!account) return NO_ACCOUNT

  const result = await exclusively(() =>
    withWriteLock('clearing senders', async (): Promise<CleanupOutcome> => {
      const store = mailStore()
      const loopback = allowLoopbackHttp()
      const plan = planFor(parsed.data)
      if (!plan.senders.length)
        return {
          ok: false,
          error: 'invalid',
          message: plan.rejected[0]?.reason ?? 'Choose at least one sender to clear.',
        }

      const provider = new ImapMailProvider(imapConfig(account.email, account.password))
      // Opened on the first mailto unsubscribe only.
      const smtp: { sender?: ReturnType<typeof createMailtoSender> } = {}
      const fetch = createGuardedFetch({ allowLoopback: loopback })
      try {
        await provider.connect()
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
                sendMail: (msg) =>
                  (smtp.sender ??= createMailtoSender(
                    smtpConfig(account.email, account.password),
                    account.email,
                  )).send(msg),
              },
              { insecureLinkConfirmed: s.insecureLinkConfirmed, mailto: s.mailto ?? undefined },
            ),
        })
        return { ok: true, cleanup: summary(record), rejected: plan.rejected }
      } catch (err) {
        return { ok: false, ...explain(err) }
      } finally {
        smtp.sender?.close()
        await provider.close().catch(() => {})
      }
    }),
  )
  return settled(result)
}

/** Past clean-ups, newest first, without the UID maps. */
export function history(): CleanupSummary[] {
  return mailStore().cleanups().map(summary)
}

/** Move a clean-up's emails from Trash back to the inbox. */
export async function undo(input: unknown): Promise<UndoOutcome> {
  const id = CleanupIdSchema.safeParse(input)
  if (!id.success) return { ok: false, error: 'invalid', message: 'Unknown clean-up.' }
  const account = loadAccount()
  if (!account) return NO_ACCOUNT
  const store = mailStore()
  if (!store.cleanup(id.data)) return { ok: false, error: 'invalid', message: 'Unknown clean-up.' }

  const result = await exclusively(() =>
    withWriteLock('undoing a clean-up', async (): Promise<UndoOutcome> => {
      const provider = new ImapMailProvider(imapConfig(account.email, account.password))
      try {
        await provider.connect()
        const res = await undoCleanup(provider, store, id.data)
        // Restored emails have new UIDs in the inbox; a quick incremental scan caches them again.
        if (res.restored) await scanMailbox(provider, store, { mailbox: INBOX }).catch(() => {})
        return { ok: true, ...res }
      } catch (err) {
        return { ok: false, ...explain(err) }
      } finally {
        await provider.close().catch(() => {})
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
