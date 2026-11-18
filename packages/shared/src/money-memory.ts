import { z } from 'zod'
import {
  MoneyFactInputSchema,
  type AccountCaveat,
  type AskStep,
  type Counterpart,
  type EventCost,
  type FactSource,
  type HeldBalance,
  type MatchConfidence,
  type MoneyFact,
  type MoneyFactData,
  type MoneyFactInput,
  type MonthComparison,
  type OwedItem,
  type QuestionKind,
  type QuestionStep,
} from '@ordo/money-core'

export type {
  AccountCaveat,
  AskStep,
  Counterpart,
  EventCost,
  FactSource,
  HeldBalance,
  MatchConfidence,
  MoneyFact,
  MoneyFactData,
  MoneyFactInput,
  MonthComparison,
  OwedItem,
  QuestionKind,
  QuestionStep,
}
export { MoneyFactInputSchema }

/** IPC channels for what Ordo learns about your money, and Ask Ordo. */
export const MEMORY_IPC = {
  view: 'money-memory:view',
  saveFact: 'money-memory:save-fact',
  deleteFact: 'money-memory:delete-fact',
  answer: 'money-memory:answer',
  compare: 'money-memory:compare',
  ask: 'money-memory:ask',
  askStop: 'money-memory:ask-stop',
  askStep: 'money-memory:ask-step',
} as const

const factId = z.string().min(1).max(100)

/** Save a new fact (no id) or change one. Ordo checks the payments it names exist. */
export const SaveFactSchema = z.strictObject({
  id: factId.optional(),
  fact: MoneyFactInputSchema,
  /** Where it came from: typed in, the Teach Ordo flow, or a suggestion from Ask Ordo. */
  source: z.enum(['you', 'onboarding', 'ask']).default('you'),
})
export type SaveFactInput = z.input<typeof SaveFactSchema>

/** Answer one of Ordo's questions. The answer's facts are worked out again in the main process. */
export const AnswerSchema = z.strictObject({
  questionId: z.string().min(1).max(400),
  answerId: z.string().min(1).max(40),
  /** `onboarding` when answered in Teach Ordo. */
  via: z.enum(['question', 'onboarding']).default('question'),
})
export type AnswerInput = z.input<typeof AnswerSchema>

export const CompareSchema = z.strictObject({
  category: z.string().trim().min(1).max(40).optional(),
  account: z.string().trim().min(1).max(60).optional(),
})
export type CompareInput = z.input<typeof CompareSchema>

export const AskInputSchema = z.strictObject({
  question: z.string().trim().min(1, 'Ask a question.').max(500, 'That question is too long.'),
  history: z
    .array(z.strictObject({ question: z.string().max(500), answer: z.string().max(2000) }))
    .max(10)
    .default([]),
})
export type AskInput = z.input<typeof AskInputSchema>

/** A saved fact with Ordo's sentence for it. */
export type FactView = MoneyFact & { summary: string }

/** A question, without the facts behind its answers (the main process keeps those). */
export interface QuestionView {
  id: string
  kind: QuestionKind
  step: QuestionStep
  text: string
  detail?: string
  confidence?: MatchConfidence
  answers: { id: string; label: string }[]
}

export interface MemoryView {
  facts: FactView[]
  questions: QuestionView[]
  held: HeldBalance[]
  owed: OwedItem[]
  /** Shared bills where you're owed money, from Bills. Pence. */
  billsOwed: { person: string; amount: number }[]
  events: EventCost[]
  people: Counterpart[]
  caveats: AccountCaveat[]
  /** This month so far against last month, all categories. */
  compare: MonthComparison
  accounts: string[]
  categories: string[]
  hasTransactions: boolean
  /** Ask Ordo can run: a model is chosen and may see exact amounts, dates and names. */
  ask: { ready: boolean; provider: string | null; cloud: boolean; reason?: 'no-model' | 'consent' }
}

export type MemoryResult =
  | { ok: true; facts?: number }
  /** `locked`: another Ordo process is writing. */
  | { ok: false; message: string; error?: 'locked' }

export interface AskProposalView {
  label: string
  fact: MoneyFactData
  /** Ordo's own sentence for the fact, so you see exactly what would be saved. */
  summary: string
}

export type AskOutcome =
  | {
      ok: true
      answer: string
      steps: AskStep[]
      proposals: AskProposalView[]
      clarify?: { question: string; options: string[] }
    }
  | { ok: false; message: string; error?: 'no-model' | 'consent' | 'busy' }

/** `window.ordo.moneyMemory`: what Ordo has learned about your money, and Ask Ordo. */
export interface MoneyMemoryApi {
  view(): Promise<MemoryView>
  saveFact(input: SaveFactInput): Promise<MemoryResult>
  deleteFact(id: string): Promise<MemoryResult>
  /** Answer a question; its answer's facts are saved. "No" and "Not now" just stop it coming back. */
  answer(input: AnswerInput): Promise<MemoryResult>
  compare(input: CompareInput): Promise<MonthComparison>
  /** Ask the chosen model; it answers by calling Ordo's query functions. Changes nothing. */
  ask(input: AskInput): Promise<AskOutcome>
  askStop(): Promise<void>
  /** Each tool the model calls while answering; returns an unsubscribe function. */
  onAskStep(listener: (s: AskStep) => void): () => void
}
