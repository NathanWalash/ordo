import { describe, expect, it } from 'vitest'
import { ASSISTANT_PAGE_IDS, type ConfirmCard } from '@ordo/shared'
import { ROUTES } from '../../routes'
import {
  answerBlocks,
  applyEvent,
  cardOpen,
  elapsed,
  finish,
  groupTrace,
  WAITING,
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
  { kind: 'reply', id: 2, question: 'Undo it', trace: [], status: 'Thinking', startedAt: 0 },
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
    expect(reply(items).status).toBe(WAITING)
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

  it('says how long it worked only for a good answer that took 3 s or more', () => {
    expect(workedFor({ answer: 'ok', startedAt: 0, endedAt: 2900 })).toBeNull()
    expect(workedFor({ answer: 'ok', startedAt: 0, endedAt: 4200 })).toBe('Worked for 4 s')
    expect(workedFor({ startedAt: 0, endedAt: 9000 })).toBeNull()
  })

  it('shows a blocked card as its own state, and doesn’t count it as waiting', () => {
    const items = applyEvent(start(), {
      type: 'confirm',
      id: 'b',
      card: { ...card, blocked: 'Choose a model in Settings → AI first.' },
    })
    expect(reply(items).trace[0]).toMatchObject({ state: 'blocked' })
    expect(cardOpen(items)).toBe(false)
    const done = finish(items, { ok: false, reason: 'blocked', message: 'Nothing was changed' }, 1)
    expect(reply(done).trace[0]).toMatchObject({ state: 'blocked' })
  })

  it('knows when a card is waiting', () => {
    const items = applyEvent(start(), { type: 'confirm', id: 'c', card })
    expect(cardOpen(items)).toBe(true)
    expect(reply(items).status).toBe(WAITING)
    expect(cardOpen(applyEvent(items, { type: 'confirmed', id: 'c', approved: false }))).toBe(false)
  })

  it('turns "- " lines into lists and keeps paragraphs', () => {
    expect(
      answerBlocks('You have two bills:\n- Netflix £10.99\n- Spotify £11.99\n\nBoth are monthly.'),
    ).toEqual([
      { kind: 'p', text: 'You have two bills:' },
      { kind: 'list', items: ['Netflix £10.99', 'Spotify £11.99'] },
      { kind: 'p', text: 'Both are monthly.' },
    ])
    expect(answerBlocks('One line\nand another')).toEqual([{ kind: 'p', text: 'One line\nand another' }])
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
