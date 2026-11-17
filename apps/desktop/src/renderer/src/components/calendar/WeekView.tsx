import { useEffect, useRef, useState } from 'react'
import { daysIn, isLong, layoutDay, sameDay, segments, type DateRange } from '@ordo/calendar-core'
import { ItemBar } from './ItemChips'
import { fill, formatHour, formatTime, ink, type CalendarItem, type OpenItem } from './model'

/** Pixels per minute in the time grid (48px an hour). */
const PX = 0.8
const GUTTER = 56
const LANE = 20

interface Props {
  range: DateRange
  today: Date
  items: CalendarItem[]
  onOpen: OpenItem
}

export function WeekView({ range, today, items, onOpen }: Props) {
  const days = daysIn(range)
  const long = items.filter((i) => isLong(i) || i.type === 'overlay')
  const timed = items.filter((i) => !long.includes(i))
  const segs = segments(long, days[0]!, days.length)
  const lanes = segs.reduce((n, s) => Math.max(n, s.lane + 1), 0)
  const scroller = useRef<HTMLDivElement>(null)
  const now = useNow()

  // Open scrolled to the working day, or to just before now if that's later.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const minutes = Math.max(7 * 60 + 30, new Date().getHours() * 60 - 90)
    el.scrollTop = Math.min(minutes, 24 * 60) * PX
  }, [])

  const cols = `${GUTTER}px repeat(${days.length}, minmax(0, 1fr))`
  return (
    // One scroller with a sticky header keeps the columns aligned whatever the scrollbar width.
    <div ref={scroller} className="h-full min-h-0 overflow-y-auto" aria-label="Week">
      <div className="sticky top-0 z-30 bg-content">
        <div className="grid border-b border-sep" style={{ gridTemplateColumns: cols }}>
          <div />
          {days.map((d) => {
            const isToday = sameDay(d, today)
            return (
              <div
                key={d.getTime()}
                role="columnheader"
                aria-current={isToday ? 'date' : undefined}
                className="flex items-center justify-center gap-1.5 py-2 text-[13px]"
              >
                <span className={isToday ? 'font-medium text-accent' : 'text-ink-2'}>
                  {d.toLocaleDateString(undefined, { weekday: 'short' })}
                </span>
                <span
                  className={`flex h-[24px] min-w-[24px] items-center justify-center rounded-full px-1 tabular-nums ${
                    isToday ? 'bg-accent font-semibold text-white' : 'font-medium'
                  }`}
                >
                  {d.getDate()}
                </span>
              </div>
            )
          })}
        </div>

        <div
          className="grid border-b border-sep shadow-[0_1px_2px_rgb(0_0_0/0.04)]"
          style={{ gridTemplateColumns: cols, gridTemplateRows: `repeat(${Math.max(lanes, 1)}, ${LANE}px)` }}
          aria-label="All-day"
        >
          <div
            className="flex items-center justify-end pr-2 text-[10px] text-ink-3"
            style={{ gridColumn: 1, gridRow: `1 / span ${Math.max(lanes, 1)}` }}
          >
            all-day
          </div>
          {segs.map((s) => (
            <div
              key={s.item.key}
              className="min-w-0 px-[3px] pt-px"
              style={{ gridColumn: `${s.col + 2} / span ${s.span}`, gridRow: s.lane + 1 }}
            >
              <ItemBar
                item={s.item}
                onOpen={onOpen}
                continuesBefore={s.continuesBefore}
                continuesAfter={s.continuesAfter}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="relative grid" style={{ gridTemplateColumns: cols, height: 24 * 60 * PX }}>
        <div className="relative">
          {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
            <span
              key={h}
              className="absolute right-2 -translate-y-1/2 text-[10px] tabular-nums text-ink-3"
              style={{ top: h * 60 * PX }}
            >
              {formatHour(h)}
            </span>
          ))}
        </div>
        {days.map((d) => (
          <DayColumn
            key={d.getTime()}
            day={d}
            items={timed}
            now={sameDay(d, now) ? now : null}
            onOpen={onOpen}
          />
        ))}
        {/* Hour lines across every day. */}
        <div className="pointer-events-none absolute inset-0" style={{ left: GUTTER }} aria-hidden="true">
          {Array.from({ length: 23 }, (_, i) => (
            <div
              key={i}
              className="absolute inset-x-0 border-t border-sep"
              style={{ top: (i + 1) * 60 * PX }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function DayColumn({
  day,
  items,
  now,
  onOpen,
}: {
  day: Date
  items: CalendarItem[]
  now: Date | null
  onOpen: OpenItem
}) {
  const weekend = day.getDay() === 0 || day.getDay() === 6
  const blocks = layoutDay(items, day, 20)
  return (
    <div
      className={`relative border-l border-sep ${weekend ? 'bg-black/[0.018] dark:bg-white/[0.025]' : ''}`}
      aria-label={day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
    >
      {blocks.map(({ item, top, height, column, columns }) => {
        const color = item.type === 'event' ? item.color : 'var(--ink-3)'
        const compact = height * PX < 34
        return (
          <button
            key={item.key}
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onOpen(item, e.currentTarget.getBoundingClientRect())
            }}
            className="absolute z-10 flex overflow-hidden rounded-[5px] border-l-[3px] px-1.5 py-0.5 text-left text-[11px] leading-tight hover:brightness-95 dark:hover:brightness-125"
            style={{
              top: top * PX + 1,
              height: height * PX - 2,
              left: `calc(${(column / columns) * 100}% + 2px)`,
              width: `calc(${100 / columns}% - 4px)`,
              background: fill(color, 22),
              borderColor: color,
              color: ink(color),
              flexDirection: compact ? 'row' : 'column',
              gap: compact ? 4 : 0,
            }}
          >
            <span className="truncate font-semibold">{item.title}</span>
            {/* Short items show their title only; the time is in the popover. */}
            <span className={compact ? 'hidden' : 'truncate opacity-80'}>
              {formatTime(item.start)}
              {!compact && item.type === 'event' && item.event.location ? ` · ${item.event.location}` : ''}
            </span>
          </button>
        )
      })}
      {now && (
        <div
          className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-danger"
          style={{ top: (now.getHours() * 60 + now.getMinutes()) * PX }}
          aria-hidden="true"
        >
          <span className="absolute -left-[5px] -top-[5px] size-2 rounded-full bg-danger" />
        </div>
      )}
    </div>
  )
}

/** The current time, updated every minute. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])
  return now
}
