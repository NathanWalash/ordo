// Calendar dates as plain `YYYY-MM-DD` strings. They sort as text, cross IPC as-is
// and never shift with time zones. All arithmetic happens in UTC.

export type ISODate = string
export type Cadence = 'weekly' | 'monthly' | 'yearly'

export const CADENCES: readonly Cadence[] = ['weekly', 'monthly', 'yearly']

const DAY = 86_400_000
const ISO = /^(\d{4})-(\d{2})-(\d{2})$/

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** Build a date, or null when the parts don't make a real day (31 February, month 13). */
export function makeDate(y: number, m: number, d: number): ISODate | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}`
}

export function isISODate(s: string): boolean {
  const m = ISO.exec(s)
  return !!m && makeDate(Number(m[1]), Number(m[2]), Number(m[3])) === s
}

function parts(s: ISODate): [number, number, number] {
  const m = ISO.exec(s)
  if (!m) throw new Error(`Not a YYYY-MM-DD date: ${s}`)
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

const toMs = (s: ISODate) => {
  const [y, m, d] = parts(s)
  return Date.UTC(y, m - 1, d)
}
const fromMs = (ms: number): ISODate => {
  const d = new Date(ms)
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** Today (or `d`) in the computer's local time zone. */
export function toISODate(d: Date = new Date()): ISODate {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function addDays(s: ISODate, n: number): ISODate {
  return fromMs(toMs(s) + n * DAY)
}

/** Add months, clamping to the end of shorter months (31 Jan + 1 month = 28 or 29 Feb). */
export function addMonths(s: ISODate, n: number): ISODate {
  const [y, m, d] = parts(s)
  const total = y * 12 + (m - 1) + n
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  return makeDate(ny, nm, Math.min(d, daysInMonth(ny, nm)))!
}

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((toMs(b) - toMs(a)) / DAY)
}

/** `2026-11` for `2026-11-17`. */
export const monthOf = (s: ISODate) => s.slice(0, 7)

/** Approximate length of one cycle, for estimates and tolerances. */
export const CADENCE_DAYS: Record<Cadence, number> = { weekly: 7, monthly: 30.44, yearly: 365.25 }

/**
 * The `n`th cycle from `anchor` (n may be negative). Always computed from the anchor,
 * so a bill due on the 31st comes back to the 31st after a short month.
 */
export function addCadence(anchor: ISODate, cadence: Cadence, n: number): ISODate {
  if (cadence === 'weekly') return addDays(anchor, 7 * n)
  if (cadence === 'monthly') return addMonths(anchor, n)
  return addMonths(anchor, 12 * n)
}

/** Index of the first cycle of `anchor` that falls on or after `date`. */
function firstCycleOnOrAfter(anchor: ISODate, cadence: Cadence, date: ISODate): number {
  let n = Math.floor(daysBetween(anchor, date) / CADENCE_DAYS[cadence]) - 2
  while (addCadence(anchor, cadence, n) < date) n++
  return n
}

/** The first cycle of `anchor` on or after `date`. */
export function nextOnOrAfter(anchor: ISODate, cadence: Cadence, date: ISODate): ISODate {
  return addCadence(anchor, cadence, firstCycleOnOrAfter(anchor, cadence, date))
}

/** The last cycle of `anchor` on or before `date`. */
export function lastOnOrBefore(anchor: ISODate, cadence: Cadence, date: ISODate): ISODate {
  let n = firstCycleOnOrAfter(anchor, cadence, date)
  if (addCadence(anchor, cadence, n) > date) n--
  return addCadence(anchor, cadence, n)
}

/** Every cycle of `anchor` from `from` to `to`, inclusive. */
export function cyclesBetween(anchor: ISODate, cadence: Cadence, from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = []
  for (let n = firstCycleOnOrAfter(anchor, cadence, from); ; n++) {
    const d = addCadence(anchor, cadence, n)
    if (d > to) return out
    out.push(d)
  }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

export type DateOrder = 'dmy' | 'mdy'

const NUMERIC = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})(?:[ T].*)?$/
const NAMED = /^(\d{1,2})[\s-]([a-z]{3})[a-z]*[\s-](\d{2,4})(?:[ T].*)?$/i

const fullYear = (y: number) => (y < 100 ? 2000 + y : y)

/**
 * Read a statement date: `2026-11-17`, `17/11/2026`, `17-11-26`, `17 Nov 2026`, `17-Nov-2026`,
 * optionally followed by a time. Slash dates are day-first (UK) unless `order` says otherwise.
 */
export function parseStatementDate(raw: string, order: DateOrder = 'dmy'): ISODate | null {
  const s = raw.trim()
  const named = NAMED.exec(s)
  if (named) {
    const m = MONTHS.indexOf(named[2]!.toLowerCase()) + 1
    return m ? makeDate(fullYear(Number(named[3])), m, Number(named[1])) : null
  }
  const num = NUMERIC.exec(s)
  if (!num) return null
  const [a, b, c] = [num[1]!, num[2]!, num[3]!]
  if (a.length === 4) return makeDate(Number(a), Number(b), Number(c))
  if (c.length !== 4 && c.length !== 2) return null
  const y = fullYear(Number(c))
  return order === 'mdy' ? makeDate(y, Number(a), Number(b)) : makeDate(y, Number(b), Number(a))
}

/**
 * Guess whether slash dates are day-first or month-first. Day-first unless a value
 * can only be month-first (e.g. `11/25/2026`).
 */
export function guessDateOrder(values: string[]): DateOrder {
  let dmy = false
  let mdy = false
  for (const v of values) {
    const m = NUMERIC.exec(v.trim())
    if (!m || m[1]!.length === 4) continue
    if (Number(m[1]) > 12) dmy = true
    if (Number(m[2]) > 12) mdy = true
  }
  return mdy && !dmy ? 'mdy' : 'dmy'
}
