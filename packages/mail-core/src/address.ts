import type { Address } from './types'
import { EMAIL_ADDRESS, hasControlChars } from './unsubscribe'

/** Longest address (RFC 5321) and display name Ordo accepts. */
export const ADDRESS_MAX = 254
export const NAME_MAX = 100

export function isEmailAddress(s: string): boolean {
  return s.length <= ADDRESS_MAX && !hasControlChars(s) && EMAIL_ADDRESS.test(s)
}

export interface ParsedAddressList {
  addresses: Address[]
  /** The entries that aren't valid addresses, as typed. */
  invalid: string[]
}

/** Split on commas and semicolons that aren't inside quotes or angle brackets. */
export function splitAddressList(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  let angle = false
  for (const ch of input) {
    if (ch === '"' && !angle) quoted = !quoted
    else if (ch === '<' && !quoted) angle = true
    else if (ch === '>' && !quoted) angle = false
    if ((ch === ',' || ch === ';') && !quoted && !angle) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** One entry: `a@b.example`, `Name <a@b.example>` or `"Last, First" <a@b.example>`. */
export function parseAddress(entry: string): Address | null {
  const s = entry.trim()
  if (!s || hasControlChars(s)) return null
  const m = /^(.*?)<([^<>]+)>$/.exec(s)
  const address = (m ? m[2]! : s).trim().replace(/^mailto:/i, '')
  if (!isEmailAddress(address)) return null
  const name = m
    ? m[1]!
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .replace(/\\(.)/g, '$1')
        .trim()
    : ''
  if (name.length > NAME_MAX) return null
  return name && name !== address ? { address, name } : { address }
}

/** Parse what someone typed into To, Cc or Bcc. Duplicates (ignoring case) are dropped. */
export function parseAddressList(input: string): ParsedAddressList {
  const addresses: Address[] = []
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const entry of splitAddressList(input)) {
    const a = parseAddress(entry)
    if (!a) {
      invalid.push(entry)
      continue
    }
    const key = a.address.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    addresses.push(a)
  }
  return { addresses, invalid }
}

/** An address as people write it: `Name <a@b.example>`, quoting the name when it needs it. */
export function formatAddress(a: Address): string {
  if (!a.name) return a.address
  const name = /[",;<>@()[\]\\:]/.test(a.name) ? `"${a.name.replace(/(["\\])/g, '\\$1')}"` : a.name
  return `${name} <${a.address}>`
}

export const formatAddressList = (list: readonly Address[]) => list.map(formatAddress).join(', ')

/**
 * A name to show for an address: the display name, or the address itself. A name that is itself
 * an email address, but not this one (`"boss@company.example" <attacker@evil.example>`), is a
 * disguise: the real address is shown instead.
 */
export function displayName(a: Address | null | undefined): string {
  const name = a?.name?.trim()
  if (!a) return ''
  if (!name) return a.address
  if (name.includes('@') && name.toLowerCase() !== a.address.toLowerCase()) return a.address
  return name
}

/** An address with its name, always showing the real address: `Name <a@b.example>`. */
export function personLabel(a: Address): string {
  const name = displayName(a)
  return name && name.toLowerCase() !== a.address.toLowerCase() ? `${name} <${a.address}>` : a.address
}
