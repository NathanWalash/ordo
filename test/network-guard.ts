/**
 * Vitest setup for every test file: unit tests can never reach the real network. A test that
 * points a client at iCloud by mistake, or forgets to set a test server, fails loudly here
 * instead of connecting to the user's account.
 *
 * - `net.connect`, `net.createConnection`, `tls.connect`, `net.Socket#connect` (which `http`,
 *   `https` and `fetch` use underneath) and `dns.lookup` throw for anything but loopback
 *   (127.0.0.0/8, ::1, localhost) or a local socket path.
 * - `ORDO_IMAP_HOST`, `ORDO_SMTP_HOST` and `ORDO_CALDAV_URL` default to a closed loopback port, so
 *   code that falls back to iCloud when they're unset talks to nothing instead. Integration tests
 *   set their own ports on 127.0.0.1 and keep working.
 */
import dns from 'node:dns'
import { isIP } from 'node:net'
import net from 'node:net'
import tls from 'node:tls'

/** Port 9 (discard) on loopback: nothing listens, so connections are refused straight away. */
const CLOSED = { host: '127.0.0.1', port: '9' }

process.env['ORDO_IMAP_HOST'] ??= CLOSED.host
process.env['ORDO_IMAP_PORT'] ??= CLOSED.port
process.env['ORDO_SMTP_HOST'] ??= CLOSED.host
process.env['ORDO_SMTP_PORT'] ??= CLOSED.port
process.env['ORDO_CALDAV_URL'] ??= `http://${CLOSED.host}:${CLOSED.port}/`

export class NetworkBlockedError extends Error {
  constructor(where: string, host: string, port?: unknown) {
    super(
      `Unit tests may not use the network: ${where} to ${host}${port === undefined ? '' : `:${String(port)}`} ` +
        'was blocked (test/network-guard.ts). Use a fake, or a local test server on 127.0.0.1.',
    )
    this.name = 'NetworkBlockedError'
  }
}

/** Loopback only: localhost, 127.0.0.0/8 and ::1 (also as an IPv4-mapped address). */
export function isLoopback(host: string): boolean {
  const h = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true
  const v4 = h.startsWith('::ffff:') ? h.slice(7) : h
  return isIP(v4) === 4 && v4.startsWith('127.')
}

type LookupFn = (hostname: string, options: unknown, callback: (...r: unknown[]) => void) => void

interface ConnectOptions {
  path?: unknown
  host?: unknown
  hostname?: unknown
  port?: unknown
  socket?: unknown
  lookup?: unknown
}

type Target = { host: string; port?: unknown; options?: ConnectOptions } | null

/** Where a connect call is going, from any of its argument shapes; null for a local socket path. */
function target(args: unknown[]): Target {
  let first = args[0]
  // net.connect hands Socket#connect its arguments already normalised, as [options, callback].
  if (Array.isArray(first)) first = first[0]
  if (first && typeof first === 'object') {
    const o = first as ConnectOptions
    if (typeof o.path === 'string' && o.path) return null
    // TLS over a socket that's already connected (STARTTLS): nothing new is dialled, and that
    // socket was checked when it connected.
    if (o.socket) return null
    const host =
      typeof o.host === 'string' ? o.host : typeof o.hostname === 'string' ? o.hostname : 'localhost'
    return { host, port: o.port, options: o }
  }
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first)))
    return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first }
  if (typeof first === 'string') return null // a socket path
  return { host: 'localhost' }
}

/**
 * A name with the caller's own `lookup` (a test's fake DNS, like the guarded fetch's tests use)
 * may go ahead, but only to the loopback addresses that lookup gives.
 */
function loopbackOnly(lookup: LookupFn, where: string, port: unknown): LookupFn {
  const wrapped: LookupFn = (hostname, options, callback) =>
    lookup(hostname, options, (err: unknown, address: unknown, family: unknown) => {
      if (err) return callback(err, address, family)
      const all = Array.isArray(address)
        ? (address as { address: string }[]).map((a) => a.address)
        : [address]
      const bad = all.find((a) => typeof a !== 'string' || !isLoopback(a))
      if (bad !== undefined)
        return callback(
          new NetworkBlockedError(where, `${hostname} (${String(bad)})`, port),
          Array.isArray(address) ? [] : '',
        )
      callback(null, address, family)
    })
  Object.defineProperty(wrapped, 'blocked', { value: true })
  return wrapped
}

function check(where: string, args: unknown[]): void {
  const t = target(args)
  if (!t || isLoopback(t.host)) return
  const lookup = t.options?.lookup
  if (typeof lookup === 'function' && isIP(t.host.replace(/^\[|\]$/g, '')) === 0) {
    if (!(lookup as { blocked?: boolean }).blocked)
      t.options!.lookup = loopbackOnly(lookup as LookupFn, where, t.port)
    return
  }
  throw new NetworkBlockedError(where, t.host, t.port)
}

function guard<T extends object, K extends keyof T>(owner: T, key: K, where: string): void {
  const original = owner[key] as unknown as (...a: unknown[]) => unknown
  if ((original as { blocked?: boolean }).blocked) return
  const wrapped = function (this: unknown, ...a: unknown[]) {
    check(where, a)
    return original.apply(this, a)
  }
  Object.defineProperty(wrapped, 'blocked', { value: true })
  owner[key] = wrapped as unknown as T[K]
}

guard(net, 'connect', 'net.connect')
guard(net, 'createConnection', 'net.createConnection')
guard(tls, 'connect', 'tls.connect')
guard(net.Socket.prototype, 'connect', 'a socket connection')

function guardLookup<T extends object, K extends keyof T>(
  owner: T,
  key: K,
  where: string,
  promise = false,
): void {
  const original = owner[key] as unknown as (...a: unknown[]) => unknown
  if ((original as { blocked?: boolean }).blocked) return
  const wrapped = function (this: unknown, hostname: unknown, ...rest: unknown[]) {
    if (typeof hostname === 'string' && !isLoopback(hostname)) {
      const error = new NetworkBlockedError(where, hostname)
      if (promise) return Promise.reject(error)
      throw error
    }
    return original.call(this, hostname, ...rest)
  }
  Object.defineProperty(wrapped, 'blocked', { value: true })
  owner[key] = wrapped as unknown as T[K]
}

guardLookup(dns, 'lookup', 'dns.lookup')
guardLookup(dns.promises, 'lookup', 'dns.promises.lookup', true)
