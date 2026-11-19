import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MoneyStore } from './store'

let dir: string
let file: string
let store: MoneyStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'money-memory-'))
  file = join(dir, 'money.sqlite')
  store = new MoneyStore(file)
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('MoneyStore memory', () => {
  it('saves facts with defaults filled in, oldest first', () => {
    const a = store.saveMemoryFact({ kind: 'held', from: 'Gabe', forPerson: 'Patrick' }, 'question')
    const b = store.saveMemoryFact({ kind: 'note', text: 'HSBC is my main account' }, 'you')
    expect(store.memoryFacts()).toEqual([
      {
        kind: 'held',
        from: 'Gabe',
        forPerson: 'Patrick',
        what: '',
        id: a.id,
        createdAt: a.createdAt,
        source: 'question',
      },
      { kind: 'note', text: 'HSBC is my main account', id: b.id, createdAt: b.createdAt, source: 'you' },
    ])
  })

  it('replaces a fact by id and keeps when it was first learned', () => {
    const a = store.saveMemoryFact(
      { kind: 'event', name: 'Italy', from: '2026-08-28', to: '2026-09-04' },
      'you',
    )
    const b = store.saveMemoryFact(
      {
        kind: 'event',
        name: 'Italy trip',
        from: '2026-08-28',
        to: '2026-09-04',
        excludeMerchants: ['Ryanair'],
      },
      'you',
      a.id,
    )
    expect(b.createdAt).toBe(a.createdAt)
    expect(store.memoryFacts()).toEqual([
      expect.objectContaining({ id: a.id, name: 'Italy trip', excludeMerchants: ['Ryanair'] }),
    ])
  })

  it('refuses invalid facts', () => {
    expect(() => store.saveMemoryFact({ kind: 'event', name: 'Nothing' }, 'you')).toThrow()
    expect(store.memoryFacts()).toEqual([])
  })

  it('skips rows that no longer pass the schema instead of trusting them', () => {
    store.saveMemoryFact({ kind: 'note', text: 'fine' }, 'you')
    const db = new DatabaseSync(file)
    db.prepare(
      "INSERT INTO memory_facts (id, kind, data, source, created_at) VALUES ('x', 'note', '{bad json', 'you', '2026')",
    ).run()
    db.prepare(
      "INSERT INTO memory_facts (id, kind, data, source, created_at) VALUES ('y', 'magic', '{\"kind\":\"magic\"}', 'you', '2026')",
    ).run()
    db.prepare(
      "INSERT INTO memory_facts (id, kind, data, source, created_at) VALUES ('z', 'note', '{\"kind\":\"note\",\"text\":\"ok\"}', 'evil', '2026')",
    ).run()
    db.close()
    expect(store.memoryFacts().map((f) => [f.id === 'z' ? 'z' : 'other', f.source])).toEqual([
      ['z', 'you'],
      ['other', 'you'],
    ])
  })

  it('deletes facts and remembers dismissed questions', () => {
    const a = store.saveMemoryFact({ kind: 'income', from: 'Acme' }, 'you')
    expect(store.deleteMemoryFact(a.id)).toBe(true)
    expect(store.deleteMemoryFact(a.id)).toBe(false)
    store.dismissQuestion('person:gabe')
    store.dismissQuestion('person:gabe')
    expect([...store.dismissedQuestions()]).toEqual(['person:gabe'])
  })

  it('clearMemory and clear forget it all', () => {
    store.saveMemoryFact({ kind: 'income', from: 'Acme' }, 'you')
    store.dismissQuestion('q')
    store.clearMemory()
    expect(store.memoryFacts()).toEqual([])
    expect(store.dismissedQuestions().size).toBe(0)
    store.saveMemoryFact({ kind: 'income', from: 'Acme' }, 'you')
    store.clear()
    expect(store.memoryFacts()).toEqual([])
  })
})
