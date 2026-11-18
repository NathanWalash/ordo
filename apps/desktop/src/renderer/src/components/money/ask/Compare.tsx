import { useEffect, useState } from 'react'
import { Info } from 'lucide-react'
import { formatPence } from '@ordo/money-core'
import type { MonthComparison } from '@ordo/shared'
import { Panel, Select, formatDate } from '../ui'

/** This month so far against last month to the same day, with or without a category. */
export function ComparePanel({
  initial,
  categories,
  accounts,
}: {
  initial: MonthComparison
  categories: string[]
  accounts: string[]
}) {
  const [category, setCategory] = useState('')
  const [account, setAccount] = useState('')
  const [filtered, setFiltered] = useState<{ key: string; c: MonthComparison } | null>(null)
  const key = `${category}|${account}`
  const c = !category && !account ? initial : filtered?.key === key ? filtered.c : initial

  useEffect(() => {
    if (!category && !account) return
    let live = true
    void window.ordo.moneyMemory
      .compare({ category: category || undefined, account: account || undefined })
      .then((r) => live && setFiltered({ key: `${category}|${account}`, c: r }))
    return () => {
      live = false
    }
  }, [category, account, initial])

  const diff = c.difference
  const sentence =
    diff === 0
      ? 'The same as last month so far.'
      : `${formatPence(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than last month so far.`

  return (
    <Panel
      title="This month so far"
      actions={
        <div className="flex gap-2">
          <Select label="Category" hideLabel value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All spending</option>
            {categories.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </Select>
          {accounts.length > 1 && (
            <Select label="Account" hideLabel value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">All accounts</option>
              {accounts.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </Select>
          )}
        </div>
      }
    >
      <div className="grid grid-cols-2 gap-3 px-4 pt-3" aria-live="polite">
        <Figure
          label={`${formatDate(c.thisMonth.from, true)} – ${formatDate(c.thisMonth.to, true)}`}
          value={c.thisMonth.net}
          paidBack={c.thisMonth.paidBack}
        />
        <Figure
          label={`${formatDate(c.lastMonth.from, true)} – ${formatDate(c.lastMonth.to, true)}`}
          value={c.lastMonth.net}
          paidBack={c.lastMonth.paidBack}
          muted
        />
      </div>
      <p className="px-4 pt-2 pb-3 font-medium">{sentence}</p>
      {c.caveats.length > 0 && (
        <ul
          className="flex flex-col gap-1 border-t border-sep px-4 py-2 text-[12px] text-ink-2"
          aria-label="Caveats"
        >
          {c.caveats.map((x) => (
            <li key={x} className="flex items-start gap-1.5">
              <Info size={12} className="mt-0.5 shrink-0" />
              {x}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

function Figure({
  label,
  value,
  paidBack,
  muted,
}: {
  label: string
  value: number
  paidBack: number
  muted?: boolean
}) {
  return (
    <div>
      <div className="text-[12px] text-ink-2">{label}</div>
      <div className={`text-[20px] font-semibold tracking-tight tabular-nums ${muted ? 'text-ink-2' : ''}`}>
        {formatPence(value)}
      </div>
      {paidBack > 0 && <div className="text-[11px] text-ink-3">after {formatPence(paidBack)} paid back</div>}
    </div>
  )
}
