import { useEffect, useState, type ReactNode } from 'react'
import { Clock, Mail, Plus, Receipt, TrendingUp, Users } from 'lucide-react'
import { ME, formatPence, type DetectedBill } from '@ordo/money-core'
import type { BillView, MoneyOverview } from '@ordo/shared'
import { Button } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import { BillSheet, type BillTarget } from '../components/money/BillSheet'
import { FlatmatesPanel } from '../components/money/FlatmatesPanel'
import {
  CADENCE_LABEL,
  daysFromToday,
  dueLabel,
  formatDate,
  PER,
  Panel,
  SourceBadge,
} from '../components/money/ui'
import type { Route } from '../routes'

export function BillsPage({ onNavigate }: { onNavigate: (r: Route) => void }) {
  const [overview, setOverview] = useState<MoneyOverview | null>(null)
  const [version, setVersion] = useState(0)
  const [target, setTarget] = useState<BillTarget | null>(null)

  useEffect(() => {
    let live = true
    void window.ordo.money.overview().then((o) => live && setOverview(o))
    return () => {
      live = false
    }
  }, [version])

  const refresh = () => setVersion((v) => v + 1)
  if (!overview) return null

  const sheet = target && (
    <BillSheet
      target={target}
      people={overview.people}
      onClose={() => setTarget(null)}
      onSaved={() => {
        setTarget(null)
        refresh()
      }}
    />
  )

  if (!overview.bills.length && !overview.review.length && !overview.hasTransactions)
    return (
      <>
        <EmptyState
          icon={<Receipt size={40} strokeWidth={1.5} />}
          title="No bills yet"
          body={`Import a bank statement on Finances and Ordo will find your subscriptions and bills${
            overview.mailConnected ? ', using your email receipts too' : ''
          }. Or add one yourself. Everything stays on this computer.`}
          action={
            <div className="flex gap-2">
              <Button onClick={() => setTarget({ kind: 'new' })}>Add a bill</Button>
              <Button variant="primary" onClick={() => onNavigate('money/finances')}>
                Import a statement
              </Button>
            </div>
          }
        />
        {sheet}
      </>
    )

  const active = overview.bills.filter((b) => b.status === 'active')
  const flags = active.flatMap((b) => billFlags(b))

  return (
    <div className="@container min-h-full px-6 pt-5 pb-8">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-semibold tracking-tight tabular-nums">
            {formatPence(overview.monthlyTotal)} a month
          </h2>
          <p className="text-ink-2">
            {active.length} active {active.length === 1 ? 'bill or subscription' : 'bills and subscriptions'}
            {!overview.mailConnected && ' · Connect Mail to match email receipts too'}
          </p>
        </div>
        <Button icon={<Plus size={14} />} onClick={() => setTarget({ kind: 'new' })}>
          Add bill
        </Button>
      </div>

      <div className="mt-4 grid grid-cols-1 items-start gap-4 @4xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-4">
          {flags.length > 0 && (
            <ul className="flex flex-col gap-1.5" aria-label="Heads-up">
              {flags.map((f) => (
                <li key={f.key} className="flex items-center gap-2 rounded-lg bg-hover px-3 py-2">
                  <span style={{ color: 'var(--promotions)' }}>{f.icon}</span>
                  {f.text}
                </li>
              ))}
            </ul>
          )}

          {overview.review.length > 0 && (
            <Panel title={<>Detected — review</>}>
              <ul aria-label="Detected bills">
                {overview.review.map((d) => (
                  <ReviewRow
                    key={d.key}
                    d={d}
                    onConfirm={() =>
                      d.amount === null
                        ? setTarget({ kind: 'confirm', detected: d })
                        : void window.ordo.money.confirmBill({ key: d.key }).then(refresh)
                    }
                    onDismiss={() => void window.ordo.money.dismissBill(d.key).then(refresh)}
                  />
                ))}
              </ul>
            </Panel>
          )}

          <Panel title="Bills & subscriptions">
            {overview.bills.length ? (
              <table className="w-full table-fixed border-collapse" aria-label="Bills">
                <thead className="text-left text-[11px] text-ink-3">
                  <tr className="border-b border-sep">
                    <th className="py-1.5 pl-4 font-medium">Name</th>
                    <th className="w-24 pr-3 text-right font-medium">Amount</th>
                    <th className="w-20 font-medium">Repeats</th>
                    <th className="w-24 font-medium">Next due</th>
                    <th className="w-20 pr-4 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.bills.map((b) => (
                    <BillRow
                      key={b.id}
                      bill={b}
                      people={overview.people}
                      onOpen={() => setTarget({ kind: 'edit', bill: b })}
                    />
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="px-4 py-3 text-ink-2">
                Confirm the bills Ordo found, or add one yourself. Confirmed bills show up here.
              </p>
            )}
          </Panel>
        </div>

        <FlatmatesPanel overview={overview} onChanged={refresh} />
      </div>
      {sheet}
    </div>
  )
}

function billFlags(b: BillView) {
  const flags: { key: string; icon: ReactNode; text: string }[] = []
  if (b.priceIncrease && daysFromToday(b.priceIncrease.date) > -120)
    flags.push({
      key: `${b.id}-price`,
      icon: <TrendingUp size={14} />,
      text: `${b.name} went up from ${formatPence(b.priceIncrease.from)} to ${formatPence(b.priceIncrease.to)} on ${formatDate(b.priceIncrease.date)}.`,
    })
  else if (b.priceChangeEmail && daysFromToday(b.priceChangeEmail) > -60)
    flags.push({
      key: `${b.id}-price-email`,
      icon: <TrendingUp size={14} />,
      text: `${b.name} emailed about a price change on ${formatDate(b.priceChangeEmail)}.`,
    })
  if (b.trialEnding && daysFromToday(b.trialEnding) > -30)
    flags.push({
      key: `${b.id}-trial`,
      icon: <Clock size={14} />,
      text: `${b.name} says your free trial is ending (email from ${formatDate(b.trialEnding)}). Cancel now if you don’t want to pay.`,
    })
  return flags
}

function ReviewRow({
  d,
  onConfirm,
  onDismiss,
}: {
  d: DetectedBill
  onConfirm: () => void
  onDismiss: () => void
}) {
  const trial = d.hints.find((h) => h.kind === 'trial-ending')
  const evidence = [
    d.transactionIds.length > 0 &&
      `${d.transactionIds.length} payments${d.lastPaid ? `, last on ${formatDate(d.lastPaid, true)}` : ''}`,
    d.hints[0] && `“${d.hints[0].subject}”`,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <li className="flex items-center gap-3 border-b border-sep px-4 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{d.name}</span>
          <SourceBadge source={d.source} />
          {d.priceIncrease && (
            <span className="text-[11px]" style={{ color: 'var(--promotions)' }}>
              Price went up
            </span>
          )}
          {trial && (
            <span className="text-[11px]" style={{ color: 'var(--promotions)' }}>
              Trial ending
            </span>
          )}
        </div>
        <div className="truncate text-[12px] text-ink-2">
          {d.amount !== null ? `${formatPence(d.amount)} ${PER[d.cadence]}` : 'Amount unknown'}
          {evidence && ` · ${evidence}`}
        </div>
      </div>
      <Button className="h-6 px-2.5 text-[12px]" aria-label={`Dismiss ${d.name}`} onClick={onDismiss}>
        Dismiss
      </Button>
      <Button
        variant="primary"
        className="h-6 px-2.5 text-[12px]"
        aria-label={`Confirm ${d.name}`}
        icon={d.source === 'email' ? <Mail size={12} /> : undefined}
        onClick={onConfirm}
      >
        Confirm
      </Button>
    </li>
  )
}

function BillRow({
  bill: b,
  people,
  onOpen,
}: {
  bill: BillView
  people: MoneyOverview['people']
  onOpen: () => void
}) {
  const cancelled = b.status === 'cancelled'
  const others = b.split?.shares
    .filter((s) => s.personId !== ME)
    .map((s) => people.find((p) => p.id === s.personId)?.name)
  const myShare = b.shares?.find((s) => s.personId === ME)
  return (
    <tr
      onClick={onOpen}
      className={`cursor-default border-b border-sep last:border-b-0 hover:bg-hover ${cancelled ? 'text-ink-3' : ''}`}
    >
      <td className="py-1.5 pl-4 pr-3">
        {/* The row handles the click; the button makes it reachable by keyboard and screen readers. */}
        <button type="button" className="block max-w-full truncate text-left font-medium">
          {b.name}
        </button>
        {(b.split || cancelled) && (
          <div className="flex items-center gap-1 truncate text-[12px] text-ink-2">
            {cancelled ? (
              'Cancelled'
            ) : (
              <>
                <Users size={11} className="shrink-0" />
                {others?.length ? `Split with ${others.filter(Boolean).join(', ')}` : 'Split'}
                {myShare && ` · your share ${formatPence(myShare.amount)}`}
              </>
            )}
          </div>
        )}
      </td>
      <td className={`pr-3 text-right tabular-nums ${cancelled ? 'line-through' : ''}`}>
        {formatPence(b.amount)}
      </td>
      <td className="text-ink-2">{CADENCE_LABEL[b.cadence]}</td>
      <td className="text-ink-2 tabular-nums">{cancelled ? '—' : dueLabel(b.nextDue)}</td>
      <td className="pr-4">
        <SourceBadge source={b.source} />
      </td>
    </tr>
  )
}
