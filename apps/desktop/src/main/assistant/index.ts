import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, ipcMain, type WebContents } from 'electron'
import { z } from 'zod'
import { AiError, PROVIDER_IDS, providerInfo } from '@ordo/ai'
import {
  ASSISTANT_IPC,
  AskInputSchema,
  AssistantPageSchema,
  CloudConsentInputSchema,
  ConfirmInputSchema,
  moneyDetailsAllowed,
  type AskOutcome,
  type AssistantEvent,
  type AssistantInfo,
} from '@ordo/shared'
import { aiSettings, resolveModel, usableProvider } from '../ai'
import { clean } from '../headless/format'
import { mainServices } from '../headless/services'
import { TOOLS } from '../headless/tools'
import { runAssistant, tidy } from './loop'
import type { Turn } from './prompt'

/**
 * The in-app assistant's main-process side. The conversation lives in memory only: closing Ordo,
 * reloading the window or pressing New conversation forgets it, and tool results are never kept
 * past the question they answered.
 */

/** Earlier questions and answers sent with each new question. */
export const MAX_HISTORY = 8
const MAX_HISTORY_CHARS = 2000
/** A card nobody answers counts as Cancel after this long. */
export const CONFIRM_TIMEOUT_MS = 10 * 60_000

/** What a cloud model sees through the assistant. Shown before the user agrees, and in docs/assistant.md. */
export const CLOUD_SENDS =
  'Your questions, and the Ordo data the assistant looks up to answer them: transactions with amounts and dates, ' +
  'balances, bills, calendar events, sender names, addresses and subject lines, the text of emails it opens, your boards’ cards, and your iCloud email address. ' +
  'What you’ve taught Ordo about your money in Ask Ordo (people’s names, paybacks, money you hold for others, events, exact amounts) ' +
  'goes only if you also allow Ask Ordo to send amounts, dates and names to this provider in Settings → AI.'

/**
 * The tools the assistant may use. With a cloud model and no Money details consent, the tools that
 * return what Ordo learned about your money (exact amounts, dates, people's names) are left out.
 */
export const assistantTools = (withoutMoneyDetails: boolean) =>
  withoutMoneyDetails ? TOOLS.filter((t) => !t.moneyDetails) : TOOLS

let history: Turn[] = []
/** The provider and consents the stored turns were answered under; a change forgets them. */
let historyFor = ''
let running: AbortController | null = null
/** The window that asked the current question: only it may answer its cards. */
let owner: WebContents | null = null
/** Bumped by Clear, so an answer that finishes afterwards isn't added back. */
let generation = 0
const pending = new Map<string, (approved: boolean) => void>()

const cut = (s: string) => (s.length > MAX_HISTORY_CHARS ? `${s.slice(0, MAX_HISTORY_CHARS)}…` : s)

// The assistant's own cloud consent, separate from AI sorting's: it sends far more.

const ConsentFile = z.object({ cloudConsent: z.enum(PROVIDER_IDS).nullable() }).strict()
const consentFile = () => join(app.getPath('userData'), 'assistant.json')

function readConsent(): z.infer<typeof ConsentFile>['cloudConsent'] {
  try {
    return ConsentFile.parse(JSON.parse(readFileSync(consentFile(), 'utf8'))).cloudConsent
  } catch {
    return null
  }
}

function writeConsent(value: z.infer<typeof ConsentFile>['cloudConsent']): void {
  const file = consentFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.tmp`, `${JSON.stringify({ cloudConsent: value }, null, 2)}\n`)
  renameSync(`${file}.tmp`, file)
}

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
  const busy = running !== null
  const ai = aiSettings()
  if (ai.provider === 'none')
    return {
      ready: false,
      busy,
      provider: 'none',
      label: null,
      model: null,
      kind: null,
      message: 'Choose a model in Settings → AI to use the assistant.',
    }
  const p = providerInfo(ai.provider)
  const base = { busy, provider: ai.provider, label: p.label, model: ai.model, kind: p.kind }
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
      cloud: { vendor: p.vendor ?? p.label, sends: CLOUD_SENDS, consent: readConsent() === ai.provider },
    }),
  }
}

/** Agree, or stop agreeing, that the assistant may send Ordo data to the chosen cloud provider. */
export function setCloudConsent(raw: unknown): AssistantInfo {
  const parsed = CloudConsentInputSchema.safeParse(raw)
  if (parsed.success) {
    const ai = aiSettings()
    if (!parsed.data.allow) writeConsent(null)
    // Only for the provider in use, and only once the user agreed to it in Settings → AI.
    else if (ai.provider !== 'none' && providerInfo(ai.provider).kind === 'cloud' && usableProvider(ai))
      writeConsent(ai.provider)
  }
  return info()
}

interface AskOptions {
  confirmTimeoutMs?: number
}

export async function ask(raw: unknown, sender: WebContents, options: AskOptions = {}): Promise<AskOutcome> {
  const parsed = AskInputSchema.safeParse(raw)
  if (!parsed.success)
    return { ok: false, reason: 'invalid', message: parsed.error.issues[0]?.message ?? 'Invalid question.' }
  if (running)
    return { ok: false, reason: 'busy', message: 'The assistant is still working on your last question.' }
  const ai = aiSettings()
  const provider = usableProvider(ai)
  if (!provider) return { ok: false, reason: 'no-model', message: info().message ?? 'Choose a model first.' }
  // A cloud model only gets Ordo data once the user agreed to it for the assistant.
  if (provider.kind === 'cloud' && readConsent() !== ai.provider)
    return {
      ok: false,
      reason: 'consent',
      message: `The assistant needs your OK before it sends anything to ${providerInfo(provider.id).vendor}.`,
    }

  // Earlier turns only go to a model under the same provider and consents they were answered under.
  const context = JSON.stringify([ai.provider, readConsent(), ai.moneyDetailsConsent])
  if (context !== historyFor) {
    history = []
    historyFor = context
  }
  const noMoneyDetails = provider.kind === 'cloud' && !moneyDetailsAllowed(ai)
  /** Checked before every tool runs: the provider and consents must still be what they were. */
  const allowed = (tool: { moneyDetails?: boolean }): string | null => {
    const now = aiSettings()
    if (now.provider !== ai.provider || !usableProvider(now))
      return 'The AI provider changed while answering, so Ordo stopped. Ask again.'
    if (provider.kind === 'cloud' && readConsent() !== now.provider)
      return `You took back the assistant’s OK for ${providerInfo(provider.id).vendor}, so Ordo stopped. Nothing more was sent.`
    if (tool.moneyDetails && provider.kind === 'cloud' && !moneyDetailsAllowed(now))
      return 'You turned off sending money details to this provider, so Ordo stopped. Nothing more was sent.'
    return null
  }

  const ctrl = (running = new AbortController())
  owner = sender
  const started = generation
  const send = (e: AssistantEvent) => {
    if (!sender.isDestroyed()) sender.send(ASSISTANT_IPC.event, e)
  }
  // If the window goes away or reloads mid-question, stop, and forget what it can no longer show.
  const gone = () => clear()
  const navigated = (...args: unknown[]) => {
    const details = args[0] as { isSameDocument?: boolean; isMainFrame?: boolean } | undefined
    const sameDocument = details?.isSameDocument ?? args[2] === true
    const mainFrame = details?.isMainFrame ?? args[3] !== false
    if (!sameDocument && mainFrame) gone()
  }
  sender.once('destroyed', gone)
  sender.once('render-process-gone', gone)
  sender.on('did-start-navigation', navigated)
  const page = AssistantPageSchema.catch('home').parse(parsed.data.page)
  try {
    let model: string | undefined
    try {
      model = await resolveModel(ai)
    } catch (err) {
      return {
        ok: false,
        reason: 'failed',
        message:
          err instanceof AiError
            ? clean(tidy(err.message), 300)
            : 'Ordo couldn’t reach the model. Try again.',
      }
    }
    const timeoutMs = options.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS
    const { tainted, moneyDetails, ...outcome } = await runAssistant({
      provider,
      model,
      services: mainServices(),
      tools: assistantTools(noMoneyDetails),
      // Turns that used money memory tools never go to a cloud model without the Money details consent.
      history: noMoneyDetails ? history.filter((t) => !t.moneyDetails) : history,
      allowed,
      question: parsed.data.text,
      page,
      today: today(),
      signal: ctrl.signal,
      onEvent: send,
      timeoutMs: provider.kind === 'local' ? 120_000 : 180_000,
      confirm: (id) =>
        new Promise<boolean>((resolve) => {
          if (ctrl.signal.aborted) return resolve(false)
          const timer = setTimeout(() => resolve(false), timeoutMs)
          pending.set(id, (yes) => {
            clearTimeout(timer)
            resolve(yes)
          })
          ctrl.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              resolve(false)
            },
            { once: true },
          )
        }).finally(() => pending.delete(id)),
    })
    if (outcome.ok && started === generation)
      history = [
        ...history,
        { user: cut(parsed.data.text), answer: cut(outcome.answer), tainted, moneyDetails },
      ].slice(-MAX_HISTORY)
    return outcome
  } finally {
    sender.removeListener('destroyed', gone)
    sender.removeListener('render-process-gone', gone)
    sender.removeListener('did-start-navigation', navigated)
    if (running === ctrl) {
      running = null
      owner = null
    }
  }
}

/** Answer a card. Only the asking window, only a card the current run is waiting on, and only once. */
export function confirm(raw: unknown, sender: WebContents): void {
  const parsed = ConfirmInputSchema.safeParse(raw)
  if (!parsed.success || sender !== owner) return
  const resolve = pending.get(parsed.data.id)
  pending.delete(parsed.data.id)
  resolve?.(parsed.data.approve)
}

export function stop(): void {
  running?.abort()
}

/** Stop anything running and forget the conversation. */
export function clear(): void {
  stop()
  generation++
  history = []
}

/** For tests: the history the next question would carry. */
export const currentHistory = (): readonly Turn[] => history

export function registerAssistantIpc(): void {
  ipcMain.handle(ASSISTANT_IPC.info, () => info())
  ipcMain.handle(ASSISTANT_IPC.ask, (e, input: unknown) => ask(input, e.sender))
  ipcMain.handle(ASSISTANT_IPC.confirm, (e, input: unknown) => confirm(input, e.sender))
  ipcMain.handle(ASSISTANT_IPC.consent, (_e, input: unknown) => setCloudConsent(input))
  ipcMain.handle(ASSISTANT_IPC.stop, () => stop())
  ipcMain.handle(ASSISTANT_IPC.clear, () => clear())
}
