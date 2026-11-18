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
  it('keeps a quote inside an unquoted cell instead of swallowing the rows after it', () => {
    const text =
      'Date,Description,Amount\n13/11/2026,ARGOS 32" TV,-199.00\n14/11/2026,TESCO,-3.41\n15/11/2026,ALDI,-1.00\n'
    expect(parseCsv(text)).toEqual([
      ['Date', 'Description', 'Amount'],
      ['13/11/2026', 'ARGOS 32" TV', '-199.00'],
      ['14/11/2026', 'TESCO', '-3.41'],
      ['15/11/2026', 'ALDI', '-1.00'],
    ])
    const r = parseStatement(text, { accountName: 'Test' })
    expect(r.ok && r.transactions.map((t) => t.amount)).toEqual([-19900, -341, -100])
  })

  it('reads a semicolon file whose quoted descriptions contain commas, with decimal commas', () => {
    const text =
      'Date;Description;Amount\n13/11/2026;"REWE, BERLIN, DE";-3,41\n14/11/2026;"LIDL, KÖLN";-1.234,56\n'
    expect(parseCsv(text)[1]).toEqual(['13/11/2026', 'REWE, BERLIN, DE', '-3,41'])
    const r = parseStatement(text, { accountName: 'Test' })
    expect(r.ok && r.transactions.map((t) => t.amount)).toEqual([-341, -123456])
  })

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

  it('reads a headerless date, description, amount file without asking', () => {
    const r = parsed('headerless.csv', 'Bank')
    expect(r.layout).toBe('CSV')
    expect(r.mapping).toEqual({ headerRow: -1, date: 0, description: 1, amount: 2 })
    expect(r.transactions.map((t) => t.amount)).toEqual([-799, -799, 1200])
    expect(r.transactions[0]!.merchant).toBe('Audible')
  })

  it('asks for a mapping when it cannot recognise the layout, with a sensible guess', () => {
    const text =
      'x,17/10/2026,AUDIBLE UK,-7.99,a\ny,17/11/2026,AUDIBLE UK,-7.99\nz,18/11/2026,REFUND,12.00,b,c\n'
    const r = parseStatement(text, { accountName: 'Bank' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toBe('unrecognised')
    expect(r.sample).toHaveLength(3)
    expect(r.suggested).toMatchObject({ headerRow: -1, date: 1, amount: 3 })

    const mapped = parseStatement(text, { accountName: 'Bank', mapping: r.suggested })
    expect(mapped.ok && mapped.layout).toBe('Custom')
  })

  it("reads the Monzo app's search export: Created, Title, Subtitle and Monzo's categories", () => {
    const r = parsed('monzo-search.csv', 'Monzo')
    expect(r.layout).toBe('Monzo')
    expect(r.transactions).toHaveLength(6)
    const [first, atm, transfer, uber, pasta] = r.transactions
    expect(first).toMatchObject({ date: '2026-11-13', amount: 12000, description: 'Sam Example' })
    expect(atm).toMatchObject({ amount: -2000, category: 'Cash' })
    expect(transfer).toMatchObject({
      description: 'TESTER A B · Monzo',
      merchant: 'Tester A B',
      category: 'Transfers',
    })
    expect(uber).toMatchObject({
      description: 'Alex Example · Ubers',
      merchant: 'Alex Example',
      date: '2026-11-08',
    })
    expect(pasta).toMatchObject({ category: 'Eating out', amount: -1461 })
  })

  it("reads HSBC's headerless export and understands its transaction codes", () => {
    const r = parsed('hsbc.csv', 'HSBC current')
    expect(r.layout).toBe('HSBC')
    expect(r.transactions).toHaveLength(10)
    const by = (start: string) => r.transactions.find((t) => t.description.startsWith(start))!
    expect(by('SAINSBURYS')).toMatchObject({ merchant: 'Sainsburys S Mkts Town', category: 'Groceries' })
    expect(by('CITY COUNCIL')).toMatchObject({ merchant: 'City Council', category: 'Bills' })
    expect(by('LETTINGS AGENT')).toMatchObject({ amount: -59750, category: 'Bills' })
    expect(by('PAYPAL')).toMatchObject({ category: 'Other' })
    expect(by("INT'L 0012345678 ANTHROPIC")).toMatchObject({ merchant: 'Anthropic' })
    expect(by("INT'L 0074866721 GELATERIA").merchant).toBe('Gelateria Roma')
    expect(by('Non-Sterling')).toMatchObject({ amount: -17, category: 'Fees' })
    expect(by('EXAMPLE EMPLOYER')).toMatchObject({ amount: 202144, category: 'Income' })
    expect(by('Test Person Monzo')).toMatchObject({ merchant: 'Test Person Monzo' })
  })

  it('keeps ids stable for exports without a Subtitle column', () => {
    const a = parsed('monzo.csv', 'Monzo').transactions.map((t) => t.id)
    const b = parsed('monzo.csv', 'Monzo').transactions.map((t) => t.id)
    expect(a).toEqual(b)
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

describe('HSBC transaction codes and categories', () => {
  const one = (line: string) => {
    const r = parseStatement(`${line}\n${line.replace(/^\d\d/, '01')}\n${line.replace(/^\d\d/, '02')}\n`, {
      accountName: 'HSBC',
    })
    if (!r.ok) throw new Error(r.message)
    return r.transactions[0]!
  }
  it("doesn't read the BP transfer code as BP petrol", () => {
    expect(one('12/09/2026,North South Barber Haircut BP,-23.00').category).toBe('Other')
  })
  it('knows common UK chains and bike hire', () => {
    expect(one('11/11/2026,ONE STOP 1630 HEADINGLEY ))),-2.85').category).toBe('Groceries')
    expect(one('12/11/2026,BERYL LONDON VIS,-18.00').category).toBe('Transport')
    expect(one('20/07/2026,LIME*RIDE CJPI LONDON VIS,-2.98').category).toBe('Transport')
    expect(one('15/10/2026,JD WETHERSPOON Watford VIS,-4.19').category).toBe('Eating out')
  })
})
