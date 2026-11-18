import { ipcMain } from 'electron'
import {
  ME,
  MoneyFactInputSchema,
  accountCaveats,
  allEventCosts,
  askMoney,
  buildLedger,
  compareMonthToDate,
  counterparts,
  describeFact,
  describeFacts,
  factTransactionIds,
  factsOf,
  heldBalances,
  owedToYou,
  periodCaveats,
  proposeQuestions,
  toISODate,
  type FactSource,
  type MoneyFactData,
  type MonthComparison,
  type Transaction,
} from '@ordo/money-core'
import {
  AnswerSchema,
  AskInputSchema,
  CompareSchema,
  MEMORY_IPC,
  SaveFactSchema,
  isCloudProvider,
  moneyDetailsAllowed,
  type AskOutcome,
  type AskStep,
  type MemoryResult,
  type MemoryView,
} from '@ordo/shared'
import { aiSettings, message as aiMessage, resolveModel, usableProvider } from './ai'
import { allTransactions, ensurePerson, moneyStore, overview } from './money'
import { Locked, toRenderer, withWriteLock } from './writes'

const fail = (message: string): MemoryResult => ({ ok: false, message })
const firstIssue = (e: { issues: { message: string }[] }) => e.issues[0]?.message ?? 'Check the details.'
const locked = (l: Locked): MemoryResult => ({ ok: false, error: 'locked', message: l.message })

/** Transactions as Finances shows them, with saved facts and the ledger they give. */
async function data() {
  const s = moneyStore()
  const transactions = await allTransactions()
  const facts = s.memoryFacts()
  return {
    s,
    transactions,
    facts,
    ledger: buildLedger(transactions, facts),
    dismissed: s.dismissedQuestions(),
    today: toISODate(),
  }
}

type Data = Awaited<ReturnType<typeof data>>

const questionsFor = (d: Data) =>
  proposeQuestions({ transactions: d.transactions, ledger: d.ledger, facts: d.facts, dismissed: d.dismissed })

function compareFor(d: Data, filter: { category?: string; account?: string } = {}): MonthComparison {
  return compareMonthToDate(d.transactions, d.ledger, d.facts, {
    ...filter,
    today: d.today,
    caveats: periodCaveats(accountCaveats(d.transactions, d.facts), d.today, filter.account),
  })
}

/** Whether Ask Ordo can run, and if not, why. */
function askReadiness(): MemoryView['ask'] {
  const ai = aiSettings()
  if (ai.provider === 'none') return { ready: false, provider: null, cloud: false, reason: 'no-model' }
  const cloud = isCloudProvider(ai.provider)
  if (!usableProvider(ai) || !moneyDetailsAllowed(ai))
    return { ready: false, provider: ai.provider, cloud, reason: 'consent' }
  return { ready: true, provider: ai.provider, cloud }
}

/** Everything the Ask Ordo page shows: questions, loose ends, events, people and what Ordo knows. */
export async function view(): Promise<MemoryView> {
  const d = await data()
  const o = await overview().catch(() => null)
  const names = new Map(o?.people.map((p) => [p.id, p.name]) ?? [])
  return {
    facts: describeFacts(d.facts, d.transactions).reverse(),
    questions: questionsFor(d).map((q) => ({
      id: q.id,
      kind: q.kind,
      step: q.step,
      text: q.text,
      ...(q.detail && { detail: q.detail }),
      ...(q.confidence && { confidence: q.confidence }),
      answers: q.answers.map((a) => ({ id: a.id, label: a.label })),
    })),
    held: heldBalances(d.transactions, d.ledger, d.facts),
    owed: owedToYou(d.transactions, d.facts),
    billsOwed: (o?.debts ?? [])
      .filter((x) => x.to === ME)
      .map((x) => ({ person: names.get(x.from) ?? 'Someone', amount: x.amount })),
    events: allEventCosts(d.transactions, d.ledger, d.facts),
    people: counterparts(d.transactions, d.ledger).slice(0, 12),
    caveats: accountCaveats(d.transactions, d.facts),
    compare: compareFor(d),
    accounts: [...new Set(d.transactions.map((t) => t.accountName))].sort(),
    categories: [
      ...new Set(d.transactions.filter((t) => t.amount < 0).map((t) => t.category ?? 'Other')),
    ].sort(),
    hasTransactions: d.transactions.length > 0,
    ask: askReadiness(),
  }
}

/** Why a fact can't be saved: it names payments or an event that aren't there. Null when fine. */
function problem(fact: MoneyFactData, transactions: Transaction[], facts: { id: string; kind: string }[]) {
  const ids = new Set(transactions.map((t) => t.id))
  if (factTransactionIds(fact).some((id) => !ids.has(id)))
    return 'One of those payments is no longer imported.'
  if ('eventId' in fact && fact.eventId && !facts.some((f) => f.id === fact.eventId && f.kind === 'event'))
    return 'That event no longer exists.'
  return null
}

/** Save a fact. A flatmate also becomes a person on Bills, so splits can use them. */
function saveChecked(d: Data, fact: MoneyFactData, source: FactSource, id?: string) {
  d.s.saveMemoryFact(fact, source, id)
  if (fact.kind === 'person' && fact.role === 'flatmate') ensurePerson(fact.name)
}

export async function saveFact(raw: unknown): Promise<MemoryResult> {
  const parsed = SaveFactSchema.safeParse(raw)
  if (!parsed.success) return fail(firstIssue(parsed.error))
  const { id, fact, source } = parsed.data
  const result = await withWriteLock('saving what Ordo learned', async () => {
    const d = await data()
    if (id && !d.facts.some((f) => f.id === id)) return fail('That fact no longer exists.')
    const why = problem(fact, d.transactions, d.facts)
    if (why) return fail(why)
    saveChecked(d, fact, source, id)
    return { ok: true as const, facts: 1 }
  })
  return result instanceof Locked ? locked(result) : result
}

export async function deleteFact(raw: unknown): Promise<MemoryResult> {
  const id = typeof raw === 'string' && raw.length > 0 && raw.length <= 100 ? raw : null
  if (!id) return fail('That fact no longer exists.')
  const result = await withWriteLock('forgetting a fact', async () => {
    const s = moneyStore()
    // Paybacks for a forgotten event would point nowhere: forget them too.
    const linked = factsOf(s.memoryFacts(), 'payback').filter((p) => p.eventId === id)
    for (const p of linked) s.deleteMemoryFact(p.id)
    return s.deleteMemoryFact(id) ? { ok: true as const } : fail('That fact no longer exists.')
  })
  return result instanceof Locked ? locked(result) : result
}

/**
 * Answer a question. The question is worked out again here from your data, so the renderer can
 * only pick one of its answers, never send facts of its own. Every answer stops it coming back.
 */
export async function answer(raw: unknown): Promise<MemoryResult> {
  const parsed = AnswerSchema.safeParse(raw)
  if (!parsed.success) return fail(firstIssue(parsed.error))
  const { questionId, answerId, via } = parsed.data
  const result = await withWriteLock('saving what Ordo learned', async () => {
    const d = await data()
    const q = questionsFor(d).find((x) => x.id === questionId)
    const a = q?.answers.find((x) => x.id === answerId)
    if (!q || !a) return fail('That question has already been answered.')
    let saved = 0
    for (const f of a.facts) {
      const fact = MoneyFactInputSchema.safeParse(f)
      if (!fact.success || problem(fact.data, d.transactions, d.facts)) continue
      saveChecked(d, fact.data, via)
      saved++
    }
    if (a.addPerson) ensurePerson(a.addPerson)
    d.s.dismissQuestion(q.id)
    return { ok: true as const, facts: saved }
  })
  return result instanceof Locked ? locked(result) : result
}

export async function compare(raw: unknown): Promise<MonthComparison> {
  const filter = CompareSchema.parse(raw ?? {})
  return compareFor(await data(), filter)
}

let asking: AbortController | null = null

/**
 * Ask Ordo. Needs a model, and for a cloud one both the usual consent and the separate consent to
 * send exact amounts, dates and names. Changes nothing: suggested facts come back to be saved by you.
 */
export async function ask(raw: unknown, onStep?: (s: AskStep) => void): Promise<AskOutcome> {
  const parsed = AskInputSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, message: firstIssue(parsed.error) }
  const ai = aiSettings()
  if (ai.provider === 'none')
    return { ok: false, error: 'no-model', message: 'Choose a model in Settings → AI first.' }
  const provider = usableProvider(ai)
  if (!provider || !moneyDetailsAllowed(ai))
    return {
      ok: false,
      error: 'consent',
      message: 'Allow Ask Ordo to send amounts, dates and names to this provider in Settings → AI first.',
    }
  if (asking) return { ok: false, error: 'busy', message: 'Ordo is already answering a question.' }

  const ctrl = (asking = new AbortController())
  try {
    const d = await data()
    const r = await askMoney(
      parsed.data.question,
      provider,
      { transactions: d.transactions, facts: d.facts, today: d.today, dismissed: d.dismissed },
      {
        model: await resolveModel(ai),
        history: parsed.data.history,
        style: ai.askStyle,
        clarify: ai.askClarify,
        signal: ctrl.signal,
        timeoutMs: 180_000,
        onStep,
      },
    )
    const byId = new Map(d.transactions.map((t) => [t.id, t]))
    const events = new Map(factsOf(d.facts, 'event').map((e) => [e.id, e.name]))
    return {
      ok: true,
      answer: r.answer,
      steps: r.steps,
      proposals: r.proposals.map((p) => ({ ...p, summary: describeFact(p.fact, byId, events) })),
      ...(r.clarify && { clarify: r.clarify }),
    }
  } catch (err) {
    return { ok: false, message: aiMessage(err) }
  } finally {
    asking = null
  }
}

export function stopAsk(): void {
  asking?.abort()
}

/** Register the Ask Ordo and memory IPC handlers. Every argument is checked with zod here. */
export function registerMemoryIpc(): void {
  ipcMain.handle(MEMORY_IPC.view, () => view())
  ipcMain.handle(MEMORY_IPC.saveFact, (_e, input: unknown) => saveFact(input))
  ipcMain.handle(MEMORY_IPC.deleteFact, (_e, id: unknown) => deleteFact(id))
  ipcMain.handle(MEMORY_IPC.answer, (_e, input: unknown) => answer(input))
  ipcMain.handle(MEMORY_IPC.compare, (_e, input: unknown) => compare(input))
  ipcMain.handle(MEMORY_IPC.ask, (e, input: unknown) => ask(input, toRenderer(e.sender, MEMORY_IPC.askStep)))
  ipcMain.handle(MEMORY_IPC.askStop, () => stopAsk())
}
