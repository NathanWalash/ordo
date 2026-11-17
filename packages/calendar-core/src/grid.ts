// Date maths and layout for month, week and agenda views. Pure, so the renderer can use it.
import { addDays, addMonths, overlaps, startOfDay, startOfMonth } from './time'
import type { DateRange } from './types'

export type CalendarView = 'month' | 'week' | 'agenda'

/** Start of the week containing `d`. `firstDay` is 0 for Sunday, 1 for Monday, ... */
export function startOfWeek(d: Date, firstDay: number): Date {
  const day = startOfDay(d)
  return addDays(day, -((day.getDay() - firstDay + 7) % 7))
}

/**
 * The days a view shows around `cursor`. Month: whole weeks covering the month (4 to 6 rows).
 * Week: the seven days containing the cursor. Agenda: the cursor's month.
 */
export function visibleRange(view: CalendarView, cursor: Date, firstDay: number): DateRange {
  if (view === 'week') {
    const start = startOfWeek(cursor, firstDay)
    return { start, end: addDays(start, 7) }
  }
  const month = startOfMonth(cursor)
  if (view === 'agenda') return { start: month, end: addMonths(month, 1) }
  const start = startOfWeek(month, firstDay)
  const lastDay = addDays(addMonths(month, 1), -1)
  return { start, end: addDays(startOfWeek(lastDay, firstDay), 7) }
}

/** The cursor one page earlier (`-1`) or later (`1`). */
export function step(view: CalendarView, cursor: Date, dir: -1 | 1): Date {
  return view === 'week' ? addDays(cursor, 7 * dir) : addMonths(cursor, dir)
}

/** Every local day in `range`. */
export function daysIn(range: DateRange): Date[] {
  const out: Date[] = []
  for (let d = startOfDay(range.start); d < range.end; d = addDays(d, 1)) out.push(d)
  return out
}

export const dayRange = (day: Date): DateRange => ({
  start: startOfDay(day),
  end: addDays(startOfDay(day), 1),
})

/** Anything that occupies time on the calendar: events, and overlay items from other modules. */
export interface Span {
  start: Date
  end: Date
  allDay: boolean
}

/** Items overlapping the given local day, all-day first, then by start time. */
export function onDay<T extends Span>(items: T[], day: Date): T[] {
  const r = dayRange(day)
  return items.filter((i) => overlaps(i.start, i.end, r)).sort(byStartAllDayFirst)
}

/** All-day or lasting a day or more: shown as a bar rather than at a time. */
export function isLong(s: Span): boolean {
  return s.allDay || s.end.getTime() - s.start.getTime() >= 86_400_000
}

function byStartAllDayFirst(a: Span, b: Span): number {
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1
  return a.start.getTime() - b.start.getTime() || b.end.getTime() - a.end.getTime()
}

export interface Segment<T> {
  item: T
  /** Column (0-based day index in the row) where the bar starts, and how many days it covers. */
  col: number
  span: number
  /** Stacking row within the week, from 0. */
  lane: number
  /** The item started before this row, or carries on after it. */
  continuesBefore: boolean
  continuesAfter: boolean
}

/**
 * Lay out items across one week row (`days` columns from `rowStart`) as bars in lanes,
 * so each item keeps one lane for its whole span. Longer and earlier items get the top lanes.
 */
export function segments<T extends Span>(items: T[], rowStart: Date, days = 7): Segment<T>[] {
  const cols = Array.from({ length: days }, (_, i) => addDays(rowStart, i))
  const rowEnd = addDays(rowStart, days)
  const placed = items
    .filter((i) => overlaps(i.start, i.end, { start: rowStart, end: rowEnd }))
    .map((item) => {
      // Last day touched: an item ending exactly at midnight doesn't cover the next day.
      const lastInstant = new Date(Math.max(item.start.getTime(), item.end.getTime() - 1))
      let first = cols.findIndex((d, i) => item.start < (cols[i + 1] ?? rowEnd) && item.start >= d)
      if (first < 0) first = 0
      let last = cols.findIndex((d, i) => lastInstant < (cols[i + 1] ?? rowEnd) && lastInstant >= d)
      if (last < 0) last = days - 1
      return {
        item,
        col: first,
        span: last - first + 1,
        lane: 0,
        continuesBefore: item.start < rowStart,
        continuesAfter: item.end > rowEnd,
      }
    })
    .sort((a, b) => a.col - b.col || b.span - a.span || byStartAllDayFirst(a.item, b.item))
  const lanes: boolean[][] = []
  for (const s of placed) {
    let lane = 0
    while (lanes[lane]?.slice(s.col, s.col + s.span).some(Boolean)) lane++
    lanes[lane] ??= Array<boolean>(days).fill(false)
    for (let c = s.col; c < s.col + s.span; c++) lanes[lane]![c] = true
    s.lane = lane
  }
  return placed
}

export interface TimedBlock<T> {
  item: T
  /** Minutes from the start of the day, clipped to the day. */
  top: number
  height: number
  /** Side-by-side position among overlapping items. */
  column: number
  columns: number
}

/**
 * Position timed items within one day for a time grid. Items that overlap share the
 * width in columns; each group of mutually overlapping items is laid out separately.
 */
export function layoutDay<T extends Span>(items: T[], day: Date, minHeight = 15): TimedBlock<T>[] {
  const { start: dayStart, end: dayEnd } = dayRange(day)
  const minutes = (d: Date) => (d.getTime() - dayStart.getTime()) / 60_000
  const dayLength = minutes(dayEnd)
  const blocks = items
    .filter((i) => overlaps(i.start, i.end, { start: dayStart, end: dayEnd }))
    .sort((a, b) => a.start.getTime() - b.start.getTime() || b.end.getTime() - a.end.getTime())
    .map((item) => {
      const top = Math.max(0, minutes(item.start))
      const bottom = Math.min(dayLength, Math.max(minutes(item.end), top + minHeight))
      return { item, top, height: bottom - top, column: 0, columns: 1 }
    })

  let group: typeof blocks = []
  let groupEnd = -1
  const columnEnds: number[] = []
  const flush = () => {
    for (const b of group) b.columns = columnEnds.length
    group = []
    columnEnds.length = 0
  }
  for (const b of blocks) {
    if (b.top >= groupEnd) flush()
    let col = columnEnds.findIndex((end) => end <= b.top)
    if (col < 0) col = columnEnds.length
    columnEnds[col] = b.top + b.height
    b.column = col
    group.push(b)
    groupEnd = Math.max(groupEnd, b.top + b.height)
  }
  flush()
  return blocks
}
