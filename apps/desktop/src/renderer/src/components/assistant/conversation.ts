import type { AskOutcome, AssistantEvent, AssistantToolKind, ConfirmCard } from '@ordo/shared'

/** One tool call or one confirmation card, in the order they happened. */
export type TraceEntry =
  | {
      kind: 'tool'
      id: string
      tool: string
      label: string
      toolKind: AssistantToolKind
      status: 'running' | 'done' | 'failed'
      summary?: string
    }
  | {
      kind: 'card'
      id: string
      card: ConfirmCard
      /** `blocked`: the change can't happen; the card only explains why. */
      state: 'open' | 'approved' | 'cancelled' | 'blocked'
    }

export interface UserItem {
  kind: 'user'
  id: number
  text: string
}

export interface ReplyItem {
  kind: 'reply'
  id: number
  /** The question it answers, for Try again. */
  question: string
  trace: TraceEntry[]
  /** What it's doing now, while it works. */
  status: string | null
  answer?: string
  error?: { reason: Exclude<AskOutcome, { ok: true }>['reason']; message: string }
  startedAt: number
  endedAt?: number
}

export type Item = UserItem | ReplyItem

export const WAITING = 'Waiting for your answer'

const lastReply = (items: Item[]): ReplyItem | undefined => {
  const last = items.at(-1)
  return last?.kind === 'reply' ? last : undefined
}

const replaceLast = (items: Item[], next: ReplyItem): Item[] => [...items.slice(0, -1), next]

/** Apply one event from the main process to the reply being written. */
export function applyEvent(items: Item[], e: AssistantEvent): Item[] {
  const reply = lastReply(items)
  if (!reply || reply.endedAt) return items
  switch (e.type) {
    case 'thinking':
      return replaceLast(items, { ...reply, status: 'Thinking' })
    case 'tool': {
      const entry: TraceEntry = {
        kind: 'tool',
        id: e.id,
        tool: e.tool,
        label: e.label,
        toolKind: e.kind,
        status: e.status,
        ...(e.summary !== undefined && { summary: e.summary }),
      }
      const at = reply.trace.findIndex((t) => t.kind === 'tool' && t.id === e.id)
      const trace = at === -1 ? [...reply.trace, entry] : reply.trace.map((t, i) => (i === at ? entry : t))
      return replaceLast(items, { ...reply, trace, status: e.status === 'running' ? e.label : reply.status })
    }
    case 'confirm':
      return replaceLast(items, {
        ...reply,
        trace: [
          ...reply.trace,
          { kind: 'card', id: e.id, card: e.card, state: e.card.blocked ? 'blocked' : 'open' },
        ],
        status: e.card.blocked ? reply.status : WAITING,
      })
    case 'confirmed':
      return replaceLast(items, {
        ...reply,
        trace: reply.trace.map((t) =>
          t.kind === 'card' && t.id === e.id ? { ...t, state: e.approved ? 'approved' : 'cancelled' } : t,
        ),
        status: e.approved ? 'Working' : reply.status,
      })
    case 'navigate':
      return items
  }
}

/** Finish the reply with the outcome of `ask`. Cards still open count as cancelled. */
export function finish(items: Item[], outcome: AskOutcome, now: number): Item[] {
  const reply = lastReply(items)
  if (!reply) return items
  const trace = reply.trace.map((t) =>
    t.kind === 'card' && t.state === 'open' ? { ...t, state: 'cancelled' as const } : t,
  )
  return replaceLast(items, {
    ...reply,
    trace,
    status: null,
    endedAt: now,
    ...(outcome.ok
      ? { answer: outcome.answer }
      : { error: { reason: outcome.reason, message: outcome.message } }),
  })
}

/** Whether a card is waiting for the user. */
export const cardOpen = (items: readonly Item[]) =>
  items.some((i) => i.kind === 'reply' && i.trace.some((t) => t.kind === 'card' && t.state === 'open'))

/** "4 s", "1 min 5 s". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`
}

export type TraceGroup =
  | { kind: 'tools'; key: string; entries: Extract<TraceEntry, { kind: 'tool' }>[] }
  | Extract<TraceEntry, { kind: 'card' }>

/** The trace in order, with runs of tool calls gathered into one row of chips. */
export function groupTrace(trace: readonly TraceEntry[]): TraceGroup[] {
  const groups: TraceGroup[] = []
  for (const t of trace) {
    const last = groups.at(-1)
    if (t.kind === 'card') groups.push(t)
    else if (last?.kind === 'tools') last.entries.push(t)
    else groups.push({ kind: 'tools', key: t.id, entries: [t] })
  }
  return groups
}

/** The footer under a finished reply: only for a good answer that took a while. */
export function workedFor(item: Pick<ReplyItem, 'answer' | 'startedAt' | 'endedAt'>): string | null {
  if (!item.answer || item.endedAt === undefined) return null
  const ms = item.endedAt - item.startedAt
  return ms >= 3000 ? `Worked for ${elapsed(ms)}` : null
}

export type AnswerBlock = { kind: 'p'; text: string } | { kind: 'list'; items: string[] }

/** An answer as paragraphs and bulleted lists ("- " lines). */
export function answerBlocks(text: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = []
  for (const line of text.split('\n')) {
    const bullet = /^\s*[-•*]\s+(.*)$/.exec(line)
    const last = blocks.at(-1)
    if (bullet) {
      if (last?.kind === 'list') last.items.push(bullet[1]!)
      else blocks.push({ kind: 'list', items: [bullet[1]!] })
    } else if (!line.trim()) {
      if (last) blocks.push({ kind: 'p', text: '' })
    } else if (last?.kind === 'p' && last.text) last.text += `\n${line}`
    else blocks.push({ kind: 'p', text: line })
  }
  return blocks.filter((b) => b.kind === 'list' || b.text)
}
