// Helpers for what Money shows a model: rounded amounts, descriptions with numbers scrubbed out,
// JSON lines that can't break out of their data block, and a fingerprint to notice changes.

/** Upper bounds in pence, each with the band it closes. */
const BANDS: [number, string][] = [
  [500, 'under £5'],
  [1000, '£5–£10'],
  [2000, '£10–£20'],
  [5000, '£20–£50'],
  [10000, '£50–£100'],
  [25000, '£100–£250'],
  [50000, '£250–£500'],
  [100000, '£500–£1,000'],
  [250000, '£1,000–£2,500'],
]

/** A rough amount instead of the real one: 1499 pence → `£10–£20`. Sign is ignored. */
export function amountBand(pence: number): string {
  const p = Math.abs(pence)
  for (const [max, band] of BANDS) if (p < max) return band
  return 'over £2,500'
}

/** The middle value, for a typical amount that one odd payment can't skew. */
export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2)
}

const MONTHS = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*'

/**
 * A statement description without dates, times, card numbers, references or phone numbers:
 * `CARD PAYMENT TO ZORBLAX 4471 ON 06-11-2026` → `CARD PAYMENT TO ZORBLAX ON`. Every number goes,
 * even a harmless store number; words are kept. Truncated to `max` characters.
 */
export function scrubDescription(text: string, max = 80): string {
  return (
    text
      .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ')
      .replace(/\b\d{1,4}[/.-]\d{1,2}([/.-]\d{2,4})?\b/g, ' ')
      .replace(new RegExp(`\\b\\d{1,2}\\s?${MONTHS}(\\s?\\d{2,4})?\\b`, 'gi'), ' ')
      // Tokens mixing letters and digits (P2B4C6D8E0, x1234), then any number left.
      .replace(/\b(?=[a-z]*\d)(?=\d*[a-z])[a-z\d]{4,}\b/gi, ' ')
      .replace(/[*#+]?\d[\d\s-]*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
      .trim()
  )
}

/** JSON with < and > escaped, so nothing in a merchant name can close the data block. */
export const dataLine = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')

/** FNV-1a, enough to notice that what a model was shown has changed. */
export function fingerprint(value: unknown): string {
  const text = JSON.stringify(value)
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
