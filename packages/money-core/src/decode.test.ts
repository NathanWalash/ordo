import { describe, expect, it } from 'vitest'
import { decodeStatement } from './decode'
import { parseStatement } from './statement'

const CSV = 'Date,Description,Amount\r\n13/11/2026,TESCO STORES,-£3.41\r\n14/11/2026,SALARY,£1500.00\r\n'

const utf16le = (s: string, bom = true) => {
  const body = Buffer.from(s, 'utf16le')
  return new Uint8Array(bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body)
}
const amounts = (text: string) => {
  const r = parseStatement(text, { accountName: 'Current' })
  if (!r.ok) throw new Error(`not parsed: ${r.error}`)
  return r.transactions.map((t) => t.amount)
}

describe('decodeStatement', () => {
  it('reads UTF-8, with or without a byte order mark', () => {
    expect(decodeStatement(new Uint8Array(Buffer.from(CSV)))).toBe(CSV)
    expect(decodeStatement(new Uint8Array(Buffer.from(`﻿${CSV}`)))).toBe(CSV)
  })

  it('reads UTF-16 from Excel’s Unicode text export, little- and big-endian', () => {
    expect(amounts(decodeStatement(utf16le(CSV)))).toEqual([-341, 150000])
    const be = Buffer.from(utf16le(CSV)).swap16()
    expect(amounts(decodeStatement(new Uint8Array(be)))).toEqual([-341, 150000])
  })

  it('reads UTF-16 without a byte order mark', () => {
    expect(amounts(decodeStatement(utf16le(CSV, false)))).toEqual([-341, 150000])
  })

  it('reads a Windows code page file, where £ is the byte 0xA3', () => {
    const bytes = new Uint8Array(Buffer.from(CSV, 'latin1'))
    expect(bytes.includes(0xa3)).toBe(true)
    expect(amounts(decodeStatement(bytes))).toEqual([-341, 150000])
  })
})
