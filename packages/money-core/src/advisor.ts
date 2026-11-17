import type { DetectedBill } from './types'

/** A model's opinion on one detected bill. */
export interface MatchSuggestion {
  /** `DetectedBill.key` this is about. */
  key: string
  /** Is this really a bill or subscription (not, say, a weekly supermarket shop)? */
  isBill?: boolean
  /** A friendlier name, e.g. `Thames Water` for `THAMES WATER UTILITIE`. */
  name?: string
  confidence: number
  reason?: string
}

/**
 * Seam for a local model to review rule-based detection: confirm likely bills, rename
 * merchants and link emails the rules missed. Only merchant names, amounts, dates and
 * subject lines would be shared, never full statements.
 *
 * The local-model adapter (LM Studio / Ollama / Claude CLI) arrives in a later
 * milestone. Until then Ordo uses `noAdvisor` and rules alone decide.
 */
export interface MatchAdvisor {
  suggest(candidates: DetectedBill[]): Promise<MatchSuggestion[]>
}

export const noAdvisor: MatchAdvisor = {
  suggest: async () => [],
}

/** Apply suggestions: drop what the model says isn't a bill, adopt better names. */
export function applySuggestions(candidates: DetectedBill[], suggestions: MatchSuggestion[]): DetectedBill[] {
  const byKey = new Map(suggestions.map((s) => [s.key, s]))
  return candidates
    .filter((c) => byKey.get(c.key)?.isBill !== false)
    .map((c) => {
      const s = byKey.get(c.key)
      return s?.name ? { ...c, name: s.name } : c
    })
}
