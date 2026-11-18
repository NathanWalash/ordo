import { randomUUID } from 'node:crypto'
import { AiError, parseModelJson, type ModelProvider } from '@ordo/ai'
import type { AskOutcome, AssistantEvent, AssistantPage, ConfirmCard } from '@ordo/shared'
import type { CommandResult, OrdoServices } from '../headless/commands'
import { clean } from '../headless/format'
import { previewTool, runTool, strictArgs, TOOLS, type OrdoTool } from '../headless/tools'
import {
  catalogue,
  OPEN_PAGE,
  OpenPageArgs,
  replySchema,
  ReplySchema,
  systemPrompt,
  turnPrompt,
  type Step,
  type Turn,
} from './prompt'

/**
 * The assistant's tool loop. Each model reply is one JSON object: an answer, or one tool call
 * `{tool, args}`, checked with zod against that tool's own schema. Ordo is the only thing that runs
 * tools (CLI providers run with their own tools off). Read tools run straight away; change tools
 * only after the user confirms a card built from Ordo's own preview; navigation opens a page.
 */

/** Tool calls per question. */
export const MAX_TOOL_CALLS = 6
/** Unusable replies in a row (bad JSON, unknown tool, bad arguments) before giving up. */
export const MAX_RETRIES = 2
/** A hard cap on model calls per question, whatever happens. */
export const MAX_MODEL_CALLS = MAX_TOOL_CALLS + MAX_RETRIES + 2

export interface LoopOptions {
  provider: ModelProvider
  model?: string
  services: OrdoServices
  history: readonly Turn[]
  question: string
  page: AssistantPage
  /** "Wednesday 18 November 2026 (2026-11-18)". */
  today: string
  signal: AbortSignal
  onEvent: (e: AssistantEvent) => void
  /** Show a card and wait for the user. Resolves false on Cancel, Stop or close. */
  confirm: (id: string, card: ConfirmCard) => Promise<boolean>
  timeoutMs?: number
  /** The tools on offer; tests can narrow it. */
  tools?: readonly OrdoTool[]
}

const plural = (n: number, one: string) => `${n.toLocaleString('en-GB')} ${one}${n === 1 ? '' : 's'}`

/** A short, Ordo-written note for a tool chip. Never text from the result itself. */
export function summarise(result: CommandResult): string {
  if (!result.ok) return clean(result.message, 120)
  const d = result.data as Record<string, unknown> | null
  if (d && typeof d === 'object') {
    for (const [key, one] of [
      ['transactions', 'transaction'],
      ['events', 'event'],
      ['senders', 'sender'],
      ['cleanups', 'clean-up'],
      ['bills', 'bill'],
      ['debts', 'balance'],
    ] as const) {
      const list = d[key]
      if (Array.isArray(list)) {
        const total = typeof d['total'] === 'number' ? (d['total'] as number) : list.length
        return plural(total, one)
      }
    }
  }
  return 'Done'
}

const STOPPED: AskOutcome = { ok: false, reason: 'stopped', message: 'Stopped.' }

/** Why a change card appeared: the user's own words, or (perhaps) something the assistant read. */
export function triggerFor(tool: OrdoTool, question: string, steps: readonly Step[]): ConfirmCard['trigger'] {
  const read = [...new Set(steps.filter((s) => !s.trusted).map((s) => TOOLS.find((t) => t.name === s.tool)))]
    .filter((t): t is OrdoTool => !!t)
    .map((t) => t.label.replace(/^\w+ing /, ''))
  const after = read.length ? ` after looking at ${read.join(', ')}` : ''
  if (tool.intent?.test(question)) return { kind: 'request', text: `You asked: “${clean(question, 160)}”` }
  return {
    kind: 'data',
    text:
      `You didn’t ask for this. The assistant suggested it${after}. ` +
      'Text in emails, statements and calendars can try to trick it, so only confirm if you want this.',
  }
}

const cardText = (s: string) => clean(s, 240)

export async function runAssistant(o: LoopOptions): Promise<AskOutcome> {
  const tools = o.tools ?? TOOLS
  const entries = catalogue(tools)
  const names = entries.map((e) => e.name)
  const system = systemPrompt(entries, { today: o.today, page: o.page })
  const schema = replySchema(names)
  const steps: Step[] = []
  let retries = 0
  let problem: string | undefined
  let toolCalls = 0

  for (let call = 0; call < MAX_MODEL_CALLS; call++) {
    if (o.signal.aborted) return STOPPED
    o.onEvent({ type: 'thinking', step: call + 1 })
    let text: string
    let json: unknown
    try {
      const res = await o.provider.complete({
        system,
        prompt: turnPrompt(o.history, o.question, steps, { lastStep: toolCalls >= MAX_TOOL_CALLS, problem }),
        model: o.model,
        schema,
        signal: o.signal,
        timeoutMs: o.timeoutMs ?? 120_000,
      })
      text = res.text
      json = res.json
    } catch (err) {
      if (o.signal.aborted || (err instanceof AiError && err.code === 'aborted')) return STOPPED
      return {
        ok: false,
        reason: 'failed',
        message:
          err instanceof AiError ? err.message : 'Something went wrong talking to the model. Try again.',
      }
    }
    if (o.signal.aborted) return STOPPED

    // Check the reply. Anything unusable goes back to the model once or twice, then we give up.
    const retry = (why: string): AskOutcome | null => {
      retries++
      problem = why
      return retries > MAX_RETRIES
        ? {
            ok: false,
            reason: 'invalid',
            message: "The model's replies weren't in the format Ordo needs. Try again, or try another model.",
          }
        : null
    }
    let value: unknown
    try {
      value = json !== undefined ? json : parseModelJson(text)
    } catch {
      const gaveUp = retry('it was not valid JSON')
      if (gaveUp) return gaveUp
      continue
    }
    const reply = ReplySchema.safeParse(value)
    if (!reply.success) {
      const gaveUp = retry(
        `it didn't match the reply format (${reply.error.issues
          .slice(0, 2)
          .map((i) => `${i.path.join('.') || 'reply'}: ${i.message}`)
          .join('; ')})`,
      )
      if (gaveUp) return gaveUp
      continue
    }

    if (reply.data.type === 'answer')
      return { ok: true, answer: tidy(reply.data.text) || 'Done.', steps: toolCalls }

    const { tool: name } = reply.data
    // `confirm` is Ordo's to give, never the model's: drop it rather than fail on it.
    const { confirm: _ignored, ...args } = reply.data.args
    if (toolCalls >= MAX_TOOL_CALLS)
      return {
        ok: false,
        reason: 'failed',
        message: `I stopped after ${MAX_TOOL_CALLS} steps without an answer. Try a narrower question.`,
      }

    if (name === OPEN_PAGE) {
      const nav = OpenPageArgs.safeParse(args)
      if (!nav.success) {
        const gaveUp = retry(`the arguments for ${OPEN_PAGE} were wrong (${nav.error.issues[0]?.message})`)
        if (gaveUp) return gaveUp
        continue
      }
      retries = 0
      problem = undefined
      toolCalls++
      const id = randomUUID()
      o.onEvent({ type: 'tool', id, tool: name, label: 'Opening a page', kind: 'navigate', status: 'done' })
      o.onEvent({ type: 'navigate', page: nav.data.page, ...(nav.data.month && { month: nav.data.month }) })
      steps.push({
        tool: name,
        args: nav.data,
        trusted: true,
        result: { opened: nav.data.page, month: nav.data.month ?? null },
      })
      continue
    }

    const tool = tools.find((t) => t.name === name)
    if (!tool) {
      const gaveUp = retry(`there is no tool called ${clean(name, 64)}; use one of ${names.join(', ')}`)
      if (gaveUp) return gaveUp
      continue
    }
    const checked = strictArgs(tool).safeParse(args)
    if (!checked.success) {
      const gaveUp = retry(
        `the arguments for ${tool.name} didn't match its schema (${checked.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || 'args'}: ${i.message}`)
          .join('; ')})`,
      )
      if (gaveUp) return gaveUp
      continue
    }
    retries = 0
    problem = undefined
    toolCalls++
    const id = randomUUID()

    let result: CommandResult
    if (tool.kind === 'change') {
      const preview = await previewTool(o.services, tool, checked.data)
      const card: ConfirmCard = {
        tool: tool.name,
        label: tool.label,
        title: cardText(preview.title),
        details: preview.details.slice(0, 50).map(cardText),
        notes: preview.notes.slice(0, 10).map(cardText),
        ...(preview.blocked && { blocked: cardText(preview.blocked) }),
        trigger: triggerFor(tool, o.question, steps),
      }
      o.onEvent({ type: 'confirm', id, card })
      const approved = !preview.blocked && (await o.confirm(id, card))
      o.onEvent({ type: 'confirmed', id, approved })
      if (o.signal.aborted) return STOPPED
      // A no ends the turn without asking the model again, so data can't keep asking.
      if (!approved)
        return {
          ok: false,
          reason: 'cancelled',
          message: preview.blocked
            ? `Nothing was changed: ${cardText(preview.blocked)}`
            : 'Cancelled. Nothing was changed.',
        }
      o.onEvent({ type: 'tool', id, tool: tool.name, label: tool.label, kind: tool.kind, status: 'running' })
      result = await runTool(o.services, tool, checked.data, { allowChanges: true, confirm: true })
    } else {
      o.onEvent({ type: 'tool', id, tool: tool.name, label: tool.label, kind: tool.kind, status: 'running' })
      // Read and refresh tools never get permission to change anything.
      result = await runTool(o.services, tool, checked.data, { allowChanges: false, confirm: false })
    }
    o.onEvent({
      type: 'tool',
      id,
      tool: tool.name,
      label: tool.label,
      kind: tool.kind,
      status: result.ok ? 'done' : 'failed',
      summary: summarise(result),
    })
    steps.push({
      tool: tool.name,
      args: checked.data,
      // Change results and Ordo's own status are Ordo's words; the rest carries third-party text.
      trusted: !tool.untrusted,
      result: result.ok ? result.data : { error: { code: result.code, message: result.message } },
    })
    if (o.signal.aborted) return STOPPED
  }
  return {
    ok: false,
    reason: 'failed',
    message: `I stopped after ${MAX_TOOL_CALLS} steps without an answer. Try a narrower question.`,
  }
}

/** An answer fit to show: control characters and bidi overrides out, runs of blank lines squeezed. */
export function tidy(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 6000)
  )
}
