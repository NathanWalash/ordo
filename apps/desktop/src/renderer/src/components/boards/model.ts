import {
  daysBetween,
  fromISODate,
  type Card,
  type Column,
  type ISODate,
  type LabelColor,
} from '@ordo/boards-core'
import type { SuggestInfo } from '@ordo/shared'

/** Cards grouped by column, in order. Columns without cards get an empty list. */
export function byColumn<T extends Pick<Card, 'columnId'>>(
  columns: readonly Column[],
  cards: readonly T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>(columns.map((c) => [c.id, []]))
  for (const card of cards) map.get(card.columnId)?.push(card)
  return map
}

/**
 * Move a card in a local list straight away, before the main process confirms: out of where it
 * was, into `columnId` at `index` among that column's other cards.
 */
export function moveLocally<T extends Pick<Card, 'id' | 'columnId'>>(
  cards: readonly T[],
  id: string,
  columnId: string,
  index: number,
): T[] {
  const moving = cards.find((c) => c.id === id)
  if (!moving) return [...cards]
  const others = cards.filter((c) => c.id !== id)
  const inColumn = others.filter((c) => c.columnId === columnId)
  const moved = { ...moving, columnId }
  const before = inColumn[Math.max(0, index)]
  if (before) {
    const at = others.indexOf(before)
    return [...others.slice(0, at), moved, ...others.slice(at)]
  }
  const last = inColumn.at(-1)
  if (last) {
    const at = others.indexOf(last) + 1
    return [...others.slice(0, at), moved, ...others.slice(at)]
  }
  return [...others, moved]
}

/** Reorder any list locally: `id` to `index` among the others. */
export function reorder<T extends { id: string }>(items: readonly T[], id: string, index: number): T[] {
  const moving = items.find((i) => i.id === id)
  if (!moving) return [...items]
  const others = items.filter((i) => i.id !== id)
  const at = Math.max(0, Math.min(index, others.length))
  return [...others.slice(0, at), moving, ...others.slice(at)]
}

/**
 * Where a drop at `visibleIndex` among the cards you can see (search or a filter may hide some)
 * lands among all the column's cards: just before the card it was dropped above, or just after
 * the last card shown.
 */
export function fullIndex(all: readonly string[], visible: readonly string[], visibleIndex: number): number {
  const before = visible[visibleIndex]
  if (before !== undefined) {
    const at = all.indexOf(before)
    if (at >= 0) return at
  }
  const last = visible[Math.min(visibleIndex, visible.length) - 1]
  if (last !== undefined) {
    const at = all.indexOf(last)
    if (at >= 0) return at + 1
  }
  return visible.length === 0 ? all.length : 0
}

export type Direction = 'up' | 'down' | 'left' | 'right'

/**
 * Where a card goes when moved one step with the keyboard: up or down in its column, or into
 * the column to the left or right at the same position (or its end). Null at the edges.
 */
export function stepTarget(
  columns: readonly { id: string; cards: readonly string[] }[],
  cardId: string,
  dir: Direction,
): { columnId: string; index: number } | null {
  const ci = columns.findIndex((c) => c.cards.includes(cardId))
  if (ci < 0) return null
  const col = columns[ci]!
  const i = col.cards.indexOf(cardId)
  if (dir === 'up') return i > 0 ? { columnId: col.id, index: i - 1 } : null
  if (dir === 'down') return i < col.cards.length - 1 ? { columnId: col.id, index: i + 1 } : null
  const next = columns[ci + (dir === 'left' ? -1 : 1)]
  if (!next) return null
  return { columnId: next.id, index: Math.min(i, next.cards.length) }
}

/** The card to focus when moving focus with the arrow keys (no modifier). */
export function focusTarget(
  columns: readonly { id: string; cards: readonly string[] }[],
  cardId: string,
  dir: Direction,
): string | null {
  const ci = columns.findIndex((c) => c.cards.includes(cardId))
  if (ci < 0) return null
  const col = columns[ci]!
  const i = col.cards.indexOf(cardId)
  if (dir === 'up') return col.cards[i - 1] ?? null
  if (dir === 'down') return col.cards[i + 1] ?? null
  // Skip empty columns on the way.
  for (let j = ci + (dir === 'left' ? -1 : 1); j >= 0 && j < columns.length; j += dir === 'left' ? -1 : 1) {
    const cards = columns[j]!.cards
    if (cards.length) return cards[Math.min(i, cards.length - 1)]!
  }
  return null
}

const dayFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
const yearFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
const weekdayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long' })

/** "Today", "Tomorrow", "Yesterday", "Friday" (this week), "20 Nov", or "3 Feb 2027". */
export function dayLabel(iso: ISODate, today: ISODate): string {
  const d = daysBetween(today, iso)
  if (d === 0) return 'Today'
  if (d === 1) return 'Tomorrow'
  if (d === -1) return 'Yesterday'
  const date = fromISODate(iso)
  if (d > 1 && d < 7) return weekdayFmt.format(date)
  return (iso.slice(0, 4) === today.slice(0, 4) ? dayFmt : yearFmt).format(date)
}

/** A card's dates for its badge: "Tomorrow", or "18 – 20 Nov" for a range. */
export function datesLabel(card: Pick<Card, 'start' | 'due'>, today: ISODate): string | null {
  if (!card.due) return null
  if (!card.start) return dayLabel(card.due, today)
  const a = fromISODate(card.start)
  const b = fromISODate(card.due)
  const sameMonth = card.start.slice(0, 7) === card.due.slice(0, 7)
  return sameMonth ? `${a.getDate()} – ${dayFmt.format(b)}` : `${dayFmt.format(a)} – ${dayFmt.format(b)}`
}

/** The CSS colour for a label or option colour (light and dark come from the stylesheet). */
export const labelColor = (c: LabelColor) => `var(--label-${c})`

/**
 * A colour as text that reads on the content: mixed towards the ink, more in light mode, where
 * pure system colours are too pale (`--chip-mix` is 50% light, 70% dark).
 */
export const tint = (color: string) => `color-mix(in srgb, ${color} var(--chip-mix), var(--ink))`

/** A soft fill and a readable text colour for a label chip, in light and dark mode. */
export const chipStyle = (c: LabelColor) => ({
  background: `color-mix(in srgb, ${labelColor(c)} 16%, transparent)`,
  color: tint(labelColor(c)),
})

/** The same for a state colour such as `var(--danger)`. */
export const toneStyle = (color: string, fill = 14) => ({
  background: `color-mix(in srgb, ${color} ${fill}%, transparent)`,
  color: tint(color),
})

export const LABEL_COLOR_NAMES: Record<LabelColor, string> = {
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  teal: 'Teal',
  blue: 'Blue',
  purple: 'Purple',
  pink: 'Pink',
  grey: 'Grey',
}

export const KIND_WORDS: Record<SuggestInfo['sends'][number], string> = {
  event: 'upcoming events',
  bill: 'bills',
  email: 'email subjects',
  card: 'other cards',
}

/** "events, bills and other cards" */
export const listOf = (words: string[]) =>
  words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`

/** What pressing Suggest will do, said before anything is sent. */
export function suggestTitle(info: SuggestInfo | null): string {
  if (!info) return 'Suggest a due date, steps, labels and links'
  if (!info.ready) return info.message
  const related = listOf(info.sends.map((k) => KIND_WORDS[k]))
  const p = info.provider!
  return p.kind === 'local'
    ? `Asks ${p.label} on this computer about this card, with related ${related}.`
    : `Sends this card, with related ${related}, to ${p.vendor ?? p.label} through ${p.label}.`
}
