import { daysBetween } from './dates'
import { fieldText } from './fields'
import type { Card, FieldDef, FieldValue, ISODate, Label } from './types'

export const DUE_FILTERS = ['overdue', 'today', 'week', 'dated', 'none'] as const
export type DueFilter = (typeof DUE_FILTERS)[number]

export interface CardFilter {
  /** Words that must all appear in the title, notes, labels or field values. */
  query?: string
  /** Cards with any of these labels. */
  labelIds?: string[]
  due?: DueFilter
  /** Cards whose field has this value (a select option id, a person's name, true for a checkbox…). */
  field?: { fieldId: string; value: FieldValue }
}

export interface FilterContext {
  labels: readonly Label[]
  fields: readonly FieldDef[]
  today: ISODate
  /** Columns whose cards count as done. */
  doneColumns?: ReadonlySet<string>
}

export type DueState = 'overdue' | 'today' | 'soon' | 'later'

/** How urgent a card's due date is. Done cards and cards without a date have none. */
export function dueState(card: Pick<Card, 'due'>, today: ISODate, done = false): DueState | null {
  if (!card.due || done) return null
  const d = daysBetween(today, card.due)
  if (d < 0) return 'overdue'
  if (d === 0) return 'today'
  if (d <= 2) return 'soon'
  return 'later'
}

const fold = (s: string) => s.toLocaleLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')

/** Everything searchable about a card, lower-cased and without accents. */
export function searchText(card: Card, ctx: Pick<FilterContext, 'labels' | 'fields'>): string {
  const labels = ctx.labels.filter((l) => card.labelIds.includes(l.id)).map((l) => l.name)
  const fields = ctx.fields.map((f) => fieldText(f, card.fields[f.id]))
  return fold([card.title, card.notes, ...labels, ...fields].join('\n'))
}

/** Is any filter actually set? */
export const isFiltering = (f: CardFilter) =>
  Boolean(f.query?.trim() || f.labelIds?.length || f.due || f.field)

export function matchesFilter(card: Card, filter: CardFilter, ctx: FilterContext): boolean {
  const words = fold(filter.query ?? '')
    .split(/\s+/)
    .filter(Boolean)
  if (words.length) {
    const text = searchText(card, ctx)
    if (!words.every((w) => text.includes(w))) return false
  }
  if (filter.labelIds?.length && !filter.labelIds.some((id) => card.labelIds.includes(id))) return false
  if (filter.due) {
    const done = ctx.doneColumns?.has(card.columnId) ?? false
    const state = dueState(card, ctx.today, done)
    const inWeek = card.due !== null && daysBetween(ctx.today, card.due) <= 7
    switch (filter.due) {
      case 'overdue':
        if (state !== 'overdue') return false
        break
      case 'today':
        if (state !== 'today' && state !== 'overdue') return false
        break
      case 'week':
        // Due in the next seven days, or already overdue, and not done.
        if (!state || !inWeek) return false
        break
      case 'dated':
        if (!card.due) return false
        break
      case 'none':
        if (card.due) return false
        break
    }
  }
  if (filter.field) {
    const def = ctx.fields.find((f) => f.id === filter.field!.fieldId)
    if (!def) return false
    const value = card.fields[def.id]
    const want = filter.field.value
    if (def.type === 'person' || def.type === 'text')
      return typeof value === 'string' && fold(value) === fold(String(want))
    return value === want
  }
  return true
}

export function filterCards<T extends Card>(
  cards: readonly T[],
  filter: CardFilter,
  ctx: FilterContext,
): T[] {
  return isFiltering(filter) ? cards.filter((c) => matchesFilter(c, filter, ctx)) : [...cards]
}
