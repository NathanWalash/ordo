// Fractional ordering keys for boards, columns, cards, checklist items, labels and fields.
//
// Each item has a `rank`: a short string over base-62 digits. Items sort by rank in plain byte
// order (JavaScript `<` and SQLite's default BINARY collation agree), and there is always room
// for a new rank between any two, so moving one card only rewrites that card's row. Ranks never
// end in the zero digit, which is what guarantees the room. If keys ever grow long (thousands of
// moves to the same spot) the list is given fresh, evenly spaced ranks.

export const RANK_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const BASE = RANK_DIGITS.length
const ZERO = RANK_DIGITS[0]!

/** Ranks longer than this trigger a rebalance of the list they're in. */
export const MAX_RANK_LENGTH = 32

const RANK = /^[0-9A-Za-z]+$/

/** A well-formed rank: base-62 digits, not empty, not ending in the zero digit. */
export function isRank(value: unknown): value is string {
  return typeof value === 'string' && RANK.test(value) && !value.endsWith(ZERO) && value.length <= 200
}

const digit = (c: string) => RANK_DIGITS.indexOf(c)

/** A key strictly between `a` and `b`, where `''` is the bottom and `null` the open top. */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // Share the common prefix, then find room after it.
    let n = 0
    while ((a[n] ?? ZERO) === b[n]) n++
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n))
  }
  const da = a ? digit(a[0]!) : 0
  const db = b !== null ? digit(b[0]!) : BASE
  if (db - da > 1) return RANK_DIGITS[Math.round((da + db) / 2)]!
  // Adjacent first digits: b's first digit alone is between when b is longer, or extend a.
  if (b !== null && b.length > 1) return b.slice(0, 1)
  return RANK_DIGITS[da]! + midpoint(a.slice(1), null)
}

const join = (ds: number[]) =>
  ds
    .map((d) => RANK_DIGITS[d]!)
    .join('')
    .replace(/0+$/, '')

/**
 * The next rank after `a` in small steps (a 62nd of a 62nd), so adding at the end again and
 * again keeps ranks two characters long for a couple of thousand cards.
 */
function increment(a: string): string {
  const ds = [...a.padEnd(2, ZERO)].map(digit)
  let i = ds.length - 1
  while (i >= 0 && ds[i] === BASE - 1) i--
  if (i < 0) return midpoint(a, null)
  const out = ds.slice(0, i + 1)
  out[i]!++
  return join(out)
}

/** The rank just before `b`, in the same small steps. */
function decrement(b: string): string {
  const ds = [...b.padEnd(2, ZERO)].map(digit)
  let i = ds.length - 1
  while (i >= 0 && ds[i] === 0) i--
  if (i >= 0) {
    ds[i]!--
    for (let j = i + 1; j < ds.length; j++) ds[j] = BASE - 1
    const r = join(ds)
    if (r) return r
  }
  return midpoint('', b)
}

/**
 * A rank strictly between `before` and `after`. `null` means the start or end of the list.
 * Throws a RangeError if either isn't a rank or they're out of order.
 */
export function rankBetween(before: string | null, after: string | null): string {
  if (before !== null && !isRank(before)) throw new RangeError(`Not a rank: ${before}`)
  if (after !== null && !isRank(after)) throw new RangeError(`Not a rank: ${after}`)
  if (before !== null && after !== null && before >= after)
    throw new RangeError(`Ranks out of order: ${before} >= ${after}`)
  if (before === null && after === null) return midpoint('', null)
  if (after === null) return increment(before!)
  if (before === null) return decrement(after)
  return midpoint(before, after)
}

/** `n` ranks in ascending order, as short and evenly spaced as possible. */
export function evenRanks(n: number): string[] {
  if (!Number.isInteger(n) || n <= 0) return []
  let len = 1
  while (BASE ** len < n + 1) len++
  const span = BASE ** len
  const out: string[] = []
  for (let i = 1; i <= n; i++) {
    let v = Math.floor((i * span) / (n + 1))
    let s = ''
    for (let k = 0; k < len; k++) {
      s = RANK_DIGITS[v % BASE]! + s
      v = Math.floor(v / BASE)
    }
    out.push(s.replace(/0+$/, ''))
  }
  return out
}

/** The rank after the last one, for adding at the end. */
export const rankAfter = (last: string | null | undefined): string => rankBetween(last ?? null, null)

export interface Ranked {
  id: string
  rank: string
}

export interface MovePlan {
  /** The moving item's new rank. */
  rank: string
  /** Every row whose rank changes, the moving item included. */
  updates: Ranked[]
}

const byRank = (a: Ranked, b: Ranked) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.id < b.id ? -1 : 1)

/**
 * Where to put an item so it ends up at `index` among `items` (the list it's moving into,
 * which may already contain it). Usually only the moving item changes; if ranks are broken
 * (duplicates, bad values) or have grown too long, the whole list is renumbered.
 */
export function planMove(items: readonly Ranked[], id: string, index: number): MovePlan {
  const others = items.filter((i) => i.id !== id).sort(byRank)
  const at = Math.max(0, Math.min(Number.isFinite(index) ? Math.trunc(index) : others.length, others.length))
  const before = others[at - 1]?.rank ?? null
  const after = others[at]?.rank ?? null
  try {
    const rank = rankBetween(before, after)
    if (rank.length <= MAX_RANK_LENGTH) return { rank, updates: [{ id, rank }] }
  } catch {
    // Fall through: renumber.
  }
  const order = [...others.slice(0, at).map((i) => i.id), id, ...others.slice(at).map((i) => i.id)]
  const ranks = evenRanks(order.length)
  const old = new Map(items.map((i) => [i.id, i.rank]))
  const updates = order
    .map((itemId, i) => ({ id: itemId, rank: ranks[i]! }))
    .filter((u) => u.id === id || old.get(u.id) !== u.rank)
  return { rank: ranks[at]!, updates }
}

/** Sort anything ranked, ties broken by id so the order is always the same. */
export function sortByRank<T extends Ranked>(items: readonly T[]): T[] {
  return [...items].sort(byRank)
}
