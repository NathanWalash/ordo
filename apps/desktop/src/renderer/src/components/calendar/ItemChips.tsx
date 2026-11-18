import type { MouseEvent } from 'react'
import { Hourglass, Receipt, RefreshCw, SquareKanban } from 'lucide-react'
import type { CalendarOverlayItem } from '@ordo/shared'
import { fill, formatTimeShort, ink, type CalendarItem, type OpenItem } from './model'
import { formatAmount } from './overlays'

export function OverlayIcon({ kind, size = 11 }: { kind: CalendarOverlayItem['kind']; size?: number }) {
  const Icon =
    kind === 'bill' ? Receipt : kind === 'renewal' ? RefreshCw : kind === 'card' ? SquareKanban : Hourglass
  return <Icon size={size} className="shrink-0" aria-hidden="true" />
}

const open = (onOpen: OpenItem, item: CalendarItem) => (e: MouseEvent<HTMLElement>) => {
  e.stopPropagation()
  onOpen(item, e.currentTarget.getBoundingClientRect())
}

/**
 * A bar for all-day and multi-day items. Square ends show it carries on from or into the
 * neighbouring week. Overlay items get a dashed outline so they never look like events.
 */
export function ItemBar({
  item,
  onOpen,
  continuesBefore = false,
  continuesAfter = false,
}: {
  item: CalendarItem
  onOpen: OpenItem
  continuesBefore?: boolean
  continuesAfter?: boolean
}) {
  const radius = `${continuesBefore ? 'rounded-l-none' : 'rounded-l-[4px]'} ${continuesAfter ? 'rounded-r-none' : 'rounded-r-[4px]'}`
  if (item.type === 'overlay') {
    const amount = formatAmount(item.overlay.amount)
    return (
      <button
        type="button"
        onClick={open(onOpen, item)}
        className={`flex h-[18px] w-full min-w-0 items-center gap-1 border border-dashed border-ink-3 px-1.5 text-left text-[11px] font-medium text-ink-2 hover:bg-hover ${radius}`}
      >
        <OverlayIcon kind={item.overlay.kind} />
        <span className="truncate">{item.title}</span>
        {amount && <span className="ml-auto shrink-0 tabular-nums text-ink-3">{amount}</span>}
      </button>
    )
  }
  return (
    <button
      type="button"
      onClick={open(onOpen, item)}
      className={`flex h-[18px] w-full min-w-0 items-center px-1.5 text-left text-[11px] font-medium hover:brightness-95 dark:hover:brightness-125 ${radius}`}
      style={{ background: fill(item.color, 24), color: ink(item.color) }}
    >
      <span className="truncate">{item.title}</span>
    </button>
  )
}

/** A timed event inside a month cell: coloured dot, start time, title. */
export function TimedRow({ item, onOpen }: { item: CalendarItem; onOpen: OpenItem }) {
  const color = item.type === 'event' ? item.color : 'var(--ink-3)'
  return (
    <button
      type="button"
      onClick={open(onOpen, item)}
      className="flex h-[18px] w-full min-w-0 items-center gap-1 rounded-[4px] px-1 text-left text-[11px] hover:bg-hover"
    >
      <span className="size-[7px] shrink-0 rounded-full" style={{ background: color }} aria-hidden="true" />
      <span className="truncate">{item.title}</span>
      <span className="ml-auto shrink-0 pl-1 tabular-nums text-ink-3">{formatTimeShort(item.start)}</span>
    </button>
  )
}
