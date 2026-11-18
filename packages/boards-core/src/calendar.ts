import type { Card, ISODate } from './types'

export interface CardCalendarItem {
  id: string
  cardId: string
  boardId: string
  boardName: string
  title: string
  /** First day: the start of a date range, or the due date. */
  from: ISODate
  /** Last day (inclusive): the due date. */
  to: ISODate
}

/**
 * Cards with a due date or date range overlapping `range` (inclusive days), for the Calendar.
 * Archived cards and cards in a done column are left out.
 */
export function cardsToCalendarItems(
  cards: readonly Pick<Card, 'id' | 'boardId' | 'columnId' | 'title' | 'start' | 'due' | 'archivedAt'>[],
  context: { boardNames: ReadonlyMap<string, string>; doneColumns: ReadonlySet<string> },
  range: { from: ISODate; to: ISODate },
): CardCalendarItem[] {
  const items: CardCalendarItem[] = []
  for (const c of cards) {
    if (!c.due || c.archivedAt || context.doneColumns.has(c.columnId)) continue
    const from = c.start && c.start <= c.due ? c.start : c.due
    if (c.due < range.from || from > range.to) continue
    items.push({
      id: `${c.id}:${from}`,
      cardId: c.id,
      boardId: c.boardId,
      boardName: context.boardNames.get(c.boardId) ?? '',
      title: c.title,
      from,
      to: c.due,
    })
  }
  return items.sort((a, b) => a.from.localeCompare(b.from) || a.title.localeCompare(b.title))
}
