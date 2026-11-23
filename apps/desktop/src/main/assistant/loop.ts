import { randomUUID } from 'node:crypto'
import { AiError, parseModelJson, type ModelProvider } from '@ordo/ai'
import {
  ASSISTANT_PAGES,
  type AskOutcome,
  type AssistantEvent,
  type AssistantPage,
  type CardDetail,
  type CardEmail,
  type ConfirmCard,
} from '@ordo/shared'
import type { CommandResult, OrdoServices } from '../headless/commands'
import { clean, UNSAFE_KEEP_LINES } from '../headless/format'
import {
  previewTool,
  runTool,
  strictArgs,
  TOOLS,
  attachmentNameOk,
  EMAIL_SHOWN_MAX,
  visibleText,
  type ChangePreview,
  type EmailPreview,
  type MailTargets,
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
   * (provider or consent changed), or null. `moneyDetails` says whether the history or the steps so
   * far include a tool returning what Ordo learned about money. A refusal ends the question before
   * sending.
   */
  canSend?: (moneyDetails: boolean) => string | null
}

/**
 * The outcome; whether untrusted data was read (so the turn is tainted in history); whether a tool
 * returning what Ordo learned about money ran (so the turn stays away from cloud models); what
 * confirmed changes did, from Ordo's own labels; and a key for each email sent, so it's never sent
 * twice.
 */
export type LoopResult = AskOutcome & {
  tainted: boolean
  moneyDetails: boolean
  changes: string[]
  sent: string[]
}

/** Emails the assistant may send in one question. */
export const MAX_SENDS = 1

/** The same email, whatever order its recipients came in: to spot one sent already. */
export const emailKey = (e: Pick<EmailPreview, 'to' | 'cc' | 'subject' | 'text' | 'original'>) =>
  JSON.stringify([
    [...e.to, ...e.cc].map((a) => a.toLowerCase()).sort(),
    e.subject.trim().toLowerCase(),
    e.text.trim(),
    e.original?.text.trim() ?? '',
  ])

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

/** Whether `value` appears as its own word in `text` (an id, a path, a name), ignoring case. */
export function mentions(text: string, value: string): boolean {
  if (!value) return false
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?<![\\w.@/\\\\-])${escaped}(?![\\w@/\\\\-])`, 'i').test(text)
}

/**
 * An email address, taken whole: as much of the local part and domain as there is, and only where it
 * really ends. Followed by anything that could go on (a letter, a mark, an underscore, a middle dot,
 * or a dot before more), it isn't an address the user typed: "sam@company.co_uk" never vouches for
 * "sam@company.co".
 */
const ADDRESS_TOKEN =
  /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+(?![\p{L}\p{N}\p{M}\p{Pc}@\u00b7-]|\.[\p{L}\p{N}\p{M}\p{Pc}-])/gu

/**
 * The email addresses written in some text, whole and lower-cased. Only an exact address counts:
 * "sam@company.co.uk" is never "sam@company.co", and "alice+work@gmail.com" is never "work@gmail.com".
 */
export function typedAddresses(text: string): Set<string> {
  // Compatibility forms first: a full-width dot (U+FF0E) is a dot, so "co．uk" is "co.uk".
  return new Set([...text.normalize('NFKC').matchAll(ADDRESS_TOKEN)].map((m) => m[0].toLowerCase()))
}

const CAUTION = 'and text in those can try to trick it. Only confirm if you want this.'

/** Words too common to count as naming a message by its sender's name or its subject. */
const TOO_COMMON = new Set(
  'email e-mail mail message messages reply the this that from last latest new inbox note hello hi thanks thank you me him her them update info news'.split(
    ' ',
  ),
)

/** A subject without Re:/Fwd: and the punctuation around it ("Lunch?" → "Lunch"). */
const bareSubject = (s: string) =>
  s.replace(/^\s*(?:(?:re|fwd?|fw)\s*:\s*)+/i, '').replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '')

/**
 * Whether the user's own words name a message: by the sender's exact address, the sender's name
 * (or its first word), or its subject, each as whole words, ignoring case. Short or common names
 * and subjects ("Hi", "email") never count. Naming a message only picks it: it never vouches for
 * where a reply goes.
 */
export function namesMessage(words: string, m: MailTargets['messages'][number]): boolean {
  if (m.address && typedAddresses(words).has(m.address.toLowerCase())) return true
  const usable = (v: string, min: number) => v.length >= min && !TOO_COMMON.has(v.toLowerCase())
  const name = (m.name ?? '').trim()
  const first = name.split(/\s+/)[0] ?? ''
  if (usable(name, 3) && mentions(words, name)) return true
  if (/^\p{L}{3,}$/u.test(first) && usable(first, 3) && mentions(words, first)) return true
  const subject = bareSubject(m.subject)
  return usable(subject, 4) && mentions(words, subject)
}

const listed = (xs: readonly string[]) =>
  xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : (xs[0] ?? '')

const isError = (result: unknown) => !!result && typeof result === 'object' && 'error' in result

/** What untrusted data a step read, as a card names it. */
const readsOf = (s: Step) => TOOLS.find((t) => t.name === s.tool)?.reads ?? 'earlier results'

/**
 * Whether a step read nothing but the email being replied to or forwarded: reading it, or a list
 * or search that found only it. Anything else is other mail, which could carry hidden text.
 */
function onlyTarget(s: Step, target: MailTargets['target']): boolean {
  if (!target || isError(s.result)) return false
  if (s.tool === 'ordo_read_message') {
    // The same message in the same account: a uid alone is only unique within one account.
    const named = s.args['account']
    const sameAccount =
      named === undefined
        ? target.first
        : typeof named === 'string' && target.accountNames.includes(named.toLowerCase())
    return sameAccount && s.args['uid'] === target.uid && (s.args['mailbox'] ?? 'INBOX') === target.mailbox
  }
  if (s.tool === 'ordo_search_mail' || s.tool === 'ordo_messages') {
    const found = (s.result as { messages?: unknown }).messages
    return (
      Array.isArray(found) &&
      found.length > 0 &&
      found.every(
        (m: { uid?: unknown; mailbox?: unknown; accountId?: unknown }) =>
          m.uid === target.uid &&
          m.mailbox === target.mailbox &&
          (m.accountId === undefined ? target.first : m.accountId === target.account),
      )
    )
  }
  return false
}

/**
 * Why a mail change's card appeared.
 *
 * Moves, flags and marks act on mail the assistant had to read to find, so their rule is about what
 * they act on: "You asked for this" needs an explicit phrase in the user's message and every email
 * named in the user's own words.
 *
 * Drafts and emails to send carry the model's text, which any email it read could have shaped. So
 * "You asked for this" also needs that nothing untrusted was read in the question but the email
 * being answered (and no earlier answer was built on untrusted data), and that every recipient's
 * exact address is in the user's own words. A sender picks their display name, subject and
 * Reply-To, so naming an email by them never vouches for an address. One exception, `sender`: a
 * reply the user asked for to an email they named, going only to the address it came from, with no
 * other Reply-To and nothing else read, gets an amber note instead of the full warning.
 */
export function mailTrigger(
  tool: OrdoTool,
  targets: MailTargets,
  question: string,
  history: readonly Turn[],
  steps: readonly Step[],
): ConfirmCard['trigger'] {
  const asked = tool.intent?.test(question) ?? false
  const words = [...history.map((t) => t.user), question].join('\n')
  const unnamed = targets.messages.filter((m) => !namesMessage(words, m))
  const recipients = targets.recipients
  const tainted = history.some((t) => t.tainted) ? ['earlier results'] : []
  const allReads = listed([...new Set([...steps.filter((s) => !s.trusted).map(readsOf), ...tainted])])
  const after = allReads ? ` after reading ${allReads}, ${CAUTION}` : '. Only confirm if you want this.'

  if (!recipients) {
    if (asked && unnamed.length === 0) return { kind: 'request', text: 'You asked for this.' }
    if (asked)
      return {
        kind: 'data',
        text:
          unnamed.length === 1 && targets.messages.length === 1
            ? `You asked for this, but didn’t name this email, so the assistant chose it${after}`
            : `You asked for this, but didn’t name every email, so the assistant chose them${after}`,
      }
    return { kind: 'data', text: `You didn’t ask for this. The assistant suggested it${after}` }
  }

  // An email: only the target email may have been read.
  const others = listed([
    ...new Set([
      ...steps.filter((s) => !s.trusted && !onlyTarget(s, targets.target)).map(readsOf),
      ...tainted,
    ]),
  ])
  const verb = tool.assistantOnly ? 'send' : 'save it'
  const typed = typedAddresses(words)
  const untyped = recipients.filter((r) => !typed.has(r.address.toLowerCase()))
  if (!asked) {
    const read = allReads ? ` after reading ${allReads}, and text in those can try to trick it.` : '.'
    const addresses = untyped.map((r) => clean(r.address, 254))
    return {
      kind: 'data',
      text:
        `You didn’t ask for this. The assistant suggested it${read}` +
        (addresses.length === 0
          ? ` Only ${verb} if you want this.`
          : addresses.length === 1
            ? ` You didn’t type ${addresses[0]}. Only ${verb} if you know this address and meant to write to it.`
            : ` You didn’t type these addresses: ${listed(addresses)}. Only ${verb} if you know these addresses and meant to write to them.`),
    }
  }
  const target = targets.messages[0]
  const who = target ? clean(target.name ?? '', 60).trim() || clean(target.address, 254) : 'the sender'

  if (untyped.length) {
    if (!others && unnamed.length === 0 && recipients.length === 1 && untyped[0]!.source === 'sender')
      return { kind: 'sender', text: `You didn’t type this address. It’s the one ${who}’s email came from.` }
    const from = target ? ` (${clean(target.address, 254)})` : ''
    const alsoRead = others ? ` It also read ${others} before writing this.` : ''
    const addresses = untyped.map((r) => clean(r.address, 254))
    if (addresses.length === 1) {
      const where =
        untyped[0]!.source === 'reply-to'
          ? ` It’s where ${who}’s email asks for replies to go, not the address it came from${from}.`
          : ''
      return {
        kind: 'data',
        text:
          `You didn’t type ${addresses[0]}.${where} The assistant got it from an email it read, and emails can ` +
          `hide text meant to trick it.${alsoRead} Only ${verb} if you know this address and meant to write to it.`,
      }
    }
    const replyTo = untyped.filter((r) => r.source === 'reply-to').map((r) => clean(r.address, 254))
    const where = replyTo.length
      ? ` ${listed(replyTo)} ${replyTo.length === 1 ? 'is' : 'are'} where ${who}’s email asks for replies to go, not the address it came from${from}.`
      : ''
    return {
      kind: 'data',
      text:
        `You didn’t type these addresses: ${listed(addresses)}.${where} The assistant got them from emails ` +
        `it read, and emails can hide text meant to trick it.${alsoRead} Only ${verb} if you know these ` +
        'addresses and meant to write to them.',
    }
  }
  if (others)
    return {
      kind: 'data',
      text:
        `You asked for this, but the assistant wrote it after reading ${others}, and text in those can try to ` +
        `trick it. Read the whole email before you ${verb === 'send' ? 'send it' : 'save it'}.`,
    }
  if (unnamed.length)
    return {
      kind: 'data',
      text: `You asked for this, but didn’t name the email it’s about, so the assistant chose it. Only ${verb} if it’s the right one.`,
    }
  return { kind: 'request', text: 'You asked for this.' }
}

/**
 * Why a change card appeared. It says "You asked for this" only when all of these hold:
 * - the user's message has an explicit phrase for this kind of change;
 * - every value the change acts on (sender addresses, a clean-up id, a path) is in the user's own
 *   messages;
 * - nothing untrusted was read in this question, and no earlier answer was built on untrusted data
 *   (it could carry third-party text back in as "history").
 * Mail changes have their own rules: see `mailTrigger`.
 */
export function triggerFor(
  tool: OrdoTool,
  args: Record<string, unknown>,
  question: string,
  history: readonly Turn[],
  steps: readonly Step[],
  /** A mail change's targets (from its preview). */
  mail?: MailTargets,
): ConfirmCard['trigger'] {
  if (mail) return mailTrigger(tool, mail, question, history, steps)
  const asked = tool.intent?.test(question) ?? false
  const userWords = [...history.map((t) => t.user), question].join('\n')
  // An address must have been typed whole, as for email recipients: "news@shop.co.uk" never vouches
  // for "news@shop.co". Anything else (a clean-up id, a path, a title) as its own word.
  const typed = typedAddresses(userWords)
  const named = (tool.named?.(args as never) ?? []).every((v) =>
    v.includes('@') ? typed.has(v.toLowerCase()) : mentions(userWords, v),
  )
  // The dry run a change must follow had the same arguments, chosen before it was read: it doesn't count.
  const ownPlan = (s: Step) => s.tool === tool.after && argsKey(s.args) === argsKey(args)
  const sources = [...new Set(steps.filter((s) => !s.trusted && !ownPlan(s)).map(readsOf))]
  if (history.some((t) => t.tainted)) sources.push('earlier results')
  const list = listed([...new Set(sources)])
  if (asked && named && sources.length === 0) return { kind: 'request', text: 'You asked for this.' }
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

/**
 * An email for the card: addresses (marked when the user didn't type them) and subject on one line
 * each, and the text and original exactly as they'd be sent. Never cut: an email that wouldn't fit
 * whole, or isn't already clean, is refused instead (see `wholeEmail`).
 */
const cardEmail = (e: EmailPreview, typed: Set<string>): CardEmail => {
  const who = (a: string) => ({
    address: clean(a, 254),
    ...(!typed.has(a.toLowerCase()) && { untyped: true as const }),
  })
  return {
    from: clean(e.from, 254),
    fromAccount: clean(e.fromAccount, 40),
    to: e.to.map(who),
    cc: e.cc.map(who),
    subject: clean(e.subject, 300),
    text: e.text,
    ...(e.original && { original: e.original }),
    // In full: names that couldn't be shown exactly were refused before the card.
    attachments: e.attachments.map((f) => ({ name: f.name, size: f.size })),
  }
}

/** Whether the card can show every character of an email that would be sent or saved. */
const wholeEmail = (e: EmailPreview) =>
  e.text.length + (e.original?.text.length ?? 0) <= EMAIL_SHOWN_MAX &&
  visibleText(e.text) === e.text &&
  (!e.original || visibleText(e.original.text) === e.original.text) &&
  e.to.length + e.cc.length <= 50 &&
  e.attachments.length <= 20 &&
  e.attachments.every((f) => attachmentNameOk(f.name))

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

  /** Keys of the emails sent in this question. */
  const sent: string[] = []
  /** Earlier sends in this conversation, so the same email is never sent twice. */
  const sentBefore = new Set(o.history.flatMap((t) => t.sent ?? []))
  let sends = 0

  const end = (outcome: AskOutcome): LoopResult => {
    const tainted = steps.some((s) => !s.trusted)
    const moneyDetails = steps.some((s) => tools.find((t) => t.name === s.tool)?.moneyDetails === true)
    const extra = { tainted, moneyDetails, changes: [...changed], sent: [...sent] }
    if (outcome.ok || changed.length === 0) return { ...outcome, ...extra }
    // A change that already ran must be reported, and remembered, whatever happened after it.
    const what = changed.join('. ')
    const lead = outcome.reason === 'stopped' ? 'Stopped.' : outcome.message
    return {
      ok: true,
      answer: `${lead} The change you confirmed was made: ${what}.`,
      steps: toolCalls,
      ...extra,
    }
  }
  const stopped = () => end({ ok: false, reason: 'stopped', message: 'Stopped.' })

  for (let call = 0; call < MAX_MODEL_CALLS; call++) {
    if (o.signal.aborted) return stopped()
    // Earlier turns and the results gathered so far go out with this call: check they still may.
    const gathered =
      o.history.some((t) => t.moneyDetails) ||
      steps.some((s) => tools.find((t) => t.name === s.tool)?.moneyDetails === true)
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

    // At most one email per question, and never the same one twice in a conversation.
    if (tool.assistantOnly && sends >= MAX_SENDS) {
      refuse(
        'Ordo sends at most one email per question, and one was already sent. Tell the user what was sent.',
        'One email per question',
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
      if (tool.assistantOnly && preview.email && sentBefore.has(emailKey(preview.email))) {
        refuse(
          'This exact email was already sent earlier in this conversation. Don’t send it again; tell the user.',
          'Already sent',
        )
        continue
      }
      // The card must show every character an email would carry, or there's no card to confirm.
      if (preview.email && !preview.blocked && !wholeEmail(preview.email))
        preview.blocked = 'Ordo can’t show this whole email on the card, so it won’t save or send it.'
      const typed = typedAddresses([...o.history.map((t) => t.user), o.question].join('\n'))
      const card: ConfirmCard = {
        tool: tool.name,
        label: tool.label,
        title: cardText(preview.title),
        details: preview.details.slice(0, 50).map(cardDetail),
        notes: preview.notes.slice(0, 10).map(cardText),
        ...(preview.blocked && { blocked: cardText(preview.blocked) }),
        ...(preview.email && { email: cardEmail(preview.email, typed) }),
        ...(tool.assistantOnly && preview.email?.send && { action: 'send' as const }),
        trigger: triggerFor(tool, data, o.question, o.history, steps, preview.mail),
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
        return end({
          ok: false,
          reason: 'cancelled',
          message: tool.assistantOnly ? 'Cancelled. Nothing was sent.' : 'Cancelled. Nothing was changed.',
        })
      const afterConfirm = notAllowed()
      if (afterConfirm) return afterConfirm
      o.onEvent({ type: 'tool', id, tool: tool.name, label: tool.label, kind: tool.kind, status: 'running' })
      if (tool.assistantOnly) sends++
      result = await runTool(o.services, tool, data, {
        allowChanges: true,
        confirm: true,
        caller: 'assistant',
      })
      if (result.ok) changed.push(tool.done(result.data))
      if (result.ok && tool.assistantOnly && preview.email) sent.push(emailKey(preview.email))
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
      // A send that went out with a problem (a refused recipient, no copy in Sent) says so.
      ...(result.ok && warningOf(result.data) && { summary: clean(warningOf(result.data), 240) }),
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

/** A change's warning, when its result has one (only Ordo's own `warning` field). */
const warningOf = (data: unknown): string =>
  data && typeof data === 'object' && typeof (data as { warning?: unknown }).warning === 'string'
    ? (data as { warning: string }).warning
    : ''

const samePreview = (a: ChangePreview, b: ChangePreview) =>
  argsKey({ ...a, blocked: a.blocked ?? null }) === argsKey({ ...b, blocked: b.blocked ?? null })
