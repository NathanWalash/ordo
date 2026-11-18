// Money is always whole pence (integers). Never do arithmetic on pounds as floats.

const CURRENCY = /[£$€]|\b(?:GBP|EUR|USD)\b/gi

/**
 * Read an amount as written in a bank statement: `-12.99`, `£1,234.56`, `(12.99)`,
 * `12.99 DR`, `−4.50` (Unicode minus). Returns pence, or null when the cell is empty
 * or isn't a number.
 */
export function parseAmount(raw: string): number | null {
  let s = raw.trim().replace(CURRENCY, '').replace(/\s/g, '')
  // A decimal comma (`-3,41`, `1.234,56`): one comma with one or two digits after it. Thousands
  // separators always group three digits, so this can't be one. Otherwise commas are thousands.
  if (/^[^,]*,\d{1,2}\D*$/.test(s)) s = s.replace(/\./g, '').replace(',', '.')
  else s = s.replace(/,/g, '')
  if (!s) return null
  let negative = false
  const suffix = /(DR|CR)$/i.exec(s)
  if (suffix) {
    negative = suffix[1]!.toUpperCase() === 'DR'
    s = s.slice(0, -2)
  }
  if (/^\(.*\)$/.test(s)) {
    negative = !negative
    s = s.slice(1, -1)
  }
  if (/^[-−–]/.test(s)) {
    negative = !negative
    s = s.slice(1)
  } else if (s.startsWith('+')) {
    s = s.slice(1)
  } else if (/[-−]$/.test(s)) {
    negative = !negative
    s = s.slice(0, -1)
  }
  const m = /^(\d*)(?:\.(\d+))?$/.exec(s)
  if (!m || (!m[1] && !m[2])) return null
  const whole = Number(m[1] || '0')
  const frac = m[2] ?? ''
  // Round half up on the third decimal, in integers.
  const pence = whole * 100 + Number(frac.slice(0, 2).padEnd(2, '0')) + (Number(frac[2] ?? 0) >= 5 ? 1 : 0)
  return negative && pence !== 0 ? -pence : pence
}

const GBP = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' })

/** `£1,234.56`, or `−£4.50` for negative amounts. */
export function formatPence(pence: number): string {
  const s = GBP.format(Math.abs(pence) / 100)
  return pence < 0 ? `−${s}` : s
}

/** Read a pounds value typed by a person (`12.5`, `£12.50`) into pence. */
export function poundsToPence(input: string): number | null {
  const p = parseAmount(input)
  return p === null || p < 0 ? null : p
}

/** Pence as a plain pounds string for an input field: `1235` → `12.35`. */
export const penceToPounds = (pence: number) => (pence / 100).toFixed(2)

/**
 * Stable short hash of a string (cyrb53). Used for transaction ids, so re-importing
 * the same statement produces the same ids. Not for security.
 */
export function hash(str: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}
