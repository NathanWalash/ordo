import { describe, expect, it } from 'vitest'
import { ASSISTANT_PAGE_IDS, type ConfirmCard } from '@ordo/shared'
import { ROUTES } from '../../routes'
import {
  applyEvent,
  elapsed,
  finish,
  groupTrace,
  workedFor,
  type Item,
  type ReplyItem,
  type TraceEntry,
} from './conversation'
import { suggestionsFor } from './suggestions'

const card: ConfirmCard = {
  tool: 'ordo_undo',
  label: 'Undoing a clean-up',
  title: 'Move 3 emails back to the inbox',
  details: [],
  notes: [],
  trigger: { kind: 'request', text: 'You asked: “undo”' },
}

const start = (): Item[] => [
  { kind: 'user', id: 1, text: 'Undo it' },
  { kind: 'reply', id: 2, trace: [], status: 'Thinking', startedAt: 0 },
]
const reply = (items: Item[]) => items.at(-1) as ReplyItem

describe('the conversation', () => {
  it('tracks a tool from running to done in place', () => {
    let items = start()
    items = applyEvent(items, {
      type: 'tool',
      id: 'a',
      tool: 'ordo_bills',
      label: 'Reading your bills',
      kind: 'read',
      status: 'running',
    })
    expect(reply(items).status).toBe('Reading your bills')
    items = applyEvent(items, {
      type: 'tool',
      id: 'a',
      tool: 'ordo_bills',
      label: 'Reading your bills',
      kind: 'read',
      status: 'done',
      summary: '2 bills',
    })
    expect(reply(items).trace).toEqual([
      expect.objectContaining({ kind: 'tool', id: 'a', status: 'done', summary: '2 bills' }),
    ])
  })

  it('opens a card, marks it answered, and cancels any card left open at the end', () => {
    let items = applyEvent(start(), { type: 'confirm', id: 'c1', card })
    expect(reply(items).status).toBe('Waiting for you')
    items = applyEvent(items, { type: 'confirmed', id: 'c1', approved: true })
    expect(reply(items).trace[0]).toMatchObject({ state: 'approved' })

    let open = applyEvent(start(), { type: 'confirm', id: 'c2', card })
    open = finish(open, { ok: false, reason: 'stopped', message: 'Stopped.' }, 5000)
    expect(reply(open)).toMatchObject({
      status: null,
      endedAt: 5000,
      error: { reason: 'stopped', message: 'Stopped.' },
      trace: [expect.objectContaining({ state: 'cancelled' })],
    })
  })

  it('ignores events once the reply has finished', () => {
    const done = finish(start(), { ok: true, answer: 'Done.', steps: 0 }, 10)
    expect(applyEvent(done, { type: 'thinking', step: 2 })).toBe(done)
  })

  it('keeps cards in order, between rows of tool chips', () => {
    const t = (id: string): TraceEntry => ({
      kind: 'tool',
      id,
      tool: 'ordo_bills',
      label: 'Reading your bills',
      toolKind: 'read',
      status: 'done',
    })
    const c: TraceEntry = { kind: 'card', id: 'c', card, state: 'approved' }
    const groups = groupTrace([t('a'), t('b'), c, t('d')])
    expect(groups.map((g) => (g.kind === 'tools' ? g.entries.map((e) => e.id).join('+') : g.id))).toEqual([
      'a+b',
      'c',
      'd',
    ])
  })

  it('says how long it worked, only when there is something to say', () => {
    expect(workedFor(300, 0)).toBeNull()
    expect(workedFor(300, 1)).toBe('1 step')
    expect(workedFor(4200, 2)).toBe('Worked for 4 s · 2 steps')
  })

  it('says how long it worked', () => {
    expect(elapsed(4200)).toBe('4 s')
    expect(elapsed(65_000)).toBe('1 min 5 s')
    expect(elapsed(120_000)).toBe('2 min')
  })
})

describe('suggestions and pages', () => {
  it('suggests prompts for every page', () => {
    for (const r of ROUTES) expect(suggestionsFor(r).length).toBeGreaterThan(1)
    expect(suggestionsFor('money/bills')[0]!.text).toBe('Which bills are due next?')
  })

  it('only lets the assistant open real routes', () => {
    for (const p of ASSISTANT_PAGE_IDS) expect(ROUTES).toContain(p)
  })
})
