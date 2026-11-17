import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseCsv, parseStatement, type ColumnMapping } from './statement'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

function parsed(name: string, accountName = 'Test', mapping?: ColumnMapping) {
  const r = parseStatement(fixture(name), { accountName, mapping })
  if (!r.ok) throw new Error(r.message)
  return r
}

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, CRLF, a BOM and blank lines', () => {
    const text = String.fromCharCode(0xfeff) + 'a,b,c\r\n"1,000","say ""hi""",x\r\n\r\n,,\n4,5,6'
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['1,000', 'say "hi"', 'x'],
      ['4', '5', '6'],
    ])
  })

  it('detects semicolon and tab delimiters', () => {
    expect(parseCsv('a;b\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})

describe('parseStatement', () => {
  it('reads a Monzo export', () => {
    const r = parsed('monzo.csv', 'Monzo')
    expect(r.layout).toBe('Monzo')
    expect(r.mapping.amount).toBeDefined()
    // 26 rows, one is a £0 card check.
    expect(r.transactions).toHaveLength(25)
    expect(r.skipped).toBe(1)
    const netflix = r.transactions.find((t) => t.date === '2026-08-03')!
    expect(netflix).toMatchObject({
      accountName: 'Monzo',
      description: 'Netflix',
      merchant: 'Netflix',
      amount: -1099,
      category: 'Entertainment',
    })
    // Monzo's "general" says nothing, and no rule knows Zorblax: it's left in Other for AI or you.
    expect(r.transactions.find((t) => t.merchant === 'Zorblax Studio')).toMatchObject({ category: 'Other' })
    expect(r.transactions.find((t) => t.date === '2026-07-28')!.amount).toBe(245000)
  })

  it('reads a Starling export', () => {
    const r = parsed('starling.csv')
    expect(r.layout).toBe('Starling')
    expect(r.transactions).toHaveLength(11)
    expect(r.transactions[0]).toMatchObject({
      date: '2026-09-01',
      description: 'Landlord Ltd',
      amount: -145000,
      category: 'Bills and services',
    })
  })

  it('reads a debit/credit export with account details above the header', () => {
    const r = parsed('nationwide.csv')
    expect(r.layout).toBe('Nationwide')
    expect(r.mapping.headerRow).toBe(3)
    expect(r.mapping.debit).toBe(3)
    expect(r.mapping.credit).toBe(4)
    expect(r.transactions).toHaveLength(7)
    expect(r.transactions[0]).toMatchObject({ date: '2026-09-04', amount: -3500, merchant: 'Sky Digital' })
    expect(r.transactions.find((t) => t.description === 'SALARY ACME')).toMatchObject({
      amount: 245000,
      category: 'Income',
    })
    expect(r.transactions.find((t) => t.date === '2026-09-10')).toMatchObject({
      merchant: 'TfL',
      category: 'Transport',
    })
  })

  it('asks for a mapping when it cannot recognise the layout, with a sensible guess', () => {
    const r = parseStatement(fixture('headerless.csv'), { accountName: 'HSBC' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('unrecognised')
    expect(r.sample).toHaveLength(3)
    expect(r.suggested).toEqual({ headerRow: -1, date: 0, description: 1, amount: 2 })

    const mapped = parsed('headerless.csv', 'HSBC', r.suggested)
    expect(mapped.layout).toBe('Custom')
    expect(mapped.transactions.map((t) => t.amount)).toEqual([-799, -799, 1200])
    expect(mapped.transactions[0]!.merchant).toBe('Audible')
  })

  it('reports a mapping that finds nothing', () => {
    const r = parseStatement(fixture('headerless.csv'), {
      accountName: 'x',
      mapping: { headerRow: -1, date: 1, description: 0, amount: 2 },
    })
    expect(r).toMatchObject({ ok: false, error: 'no-rows' })
  })

  it('reports an empty file', () => {
    expect(parseStatement('\n\n', { accountName: 'x' })).toMatchObject({ ok: false, error: 'empty' })
  })

  it('gives the same ids on re-import, and distinct ids to identical rows in one file', () => {
    const a = parsed('monzo.csv', 'Monzo').transactions
    const b = parsed('monzo.csv', 'Monzo').transactions
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id))
    expect(new Set(a.map((t) => t.id)).size).toBe(a.length)
    const coffees = a.filter((t) => t.date === '2026-09-07')
    expect(coffees).toHaveLength(2)
    expect(coffees[0]!.id).not.toBe(coffees[1]!.id)
  })

  it('gives different ids in different accounts', () => {
    const a = parsed('monzo.csv', 'Monzo').transactions[0]!
    const b = parsed('monzo.csv', 'Joint').transactions[0]!
    expect(a.id).not.toBe(b.id)
  })

  it('reads month-first dates when that is the only reading that fits', () => {
    const r = parseStatement('Date,Description,Amount\n11/25/2026,Shop,-1.00\n12/01/2026,Shop,-2.00', {
      accountName: 'US',
    })
    expect(r.ok && r.transactions.map((t) => t.date)).toEqual(['2026-11-25', '2026-12-01'])
  })
})
