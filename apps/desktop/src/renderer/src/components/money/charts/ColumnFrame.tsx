import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { formatMonth } from '../ui'
import { formatAxisPence, labelEvery, niceTicks, shortMonth } from './scale'

/** Width of the element, following it as the window resizes (600 until it's measured). */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (el.clientWidth) setWidth(el.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => e?.contentRect.width && setWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

export interface Column {
  /** Left edge of the band, in pixels. */
  x: number
  /** Width of the band (the bars sit in its middle). */
  band: number
  /** Pixel y for a value in pence. */
  y: (pence: number) => number
}

export interface ColumnFrameProps {
  /** Names the chart for screen readers. */
  label: string
  /** One `YYYY-MM` per column, oldest first. */
  months: string[]
  /** The values the axis must reach, in pence (zero is always included). */
  min: number
  max: number
  height?: number
  /** Index of the chosen month, drawn with a highlight behind it. */
  selected?: number
  /** Clicking (or Return / Space on) a column. */
  onSelect?: (index: number) => void
  /** The marks for one column. */
  renderColumn: (index: number, c: Column) => ReactNode
  /** Drawn over the columns, e.g. a reference line. */
  renderOverlay?: (c: { left: number; right: number; y: (pence: number) => number }) => ReactNode
  /** Read out for a column on focus. */
  describe: (index: number) => string
  /** Shown on hover and focus. */
  tooltip: (index: number) => ReactNode
}

const LEFT = 48
const RIGHT = 8
const TOP = 10
const BOTTOM = 22

/**
 * The shared frame of a monthly column chart: a recessive grid with round £ ticks, month labels
 * thinned to fit, and one focusable column per month. Arrow keys move between months (one tab
 * stop for the whole chart); hovering or focusing a column shows its tooltip.
 */
export function ColumnFrame(props: ColumnFrameProps) {
  const { months, height = 180 } = props
  const [ref, width] = useWidth()
  const [active, setActive] = useState<number | null>(null)
  const [stop, setStop] = useState<number | null>(null)
  const cols = useRef<(SVGGElement | null)[]>([])

  const n = months.length
  const plotW = Math.max(0, width - LEFT - RIGHT)
  const plotH = height - TOP - BOTTOM
  const band = n ? plotW / n : 0
  const { lo, hi, ticks } = niceTicks(props.min, props.max)
  const y = (v: number) => TOP + ((hi - v) / (hi - lo)) * plotH
  const every = labelEvery(n, plotW)
  // Show the year under January and under the first label.
  // Labels count back from the latest month, so it always has one.
  const labelled = (i: number) => (n - 1 - i) % every === 0
  const firstLabel = (n - 1) % every
  const withYear = (i: number) => months[i]!.endsWith('-01') || (i === firstLabel && n > 1)
  const tabStop = stop ?? props.selected ?? n - 1

  const move = (e: KeyboardEvent, i: number) => {
    const to =
      e.key === 'ArrowRight'
        ? i + 1
        : e.key === 'ArrowLeft'
          ? i - 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : null
    if (to !== null) {
      e.preventDefault()
      const next = Math.max(0, Math.min(n - 1, to))
      setStop(next)
      cols.current[next]?.focus()
    } else if ((e.key === 'Enter' || e.key === ' ') && props.onSelect) {
      e.preventDefault()
      props.onSelect(i)
    }
  }

  // The tooltip sits beside its column (right of it, or left near the right edge), never over it.
  const tipSide = active !== null && LEFT + band * (active + 1) + 170 > width ? 'left' : 'right'
  const tipStyle =
    active === null
      ? {}
      : tipSide === 'right'
        ? { left: LEFT + band * (active + 1) + 4 }
        : { right: Math.max(0, width - (LEFT + band * active) + 4) }

  return (
    <div ref={ref} className="relative w-full">
      <svg
        width={width}
        height={height}
        role="group"
        aria-label={props.label}
        className="block overflow-visible"
      >
        {ticks.map((t) => (
          <g key={t} aria-hidden="true">
            <line
              x1={LEFT}
              x2={LEFT + plotW}
              y1={y(t)}
              y2={y(t)}
              className={t === 0 ? 'stroke-ink-3' : 'stroke-sep'}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
            <text
              x={LEFT - 6}
              y={y(t)}
              dy="0.32em"
              textAnchor="end"
              className="fill-ink-3 text-[10px] tabular-nums"
            >
              {formatAxisPence(t)}
            </text>
          </g>
        ))}
        {months.map((m, i) => {
          const x = LEFT + band * i
          return (
            <g
              key={m}
              ref={(el) => {
                cols.current[i] = el
              }}
              role={props.onSelect ? 'button' : 'img'}
              tabIndex={i === tabStop ? 0 : -1}
              aria-label={props.describe(i)}
              aria-pressed={props.onSelect ? props.selected === i : undefined}
              className="outline-none focus-visible:[&>.hit]:stroke-accent"
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive((a) => (a === i ? null : a))}
              onFocus={() => {
                setActive(i)
                setStop(i)
              }}
              onBlur={() => setActive((a) => (a === i ? null : a))}
              onClick={() => props.onSelect?.(i)}
              onKeyDown={(e) => move(e, i)}
            >
              <rect
                className={`hit ${
                  props.selected === i ? 'fill-selected' : active === i ? 'fill-hover' : 'fill-transparent'
                }`}
                x={x + 1}
                y={TOP}
                width={Math.max(0, band - 2)}
                height={plotH}
                rx={4}
                strokeWidth={1.5}
              />
              {props.renderColumn(i, { x, band, y })}
            </g>
          )
        })}
        {props.renderOverlay?.({ left: LEFT, right: LEFT + plotW, y })}
        {months.map((m, i) =>
          labelled(i) ? (
            <text
              key={m}
              aria-hidden="true"
              x={LEFT + band * (i + 0.5)}
              y={height - 6}
              textAnchor="middle"
              className={`text-[10px] ${props.selected === i ? 'fill-ink font-semibold' : 'fill-ink-3'}`}
            >
              {shortMonth(m, withYear(i))}
            </text>
          ) : null,
        )}
      </svg>
      {active !== null && months[active] && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 z-10 min-w-32 rounded-md border border-sep bg-field px-2.5 py-1.5 text-[12px] shadow-[0_4px_14px_rgb(0_0_0/0.12)]"
          style={tipStyle}
        >
          <div className="mb-1 text-[11px] text-ink-2">{formatMonth(months[active])}</div>
          {props.tooltip(active)}
        </div>
      )}
    </div>
  )
}

/** One line of a tooltip: the value first and strong, a short key in the series colour, then its name. */
export function TipRow({ swatch, label, value }: { swatch?: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 leading-5">
      <span className={`inline-block h-0.5 w-2.5 shrink-0 rounded-full ${swatch ?? 'bg-transparent'}`} />
      <span className="font-semibold tabular-nums">{value}</span>
      <span className="text-ink-2">{label}</span>
    </div>
  )
}
