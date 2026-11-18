import { z } from 'zod'
import type { AiProviderId } from './ai'

/**
 * Pages the assistant can open, with what each shows (sent to the model). Each key must be a
 * renderer route (a test checks). Add a page here to let the assistant open it.
 */
export const ASSISTANT_PAGES = {
  home: 'Home: an overview of every module',
  'mail/inbox': 'Mail → Inbox: the connected iCloud account',
  'mail/unclutter': 'Mail → Unclutter: senders by category, to unsubscribe and clear',
  'mail/history': 'Mail → History: past clean-ups, with undo',
  calendar: 'Calendar: month, week and agenda views',
  'money/finances':
    'Money → Finances: spending by category and month, every transaction; can filter to one month',
  'money/bills': 'Money → Bills & Subscriptions: recurring payments, splits and who owes whom',
  settings: 'Settings: appearance and AI provider',
} as const
export type AssistantPage = keyof typeof ASSISTANT_PAGES
export const ASSISTANT_PAGE_IDS = Object.keys(ASSISTANT_PAGES) as [AssistantPage, ...AssistantPage[]]

/** The longest question the assistant takes. */
export const MAX_QUESTION_CHARS = 2000

export const AskInputSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1, 'Ask something first.')
      .max(MAX_QUESTION_CHARS, 'That question is too long.'),
    /** The page the user is on, so the assistant knows what "this" means. */
    page: z.string().max(40),
  })
  .strict()
export type AskInput = z.input<typeof AskInputSchema>

export const ConfirmInputSchema = z.object({ id: z.string().min(1).max(64), approve: z.boolean() }).strict()
export type ConfirmInput = z.infer<typeof ConfirmInputSchema>

export type AssistantToolKind = 'read' | 'refresh' | 'change' | 'navigate'

/** What a confirmation card shows. Built by Ordo from its own data; never the model's free text. */
export interface ConfirmCard {
  tool: string
  /** "Importing a statement". */
  label: string
  /** "Import 26 transactions into Monzo". */
  title: string
  details: string[]
  notes: string[]
  /** Set when it can't go ahead; the card then only offers Cancel. */
  blocked?: string
  /**
   * Why this card appeared. `request`: the user's own message asked for this kind of change.
   * `data`: it didn't, so the request may have come from text the assistant read.
   */
  trigger: { kind: 'request' | 'data'; text: string }
}

export type AssistantEvent =
  /** A model call started (`step` counts from 1). */
  | { type: 'thinking'; step: number }
  | {
      type: 'tool'
      id: string
      tool: string
      label: string
      kind: AssistantToolKind
      status: 'running' | 'done' | 'failed'
      /** A short, Ordo-written result, e.g. "12 transactions" or the error message. */
      summary?: string
    }
  | { type: 'confirm'; id: string; card: ConfirmCard }
  /** The user answered a card (or the run stopped while one was open). */
  | { type: 'confirmed'; id: string; approved: boolean }
  /** Open a page; `month` (YYYY-MM) filters Finances. */
  | { type: 'navigate'; page: AssistantPage; month?: string }

export type AskOutcome =
  | { ok: true; answer: string; steps: number }
  | {
      ok: false
      reason: 'no-model' | 'busy' | 'stopped' | 'cancelled' | 'failed' | 'invalid'
      message: string
    }

/** Which model the assistant uses, and what the panel should say about it. */
export interface AssistantInfo {
  ready: boolean
  provider: AiProviderId | 'none'
  /** "LM Studio". */
  label: string | null
  model: string | null
  kind: 'local' | 'cloud' | null
  /** Why it isn't ready, e.g. "Choose a model in Settings → AI to use the assistant." */
  message?: string
  /** With a cloud provider: what the model will see, and who receives it. */
  dataNotice?: string
}

export interface AssistantApi {
  info(): Promise<AssistantInfo>
  /** Ask a question; resolves when the answer is ready. Progress arrives through `onEvent`. */
  ask(input: AskInput): Promise<AskOutcome>
  /** Answer an open confirmation card. */
  confirm(input: ConfirmInput): Promise<void>
  /** Stop the current answer. An open card counts as cancelled. */
  stop(): Promise<void>
  /** Forget the conversation. Nothing is kept on disk anyway. */
  clear(): Promise<void>
  onEvent(listener: (e: AssistantEvent) => void): () => void
}

export const ASSISTANT_IPC = {
  info: 'assistant:info',
  ask: 'assistant:ask',
  confirm: 'assistant:confirm',
  stop: 'assistant:stop',
  clear: 'assistant:clear',
  event: 'assistant:event',
} as const
