import { merchantKey } from './merchant'
import type { DetectedBill, EmailHint } from './types'

/** An email sender, as Money groups subscription emails: display name plus domain. */
export const senderKey = (h: Pick<EmailHint, 'merchant' | 'domain'>) =>
  `${merchantKey(h.merchant)}|${h.domain.toLowerCase()}`

/** A model's opinion that a bank payment run and an email sender are the same business. */
export interface MatchSuggestion {
  /** `DetectedBill.key` of a bank-only bill. */
  key: string
  /** `senderKey()` of the email sender it matches. */
  sender: string
  confidence: number
}

/**
 * Seam for a model to link what the rules couldn't: a bank merchant (`AMZN MKTP`) and an email
 * sender (`Amazon`, amazon.co.uk). Only merchant and sender names, domains, the kind of email
 * and a rough amount are shared, never statements or subject lines.
 *
 * A suggestion only adds the email to a detected bill waiting for review; nothing is confirmed.
 */
export interface MatchAdvisor {
  suggest(detected: DetectedBill[], hints: EmailHint[]): Promise<MatchSuggestion[]>
}

export const noAdvisor: MatchAdvisor = {
  suggest: async () => [],
}

/** Hints the rules didn't link to any bank payment run. */
export function unlinkedHints(detected: DetectedBill[], hints: EmailHint[]): EmailHint[] {
  const linked = new Set(detected.filter((d) => d.source === 'both').flatMap((d) => d.hints))
  return hints.filter((h) => !linked.has(h))
}

/**
 * Apply match suggestions: each matched bank-only bill takes the sender's emails and becomes
 * `both`, marked as matched by AI. An email-only suggestion for the same sender is folded in.
 * Suggestions about anything else (bills that already have email, unknown keys or senders) are
 * ignored. Every bill stays a detected bill for you to confirm or dismiss.
 */
export function applySuggestions(
  detected: DetectedBill[],
  hints: EmailHint[],
  suggestions: MatchSuggestion[],
): DetectedBill[] {
  if (!suggestions.length) return detected
  const free = unlinkedHints(detected, hints)
  const bySender = new Map<string, EmailHint[]>()
  for (const h of free) bySender.set(senderKey(h), [...(bySender.get(senderKey(h)) ?? []), h])

  // The most confident suggestion wins, one sender per bill and one bill per sender.
  const bankOnly = new Set(detected.filter((d) => d.source === 'bank').map((d) => d.key))
  const best = new Map<string, MatchSuggestion>()
  const taken = new Set<string>()
  for (const s of [...suggestions].sort((a, b) => b.confidence - a.confidence)) {
    if (!bankOnly.has(s.key) || best.has(s.key) || taken.has(s.sender) || !bySender.has(s.sender)) continue
    best.set(s.key, s)
    taken.add(s.sender)
  }

  const used = new Set<EmailHint>()
  const out = detected.map((d) => {
    const s = best.get(d.key)
    if (!s) return d
    const linked = bySender.get(s.sender)!
    linked.forEach((h) => used.add(h))
    return {
      ...d,
      source: 'both' as const,
      hints: linked,
      matchedBy: 'ai' as const,
      matchConfidence: s.confidence,
    }
  })
  // An email-only suggestion whose emails now belong to a bank bill would be a duplicate.
  return out.filter((d) => d.source !== 'email' || !d.hints.every((h) => used.has(h)))
}
