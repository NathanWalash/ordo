import { useEffect, useState } from 'react'
import { FileUp, Landmark } from 'lucide-react'
import { formatPence } from '@ordo/money-core'
import type { TransactionPage } from '@ordo/shared'
import { Button } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import { formatDate, formatMonth, Notice, Panel, Select } from '../components/money/ui'
import { useStatementImport } from '../components/money/useStatementImport'

export function FinancesPage() {
  const [page, setPage] = useState<TransactionPage | null>(null)
  const [account, setAccount] = useState('')
  const [month, setMonth] = useState('')
  const [version, setVersion] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)

  const importer = useStatementImport((o) => {
    setNotice(
      `Imported ${o.added.toLocaleString()} transaction${o.added === 1 ? '' : 's'} into ${o.accountName}` +
        (o.duplicates ? `. ${o.duplicates.toLocaleString()} were already here and were skipped.` : '.'),
    )
    setVersion((v) => v + 1)
  })

  useEffect(() => {
    let live = true
    void window.ordo.money
      .transactions({ account: account || undefined, month: month || undefined })
      .then((p) => live && setPage(p))
    return () => {
      live = false
    }
  }, [account, month, version])

  if (!page) return null

  const importButton = (
    <Button variant="primary" icon={<FileUp size={14} />} onClick={() => void importer.pick()}>
      Import statement
    </Button>
  )

  if (!page.accounts.length)
    return (
      <div className="relative h-full" {...importer.dropProps}>
        <EmptyState
          icon={<Landmark size={40} strokeWidth={1.5} />}
          title="Import a bank statement"
          body="Export a CSV from your bank’s app or website (Monzo, Starling, Nationwide and most UK banks work) and import it here, or drop it on this window. Your statements stay on this computer."
          action={importButton}
        />
        {importer.overlay}
        {importer.sheet}
      </div>
    )

  const { summary } = page
  const net = summary.moneyIn - summary.moneyOut
  const biggest = summary.byCategory[0]?.amount ?? 0
  const showAccount = page.accounts.length > 1 && !account

  return (
    <div className="relative min-h-full px-6 pt-5 pb-8" {...importer.dropProps}>
      <div className="flex flex-wrap items-end gap-3">
        <Select label="Account" hideLabel value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="">All accounts</option>
          {page.accounts.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
        <Select label="Month" hideLabel value={month} onChange={(e) => setMonth(e.target.value)}>
          <option value="">All months</option>
          {page.months.map((m) => (
            <option key={m} value={m}>
              {formatMonth(m)}
            </option>
          ))}
        </Select>
        <span className="flex-1" />
        {importButton}
      </div>

      {notice && (
        <div className="mt-3">
          <Notice>{notice}</Notice>
        </div>
      )}

      <div className="mt-4 grid grid-cols-3 gap-3">
        <Stat label="Money in" value={formatPence(summary.moneyIn)} tone="in" />
        <Stat label="Money out" value={formatPence(summary.moneyOut)} />
        <Stat
          label="Net"
          value={(net > 0 ? '+' : '') + formatPence(net)}
          tone={net >= 0 ? 'in' : undefined}
        />
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel title="Spending by category">
          <ul className="flex flex-col gap-2 px-4 py-3">
            {summary.byCategory.slice(0, 8).map((c) => (
              <li key={c.category} className="grid grid-cols-[110px_1fr_auto] items-center gap-3">
                <span className="truncate text-ink-2">{c.category}</span>
                <span className="h-1.5 overflow-hidden rounded-full bg-selected" aria-hidden="true">
                  <span
                    className="block h-full rounded-full bg-accent"
                    style={{ width: `${biggest ? Math.max(2, (c.amount / biggest) * 100) : 0}%` }}
                  />
                </span>
                <span className="tabular-nums">{formatPence(c.amount)}</span>
              </li>
            ))}
            {!summary.byCategory.length && <li className="text-ink-2">No spending in this period.</li>}
          </ul>
        </Panel>
        <Panel title="By month">
          <table className="w-full border-collapse">
            <thead className="text-left text-[11px] text-ink-3">
              <tr>
                <th className="py-1.5 pl-4 font-medium">Month</th>
                <th className="pr-4 text-right font-medium">In</th>
                <th className="pr-4 text-right font-medium">Out</th>
              </tr>
            </thead>
            <tbody>
              {summary.byMonth.slice(0, 6).map((m) => (
                <tr key={m.month} className="border-t border-sep">
                  <td className="py-1.5 pl-4">{formatMonth(m.month)}</td>
                  <td className="pr-4 text-right text-success tabular-nums">{formatPence(m.moneyIn)}</td>
                  <td className="pr-4 text-right tabular-nums">{formatPence(m.moneyOut)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>

      <h3 className="mt-6 mb-2 text-[13px] font-semibold">
        Transactions{' '}
        <span className="font-normal text-ink-3">{page.transactions.length.toLocaleString()}</span>
      </h3>
      <div className="overflow-hidden rounded-xl border border-sep">
        <table className="w-full table-fixed border-collapse" aria-label="Transactions">
          <thead className="text-left text-[11px] text-ink-3">
            <tr className="border-b border-sep">
              <th className="w-24 py-1.5 pl-4 font-medium">Date</th>
              <th className="font-medium">Merchant</th>
              <th className="w-32 font-medium">Category</th>
              {showAccount && <th className="w-28 font-medium">Account</th>}
              <th className="w-28 pr-4 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {page.transactions.map((t, i) => (
              <tr key={t.id} className={i % 2 ? 'bg-hover/50' : ''}>
                <td className="py-1.5 pl-4 text-ink-2 tabular-nums">{formatDate(t.date, true)}</td>
                <td className="truncate pr-3" title={t.description}>
                  {t.merchant ?? t.description}
                </td>
                <td className="truncate pr-3 text-ink-2">{t.category}</td>
                {showAccount && <td className="truncate pr-3 text-ink-2">{t.accountName}</td>}
                <td className={`pr-4 text-right tabular-nums ${t.amount > 0 ? 'text-success' : ''}`}>
                  {t.amount > 0 ? '+' : ''}
                  {formatPence(t.amount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {importer.overlay}
      {importer.sheet}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'in' }) {
  return (
    <div className="rounded-xl border border-sep px-4 py-3">
      <div className="text-[12px] text-ink-2">{label}</div>
      <div
        className={`mt-0.5 text-[20px] font-semibold tracking-tight tabular-nums ${tone === 'in' ? 'text-success' : ''}`}
      >
        {value}
      </div>
    </div>
  )
}
