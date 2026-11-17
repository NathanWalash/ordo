import { useState, type FormEvent } from 'react'
import { ArrowRightLeft, CircleCheck, HandCoins, UserPlus, X } from 'lucide-react'
import { ME, formatPence, penceToPounds, poundsToPence, type Debt, type Person } from '@ordo/money-core'
import type { MoneyOverview } from '@ordo/shared'
import { Button } from '../Button'
import { Sheet } from '../Sheet'
import { TextField } from '../TextField'
import { formatDate, Panel } from './ui'

/** "Sam owes you £5.49", "You owe Alex £12.00", "Sam owes Alex £3.00". */
export function describeDebt(d: Debt, people: Person[]): string {
  const name = (id: string) => people.find((p) => p.id === id)?.name ?? 'Someone'
  const amount = formatPence(d.amount)
  if (d.to === ME) return `${name(d.from)} owes you ${amount}`
  if (d.from === ME) return `You owe ${name(d.to)} ${amount}`
  return `${name(d.from)} owes ${name(d.to)} ${amount}`
}

function describePayment(from: string, to: string, amount: number, people: Person[]): string {
  const name = (id: string) => (id === ME ? 'you' : (people.find((p) => p.id === id)?.name ?? 'Someone'))
  const who = name(from)
  return `${who.charAt(0).toUpperCase() + who.slice(1)} paid ${name(to)} ${formatPence(amount)}`
}

interface Props {
  overview: MoneyOverview
  onChanged: () => void
}

/** Flatmates you split bills with, who owes whom, and settling up. */
export function FlatmatesPanel({ overview, onChanged }: Props) {
  const { people, debts, settlements } = overview
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [settling, setSettling] = useState<Debt | null>(null)
  const flatmates = people.filter((p) => p.id !== ME)
  const anySplit = overview.bills.some((b) => b.split)

  const add = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    const r = await window.ordo.money.savePerson({ name })
    if (!r.ok) return setError(r.message)
    setName('')
    onChanged()
  }

  const remove = async (id: string) => {
    setError(null)
    const r = await window.ordo.money.deletePerson(id)
    if (!r.ok) setError(r.message)
    onChanged()
  }

  return (
    <Panel title="Flatmates">
      <ul aria-label="Flatmates">
        {flatmates.map((p) => (
          <li key={p.id} className="group flex h-8 items-center gap-2 border-b border-sep px-4">
            <span className="flex size-5 items-center justify-center rounded-full bg-selected text-[10px] font-semibold text-ink-2">
              {p.name.charAt(0).toUpperCase()}
            </span>
            <span className="flex-1 truncate">{p.name}</span>
            <button
              type="button"
              aria-label={`Remove ${p.name}`}
              onClick={() => void remove(p.id)}
              className="rounded p-0.5 text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-ink focus-visible:opacity-100"
            >
              <X size={13} />
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => void add(e)} className="flex items-end gap-2 border-b border-sep px-4 py-3">
        <TextField
          label="Flatmate name"
          placeholder={flatmates.length ? 'Add another' : 'e.g. Sam'}
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          className="flex-1 [&>label]:sr-only"
        />
        <Button type="submit" icon={<UserPlus size={13} />} disabled={!name.trim()}>
          Add
        </Button>
      </form>
      {error && <p className="px-4 pt-2 text-[12px] text-danger">{error}</p>}

      <div className="px-4 py-3">
        <h4 className="pb-1.5 text-[11px] font-semibold text-ink-3">Balances</h4>
        {debts.length ? (
          <ul className="flex flex-col gap-1.5" aria-label="Balances">
            {debts.map((d) => (
              <li key={`${d.from}-${d.to}`} className="flex items-center gap-2">
                <ArrowRightLeft size={13} className="shrink-0 text-ink-3" />
                <span
                  className={`flex-1 ${d.to === ME ? 'text-success' : d.from === ME ? 'text-danger' : ''}`}
                >
                  {describeDebt(d, people)}
                </span>
                <Button className="h-6 px-2 text-[12px]" onClick={() => setSettling(d)}>
                  Settle up
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-1.5 text-ink-2">
            {anySplit ? (
              <>
                <CircleCheck size={14} className="text-success" /> All settled up.
              </>
            ) : flatmates.length ? (
              'Open a bill and choose Split this bill to share it.'
            ) : (
              'Add the people you live with, then split bills with them.'
            )}
          </p>
        )}
      </div>

      {settlements.length > 0 && (
        <div className="border-t border-sep px-4 py-3">
          <h4 className="pb-1.5 text-[11px] font-semibold text-ink-3">Recent payments</h4>
          <ul className="flex flex-col gap-1">
            {settlements.slice(0, 5).map((s) => (
              <li key={s.id} className="group flex items-center gap-2 text-ink-2">
                <span className="flex-1">
                  {describePayment(s.from, s.to, s.amount, people)}
                  <span className="text-ink-3"> · {formatDate(s.date, true)}</span>
                </span>
                <button
                  type="button"
                  aria-label="Undo this payment"
                  onClick={() => void window.ordo.money.deleteSettlement(s.id).then(onChanged)}
                  className="rounded p-0.5 text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-hover focus-visible:opacity-100"
                >
                  <X size={13} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {settling && (
        <SettleSheet
          debt={settling}
          people={people}
          onClose={() => setSettling(null)}
          onDone={() => {
            setSettling(null)
            onChanged()
          }}
        />
      )}
    </Panel>
  )
}

function SettleSheet(props: { debt: Debt; people: Person[]; onClose: () => void; onDone: () => void }) {
  const { debt, people } = props
  const [amountText, setAmountText] = useState(penceToPounds(debt.amount))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const amount = poundsToPence(amountText)
    if (!amount) return setError('Enter the amount that was paid.')
    setBusy(true)
    try {
      const r = await window.ordo.money.settle({ from: debt.from, to: debt.to, amount })
      if (r.ok) props.onDone()
      else setError(r.message)
    } finally {
      setBusy(false)
    }
  }

  const amount = poundsToPence(amountText)
  return (
    <Sheet
      title="Settle up"
      subtitle={describeDebt(debt, people)}
      icon={<HandCoins size={22} />}
      width={400}
      busy={busy}
      onClose={props.onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <span className="flex-1" />
          <Button disabled={busy} onClick={props.onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Record payment
          </Button>
        </>
      }
    >
      <TextField
        label="Amount paid (£)"
        inputMode="decimal"
        value={amountText}
        onChange={(e) => setAmountText(e.target.value)}
        error={error ?? undefined}
        hint={
          amount
            ? `${describePayment(debt.from, debt.to, amount, people)}. Ordo only records it; no money moves.`
            : undefined
        }
      />
    </Sheet>
  )
}
