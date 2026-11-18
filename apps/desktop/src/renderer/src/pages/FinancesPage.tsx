import { useEffect, useState } from 'react'
import { FileUp, Landmark, Sparkles } from 'lucide-react'
import { SPENDING_CATEGORIES, formatPence, type Transaction } from '@ordo/money-core'
import {
  AI_PROVIDERS,
  type AiSettings,
  type MoneyAiOutcome,
  type MoneyAiProgress,
  type TransactionPage,
} from '@ordo/shared'
import { Button } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import { formatDate, formatMonth, Notice, Panel, Select } from '../components/money/ui'
import { useStatementImport } from '../components/money/useStatementImport'

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** What Sort with AI did, in a sentence or two. */
function sortSummary(name: string, r: Extract<MoneyAiOutcome, { ok: true }>): string {
  const parts = [
    r.changed
      ? `${name} sorted ${plural(r.changed, 'merchant')} out of Other.`
      : r.merchants
        ? `${name} left everything in Other where it was.`
        : 'Nothing was left in Other.',
  ]
  if (r.billsMatched)
    parts.push(
      `It matched ${plural(r.billsMatched, 'bill')} to your email: check them in Bills & Subscriptions.`,
    )
  if (r.failed) parts.push(`${plural(r.failed, 'merchant')} couldn't be sorted.`)
  return [...parts, ...r.errors].join(' ')
}

export function FinancesPage({
  onOpenSettings,
  initialMonth,
}: {
  onOpenSettings?: () => void
  /** Show just this month (YYYY-MM) at first, e.g. when the assistant opens the page. */
  initialMonth?: string
}) {
  const [page, setPage] = useState<TransactionPage | null>(null)
  const [account, setAccount] = useState('')
  const [month, setMonth] = useState(initialMonth ?? '')
  const [version, setVersion] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ai, setAi] = useState<AiSettings | null>(null)
  const [sorting, setSorting] = useState<MoneyAiProgress | null>(null)

  useEffect(() => {
    let live = true
    void window.ordo.settings.get().then((s) => live && setAi(s.ai))
    return () => {
      live = false
    }
  }, [])

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

  const aiReady = ai !== null && ai.provider !== 'none' && ai.money
  const aiName = AI_PROVIDERS.find((p) => p.id === ai?.provider)?.label ?? 'AI'
  const unsure = page.uncategorisedMerchants

  const sortWithAi = async () => {
    if (!aiReady) return onOpenSettings?.()
    setError(null)
    setNotice(null)
    setSorting({ phase: 'categories', done: 0, total: unsure })
    const off = window.ordo.money.onAiProgress(setSorting)
    try {
      const res = await window.ordo.money.aiSort()
      if (!res.ok) setError(res.message)
      else setNotice(sortSummary(aiName, res))
      setVersion((v) => v + 1)
    } finally {
      off()
      setSorting(null)
    }
  }

  const setCategory = async (t: Transaction, category: string | null) => {
    setError(null)
    const res = await window.ordo.money.setCategory({
      transactionId: t.id,
      category: category as (typeof SPENDING_CATEGORIES)[number] | null,
    })
    if (!res.ok) setError(res.message)
    setVersion((v) => v + 1)
  }

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
        {(unsure > 0 || aiReady) && (
          <Button
            icon={<Sparkles size={13} />}
            disabled={Boolean(sorting)}
            onClick={() => void sortWithAi()}
            title={
              aiReady
                ? `Ask ${aiName} to categorise the ${plural(unsure, 'merchant')} in Other and match bills to your email. It sees merchant names and rough amounts, never balances, accounts or dates.`
                : 'Set up a model and turn on AI for Money in Settings → AI'
            }
          >
            Sort with AI
          </Button>
        )}
        {importButton}
      </div>

      {sorting ? (
        <div
          className="mt-3 flex items-center justify-between gap-3 rounded-md bg-hover px-3 py-2 text-ink-2"
          aria-live="polite"
        >
          <span className="flex items-center gap-1.5">
            <Sparkles size={13} />
            {sorting.phase === 'categories'
              ? `Sorting with ${aiName}… ${sorting.done} of ${plural(sorting.total, 'merchant')}`
              : `Matching bills with ${aiName}… ${sorting.done} of ${sorting.total}`}
          </span>
          <Button onClick={() => void window.ordo.money.aiStop()}>Stop</Button>
        </div>
      ) : error ? (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      ) : notice ? (
        <div className="mt-3">
          <Notice>{notice}</Notice>
        </div>
      ) : null}

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
              <th className="w-40 font-medium">Category</th>
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
                  {t.transferAccount && (
                    <span className="ml-2 text-[12px] text-ink-2">
                      {t.amount < 0 ? 'to' : 'from'} your {t.transferAccount} account
                    </span>
                  )}
                </td>
                <td className="pr-3">
                  <CategoryCell transaction={t} onChange={(c) => void setCategory(t, c)} />
                </td>
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

const AUTOMATIC = '__automatic__'

/**
 * The category, as a menu to change it. A sparkle marks a model's choice, with its confidence.
 * Your own choice always wins; "Automatic" goes back to the bank's, the rules' or the model's.
 */
function CategoryCell({
  transaction: t,
  onChange,
}: {
  transaction: Transaction
  onChange: (category: string | null) => void
}) {
  const current = t.category ?? 'Other'
  const options: string[] = SPENDING_CATEGORIES.includes(current as never)
    ? [...SPENDING_CATEGORIES]
    : [current, ...SPENDING_CATEGORIES]
  const name = t.merchant ?? t.description
  return (
    <div className="flex min-w-0 items-center gap-1">
      <select
        aria-label={`Category for ${name}`}
        value={current}
        onChange={(e) => onChange(e.target.value === AUTOMATIC ? null : e.target.value)}
        className="no-drag -ml-1 h-6 min-w-0 max-w-full appearance-none [field-sizing:content] truncate rounded-[5px] bg-transparent px-1 text-[13px] text-ink-2 outline-none hover:bg-hover focus:ring-1 focus:ring-accent"
      >
        {options.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
        {t.categorisedBy === 'you' && <option value={AUTOMATIC}>Automatic</option>}
      </select>
      {t.categorisedBy === 'ai' && (
        <span
          className="flex shrink-0 items-center text-ink-3"
          title={`Categorised by AI${t.confidence !== undefined ? ` (${Math.round(t.confidence * 100)}% sure)` : ''}`}
        >
          <Sparkles size={11} aria-label="Categorised by AI" />
        </span>
      )}
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
