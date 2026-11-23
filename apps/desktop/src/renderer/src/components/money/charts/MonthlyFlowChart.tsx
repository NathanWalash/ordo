import { formatPence, type MonthFlow } from '@ordo/money-core'
import { formatMonth } from '../ui'
import { ColumnFrame, TipRow } from './ColumnFrame'
import { barPath } from './scale'

const signed = (p: number) => (p > 0 ? '+' : '') + formatPence(p)

export const partialNote = (m: MonthFlow) =>
  m.partial === 'to-date' ? 'so far' : m.partial === 'start' ? 'from when your statements start' : null

/** The month in words for a screen reader: in, out and net. */
export function describeFlow(m: MonthFlow): string {
  const note = partialNote(m)
  return (
    `${formatMonth(m.month)}${note ? ` (${note})` : ''}: ` +
    `${formatPence(m.moneyIn)} in, ${formatPence(m.moneyOut)} out, net ${signed(m.net)}`
  )
}

/** One sentence summing up the chart, for its label. */
export function summariseFlows(months: MonthFlow[]): string {
  if (!months.length) return 'Money in and out by month: no months yet.'
  const behind = months.filter((m) => m.net < 0).length
  const span =
    months.length === 1
      ? formatMonth(months[0]!.month)
      : `${formatMonth(months[0]!.month)} to ${formatMonth(months.at(-1)!.month)}`
  return (
    `Money in and out by month, ${span}. ` +
    (behind
      ? `More went out than came in for ${behind} of ${months.length} month${months.length === 1 ? '' : 's'}.`
      : 'More came in than went out every month.')
  )
}

/**
 * Money in above the line and money out below it, month by month, with a dot for the net. The net
 * shares the same axis, so a month where more went out sits below zero.
 */
export function MonthlyFlowChart({
  months,
  selected,
  onSelect,
}: {
  months: MonthFlow[]
  /** `YYYY-MM` of the chosen month, if any. */
  selected?: string
  onSelect?: (month: string) => void
}) {
  if (!months.length) return <p className="px-4 py-6 text-ink-2">No months to show yet.</p>
  const index = selected ? months.findIndex((m) => m.month === selected) : -1
  const maxIn = Math.max(0, ...months.map((m) => Math.max(m.moneyIn, m.net)))
  const minOut = Math.min(0, ...months.map((m) => Math.min(-m.moneyOut, m.net)))
  return (
    <ColumnFrame
      label={summariseFlows(months)}
      months={months.map((m) => m.month)}
      min={minOut}
      max={maxIn}
      height={200}
      selected={index >= 0 ? index : undefined}
      onSelect={onSelect && ((i) => onSelect(months[i]!.month))}
      describe={(i) => describeFlow(months[i]!)}
      tooltip={(i) => {
        const m = months[i]!
        const note = partialNote(m)
        return (
          <>
            <TipRow swatch="bg-success" label="in" value={formatPence(m.moneyIn)} />
            <TipRow swatch="bg-accent" label="out" value={formatPence(m.moneyOut)} />
            <TipRow swatch="bg-ink" label="net" value={signed(m.net)} />
            {m.spent !== m.moneyOut && <TipRow label="of it spending" value={formatPence(m.spent)} />}
            {note && <div className="mt-1 text-[11px] text-ink-3">Part month: {note}</div>}
          </>
        )
      }}
      renderColumn={(i, { x, band, y }) => {
        const m = months[i]!
        const w = Math.max(2, Math.min(24, band * 0.5))
        const left = x + (band - w) / 2
        const zero = y(0)
        // A tiny amount still shows as a sliver rather than vanishing.
        const up = m.moneyIn ? Math.min(y(m.moneyIn), zero - 1.5) : zero
        const down = m.moneyOut ? Math.max(y(-m.moneyOut), zero + 1.5) : zero
        const faded = m.partial ? 0.45 : 1
        return (
          <g aria-hidden="true">
            <path d={barPath(left, w, zero, up)} className="fill-success" fillOpacity={faded} />
            <path d={barPath(left, w, zero, down)} className="fill-accent" fillOpacity={faded} />
            <circle
              cx={x + band / 2}
              cy={y(m.net)}
              r={4}
              className="fill-ink stroke-content"
              strokeWidth={2}
            />
          </g>
        )
      }}
    />
  )
}

/** The key above the chart. Words are short so they never repeat the stat tiles' labels. */
export function FlowLegend() {
  return (
    <div className="flex items-center gap-3 text-[12px] text-ink-2" aria-hidden="true">
      <span className="flex items-center gap-1.5">
        <span className="inline-block size-2.5 rounded-[3px] bg-success" />
        In
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block size-2.5 rounded-[3px] bg-accent" />
        Out
      </span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block size-2 rounded-full bg-ink" />
        Net
      </span>
    </div>
  )
}
