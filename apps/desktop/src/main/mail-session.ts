import { type ImapMailProvider, MailConnectionError } from '@ordo/mail-core/node'
import type { MailAccount } from '@ordo/shared'
import { connectImap, onAccountRemoved, resolveAccount } from './mail'

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
  /** Set once signed in (connecting may refresh a Google token and try again). */
  provider: ImapMailProvider | null
  ready: Promise<void>
  /** Closed or replaced while still connecting: close the connection as soon as it's made. */
  dropped: boolean
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
  s.dropped = true
  void s.provider?.close().catch(() => {})
}

async function open(accountId: string): Promise<Session> {
  const account = resolveAccount(accountId)
  if (!account) throw new NotConnected('Connect your iCloud account first.')
  const s = sessions.get(account.id)
  if (s && s.key === keyOf(account) && (!s.provider || s.provider.usable)) {
    // Still connecting (another call started it), or connected and fine.
    await s.ready
    return s
  }
  if (s) drop(s)
  const fresh: Session = {
    account: account.id,
    key: keyOf(account),
    provider: null,
    ready: Promise.resolve(),
    dropped: false,
    users: 0,
    idle: null,
  }
  fresh.ready = connectImap(account).then(
    (provider) => {
      fresh.provider = provider
      // Removed or replaced while it was connecting: don't keep it open.
      if (fresh.dropped) {
        void provider.close().catch(() => {})
        throw new MailConnectionError('The connection was closed', 'dropped')
      }
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
  const provider = s.provider!
  try {
    return await fn(provider)
  } catch (err) {
    if (!provider.usable || err instanceof MailConnectionError) drop(s)
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
