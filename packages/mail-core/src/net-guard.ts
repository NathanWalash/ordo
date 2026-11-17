// A fetch for untrusted URLs (one-click unsubscribe) that can only reach the public internet.
import { promises as dns, type LookupAddress } from 'node:dns'
import { Agent, fetch as undiciFetch } from 'undici'
import { isBlockedIp, type GuardOptions } from './url-guard'
import { BLOCKED_ADDRESS, type FetchLike } from './unsubscribe-run'

export type Resolver = (hostname: string) => Promise<LookupAddress[]>

const systemResolver: Resolver = (hostname) => dns.lookup(hostname, { all: true, verbatim: true })

export class BlockedAddressError extends Error {
  override name = 'BlockedAddressError'
  readonly code = BLOCKED_ADDRESS
}

type LookupCallback = (err: Error | null, address: string | LookupAddress[], family?: number) => void
type LookupOptions = { family?: number | string; all?: boolean }

/**
 * A `lookup` for net/tls.connect that resolves the name and refuses the
 * connection if any address is private or local. The socket connects to the
 * address checked here, so a second DNS answer (DNS rebinding) can't slip past.
 */
export function createGuardedLookup(opts: GuardOptions & { resolve?: Resolver } = {}) {
  const resolve = opts.resolve ?? systemResolver
  return (hostname: string, options: LookupOptions | LookupCallback, cb?: LookupCallback): void => {
    const callback = (typeof options === 'function' ? options : cb)!
    const o: LookupOptions = typeof options === 'function' ? {} : options
    resolve(hostname)
      .then((all) => {
        const blocked = all.find((a) => isBlockedIp(a.address, opts))
        if (blocked)
          throw new BlockedAddressError(
            `${hostname} points to ${blocked.address}, a private or local address`,
          )
        const family = o.family === 'IPv4' ? 4 : o.family === 'IPv6' ? 6 : Number(o.family) || 0
        const usable = family ? all.filter((a) => a.family === family) : all
        if (!usable.length)
          throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' })
        if (o.all) callback(null, usable)
        else callback(null, usable[0]!.address, usable[0]!.family)
      })
      .catch((err: Error) => callback(err, o.all ? [] : ''))
  }
}

/**
 * fetch that refuses private and local destinations at connect time, for the
 * first request and every redirect hop. Pair it with hostRefusal(), which
 * executeUnsubscribe applies to each URL first (IP literals never hit DNS).
 */
export function createGuardedFetch(opts: GuardOptions & { resolve?: Resolver } = {}): FetchLike {
  const dispatcher = new Agent({ connect: { lookup: createGuardedLookup(opts) } })
  return async (url, init) => {
    const res = await undiciFetch(url, { ...init, dispatcher })
    return res
  }
}
