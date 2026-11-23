// The only way Ordo's Google code reaches the network: a fetch that goes to the configured Google
// endpoints and nowhere else (no redirects followed), over https, and refuses private and local
// addresses at connect time. A packaged Ordo's endpoints are fixed to Google's own hosts.
import { createGuardedFetch } from '@ordo/mail-core/node'
import { GOOGLE_ENDPOINTS, type FetchFn, type GoogleEndpoints } from './oauth'

/** accounts.google.com is only ever opened in the browser; Ordo fetches from these two. */
export const GOOGLE_HOSTS = ['oauth2.googleapis.com', 'www.googleapis.com'] as const

export class GoogleHostError extends Error {
  override name = 'GoogleHostError'
}

const isLoopback = (host: string) => host === '127.0.0.1' || host === 'localhost' || host === '[::1]'

/**
 * Check a set of endpoints is safe to use. Packaged builds may only use Google's; a development or
 * test build may instead use a fake on loopback, and nothing else.
 */
export function checkEndpoints(endpoints: GoogleEndpoints, { packaged }: { packaged: boolean }): void {
  const same = (Object.keys(GOOGLE_ENDPOINTS) as (keyof GoogleEndpoints)[]).every(
    (k) => endpoints[k] === GOOGLE_ENDPOINTS[k],
  )
  if (same) return
  if (packaged) throw new GoogleHostError('Ordo only talks to Google’s own servers.')
  for (const url of Object.values(endpoints)) {
    const u = new URL(url)
    if (!isLoopback(u.hostname))
      throw new GoogleHostError(`A test Google must be on loopback, not ${u.hostname}.`)
  }
}

/** The origins `endpoints` allow Ordo to fetch from (token, revoke, API). */
export function allowedOrigins(endpoints: GoogleEndpoints): Set<string> {
  return new Set([endpoints.token, endpoints.revoke, endpoints.api].map((u) => new URL(u).origin))
}

/**
 * A fetch limited to `endpoints`' origins. Redirects are refused, so a response can't send a
 * token anywhere else. `base` does the fetching (by default a guarded fetch that also refuses
 * private addresses; tests pass the global one for their loopback fake).
 */
export function googleFetch(endpoints: GoogleEndpoints, base?: FetchFn): FetchFn {
  const allowed = allowedOrigins(endpoints)
  const loopback = [...allowed].every((o) => isLoopback(new URL(o).hostname))
  const inner: FetchFn = base ?? (createGuardedFetch({ allowLoopback: loopback }) as unknown as FetchFn)
  return async (url, init) => {
    const u = new URL(url)
    if (!allowed.has(u.origin)) throw new GoogleHostError(`Ordo doesn’t send Google requests to ${u.host}.`)
    if (u.protocol !== 'https:' && !(loopback && u.protocol === 'http:'))
      throw new GoogleHostError('Google requests must use https.')
    return inner(u.href, { ...init, redirect: 'error' })
  }
}

/** Whether `url` is the consent page of `endpoints`, and so may be opened in the browser. */
export function isConsentUrl(url: string, endpoints: GoogleEndpoints): boolean {
  try {
    const u = new URL(url)
    const auth = new URL(endpoints.auth)
    return (
      u.origin === auth.origin &&
      u.pathname === auth.pathname &&
      (u.protocol === 'https:' || isLoopback(u.hostname)) &&
      !u.username &&
      !u.password
    )
  } catch {
    return false
  }
}
