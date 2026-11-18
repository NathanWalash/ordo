import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { daysIn, isLong, layoutDay, sameDay, segments, type DateRange } from '@ordo/calendar-core'
import { ItemBar } from './ItemChips'
import { nudged, nudgeFor, snap, SNAP } from './editing'
import { fill, formatHour, formatTime, ink, type CalendarItem, type OpenItem } from './model'

/** Pixels per minute in the time grid (48px an hour). */
const PX = 0.8
const GUTTER = 56
const LANE = 20
/** A keyboard move is saved once the keys have been still this long. */
const KEY_SETTLE_MS = 900

/** A move in progress, by drag or keys, shown before it's saved. */
interface Pending {
  key: string
  days: number
  minutes: number
  resize: number
}

interface Props {
  range: DateRange
  today: Date
  items: CalendarItem[]
  onOpen: OpenItem
  /** Double-click on an empty slot (or the all-day row) to create an event there. */
  onCreate?: (at: Date, allDay: boolean) => void
  /** Double-click on an event to edit it. */
  onEditItem?: (item: CalendarItem) => void
  /** Which timed events can be dragged or moved with the keyboard. */
  canMove?: (item: CalendarItem) => boolean
  onMove?: (item: CalendarItem, span: { start: Date; end: Date }) => void
}

export function WeekView({ range, today, items, onOpen, onCreate, onEditItem, canMove, onMove }: Props) {
  const days = daysIn(range)
  const long = items.filter((i) => isLong(i) || i.type === 'overlay')
  const timed = items.filter((i) => !long.includes(i))
  const segs = segments(long, days[0]!, days.length)
  const lanes = segs.reduce((n, s) => Math.max(n, s.lane + 1), 0)
  const scroller = useRef<HTMLDivElement>(null)
  const grid = useRef<HTMLDivElement>(null)
  const now = useNow()
  const hintId = useId()
  const [pending, setPending] = useState<Pending | null>(null)
  const [announce, setAnnounce] = useState('')
  const pendingRef = useRef<Pending | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The click that ends a drag mustn't also open the popover. */
  const dragged = useRef(false)

  const show = (p: Pending | null) => {
    pendingRef.current = p
    setPending(p)
  }

  // Open scrolled to the working day, or to just before now if that's later.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const minutes = Math.max(7 * 60 + 30, new Date().getHours() * 60 - 90)
    el.scrollTop = Math.min(minutes, 24 * 60) * PX
  }, [])

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  const columnWidth = () => {
    const w = grid.current?.getBoundingClientRect().width ?? 0
    return Math.max(1, (w - GUTTER) / days.length)
  }

  /** Save the move shown for `item`, if it actually moved. */
  const commit = useCallback(
    (item: CalendarItem) => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      const p = pendingRef.current
      show(null)
      if (!p || p.key !== item.key || (!p.days && !p.minutes && !p.resize)) return
      onMove?.(item, nudged(item, p))
    },
    [onMove],
  )

  const startDrag = (e: ReactPointerEvent<HTMLElement>, item: CalendarItem, mode: 'move' | 'resize') => {
    if (e.button !== 0 || !canMove?.(item)) return
    e.stopPropagation()
    const el = e.currentTarget
    const origin = { x: e.clientX, y: e.clientY }
    const width = columnWidth()
    let moving = false
    el.setPointerCapture?.(e.pointerId)
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - origin.x
      const dy = ev.clientY - origin.y
      if (!moving && Math.hypot(dx, dy) < 4) return
      moving = true
      const minutes = snap(dy / PX)
      show(
        mode === 'move'
          ? { key: item.key, days: Math.round(dx / width), minutes, resize: 0 }
          : { key: item.key, days: 0, minutes: 0, resize: minutes },
      )
    }
    const end = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', end)
      el.removeEventListener('pointercancel', cancel)
      if (moving) {
        dragged.current = true
        setTimeout(() => (dragged.current = false), 0)
        commit(item)
      }
    }
    const cancel = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', end)
      el.removeEventListener('pointercancel', cancel)
      show(null)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', end)
    el.addEventListener('pointercancel', cancel)
  }

  const onKey = (e: KeyboardEvent<HTMLElement>, item: CalendarItem) => {
    if (e.key === 'Escape' && pendingRef.current?.key === item.key) {
      e.stopPropagation()
      if (timer.current) clearTimeout(timer.current)
      show(null)
      setAnnounce('Move cancelled.')
      return
    }
    const n = nudgeFor(e)
    if (!n || !canMove?.(item)) return
    e.preventDefault()
    const was =
      pendingRef.current?.key === item.key
        ? pendingRef.current
        : { key: item.key, days: 0, minutes: 0, resize: 0 }
    const next = {
      key: item.key,
      days: was.days + (n.days ?? 0),
      minutes: was.minutes + (n.minutes ?? 0),
      resize: Math.max(
        SNAP - (item.end.getTime() - item.start.getTime()) / 60_000,
        was.resize + (n.resize ?? 0),
      ),
    }
    show(next)
    const span = nudged(item, next)
    setAnnounce(
      `${item.title}: ${span.start.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}, ${formatTime(span.start)} to ${formatTime(span.end)}. Saves in a moment.`,
    )
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => commit(item), KEY_SETTLE_MS)
  }

  const cols = `${GUTTER}px repeat(${days.length}, minmax(0, 1fr))`
  return (
    // One scroller with a sticky header keeps the columns aligned whatever the scrollbar width.
    <div ref={scroller} className="h-full min-h-0 overflow-y-auto" aria-label="Week">
      <span id={hintId} className="sr-only">
        Option and the arrow keys move this event by 15 minutes or a day. Add Shift to change how long it is.
      </span>
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
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
          {onCreate &&
            days.map((d, i) => (
              <div
                key={`slot-${d.getTime()}`}
                data-testid="all-day-slot"
                onDoubleClick={() => onCreate(d, true)}
                style={{ gridColumn: i + 2, gridRow: `1 / span ${Math.max(lanes, 1)}` }}
              />
            ))}
          {segs.map((s) => (
            <div
              key={s.item.key}
              className="min-w-0 px-[3px] pt-px"
              style={{ gridColumn: `${s.col + 2} / span ${s.span}`, gridRow: s.lane + 1 }}
            >
              <ItemBar
                item={s.item}
                onOpen={onOpen}
                onEdit={onEditItem}
                continuesBefore={s.continuesBefore}
                continuesAfter={s.continuesAfter}
              />
            </div>
          ))}
        </div>
      </div>

      <div ref={grid} className="relative grid" style={{ gridTemplateColumns: cols, height: 24 * 60 * PX }}>
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
            onOpen={(item, anchor) => {
              if (dragged.current) {
                dragged.current = false
                return
              }
              onOpen(item, anchor)
            }}
            onCreate={onCreate}
            onEditItem={onEditItem}
            canMove={canMove}
            pending={pending}
            columnWidth={columnWidth}
            hintId={hintId}
            onPointerDown={startDrag}
            onKey={onKey}
            onBlurItem={(item) => pendingRef.current?.key === item.key && commit(item)}
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
  onCreate,
  onEditItem,
  canMove,
  pending,
  columnWidth,
  hintId,
  onPointerDown,
  onKey,
  onBlurItem,
}: {
  day: Date
  items: CalendarItem[]
  now: Date | null
  onOpen: OpenItem
  onCreate?: (at: Date, allDay: boolean) => void
  onEditItem?: (item: CalendarItem) => void
  canMove?: (item: CalendarItem) => boolean
  pending: Pending | null
  columnWidth: () => number
  hintId: string
  onPointerDown: (e: ReactPointerEvent<HTMLElement>, item: CalendarItem, mode: 'move' | 'resize') => void
  onKey: (e: KeyboardEvent<HTMLElement>, item: CalendarItem) => void
  onBlurItem: (item: CalendarItem) => void
}) {
  const weekend = day.getDay() === 0 || day.getDay() === 6
  const blocks = layoutDay(items, day, 20)
  return (
    <div
      className={`relative border-l border-sep ${weekend ? 'bg-black/[0.018] dark:bg-white/[0.025]' : ''}`}
      aria-label={day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
      onDoubleClick={(e) => {
        if (!onCreate || e.target !== e.currentTarget) return
        const minutes = Math.floor((e.clientY - e.currentTarget.getBoundingClientRect().top) / PX / 30) * 30
        const at = new Date(day)
        at.setMinutes(Math.max(0, Math.min(23 * 60 + 30, minutes)))
        onCreate(at, false)
      }}
    >
      {blocks.map(({ item, top, height, column, columns }) => {
        const color = item.type === 'event' ? item.color : 'var(--ink-3)'
        const p = pending?.key === item.key ? pending : null
        const movable = canMove?.(item) ?? false
        const shownTop = top + (p?.minutes ?? 0)
        const shownHeight = Math.max(SNAP, height + (p?.resize ?? 0))
        const compact = shownHeight * PX < 34
        const shownStart = p ? nudged(item, p).start : item.start
        return (
          <button
            key={item.key}
            type="button"
            data-testid="week-event"
            aria-describedby={movable ? hintId : undefined}
            aria-keyshortcuts={movable ? 'Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight' : undefined}
            onClick={(e) => {
              e.stopPropagation()
              onOpen(item, e.currentTarget.getBoundingClientRect())
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              onEditItem?.(item)
            }}
            onPointerDown={(e) => onPointerDown(e, item, 'move')}
            onKeyDown={(e) => onKey(e, item)}
            onBlur={() => onBlurItem(item)}
            className={`absolute flex overflow-hidden rounded-[5px] border-l-[3px] px-1.5 py-0.5 text-left text-[11px] leading-tight hover:brightness-95 dark:hover:brightness-125 ${
              p ? 'z-20 shadow-[0_4px_12px_rgb(0_0_0/0.18)] ring-1 ring-accent' : 'z-10'
            } ${movable ? 'touch-none' : ''}`}
            style={{
              top: shownTop * PX + 1,
              height: shownHeight * PX - 2,
              left: `calc(${(column / columns) * 100}% + 2px)`,
              width: `calc(${100 / columns}% - 4px)`,
              transform: p?.days ? `translateX(${p.days * columnWidth()}px)` : undefined,
              background: fill(color, p ? 34 : 22),
              borderColor: color,
              color: ink(color),
              flexDirection: compact ? 'row' : 'column',
              gap: compact ? 4 : 0,
            }}
          >
            <span className="truncate font-semibold">{item.title}</span>
            {/* Short items show their title only; the time is in the popover. */}
            <span className={compact ? 'hidden' : 'truncate opacity-80'}>
              {formatTime(shownStart)}
              {!compact && item.type === 'event' && item.event.location ? ` · ${item.event.location}` : ''}
            </span>
            {movable && (
              <span
                aria-hidden="true"
                data-testid="resize-handle"
                onPointerDown={(e) => onPointerDown(e, item, 'resize')}
                className="absolute inset-x-0 bottom-0 h-[6px] cursor-ns-resize"
              />
            )}
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
