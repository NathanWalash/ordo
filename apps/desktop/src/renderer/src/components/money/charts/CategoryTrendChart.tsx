import { formatPence, type CategorySeries, type MonthFlow } from '@ordo/money-core'
import { formatMonth } from '../ui'
import { ColumnFrame, TipRow } from './ColumnFrame'
import { partialNote } from './MonthlyFlowChart'
import { barPath } from './scale'

/** How a month compares with the usual, in words: `£12.00 more than usual`. */
export function againstUsual(amount: number, usual: number | null): string | null {
  if (usual === null) return null
  const d = amount - usual
  return d === 0 ? 'the same as usual' : `${formatPence(Math.abs(d))} ${d > 0 ? 'more' : 'less'} than usual`
}

/** One sentence for the chart's label. */
export function summariseTrend(series: CategorySeries, months: MonthFlow[]): string {
  const peak = series.monthly.reduce((best, v, i) => (v > series.monthly[best]! ? i : best), 0)
  return (
    `${series.category} spending by month. ` +
    (series.usual === null
      ? 'Not enough whole months yet to know your usual. '
      : `Usual month ${formatPence(series.usual)}. `) +
    (series.total
      ? `Most in ${formatMonth(months[peak]!.month)}, ${formatPence(series.monthly[peak]!)}.`
      : '')
  )
}

/**
 * One category's spending month by month, with a line at the usual (median) whole month. Months
 * only partly covered are paler and never count towards the usual.
 */
export function CategoryTrendChart({
  series,
  months,
  selected,
  onSelect,
}: {
  series: CategorySeries
  /** The same months as `series.monthly`, for their dates and whether they're partial. */
  months: MonthFlow[]
  selected?: string
  onSelect?: (month: string) => void
}) {
  if (!months.length) return <p className="px-4 py-6 text-ink-2">No months to show yet.</p>
  const index = selected ? months.findIndex((m) => m.month === selected) : -1
  const { usual, monthly } = series
  const max = Math.max(usual ?? 0, ...monthly)
  return (
    <ColumnFrame
      label={summariseTrend(series, months)}
      months={months.map((m) => m.month)}
      min={0}
      max={max}
      selected={index >= 0 ? index : undefined}
      onSelect={onSelect && ((i) => onSelect(months[i]!.month))}
      describe={(i) => {
        const note = partialNote(months[i]!)
        const vs = !note && againstUsual(monthly[i]!, usual)
        return `${formatMonth(months[i]!.month)}${note ? ` (${note})` : ''}: ${formatPence(monthly[i]!)}${vs ? `, ${vs}` : ''}`
      }}
      tooltip={(i) => {
        const note = partialNote(months[i]!)
        const vs = !note && againstUsual(monthly[i]!, usual)
        return (
          <>
            <TipRow swatch="bg-accent" label={series.category} value={formatPence(monthly[i]!)} />
            {usual !== null && <TipRow swatch="bg-ink-2" label="usual month" value={formatPence(usual)} />}
            {vs && <div className="mt-1 text-[11px] text-ink-2">{vs[0]!.toUpperCase() + vs.slice(1)}</div>}
            {note && <div className="mt-1 text-[11px] text-ink-3">Part month: {note}</div>}
          </>
        )
      }}
      renderColumn={(i, { x, band, y }) => {
        const w = Math.max(2, Math.min(24, band * 0.55))
        const v = monthly[i]!
        const end = v ? Math.min(y(v), y(0) - 1.5) : y(0)
        return (
          <path
            aria-hidden="true"
            d={barPath(x + (band - w) / 2, w, y(0), end)}
            className="fill-accent"
            fillOpacity={months[i]!.partial ? 0.45 : 1}
          />
        )
      }}
      renderOverlay={
        usual === null
          ? undefined
          : ({ left, right, y }) => (
              <g aria-hidden="true" className="pointer-events-none">
                <line
                  x1={left}
                  x2={right}
                  y1={y(usual)}
                  y2={y(usual)}
                  className="stroke-ink-2"
                  strokeWidth={1.5}
                />
                <text
                  x={right}
                  y={y(usual) - 5}
                  textAnchor="end"
                  className="fill-ink-2 stroke-content text-[11px] font-medium [paint-order:stroke]"
                  strokeWidth={3}
                >
                  Usual {formatPence(usual)}
                </text>
              </g>
            )
      }
    />
  )
}
