// Short questions with one-tap answers, worked out by Ordo (no model needed). Each answer turns
// into saved facts, so Ordo stops guessing. Questions are rebuilt from the data every time and
// identified by what they're about, so an answered or dismissed one never comes back.

import { formatPence } from './amount'
import { allEventCosts } from './events'
import type { Ledger } from './ledger'
import { counterparts, onwardFor, regularRuns } from './loose-ends'
import { counterpartName, factsOf, shortDate, type MoneyFact, type MoneyFactInput } from './memory'
import { merchantKey } from './merchant'
import { candidateKey, findMatches, type MatchCandidate, type MatchConfidence } from './paybacks'
import type { Transaction } from './types'

export type QuestionKind = 'person' | 'regular-in' | 'pass-through' | 'payback'
/** The onboarding step a question belongs to. */
export type QuestionStep = 'people' | 'regular' | 'matches'

export interface QuestionAnswer {
  id: string
  label: string
  /** Facts saved when this answer is chosen. Empty means "don't ask again". */
  facts: MoneyFactInput[]
  /** Also add this person to Bills, so splits can use them. */
  addPerson?: string
}

export interface MoneyQuestion {
  /** Stable: the same evidence always gives the same id. */
  id: string
  kind: QuestionKind
  step: QuestionStep
  /** Ordo's own sentence. Names in it come from statements. */
  text: string
  detail?: string
  confidence?: MatchConfidence
  transactionIds: string[]
  answers: QuestionAnswer[]
}

const INCOME_WORDS = /\b(salary|payroll|wages|pension|hmrc|dwp|interest|cashback|dividend|refund)\b/i

/** Everyone Ordo already knows about, as keys, so it doesn't ask about them again. */
function knownKeys(facts: readonly MoneyFact[]): string[] {
  return [
    ...factsOf(facts, 'person').flatMap((p) => [p.name, ...p.aliases]),
    ...factsOf(facts, 'income').map((f) => f.from),
    ...factsOf(facts, 'held').flatMap((f) => [f.from, f.forPerson]),
  ]
    .map(merchantKey)
    .filter((k) => k.length >= 3)
}

const knownBy = (keys: string[], key: string) => keys.some((k) => key === k || key.startsWith(k))

const later: QuestionAnswer = { id: 'later', label: 'Not now', facts: [] }

function matchQuestion(
  c: MatchCandidate,
  byId: Map<string, Transaction>,
  eventFor: (outIds: string[]) => string | undefined,
): MoneyQuestion | null {
  const inn = byId.get(c.inId)
  const outs = c.outIds.map((id) => byId.get(id)).filter((t): t is Transaction => !!t)
  if (!inn || outs.length !== c.outIds.length) return null
  const who = counterpartName(inn)
  const got = `${who}'s ${formatPence(inn.amount)} on ${shortDate(inn.date)}`
  if (c.kind === 'pass-through') {
    const o = outs[0]!
    return {
      id: candidateKey(c),
      kind: 'pass-through',
      step: 'matches',
      text: `${got} ${c.reason}. Was it just passing through?`,
      detail: 'Then it counts as neither income nor spending.',
      confidence: c.confidence,
      transactionIds: [inn.id, o.id],
      answers: [
        {
          id: 'yes',
          label: 'Yes, passing through',
          facts: [{ kind: 'pass-through', inId: inn.id, outId: o.id }],
        },
        { id: 'no', label: 'No', facts: [] },
      ],
    }
  }
  const eventId = eventFor(c.outIds)
  return {
    id: candidateKey(c),
    kind: 'payback',
    step: 'matches',
    text: `Was ${got} paying you back? It's ${c.reason}.`,
    confidence: c.confidence,
    transactionIds: [inn.id, ...c.outIds],
    answers: [
      {
        id: 'yes',
        label: 'Yes, a payback',
        facts: [
          {
            kind: 'payback',
            inId: inn.id,
            outIds: c.outIds,
            person: who.slice(0, 60),
            ...(eventId && { eventId }),
          },
        ],
      },
      { id: 'no', label: 'No', facts: [] },
    ],
  }
}

/**
 * Questions worth asking, most useful first: who people are, what regular money in is, then
 * pass-throughs and paybacks by how sure Ordo is. `dismissed` holds ids answered "no" or "not now".
 */
export function proposeQuestions(input: {
  transactions: readonly Transaction[]
  ledger: Ledger
  facts: readonly MoneyFact[]
  dismissed: ReadonlySet<string>
  limit?: number
}): MoneyQuestion[] {
  const { transactions, ledger, facts, dismissed } = input
  const byId = new Map(transactions.map((t) => [t.id, t]))
  const known = knownKeys(facts)
  const questions: MoneyQuestion[] = []
  const add = (q: MoneyQuestion | null) => {
    if (q && !dismissed.has(q.id) && !questions.some((x) => x.id === q.id)) questions.push(q)
  }

  // Regular money in: rent shares, pocket money, salary.
  const ins = regularRuns(transactions, ledger, 'in').filter(
    (r) =>
      !knownBy(known, r.key) &&
      !r.transactionIds.some((id) => INCOME_WORDS.test(byId.get(id)?.description ?? '')),
  )
  const outRuns = regularRuns(transactions, ledger, 'out')
  const regularIds = new Set(ins.flatMap((r) => r.transactionIds))
  for (const r of ins) {
    const onward = onwardFor(r, outRuns)
    const each = `about ${formatPence(r.amount)} a month`
    add(
      onward
        ? {
            id: `regular-in:${r.key}>${onward.key}`,
            kind: 'regular-in',
            step: 'regular',
            text: `${r.name} pays you ${each}, and you pay ${onward.name} about ${formatPence(onward.amount)} a month. Is ${r.name}'s money for ${onward.name}?`,
            detail: 'Money you pass on isn’t your income. Ordo keeps track of what you’re still holding.',
            transactionIds: r.transactionIds,
            answers: [
              {
                id: 'pass-on',
                label: 'Yes, I pass it on',
                facts: [
                  { kind: 'held', from: r.name.slice(0, 60), forPerson: onward.name.slice(0, 60), what: '' },
                ],
              },
              {
                id: 'income',
                label: 'No, it’s mine',
                facts: [{ kind: 'income', from: r.name.slice(0, 60) }],
              },
              later,
            ],
          }
        : {
            id: `regular-in:${r.key}`,
            kind: 'regular-in',
            step: 'regular',
            text: `${r.name} pays you ${each}. What is it?`,
            transactionIds: r.transactionIds,
            answers: [
              {
                id: 'share',
                label: 'Their share of a bill',
                facts: [{ kind: 'person', name: r.name.slice(0, 60), role: 'flatmate', aliases: [] }],
                addPerson: r.name.slice(0, 40),
              },
              { id: 'income', label: 'My income', facts: [{ kind: 'income', from: r.name.slice(0, 60) }] },
              later,
            ],
          },
    )
  }

  // People you pay back and forth with.
  for (const c of counterparts(transactions, ledger)) {
    if (knownBy(known, c.key)) continue
    if (ins.some((r) => r.key === c.key)) continue
    const name = c.name.slice(0, 60)
    const person = (role: 'flatmate' | 'friend' | 'family'): MoneyFactInput[] => [
      { kind: 'person', name, role, aliases: [] },
    ]
    add({
      id: `person:${c.key}`,
      kind: 'person',
      step: 'people',
      text:
        c.sent && c.received
          ? `You and ${c.name} have paid each other ${c.payments} times. Who is ${c.name}?`
          : `${c.name} has paid you ${c.payments} times. Who is ${c.name}?`,
      detail: `You sent ${formatPence(c.sent)} and got ${formatPence(c.received)} back.`,
      transactionIds: [],
      answers: [
        { id: 'flatmate', label: 'Flatmate', facts: person('flatmate'), addPerson: name.slice(0, 40) },
        { id: 'friend', label: 'Friend', facts: person('friend') },
        { id: 'family', label: 'Family', facts: person('family') },
        { id: 'not-person', label: 'Not a person', facts: [] },
      ],
    })
  }

  // Paybacks and pass-throughs, sure ones first.
  const events = allEventCosts(transactions, ledger, facts)
  const eventFor = (outIds: string[]) =>
    events.find((e) => outIds.every((id) => e.outgoings.some((o) => o.id === id)))?.id
  const matches = findMatches(transactions, ledger, facts, { rejected: dismissed }).filter(
    (c) => !regularIds.has(c.inId),
  )
  for (const c of matches) add(matchQuestion(c, byId, eventFor))

  const order: Record<QuestionStep, number> = { people: 0, regular: 1, matches: 2 }
  return questions
    .map((q, i) => ({ q, i }))
    .sort((a, b) => order[a.q.step] - order[b.q.step] || a.i - b.i)
    .map(({ q }) => q)
    .slice(0, input.limit ?? 30)
}
