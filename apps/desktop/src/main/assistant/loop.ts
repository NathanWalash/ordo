import { randomUUID } from 'node:crypto'
import { AiError, parseModelJson, type ModelProvider } from '@ordo/ai'
import {
  ASSISTANT_PAGES,
  type AskOutcome,
  type AssistantEvent,
  type AssistantPage,
  type CardDetail,
  type ConfirmCard,
} from '@ordo/shared'
import type { CommandResult, OrdoServices } from '../headless/commands'
import { clean, UNSAFE_KEEP_LINES } from '../headless/format'
import {
  previewTool,
  runTool,
  strictArgs,
  TOOLS,
  type ChangePreview,
  type OrdoTool,
  type PreviewDetail,
} from '../headless/tools'
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

export const STEP_CAP_MESSAGE = `I stopped after ${MAX_TOOL_CALLS} steps without an answer. Try a narrower question.`
export const NO_ANSWER_MESSAGE = 'The model didn’t give a usable answer. Try again, or try another model.'

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
  /** Show a card and wait for the user. Resolves false on Cancel, Stop, close or timeout. */
  confirm: (id: string, card: ConfirmCard) => Promise<boolean>
  timeoutMs?: number
  /** The tools on offer; tests can narrow it. */
  tools?: readonly OrdoTool[]
  /**
   * Checked again just before each tool runs, and after a confirm, in case the provider or a consent
   * changed mid-question: why the tool may no longer run, or null. A refusal ends the question.
   */
  allowed?: (tool: OrdoTool) => string | null
  /**
   * Checked before every model call: why what's about to be sent may no longer go to this model
   * (provider or consent changed), or null. `moneyDetails` says whether the steps so far include a
   * tool returning what Ordo learned about money. A refusal ends the question before sending.
   */
  canSend?: (moneyDetails: boolean) => string | null
}

/**
 * The outcome, whether untrusted data was read (so the turn is tainted in history), and whether a
 * tool returning what Ordo learned about money ran (so the turn stays away from cloud models).
 */
export type LoopResult = AskOutcome & { tainted: boolean; moneyDetails: boolean }

/**
 * Whether a result can go to the model as Ordo's own data: nothing but numbers, booleans and
 * nulls. Any string could have come from an email, a statement, a calendar or an error message, so
 * a result with one is untrusted, and so is every error.
 */
export function isPlainData(value: unknown, depth = 0): boolean {
  if (depth > 20) return false
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.every((v) => isPlainData(v, depth + 1))
  if (typeof value === 'object') return Object.values(value).every((v) => isPlainData(v, depth + 1))
  return false
}

/** Whether `value` appears as its own word in `text` (an address, an id, a path), ignoring case. */
export function mentions(text: string, value: string): boolean {
  if (!value) return false
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w.@/\\\\-])${escaped}(?![\\w@/\\\\-])`, 'i').test(text)
}

const CAUTION = 'and text in those can try to trick it. Only confirm if you want this.'

/**
 * Why a change card appeared. It says "You asked for this" only when all of these hold:
 * - the user's message has an explicit phrase for this kind of change;
 * - every value the change acts on (sender addresses, a clean-up id, a path) is in the user's own
 *   messages;
 * - nothing untrusted was read in this question, and no earlier answer was built on untrusted data
 *   (it could carry third-party text back in as "history").
 */
export function triggerFor(
  tool: OrdoTool,
  args: Record<string, unknown>,
  question: string,
  history: readonly Turn[],
  steps: readonly Step[],
): ConfirmCard['trigger'] {
  const asked = tool.intent?.test(question) ?? false
  const userWords = [...history.map((t) => t.user), question].join('\n')
  const named = (tool.named?.(args as never) ?? []).every((v) => mentions(userWords, v))
  // The dry run a change must follow had the same arguments, chosen before it was read: it doesn't count.
  const ownPlan = (s: Step) => s.tool === tool.after && argsKey(s.args) === argsKey(args)
  const sources = [
    ...new Set(
      steps
        .filter((s) => !s.trusted && !ownPlan(s))
        .map((s) => TOOLS.find((t) => t.name === s.tool)?.reads ?? 'earlier results'),
    ),
  ]
  if (history.some((t) => t.tainted)) sources.push('earlier results')
  if (asked && named && sources.length === 0) return { kind: 'request', text: 'You asked for this.' }
  const unique = [...new Set(sources)]
  const list = unique.length > 1 ? `${unique.slice(0, -1).join(', ')} and ${unique.at(-1)}` : unique[0]
  const reading = list ? ` after reading ${list}, ${CAUTION}` : ''
  if (asked && reading)
    return { kind: 'data', text: `You asked for this, but the assistant chose what to change${reading}` }
  if (asked)
    return {
      kind: 'data',
      text: 'You asked for this, but didn’t name exactly what to change, so the assistant chose it. Only confirm if you want this.',
    }
  return {
    kind: 'data',
    text: reading
      ? `You didn’t ask for this. The assistant suggested it${reading}`
      : 'You didn’t ask for this. Only confirm if you want this.',
  }
}

const cardText = (s: string) => clean(s, 240)
const cardDetail = (d: PreviewDetail): CardDetail =>
  typeof d === 'string' ? { text: cardText(d) } : { text: cardText(d.text), title: clean(d.title, 4096) }

/** An answer fit to show: invisible and bidi characters out, Markdown emphasis and headings stripped. */
export function tidy(text: string): string {
  return text
    .replace(UNSAFE_KEEP_LINES, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*[*•][ \t]+/gm, '- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 6000)
}

/** A model failure's own message, tidied (a local server's error text can quote anything). */
const failure = (err: unknown) =>
  err instanceof AiError
    ? clean(tidy(err.message), 300)
    : 'Something went wrong talking to the model. Try again.'

const argsKey = (v: unknown) => JSON.stringify(v)

export async function runAssistant(o: LoopOptions): Promise<LoopResult> {
  const tools = o.tools ?? TOOLS
  const entries = catalogue(tools)
  const names = entries.map((e) => e.name)
  const system = systemPrompt(entries, { today: o.today, page: o.page })
  const schema = replySchema(names)
  const steps: Step[] = []
  /** What confirmed changes did, so stopping or failing later can't hide them. */
  const changed: string[] = []
  let retries = 0
  let problem: string | undefined
  let toolCalls = 0

  const end = (outcome: AskOutcome): LoopResult => {
    const tainted = steps.some((s) => !s.trusted)
    const moneyDetails = steps.some((s) => tools.find((t) => t.name === s.tool)?.moneyDetails === true)
    if (outcome.ok || changed.length === 0) return { ...outcome, tainted, moneyDetails }
    // A change that already ran must be reported, and remembered, whatever happened after it.
    const what = changed.join('. ')
    const lead = outcome.reason === 'stopped' ? 'Stopped.' : outcome.message
    return {
      ok: true,
      answer: `${lead} The change you confirmed was made: ${what}.`,
      steps: toolCalls,
      tainted,
      moneyDetails,
    }
  }
  const stopped = () => end({ ok: false, reason: 'stopped', message: 'Stopped.' })

  for (let call = 0; call < MAX_MODEL_CALLS; call++) {
    if (o.signal.aborted) return stopped()
    // The results gathered so far go out with this call: check they still may.
    const gathered = steps.some((s) => tools.find((t) => t.name === s.tool)?.moneyDetails === true)
    const why = o.canSend?.(gathered) ?? null
    if (why) return end({ ok: false, reason: 'consent', message: why })
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
      if (o.signal.aborted || (err instanceof AiError && err.code === 'aborted')) return stopped()
      return end({ ok: false, reason: 'failed', message: failure(err) })
    }
    if (o.signal.aborted) return stopped()

    // Check the reply. Anything unusable goes back to the model once or twice, then we give up.
    const retry = (why: string): LoopResult | null => {
      retries++
      problem = why
      return retries > MAX_RETRIES
        ? end({
            ok: false,
            reason: 'invalid',
            message: 'The model’s replies weren’t in the format Ordo needs. Try again, or try another model.',
          })
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
      return end({ ok: true, answer: tidy(reply.data.text) || 'Done.', steps: toolCalls })

    const { tool: name } = reply.data
    // `confirm` is Ordo's to give, never the model's: drop it rather than fail on it.
    const { confirm: _ignored, ...args } = reply.data.args
    if (toolCalls >= MAX_TOOL_CALLS) return end({ ok: false, reason: 'failed', message: STEP_CAP_MESSAGE })

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
      o.onEvent({
        type: 'tool',
        id,
        tool: name,
        label: `Opened ${ASSISTANT_PAGES[nav.data.page].title}`,
        kind: 'navigate',
        status: 'done',
      })
      o.onEvent({ type: 'navigate', page: nav.data.page, ...(nav.data.month && { month: nav.data.month }) })
      steps.push({
        tool: name,
        args: nav.data,
        // Ordo's own enum (the page) and a checked YYYY-MM: no third-party text.
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
    const data = checked.data as Record<string, unknown>

    /** Refuse the call without running anything; the model hears why and can try again. */
    const refuse = (message: string, chip: string) => {
      o.onEvent({
        type: 'tool',
        id,
        tool: tool.name,
        label: tool.label,
        kind: tool.kind,
        status: 'failed',
        summary: chip,
      })
      steps.push({
        tool: tool.name,
        args: data,
        trusted: false,
        result: { error: { code: 'usage', message } },
      })
    }

    // A file path is only accepted when the user typed it, word for word. Nothing has touched it yet.
    const unasked = (tool.localPaths ?? []).filter((key) => {
      const value = data[key]
      return typeof value === 'string' && !o.question.includes(value)
    })
    if (unasked.length) {
      refuse(
        'Ordo only opens a file whose full path is in the user’s own message. Ask the user for the path.',
        'Only files you name yourself',
      )
      continue
    }
    // Some changes must follow a dry run with the same arguments (a clean-up after its plan).
    if (
      tool.after &&
      !steps.some((s) => s.tool === tool.after && argsKey(s.args) === argsKey(data) && !isError(s.result))
    ) {
      refuse(
        `Call ${tool.after} with exactly the same arguments first, so the user can see the plan.`,
        'Needs a plan first',
      )
      continue
    }

    /** Still allowed to run this tool now? If the provider or a consent changed, the question ends. */
    const notAllowed = () => {
      const why = o.allowed?.(tool) ?? null
      return why ? end({ ok: false, reason: 'consent', message: why }) : null
    }

    let result: CommandResult
    if (tool.kind === 'change') {
      const before = notAllowed()
      if (before) return before
      const preview = await previewTool(o.services, tool, data)
      const card: ConfirmCard = {
        tool: tool.name,
        label: tool.label,
        title: cardText(preview.title),
        details: preview.details.slice(0, 50).map(cardDetail),
        notes: preview.notes.slice(0, 10).map(cardText),
        ...(preview.blocked && { blocked: cardText(preview.blocked) }),
        trigger: triggerFor(tool, data, o.question, o.history, steps),
      }
      o.onEvent({ type: 'confirm', id, card })
      // A change that can't happen ends here: its card explains why, and there's nothing to answer.
      if (preview.blocked)
        return end({
          ok: false,
          reason: 'blocked',
          message: `Nothing was changed: ${cardText(preview.blocked)}`,
        })
      let approved = await o.confirm(id, card)
      if (o.signal.aborted) approved = false
      // What's run must be what was shown: if the preview moved on (new mail, say), ask again.
      const stale = approved && !samePreview(preview, await previewTool(o.services, tool, data))
      o.onEvent({ type: 'confirmed', id, approved: approved && !stale })
      if (o.signal.aborted) return stopped()
      if (stale)
        return end({
          ok: false,
          reason: 'failed',
          message: tool.staleMessage ?? 'This changed since it was shown, so nothing was done. Ask again.',
        })
      // A no ends the turn without asking the model again, so data can't keep asking.
      if (!approved)
        return end({ ok: false, reason: 'cancelled', message: 'Cancelled. Nothing was changed.' })
      const afterConfirm = notAllowed()
      if (afterConfirm) return afterConfirm
      o.onEvent({ type: 'tool', id, tool: tool.name, label: tool.label, kind: tool.kind, status: 'running' })
      result = await runTool(o.services, tool, data, { allowChanges: true, confirm: true })
      if (result.ok) changed.push(tool.done(result.data))
    } else {
      const now = notAllowed()
      if (now) return now
      o.onEvent({ type: 'tool', id, tool: tool.name, label: tool.label, kind: tool.kind, status: 'running' })
      // Read and refresh tools never get permission to change anything.
      result = await runTool(o.services, tool, data, { allowChanges: false, confirm: false })
    }
    o.onEvent({
      type: 'tool',
      id,
      tool: tool.name,
      label: result.ok ? tool.done(result.data) : tool.label,
      kind: tool.kind,
      status: result.ok ? 'done' : 'failed',
      ...(!result.ok && { summary: clean(result.message, 160) }),
    })
    steps.push({
      tool: tool.name,
      args: data,
      // Only numbers and booleans count as Ordo's own data; any text, and every error, is untrusted.
      trusted: result.ok && isPlainData(result.data),
      result: result.ok ? result.data : { error: { code: result.code, message: result.message } },
    })
    if (o.signal.aborted) return stopped()
  }
  return end({
    ok: false,
    reason: 'failed',
    message: toolCalls >= MAX_TOOL_CALLS ? STEP_CAP_MESSAGE : NO_ANSWER_MESSAGE,
  })
}

const isError = (result: unknown) => !!result && typeof result === 'object' && 'error' in result

const samePreview = (a: ChangePreview, b: ChangePreview) =>
  argsKey({ ...a, blocked: a.blocked ?? null }) === argsKey({ ...b, blocked: b.blocked ?? null })
