import { useEffect, useRef, useState } from 'react'
import { daysIn, isLong, sameDay, segments, type DateRange } from '@ordo/calendar-core'
import { ItemBar, TimedRow, type EditItem } from './ItemChips'
import type { CalendarItem, OpenItem } from './model'

const HEADER = 27
const LANE = 19

interface Props {
  range: DateRange
  /** Any day in the month being shown; other days are dimmed. */
  cursor: Date
  today: Date
  items: CalendarItem[]
  onOpen: OpenItem
  onShowDay: (day: Date) => void
  /** Double-click an empty part of a day to create an event on it. */
  onCreate?: (day: Date) => void
  onEditItem?: EditItem
}

export function MonthView({ range, cursor, today, items, onOpen, onShowDay, onCreate, onEditItem }: Props) {
  const days = daysIn(range)
  const weeks = Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7))
  const grid = useRef<HTMLDivElement>(null)
  const [rowHeight, setRowHeight] = useState(120)

  useEffect(() => {
    const el = grid.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => entry && setRowHeight(entry.contentRect.height / weeks.length))
    ro.observe(el)
    return () => ro.disconnect()
  }, [weeks.length])

  const maxLanes = Math.max(1, Math.floor((rowHeight - HEADER - 4) / LANE))

  return (
    <div className="isolate flex h-full min-h-0 flex-col" role="grid" aria-label="Month">
      <div className="grid shrink-0 grid-cols-7 border-b border-sep" role="row">
        {weeks[0]!.map((d) => (
          <div
            key={d.getDay()}
            role="columnheader"
            className="px-2 py-1.5 text-right text-[11px] font-medium text-ink-2"
          >
            {d.toLocaleDateString(undefined, { weekday: 'short' })}
          </div>
        ))}
      </div>
      <div ref={grid} className="flex min-h-0 flex-1 flex-col">
        {weeks.map((week) => (
          <WeekRow
            key={week[0]!.getTime()}
            week={week}
            month={cursor.getMonth()}
            today={today}
            items={items}
            maxLanes={maxLanes}
            onOpen={onOpen}
            onShowDay={onShowDay}
            onCreate={onCreate}
            onEditItem={onEditItem}
          />
        ))}
      </div>
    </div>
  )
}

function WeekRow(props: {
  week: Date[]
  month: number
  today: Date
  items: CalendarItem[]
  maxLanes: number
  onOpen: OpenItem
  onShowDay: (day: Date) => void
  onCreate?: (day: Date) => void
  onEditItem?: EditItem
}) {
  const { week, month, today, items, maxLanes, onOpen, onShowDay, onCreate, onEditItem } = props
  const segs = segments(items, week[0]!)
  const lanes = segs.reduce((n, s) => Math.max(n, s.lane + 1), 0)
  // When everything doesn't fit, the last visible lane becomes "+N more".
  const shown = lanes <= maxLanes ? lanes : maxLanes - 1
  const hidden = week.map(
    (_, col) => segs.filter((s) => s.lane >= shown && s.col <= col && col < s.col + s.span).length,
  )

  return (
    <div
      role="row"
      className="relative grid min-h-0 flex-1 grid-cols-7 border-b border-sep last:border-b-0"
      style={{ gridTemplateRows: `${HEADER}px repeat(${Math.max(maxLanes, 1)}, ${LANE}px) 1fr` }}
    >
      {week.map((day, col) => {
        const isToday = sameDay(day, today)
        const weekend = day.getDay() === 0 || day.getDay() === 6
        return (
          <div
            key={col}
            role="gridcell"
            aria-label={day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
            aria-current={isToday ? 'date' : undefined}
            className={`flex justify-end border-r border-sep px-1.5 pt-1 last:border-r-0 ${
              weekend ? 'bg-black/[0.018] dark:bg-white/[0.025]' : ''
            }`}
            style={{ gridColumn: col + 1, gridRow: '1 / -1' }}
            onDoubleClick={(e) => e.target === e.currentTarget && onCreate?.(day)}
          >
            <button
              type="button"
              onClick={() => onShowDay(day)}
              title="Show this week"
              className={`flex h-[22px] min-w-[22px] items-center justify-center rounded-full px-1 text-[12px] tabular-nums ${
                isToday
                  ? 'bg-accent font-semibold text-white'
                  : day.getMonth() === month
                    ? 'text-ink hover:bg-hover'
                    : 'text-ink-3 hover:bg-hover'
              }`}
            >
              {day.getDate() === 1 && !isToday
                ? day.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
                : day.getDate()}
            </button>
          </div>
        )
      })}
      {segs
        .filter((s) => s.lane < shown)
        .map((s) => (
          <div
            key={s.item.key}
            className="z-10 min-w-0 px-[3px] pt-px"
            style={{ gridColumn: `${s.col + 1} / span ${s.span}`, gridRow: s.lane + 2 }}
          >
            {isLong(s.item) || s.span > 1 || s.item.type === 'overlay' ? (
              <ItemBar
                item={s.item}
                onOpen={onOpen}
                onEdit={onEditItem}
                continuesBefore={s.continuesBefore}
                continuesAfter={s.continuesAfter}
              />
            ) : (
              <TimedRow item={s.item} onOpen={onOpen} onEdit={onEditItem} />
            )}
          </div>
        ))}
      {hidden.map(
        (n, col) =>
          n > 0 && (
            <div
              key={`more-${col}`}
              className="z-10 min-w-0 px-[3px]"
              style={{ gridColumn: col + 1, gridRow: shown + 2 }}
            >
              <button
                type="button"
                onClick={() => onShowDay(week[col]!)}
                className="h-[18px] w-full rounded-[4px] px-1 text-left text-[11px] font-medium text-ink-2 hover:bg-hover"
              >
                {n} more
              </button>
            </div>
          ),
      )}
    </div>
  )
}
