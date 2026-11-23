import { ImapMailProvider, MailConnectionError } from '@ordo/mail-core/node'
import type { MailAccount } from '@ordo/shared'
import { getAccount } from './account'
import { imapConfigFor, onAccountRemoved } from './mail'

/**
 * One IMAP connection per account that the mail client keeps open while you read, so opening a
 * message or flagging one doesn't sign in each time. Each closes after a minute with nothing to
 * do, when its connection drops (the next call reconnects) and when its account is removed. A
 * problem with one account's connection never touches another's. Syncs use their own
 * short-lived connections, like the inbox scan.
 */

const IDLE_MS = 60_000

interface Session {
  account: string
  /** The sign-in it was opened with, so a changed address or server opens a new one. */
  key: string
  provider: ImapMailProvider
  ready: Promise<void>
  connected: boolean
  users: number
  idle: ReturnType<typeof setTimeout> | null
}

const sessions = new Map<string, Session>()

export class NotConnected extends Error {
  override name = 'NotConnected'
}

const keyOf = (a: MailAccount) => JSON.stringify([a.email, a.imap.host, a.imap.port, a.imap.secure])

function drop(s: Session): void {
  if (sessions.get(s.account) === s) sessions.delete(s.account)
  if (s.idle) clearTimeout(s.idle)
  void s.provider.close().catch(() => {})
}

async function open(accountId: string): Promise<Session> {
  const account = getAccount(accountId)
  if (!account) throw new NotConnected('Connect your iCloud account first.')
  const s = sessions.get(account.id)
  if (s && s.key === keyOf(account) && (!s.connected || s.provider.usable)) {
    // Still connecting (another call started it), or connected and fine.
    await s.ready
    return s
  }
  if (s) drop(s)
  const provider = new ImapMailProvider(await imapConfigFor(account))
  const fresh: Session = {
    account: account.id,
    key: keyOf(account),
    provider,
    ready: Promise.resolve(),
    connected: false,
    users: 0,
    idle: null,
  }
  fresh.ready = provider.connect().then(
    () => {
      fresh.connected = true
    },
    (err: unknown) => {
      drop(fresh)
      throw err
    },
  )
  sessions.set(account.id, fresh)
  await fresh.ready
  return fresh
}

/** Run `fn` with an account's shared connection. A dropped connection is replaced on the next call. */
export async function withImap<T>(
  account: string,
  fn: (provider: ImapMailProvider) => Promise<T>,
): Promise<T> {
  const s = await open(account)
  s.users++
  if (s.idle) clearTimeout(s.idle)
  s.idle = null
  try {
    return await fn(s.provider)
  } catch (err) {
    if (!s.provider.usable || err instanceof MailConnectionError) drop(s)
    throw err
  } finally {
    s.users--
    if (s.users === 0 && sessions.get(s.account) === s) s.idle = setTimeout(() => drop(s), IDLE_MS)
  }
}

/** Close one account's shared connection, or every one (quitting). */
export function closeImapSession(account?: string): void {
  for (const s of [...sessions.values()]) if (!account || s.account === account) drop(s)
}

onAccountRemoved((account) => closeImapSession(account))
