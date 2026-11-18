import { ImapMailProvider, MailConnectionError } from '@ordo/mail-core/node'
import { loadAccount } from './account'
import { imapConfig } from './mail'

/**
 * One IMAP connection the mail client keeps open while you read, so opening a message or
 * flagging one doesn't sign in each time. It closes after a minute with nothing to do, when the
 * connection drops (the next call reconnects) and when the account is disconnected. Syncs use
 * their own short-lived connection, like the inbox scan.
 */

const IDLE_MS = 60_000

interface Session {
  email: string
  provider: ImapMailProvider
  ready: Promise<void>
  connected: boolean
  users: number
  idle: ReturnType<typeof setTimeout> | null
}

let session: Session | null = null

export class NotConnected extends Error {
  override name = 'NotConnected'
}

function drop(s: Session): void {
  if (session === s) session = null
  if (s.idle) clearTimeout(s.idle)
  void s.provider.close().catch(() => {})
}

async function open(): Promise<Session> {
  const account = loadAccount()
  if (!account) throw new NotConnected('Connect your iCloud account first.')
  const s = session
  if (s && s.email === account.email && (!s.connected || s.provider.usable)) {
    // Still connecting (another call started it), or connected and fine.
    await s.ready
    return s
  }
  if (s) drop(s)
  const provider = new ImapMailProvider(imapConfig(account.email, account.password))
  const fresh: Session = {
    email: account.email,
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
  session = fresh
  await fresh.ready
  return fresh
}

/** Run `fn` with the shared connection. A dropped connection is replaced on the next call. */
export async function withImap<T>(fn: (provider: ImapMailProvider) => Promise<T>): Promise<T> {
  const s = await open()
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
    if (s.users === 0 && session === s) s.idle = setTimeout(() => drop(s), IDLE_MS)
  }
}

/** Close the shared connection (disconnecting, quitting). */
export function closeImapSession(): void {
  if (session) drop(session)
}
