import type { UnsubscribeMethod } from './types'
import { isSecureUrl, type MailtoMessage } from './unsubscribe'
import { hostRefusal } from './url-guard'

export type UnsubscribeStatus = 'done' | 'opened' | 'failed' | 'skipped'

/** What happened when Ordo tried to unsubscribe from one sender. */
export interface UnsubscribeOutcome {
  status: UnsubscribeStatus
  method: UnsubscribeMethod['kind']
  /** Why it failed, or what the user still has to do. */
  detail?: string
}

/** The slice of the Fetch API the one-click request needs, so tests can pass a fake. */
export type FetchLike = (
  url: string,
  init: {
    method: string
    headers: Record<string, string>
    body?: string
    redirect: 'manual'
    credentials: 'omit'
    signal: AbortSignal
  },
) => Promise<{ status: number; ok: boolean; headers: { get(name: string): string | null }; body?: unknown }>

export interface UnsubscribeDeps {
  /**
   * Must refuse to connect to private and local addresses at connect time (see
   * createGuardedFetch in '@ordo/mail-core/node'); this module only checks the URL.
   */
  fetch: FetchLike
  /** Open a URL in the user's browser. */
  openExternal(url: string): Promise<void>
  /** Send an email (the mailto: method). */
  sendMail(message: MailtoMessage): Promise<void>
  /** Test-only: treat http://127.0.0.1 like https. */
  allowLoopbackHttp?: boolean
  timeoutMs?: number
  maxRedirects?: number
}

export interface UnsubscribeRequestOptions {
  /** The user has seen this plain http link in the review sheet and chose to open it. */
  insecureLinkConfirmed?: boolean
  /**
   * For mailto: the exact message the review sheet showed, from planMailto (and,
   * for another domain, ticked by the user). Without it nothing is sent.
   */
  mailto?: MailtoMessage
}

export const ONE_CLICK_BODY = 'List-Unsubscribe=One-Click'
const USER_AGENT = 'Ordo'

/**
 * Carry out one unsubscribe. Never throws: failures come back as an outcome with
 * a reason the user can read.
 */
export async function executeUnsubscribe(
  method: UnsubscribeMethod,
  deps: UnsubscribeDeps,
  opts: UnsubscribeRequestOptions = {},
): Promise<UnsubscribeOutcome> {
  try {
    switch (method.kind) {
      case 'one-click':
        return await oneClick(method.url, deps)
      case 'link':
        return await openLink(method.url, deps, opts)
      case 'mailto':
        return await mailto(opts.mailto, deps)
      default:
        return { status: 'skipped', method: 'none', detail: 'No unsubscribe option' }
    }
  } catch (err) {
    return { status: 'failed', method: method.kind, detail: message(err) }
  }
}

/** RFC 8058: POST `List-Unsubscribe=One-Click` to the URL, no cookies, https all the way. */
async function oneClick(start: string, deps: UnsubscribeDeps): Promise<UnsubscribeOutcome> {
  const fail = (detail: string): UnsubscribeOutcome => ({ status: 'failed', method: 'one-click', detail })
  const timeoutMs = deps.timeoutMs ?? 10_000
  const signal = AbortSignal.timeout(timeoutMs)
  const maxRedirects = deps.maxRedirects ?? 3
  let url = start
  let post = true
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!isSecureUrl(url, deps))
      return fail(hop ? 'Refused a redirect to an address that isn’t https' : 'Not an https address')
    const refusal = hostRefusal(url, { allowLoopback: deps.allowLoopbackHttp })
    if (refusal) return fail(hop ? `Refused a redirect. ${refusal}` : refusal)
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await deps.fetch(url, {
        method: post ? 'POST' : 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          ...(post && { 'Content-Type': 'application/x-www-form-urlencoded' }),
        },
        ...(post && { body: ONE_CLICK_BODY }),
        redirect: 'manual',
        credentials: 'omit',
        signal,
      })
    } catch (err) {
      if (signal.aborted) return fail(`No answer within ${Math.round(timeoutMs / 1000)} seconds`)
      const blocked = rootCause(err, (e) => e.code === BLOCKED_ADDRESS)
      if (blocked) return fail(`Refused: ${blocked.message}`)
      return fail(`Couldn’t reach the server: ${message(rootCause(err) ?? err)}`)
    }
    discard(res.body)
    const location = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && location) {
      try {
        url = new URL(location, url).href
      } catch {
        return fail('The server redirected to an invalid address')
      }
      // Like browsers: 307/308 repeat the POST, other redirects become a GET.
      post = post && (res.status === 307 || res.status === 308)
      continue
    }
    if (res.status >= 200 && res.status < 300) return { status: 'done', method: 'one-click' }
    return fail(`The server answered ${res.status}`)
  }
  return fail('Too many redirects')
}

async function openLink(
  url: string,
  deps: UnsubscribeDeps,
  opts: UnsubscribeRequestOptions,
): Promise<UnsubscribeOutcome> {
  const secure = /^https:\/\//i.test(url)
  if (!secure && !(/^http:\/\//i.test(url) && opts.insecureLinkConfirmed))
    return { status: 'failed', method: 'link', detail: 'Plain http link not confirmed, so it wasn’t opened' }
  await deps.openExternal(url)
  return { status: 'opened', method: 'link', detail: 'Opened in your browser. Finish there.' }
}

async function mailto(msg: MailtoMessage | undefined, deps: UnsubscribeDeps): Promise<UnsubscribeOutcome> {
  if (!msg)
    return {
      status: 'failed',
      method: 'mailto',
      detail: 'The unsubscribe email wasn’t reviewed, so it wasn’t sent',
    }
  await deps.sendMail(msg)
  return { status: 'done', method: 'mailto', detail: `Sent “${msg.subject}” to ${msg.to}` }
}

/** Error code the guarded fetch uses when a name resolves to a private or local address. */
export const BLOCKED_ADDRESS = 'ORDO_BLOCKED_ADDRESS'

type CodedError = Error & { code?: string; cause?: unknown }

/** Walk an error's `cause` chain (fetch wraps socket errors) for the first match, or the deepest error. */
function rootCause(err: unknown, match?: (e: CodedError) => boolean): CodedError | null {
  let found: CodedError | null = null
  for (
    let e = err as CodedError | undefined, i = 0;
    e instanceof Error && i < 10;
    e = e.cause as CodedError, i++
  ) {
    if (match?.(e)) return e
    found = e
  }
  return match ? null : found
}

function discard(body: unknown) {
  const b = body as { cancel?: () => Promise<void> } | null | undefined
  b?.cancel?.().catch(() => {})
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
