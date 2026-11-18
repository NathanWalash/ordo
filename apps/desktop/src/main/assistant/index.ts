import { ipcMain, type WebContents } from 'electron'
import { providerInfo } from '@ordo/ai'
import {
  ASSISTANT_IPC,
  ASSISTANT_PAGES,
  AskInputSchema,
  ConfirmInputSchema,
  type AskOutcome,
  type AssistantEvent,
  type AssistantInfo,
  type AssistantPage,
} from '@ordo/shared'
import { aiSettings, resolveModel, usableProvider } from '../ai'
import { mainServices } from '../headless/services'
import { runAssistant } from './loop'
import type { Turn } from './prompt'

/**
 * The in-app assistant's main-process side. The conversation lives in memory only: closing Ordo
 * or pressing Clear forgets it, and tool results are never kept past the question they answered.
 */

/** Earlier questions and answers sent with each new question. */
const MAX_HISTORY = 8
const MAX_HISTORY_CHARS = 2000

let history: Turn[] = []
let running: AbortController | null = null
/** Bumped by Clear, so an answer that finishes afterwards isn't added back. */
let generation = 0
const pending = new Map<string, (approved: boolean) => void>()

const cut = (s: string) => (s.length > MAX_HISTORY_CHARS ? `${s.slice(0, MAX_HISTORY_CHARS)}…` : s)

/** "Wednesday 18 November 2026 (2026-11-18)", in local time. */
export function today(now = new Date()): string {
  const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const long = now.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
  return `${long.replace(',', '')} (${iso})`
}

export function info(): AssistantInfo {
  const ai = aiSettings()
  if (ai.provider === 'none')
    return {
      ready: false,
      provider: 'none',
      label: null,
      model: null,
      kind: null,
      message: 'Choose a model in Settings → AI to use the assistant.',
    }
  const p = providerInfo(ai.provider)
  const base = { provider: ai.provider, label: p.label, model: ai.model, kind: p.kind }
  if (!usableProvider(ai))
    return {
      ...base,
      ready: false,
      message: 'Confirm that Ordo may use this provider in Settings → AI first.',
    }
  return {
    ...base,
    ready: true,
    ...(p.kind === 'cloud' && {
      dataNotice:
        `Your questions, and the Ordo data the assistant looks up to answer them (sender names and subject lines, ` +
        `calendar events, transactions, bills and balances), go to ${p.vendor} under your own account.`,
    }),
  }
}

export async function ask(raw: unknown, sender: WebContents): Promise<AskOutcome> {
  const parsed = AskInputSchema.safeParse(raw)
  if (!parsed.success)
    return { ok: false, reason: 'invalid', message: parsed.error.issues[0]?.message ?? 'Invalid question.' }
  if (running)
    return { ok: false, reason: 'busy', message: 'The assistant is still working on your last question.' }
  const ai = aiSettings()
  const provider = usableProvider(ai)
  if (!provider) return { ok: false, reason: 'no-model', message: info().message ?? 'Choose a model first.' }

  const ctrl = (running = new AbortController())
  const started = generation
  const send = (e: AssistantEvent) => {
    if (!sender.isDestroyed()) sender.send(ASSISTANT_IPC.event, e)
  }
  const page: AssistantPage =
    parsed.data.page in ASSISTANT_PAGES ? (parsed.data.page as AssistantPage) : 'home'
  try {
    const model = await resolveModel(ai).catch(() => undefined)
    const outcome = await runAssistant({
      provider,
      model,
      services: mainServices(),
      history,
      question: parsed.data.text,
      page,
      today: today(),
      signal: ctrl.signal,
      onEvent: send,
      timeoutMs: provider.kind === 'local' ? 120_000 : 180_000,
      confirm: (id) =>
        new Promise<boolean>((resolve) => {
          if (ctrl.signal.aborted) return resolve(false)
          pending.set(id, resolve)
          ctrl.signal.addEventListener('abort', () => resolve(false), { once: true })
        }).finally(() => pending.delete(id)),
    })
    if (outcome.ok && started === generation)
      history = [...history, { user: cut(parsed.data.text), answer: cut(outcome.answer) }].slice(-MAX_HISTORY)
    return outcome
  } finally {
    running = null
  }
}

/** Answer a card. Only a card the current run is waiting on can be answered, and only once. */
export function confirm(raw: unknown): void {
  const parsed = ConfirmInputSchema.safeParse(raw)
  if (!parsed.success) return
  const resolve = pending.get(parsed.data.id)
  pending.delete(parsed.data.id)
  resolve?.(parsed.data.approve)
}

export function stop(): void {
  running?.abort()
}

export function clear(): void {
  stop()
  generation++
  history = []
}

export function registerAssistantIpc(): void {
  ipcMain.handle(ASSISTANT_IPC.info, () => info())
  ipcMain.handle(ASSISTANT_IPC.ask, (e, input: unknown) => ask(input, e.sender))
  ipcMain.handle(ASSISTANT_IPC.confirm, (_e, input: unknown) => confirm(input))
  ipcMain.handle(ASSISTANT_IPC.stop, () => stop())
  ipcMain.handle(ASSISTANT_IPC.clear, () => clear())
}
