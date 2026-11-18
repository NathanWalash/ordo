import { parse } from 'tldts'
import { registrableDomain } from './unsubscribe'

/** Longest link Ordo will open. */
export const LINK_MAX = 4096

/** A link someone clicked in an email, checked before anything opens it. */
export type CheckedLink =
  | {
      kind: 'web'
      url: string
      host: string
      /** https rather than plain http. */
      secure: boolean
      /** The link's text names a different site from where it really goes. */
      mismatch: { shown: string; actual: string } | null
    }
  | { kind: 'mailto'; url: string }
  | { kind: 'refused'; url: string; reason: string }

const DOMAINISH = /(?:[a-z][a-z0-9+.-]*:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?=[/:?#\s]|$)/i

/**
 * Decide what a link from an email is and whether Ordo may open it: only http, https and
 * mailto, no user name or password in the address (`https://bank.example@evil.example`), and a
 * warning when the text shows one site but the link goes to another.
 */
export function checkLink(href: string, text = ''): CheckedLink {
  const raw = href.trim()
  if (raw.length > LINK_MAX)
    return { kind: 'refused', url: raw.slice(0, 200), reason: 'This link is too long.' }
  if (/^mailto:/i.test(raw)) return { kind: 'mailto', url: raw }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { kind: 'refused', url: raw, reason: 'This isn’t a web address Ordo can open.' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    return { kind: 'refused', url: raw, reason: `Ordo only opens web links, not ${url.protocol} links.` }
  if (url.username || url.password)
    return {
      kind: 'refused',
      url: url.href,
      reason: 'This link hides where it goes behind a user name, a trick used in scams. Ordo won’t open it.',
    }
  const host = url.hostname.toLowerCase()
  // Only text that names a real domain counts: "report.pdf" isn't one.
  const shownHost = DOMAINISH.exec(text.trim())?.[1]?.toLowerCase()
  const parsed = shownHost ? parse(shownHost, { allowPrivateDomains: true }) : null
  const shown = parsed?.isIcann || parsed?.isPrivate ? parsed.domain : null
  const mismatch =
    shown && shown !== registrableDomain(host) ? { shown, actual: registrableDomain(host) } : null
  return { kind: 'web', url: url.href, host, secure: url.protocol === 'https:', mismatch }
}
