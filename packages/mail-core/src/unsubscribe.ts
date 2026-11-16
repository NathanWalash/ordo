import type { UnsubscribeMethod } from './types'

/**
 * Pick the best unsubscribe method from List-Unsubscribe headers (RFC 2369)
 * and List-Unsubscribe-Post (RFC 8058). Only https URLs are accepted.
 */
export function parseUnsubscribe(listUnsubscribe?: string, listUnsubscribePost?: string): UnsubscribeMethod {
  if (!listUnsubscribe) return { kind: 'none' }
  const targets = [...listUnsubscribe.matchAll(/<([^>]+)>/g)].map((m) => m[1]!.trim())
  const https = targets.find((t) => /^https:\/\//i.test(t))
  const mailto = targets.find((t) => /^mailto:/i.test(t))
  const oneClick = /List-Unsubscribe=One-Click/i.test(listUnsubscribePost ?? '')
  if (https && oneClick) return { kind: 'one-click', url: https }
  if (https) return { kind: 'link', url: https }
  if (mailto) return { kind: 'mailto', address: mailto.slice('mailto:'.length).split('?')[0]! }
  return { kind: 'none' }
}
