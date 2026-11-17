// Guards for URLs that come from untrusted email headers (List-Unsubscribe).
// Pure code: the renderer bundle imports mail-core, so no Node modules here.
// The connect-time DNS check that uses these lives in net-guard.ts.

export interface GuardOptions {
  /** Test-only (unpackaged builds): allow 127.0.0.0/8, ::1 and `localhost`. */
  allowLoopback?: boolean
}

/** A strict dotted-quad IPv4 address as a 32-bit number, or null. */
export function parseIPv4(s: string): number | null {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null
    n = n * 256 + Number(p)
  }
  return n
}

/** An IPv6 address (optionally bracketed, with a zone or an embedded IPv4 tail) as a 128-bit number, or null. */
export function parseIPv6(input: string): bigint | null {
  let s = input
    .replace(/^\[|\]$/g, '')
    .replace(/%.*$/, '')
    .toLowerCase()
  if (!s.includes(':')) return null
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)
  if (v4) {
    const n = parseIPv4(v4[1]!)
    if (n === null) return null
    s = s.slice(0, -v4[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  let n = 0n
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    n = (n << 16n) | BigInt(parseInt(g, 16))
  }
  return n
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and 255.255.255.255 broadcast
]

const inV4 = (n: number, [base, bits]: [string, number]) =>
  bits === 0 || n >>> (32 - bits) === parseIPv4(base)! >>> (32 - bits)

const V6_BLOCKED: [bigint, number][] = [
  [0n, 128], // unspecified ::
  [1n, 128], // loopback ::1
  [0x0100n << 112n, 64], // discard-only 100::/64
  [0x2001_0db8n << 96n, 32], // documentation
  [0xfc00n << 112n, 7], // unique local
  [0xfe80n << 112n, 10], // link-local
  [0xfec0n << 112n, 10], // old site-local
  [0xff00n << 112n, 8], // multicast
]

const inV6 = (n: bigint, [base, bits]: [bigint, number]) =>
  n >> BigInt(128 - bits) === base >> BigInt(128 - bits)

/** IPv4 addresses carried inside IPv6: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d), NAT64 and 6to4. */
function embeddedV4(n: bigint): number | null {
  const low32 = Number(n & 0xffff_ffffn)
  if (n >> 32n === 0xffffn) return low32 // ::ffff:0:0/96
  if (n >> 32n === 0n) return low32 // ::/96 (deprecated compatible form)
  if (n >> 32n === 0x0064_ff9b_0000_0000_0000_0000n) return low32 // 64:ff9b::/96
  if (n >> 112n === 0x2002n) return Number((n >> 80n) & 0xffff_ffffn) // 2002::/16 (6to4)
  return null
}

/**
 * True when connecting to this address could reach the user's own machine or
 * network: loopback, private, link-local, unique-local, CGNAT, multicast,
 * reserved, or any of those wrapped in IPv6. Anything unparseable is blocked.
 */
export function isBlockedIp(ip: string, opts: GuardOptions = {}): boolean {
  const v4 = parseIPv4(ip)
  if (v4 !== null) {
    if (opts.allowLoopback && inV4(v4, ['127.0.0.0', 8])) return false
    return V4_BLOCKED.some((r) => inV4(v4, r))
  }
  const v6 = parseIPv6(ip)
  if (v6 === null) return true
  if (opts.allowLoopback && v6 === 1n) return false
  const inner = embeddedV4(v6)
  if (inner !== null && !(v6 >> 32n === 0n && inner <= 1)) {
    const dotted = [24, 16, 8, 0].map((s) => (inner >>> s) & 255).join('.')
    return isBlockedIp(dotted, opts)
  }
  return V6_BLOCKED.some((r) => inV6(v6, r))
}

/**
 * Why Ordo won't send a request to this URL's host, or null if it may (subject
 * to the DNS check at connect time). Refuses IP literals in any notation (the
 * URL parser normalises decimal, octal and hex forms to dotted quads) and
 * single-label names like `router` or `intranet`.
 */
export function hostRefusal(url: string, opts: GuardOptions = {}): string | null {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return 'Not a valid address'
  }
  if (opts.allowLoopback && (host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host)))
    return null
  if (host.startsWith('[') || parseIPv4(host) !== null)
    return 'Refused an address given as an IP number rather than a domain name'
  if (!host.includes('.') || host.endsWith('.localhost'))
    return 'Refused a local network name rather than a public domain'
  return null
}
