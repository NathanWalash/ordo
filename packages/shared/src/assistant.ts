import { z } from 'zod'
import type { AiProviderId } from './ai'

/**
 * Pages the assistant can open: a short title for its chip, and what each shows (sent to the
 * model). Each key must be a renderer route (a test checks). Add a page here to let the assistant
 * open it.
 */
export const ASSISTANT_PAGES = {
  home: { title: 'Home', about: 'Home: an overview of every module' },
  'mail/inbox': { title: 'Mail', about: 'Mail: the iCloud mail folders, message list and reader' },
  'mail/unclutter': {
    title: 'Unclutter',
    about: 'Mail → Unclutter: senders by category, to unsubscribe and clear',
  },
  'mail/history': { title: 'Clean-up history', about: 'Mail → History: past clean-ups, with undo' },
  calendar: { title: 'Calendar', about: 'Calendar: month, week and agenda views' },
  boards: { title: 'Boards', about: 'Boards: kanban boards of cards in columns, with due dates and labels' },
  'money/finances': {
    title: 'Finances',
    about: 'Money → Finances: spending by category and month, every transaction; can filter to one month',
  },
  'money/bills': {
    title: 'Bills & Subscriptions',
    about: 'Money → Bills & Subscriptions: recurring payments, splits and who owes whom',
  },
  'money/ask': {
    title: 'Ask Ordo',
    about:
      'Money → Ask Ordo: what Ordo has learned about your money, its questions, loose ends, events and trips',
  },
  settings: { title: 'Settings', about: 'Settings: appearance and AI provider' },
} as const
export type AssistantPage = keyof typeof ASSISTANT_PAGES
export const ASSISTANT_PAGE_IDS = Object.keys(ASSISTANT_PAGES) as [AssistantPage, ...AssistantPage[]]
export const AssistantPageSchema = z.enum(ASSISTANT_PAGE_IDS)

/** The longest question the assistant takes. */
export const MAX_QUESTION_CHARS = 2000

export const AskInputSchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(1, 'Ask something first.')
      .max(MAX_QUESTION_CHARS, 'That question is too long.'),
    /** The page the user is on, so the assistant knows what "this" means. Unknown pages read as Home. */
    page: z.string().max(40),
  })
  .strict()
export type AskInput = z.input<typeof AskInputSchema>

export const ConfirmInputSchema = z.object({ id: z.string().min(1).max(64), approve: z.boolean() }).strict()
export type ConfirmInput = z.infer<typeof ConfirmInputSchema>

export const CloudConsentInputSchema = z.object({ allow: z.boolean() }).strict()
export type CloudConsentInput = z.infer<typeof CloudConsentInputSchema>

export type AssistantToolKind = 'read' | 'refresh' | 'change' | 'navigate'

/** One line on a card. `title` holds the full text when `text` is shortened (a long path). */
export interface CardDetail {
  text: string
  title?: string
}

/** What a confirmation card shows. Built by Ordo from its own data; never the model's free text. */
export interface ConfirmCard {
  tool: string
  /** "Importing a statement". */
  label: string
  /** "Import a bank statement". */
  title: string
  details: CardDetail[]
  notes: string[]
  /** Set when it can't go ahead: the card shows why and only offers Cancel. */
  blocked?: string
  /**
   * Why this card appeared. `request`: the user's own words asked for exactly this, and nothing
   * untrusted had been read. `data`: otherwise, so it may have come from text the assistant read.
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
      /** While running, what it's doing ("Reading transactions"); when done, what it did ("Read 8 transactions"). */
      label: string
      kind: AssistantToolKind
      status: 'running' | 'done' | 'failed'
      /** For a failure: Ordo's message. */
      summary?: string
    }
  /** A card: waiting for the user, or (with `card.blocked`) showing why a change can't happen. */
  | { type: 'confirm'; id: string; card: ConfirmCard }
  /** The user answered a card (or the run stopped while one was open). */
  | { type: 'confirmed'; id: string; approved: boolean }
  /** Open a page; `month` (YYYY-MM) filters Finances. */
  | { type: 'navigate'; page: AssistantPage; month?: string }

export type AskOutcome =
  | { ok: true; answer: string; steps: number }
  | {
      ok: false
      reason: 'no-model' | 'consent' | 'busy' | 'stopped' | 'cancelled' | 'blocked' | 'failed' | 'invalid'
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
  /**
   * With a cloud provider: the company that receives the data, what is sent, and whether the user
   * has agreed to it for the assistant (separately from AI sorting).
   */
  cloud?: { vendor: string; sends: string; consent: boolean }
  /** A question is being answered right now. */
  busy: boolean
}

export interface AssistantApi {
  info(): Promise<AssistantInfo>
  /** Ask a question; resolves when the answer is ready. Progress arrives through `onEvent`. */
  ask(input: AskInput): Promise<AskOutcome>
  /** Answer an open confirmation card. */
  confirm(input: ConfirmInput): Promise<void>
  /** Agree (or stop agreeing) that the assistant may send Ordo data to the chosen cloud provider. */
  setCloudConsent(input: CloudConsentInput): Promise<AssistantInfo>
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
  consent: 'assistant:consent',
  stop: 'assistant:stop',
  clear: 'assistant:clear',
  event: 'assistant:event',
} as const
