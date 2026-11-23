import { ArrowDown, ArrowUp } from 'lucide-react'
import { formatPence, type UsualComparison, type UsualRow } from '@ordo/money-core'
import { formatMonth } from '../ui'
import { shortMonth } from './scale'

const ROWS = 6

/** `November so far` or `October`. */
export function usualTitle(c: UsualComparison): string {
  return `${formatMonth(c.month).split(' ')[0]}${c.throughDay !== null ? ' so far' : ''} vs usual`
}

/** What the usual is, in a sentence. */
export function usualBasis(c: UsualComparison): string {
  const n = c.baseline.length
  const span =
    n === 1
      ? formatMonth(c.baseline[0]!)
      : `${shortMonth(c.baseline[0]!, true)} to ${shortMonth(c.baseline.at(-1)!, true)}`
  const days = c.throughDay !== null ? `, up to day ${c.throughDay} of each` : ''
  return n === 1 ? `Usual is ${span}${days}.` : `Usual is the middle (median) of ${n} months, ${span}${days}.`
}

function Change({ row, scale }: { row: UsualRow; scale: number }) {
  const d = row.difference
  const width = scale ? Math.max(3, (Math.abs(d) / scale) * 50) : 0
  return (
    <div className="flex items-center justify-end gap-2">
      <span className="flex items-center gap-0.5 whitespace-nowrap tabular-nums">
        {d > 0 ? (
          <ArrowUp size={11} aria-hidden="true" />
        ) : d < 0 ? (
          <ArrowDown size={11} aria-hidden="true" />
        ) : null}
        {d === 0 ? 'Same' : `${d > 0 ? '+' : '−'}${formatPence(Math.abs(d))}`}
        {d !== 0 && <span className="sr-only">{d > 0 ? ' more than usual' : ' less than usual'}</span>}
      </span>
      {/* Diverging: more than usual grows right in the warning colour, less grows left in green. */}
      <span className="relative h-2 w-10 shrink-0" aria-hidden="true">
        <span className="absolute inset-y-0 left-1/2 w-px bg-ink-3" />
        {d !== 0 && (
          <span
            className={`absolute inset-y-0 ${d > 0 ? 'left-1/2 rounded-r-full bg-warn' : 'right-1/2 rounded-l-full bg-success'}`}
            style={{ width: `${width}%` }}
          />
        )}
      </span>
    </div>
  )
}

/**
 * This month (or the chosen one) against the usual month: all spending, then the categories that
 * moved most. A table, so every number can be read without the bars.
 */
export function VersusUsual({ comparison: c }: { comparison: UsualComparison | null }) {
  if (!c)
    return (
      <p className="px-4 py-3 text-ink-2">
        Ordo needs at least one whole month before this one to know what your usual month looks like.
      </p>
    )
  const moved = c.categories.filter((r) => r.difference !== 0).slice(0, ROWS)
  const rows = [c.total, ...moved]
  const scale = Math.max(...rows.map((r) => Math.abs(r.difference)))
  return (
    <div>
      <table className="w-full table-fixed border-collapse" aria-label={usualTitle(c)}>
        <thead className="text-left text-[11px] text-ink-3">
          <tr>
            <th className="py-1.5 pl-4 font-medium">Category</th>
            <th className="w-[84px] pr-3 text-right font-medium">
              {c.throughDay !== null ? 'So far' : 'Spent'}
            </th>
            <th className="w-[84px] pr-3 text-right font-medium">Usual</th>
            <th className="w-[132px] pr-4 text-right font-medium">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.category} className={`border-t border-sep ${i === 0 ? 'font-medium' : ''}`}>
              <td className="truncate py-1.5 pl-4" title={r.category}>
                {r.category}
              </td>
              <td className="pr-3 text-right tabular-nums">{formatPence(r.thisMonth)}</td>
              <td className="pr-3 text-right text-ink-2 tabular-nums">{formatPence(r.usual)}</td>
              <td className="pr-4">
                <Change row={r} scale={scale} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-sep px-4 py-2 text-[12px] text-ink-3">
        {usualBasis(c)}
        {!moved.length && ' Every category is where it usually is.'}
      </p>
    </div>
  )
}
