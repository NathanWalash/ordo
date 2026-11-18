import { describe, expect, it } from 'vitest'
import { formatPence, hash, parseAmount, poundsToPence } from './amount'

describe('parseAmount', () => {
  it('reads plain and signed amounts as pence', () => {
    expect(parseAmount('12.99')).toBe(1299)
    expect(parseAmount('-12.99')).toBe(-1299)
    expect(parseAmount('+3')).toBe(300)
    expect(parseAmount('0.1')).toBe(10)
    expect(parseAmount('.5')).toBe(50)
    expect(parseAmount('1450.00')).toBe(145000)
  })

  it('handles currency symbols, thousands separators and bank notations', () => {
    expect(parseAmount('£1,234.56')).toBe(123456)
    expect(parseAmount('-£1,234.56')).toBe(-123456)
    expect(parseAmount('£-4.50')).toBe(-450)
    expect(parseAmount('(12.99)')).toBe(-1299)
    expect(parseAmount('12.99 DR')).toBe(-1299)
    expect(parseAmount('12.99CR')).toBe(1299)
    expect(parseAmount('−4.50')).toBe(-450)
    expect(parseAmount('4.50-')).toBe(-450)
    expect(parseAmount('GBP 10.00')).toBe(1000)
  })

  it('reads a decimal comma instead of making the amount 100 times bigger', () => {
    expect(parseAmount('-3,41')).toBe(-341)
    expect(parseAmount('1.234,56')).toBe(123456)
    expect(parseAmount('12,5')).toBe(1250)
    expect(parseAmount('(3,41)')).toBe(-341)
    expect(parseAmount('3,41 DR')).toBe(-341)
    // Three digits after a comma are thousands.
    expect(parseAmount('1,234')).toBe(123400)
    expect(parseAmount('1,234,567.89')).toBe(123456789)
  })

  it('is exact where floats are not', () => {
    expect(parseAmount('0.29')).toBe(29) // 0.29 * 100 = 28.999999999999996
    expect(parseAmount('1.005')).toBe(101)
  })

  it('returns null for empty or non-numeric cells', () => {
    expect(parseAmount('')).toBeNull()
    expect(parseAmount('  ')).toBeNull()
    expect(parseAmount('£')).toBeNull()
    expect(parseAmount('n/a')).toBeNull()
    expect(parseAmount('1.2.3')).toBeNull()
  })
})

describe('formatting', () => {
  it('formats pence as pounds', () => {
    expect(formatPence(123456)).toBe('£1,234.56')
    expect(formatPence(5)).toBe('£0.05')
    expect(formatPence(-450)).toBe('−£4.50')
  })

  it('reads typed pounds and rejects negatives', () => {
    expect(poundsToPence('12.5')).toBe(1250)
    expect(poundsToPence('£42.10')).toBe(4210)
    expect(poundsToPence('-1')).toBeNull()
    expect(poundsToPence('abc')).toBeNull()
  })
})

describe('hash', () => {
  it('is stable and distinguishes inputs', () => {
    expect(hash('a|2026-11-17|-1299|netflix')).toBe(hash('a|2026-11-17|-1299|netflix'))
    expect(hash('a|2026-11-17|-1299|netflix')).not.toBe(hash('a|2026-11-17|-1298|netflix'))
  })
})
