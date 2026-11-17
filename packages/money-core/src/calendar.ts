import { cyclesBetween, type ISODate } from './dates'
import type { Bill } from './types'

export interface BillCalendarItem {
  id: string
  date: ISODate
  title: string
  kind: 'bill' | 'renewal' | 'trial'
  /** Pence; absent for trial reminders. */
  amount?: number
}

/**
 * Due dates of active bills within `range` (inclusive), for the Calendar module.
 * Yearly bills show as renewals; an email saying a trial is ending shows on its day.
 */
export function billsToCalendarItems(
  bills: Bill[],
  range: { from: ISODate; to: ISODate },
): BillCalendarItem[] {
  const items: BillCalendarItem[] = []
  for (const b of bills) {
    if (b.status !== 'active') continue
    for (const date of cyclesBetween(b.nextDue, b.cadence, range.from, range.to))
      items.push({
        id: `${b.id}:${date}`,
        date,
        title: b.name,
        kind: b.cadence === 'yearly' ? 'renewal' : 'bill',
        amount: b.amount,
      })
    if (b.trialEnding && b.trialEnding >= range.from && b.trialEnding <= range.to)
      items.push({ id: `${b.id}:trial`, date: b.trialEnding, title: `${b.name} trial ending`, kind: 'trial' })
  }
  return items.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title))
}
