import { useEffect, useRef } from 'react'
import { CalendarDays } from 'lucide-react'
import { daysIn, onDay, sameDay, type DateRange } from '@ordo/calendar-core'
import { EmptyState } from '../EmptyState'
import { OverlayIcon } from './ItemChips'
import { formatTime, type CalendarItem, type OpenItem } from './model'
import { formatAmount, OVERLAY_LABELS } from './overlays'

interface Props {
  range: DateRange
  today: Date
  items: CalendarItem[]
  onOpen: OpenItem
}

/** A list of the days in range that have something on, each with its items in time order. */
export function AgendaView({ range, today, items, onOpen }: Props) {
  const days = daysIn(range)
    .map((day) => ({ day, items: onDay(items, day) }))
    .filter((d) => d.items.length > 0)
  // Open at today (or the next day with something on) when it's in this month.
  const focus = days.find((d) => d.day >= today && range.start <= today)?.day.getTime()
  const focusRef = useRef<HTMLElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  // Scroll only the list itself; scrollIntoView would also scroll the app's outer containers.
  useEffect(() => {
    if (scroller.current && focusRef.current) scroller.current.scrollTop = focusRef.current.offsetTop - 20
  }, [focus])
  if (days.length === 0)
    return (
      <EmptyState
        icon={<CalendarDays size={40} strokeWidth={1.5} />}
        title="Nothing scheduled"
        body={`No events in ${range.start.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}.`}
      />
    )
  return (
    <div ref={scroller} className="relative h-full overflow-y-auto" aria-label="Agenda">
      <div className="mx-auto max-w-3xl px-6 pb-8">
        {days.map(({ day, items }) => {
          const isToday = sameDay(day, today)
          return (
            <section
              key={day.getTime()}
              ref={day.getTime() === focus ? focusRef : undefined}
              aria-label={day.toDateString()}
              className="mt-5"
            >
              <h3 className="sticky top-0 z-10 flex items-baseline gap-2 border-b border-sep bg-content pb-1.5 pt-2 text-[13px] font-semibold">
                <span className={isToday ? 'text-accent' : ''}>
                  {day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
                </span>
                {isToday && <span className="text-[11px] font-medium text-accent">Today</span>}
              </h3>
              <ul className="mt-1">
                {items.map((item) => (
                  <li key={item.key}>
                    <AgendaRow item={item} day={day} onOpen={onOpen} />
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function AgendaRow({ item, day, onOpen }: { item: CalendarItem; day: Date; onOpen: OpenItem }) {
  const color = item.type === 'event' ? item.color : 'var(--ink-3)'
  const startsToday = sameDay(item.start, day)
  const when = item.allDay
    ? 'All day'
    : startsToday
      ? formatTime(item.start)
      : `Until ${formatTime(item.end)}`
  const detail =
    item.type === 'event'
      ? [item.event.location, item.calendar?.name].filter(Boolean).join(' · ')
      : [OVERLAY_LABELS[item.overlay.kind], item.overlay.detail, formatAmount(item.overlay.amount)]
          .filter(Boolean)
          .join(' · ')
  return (
    <button
      type="button"
      onClick={(e) => onOpen(item, e.currentTarget.getBoundingClientRect())}
      className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-hover"
    >
      <span className="w-[72px] shrink-0 text-right text-[12px] tabular-nums text-ink-2">{when}</span>
      {item.type === 'overlay' ? (
        <span className="flex w-[3px] shrink-0 justify-center text-ink-2">
          <OverlayIcon kind={item.overlay.kind} size={13} />
        </span>
      ) : (
        <span
          className="h-8 w-[3px] shrink-0 rounded-full"
          style={{ background: color }}
          aria-hidden="true"
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{item.title}</span>
        {detail && <span className="block truncate text-[12px] text-ink-2">{detail}</span>}
      </span>
      {!item.allDay && startsToday && (
        <span className="shrink-0 text-[12px] tabular-nums text-ink-3">{formatTime(item.end)}</span>
      )}
    </button>
  )
}
