import type { CalendarOverlayItem, DateRange } from '@ordo/shared'

/**
 * Where other modules plug items into the calendar. A source returns the overlay items
 * (bill due dates, renewals, trial ends...) that fall in a range; Calendar shows them
 * alongside events, styled by `kind`, and never treats them as calendar events.
 *
 * To add one, append to OVERLAY_SOURCES, e.g. Money:
 *   { id: 'money', name: 'Bills and renewals', load: (range) => window.ordo.money.dueDates(range) }
 */
export interface CalendarOverlaySource {
  id: string
  /** Shown in the calendar list. */
  name: string
  load(range: DateRange): Promise<CalendarOverlayItem[]>
}

export const OVERLAY_SOURCES: readonly CalendarOverlaySource[] = []

/** Items from every source in `range`. A failing source is skipped rather than hiding the rest. */
export async function loadOverlays(
  range: DateRange,
  sources: readonly CalendarOverlaySource[] = OVERLAY_SOURCES,
): Promise<CalendarOverlayItem[]> {
  const results = await Promise.allSettled(sources.map((s) => s.load(range)))
  return results
    .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .filter((i) => i.date >= range.start && i.date < range.end)
    .sort((a, b) => a.date.getTime() - b.date.getTime())
}

export const OVERLAY_LABELS: Record<CalendarOverlayItem['kind'], string> = {
  bill: 'Bill due',
  renewal: 'Renews',
  trial: 'Trial ends',
}

export function formatAmount(amount: CalendarOverlayItem['amount']): string | null {
  if (!amount) return null
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: amount.currency }).format(
      amount.value,
    )
  } catch {
    return `${amount.value} ${amount.currency}`
  }
}
