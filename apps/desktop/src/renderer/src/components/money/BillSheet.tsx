import { useState } from 'react'
import { Receipt, Users } from 'lucide-react'
import {
  ME,
  WHOLE,
  allocate,
  formatPence,
  isISODate,
  penceToPounds,
  poundsToPence,
  toISODate,
  validateSplit,
  type Cadence,
  type DetectedBill,
  type Person,
  type SplitMode,
} from '@ordo/money-core'
import type { BillView, MoneyResult, SplitInput } from '@ordo/shared'
import { Button } from '../Button'
import { Sheet } from '../Sheet'
import { TextField } from '../TextField'
import { CADENCE_LABEL, formatDate, Notice, Segmented, Select, SourceBadge } from './ui'

export type BillTarget =
  | { kind: 'edit'; bill: BillView }
  | { kind: 'new' }
  /** A bill only email knows about: confirm it with an amount and due date. */
  | { kind: 'confirm'; detected: DetectedBill }

interface Props {
  target: BillTarget
  people: Person[]
  onClose: () => void
  onSaved: () => void
}

const MODES: { value: SplitMode; label: string }[] = [
  { value: 'equal', label: 'Equally' },
  { value: 'fixed', label: 'Amounts' },
  { value: 'percent', label: 'Percentages' },
]

/** Per-person text in the split editor: pounds for fixed shares, a percentage for percent shares. */
function shareText(mode: SplitMode, value: number) {
  return mode === 'fixed' ? penceToPounds(value) : String(value / 100)
}

function readShare(mode: SplitMode, text: string): number {
  if (mode === 'equal') return 0
  if (mode === 'fixed') return poundsToPence(text) ?? -1
  const n = Number(text.trim().replace(/%$/, ''))
  return text.trim() && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : -1
}

/** Add, edit, confirm or split a bill. */
export function BillSheet({ target, people, onClose, onSaved }: Props) {
  const bill = target.kind === 'edit' ? target.bill : null
  const detected = target.kind === 'confirm' ? target.detected : null
  const fromBank = bill?.source === 'bank' || bill?.source === 'both'

  const [name, setName] = useState(bill?.name ?? detected?.name ?? '')
  const [amountText, setAmountText] = useState(bill ? penceToPounds(bill.amount) : '')
  const [cadence, setCadence] = useState<Cadence>(bill?.cadence ?? detected?.cadence ?? 'monthly')
  const [nextDue, setNextDue] = useState(bill?.nextDue ?? '')
  const [cancelled, setCancelled] = useState(bill?.status === 'cancelled')

  const [splitOn, setSplitOn] = useState(!!bill?.split)
  const [paidBy, setPaidBy] = useState(bill?.split?.paidBy ?? ME)
  const [mode, setMode] = useState<SplitMode>(bill?.split?.mode ?? 'equal')
  const [included, setIncluded] = useState<Set<string>>(
    () => new Set(bill?.split ? bill.split.shares.map((s) => s.personId) : people.map((p) => p.id)),
  )
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (bill?.split?.shares ?? []).map((s) => [s.personId, shareText(bill!.split!.mode, s.value)]),
    ),
  )

  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const amount = fromBank ? bill!.amount : poundsToPence(amountText)
  const sharing = people.filter((p) => included.has(p.id))
  const split: SplitInput = {
    billId: bill?.id ?? '',
    paidBy,
    mode,
    shares: sharing.map((p) => ({ personId: p.id, value: readShare(mode, values[p.id] ?? '') })),
  }
  const splitError = splitOn && amount !== null ? validateSplit(split, amount, people) : null
  const shares = splitOn && amount !== null && !splitError ? allocate(amount, split) : null

  const changeMode = (m: SplitMode) => {
    setMode(m)
    if (m === 'equal' || amount === null) return
    // Start custom splits from an equal split, so the numbers already add up.
    const ids = sharing.map((p) => ({ personId: p.id, value: 0 }))
    const even = allocate(m === 'fixed' ? amount : WHOLE, { mode: 'equal', paidBy, shares: ids })
    setValues(Object.fromEntries(even.map((s) => [s.personId, shareText(m, s.amount)])))
  }

  const toggle = (id: string) =>
    setIncluded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const run = async (steps: (() => Promise<MoneyResult | void>)[]) => {
    setBusy(true)
    setError(null)
    try {
      for (const step of steps) {
        const r = await step()
        if (r && !r.ok) {
          setError(r.message)
          return
        }
      }
      onSaved()
    } finally {
      setBusy(false)
    }
  }

  const save = () => {
    if (!name.trim()) return setError('Give the bill a name.')
    if (amount === null) return setError('Enter the amount, like 12.99.')
    if (!fromBank && !isISODate(nextDue)) return setError('Choose when it’s next due.')
    if (splitError) return setError(splitError)
    const details = { name, amount, cadence, nextDue }
    if (detected)
      return void run([() => window.ordo.money.confirmBill({ key: detected.key, amount, nextDue })])
    if (!bill) return void run([() => window.ordo.money.saveBill(details)])
    void run([
      () =>
        window.ordo.money.saveBill({ ...details, id: bill.id, status: cancelled ? 'cancelled' : 'active' }),
      () =>
        splitOn
          ? window.ordo.money.saveSplit({ ...split, billId: bill.id })
          : bill.split
            ? window.ordo.money.deleteSplit(bill.id)
            : Promise.resolve(),
    ])
  }

  const title = bill ? bill.name : detected ? `Add ${detected.name}` : 'Add a bill'
  const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? 'Someone'

  return (
    <Sheet
      title={title}
      subtitle={
        bill ? (
          <span className="flex items-center gap-1.5">
            <SourceBadge source={bill.source} />
            {bill.lastPaid && `Last paid ${formatDate(bill.lastPaid)}`}
          </span>
        ) : detected ? (
          'Ordo found this in your email but not in a statement, so it needs the amount.'
        ) : (
          'For bills that don’t show up in a statement, like rent paid by a flatmate.'
        )
      }
      icon={<Receipt size={22} />}
      width={520}
      busy={busy}
      onClose={onClose}
      onSubmit={save}
      footer={
        <>
          {bill &&
            (confirmDelete ? (
              <Button
                className="text-danger!"
                disabled={busy}
                onClick={() => void run([() => window.ordo.money.deleteBill(bill.id)])}
              >
                Delete {bill.name}?
              </Button>
            ) : (
              <Button className="text-danger!" disabled={busy} onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            ))}
          <span className="flex-1" />
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? 'Saving…' : bill ? 'Save' : 'Add bill'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label="Name"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          className="col-span-2"
        />
        {fromBank ? (
          <p className="col-span-2 text-ink-2">
            {formatPence(bill!.amount)} {CADENCE_LABEL[bill!.cadence].toLowerCase()}, next due{' '}
            {formatDate(bill!.nextDue)}. Amount and dates come from your bank statements.
          </p>
        ) : (
          <>
            <TextField
              label="Amount (£)"
              inputMode="decimal"
              placeholder="0.00"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
            />
            <Select label="Repeats" value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
              {(['weekly', 'monthly', 'yearly'] as const).map((c) => (
                <option key={c} value={c}>
                  {CADENCE_LABEL[c]}
                </option>
              ))}
            </Select>
            <TextField
              label="Next due"
              type="date"
              value={nextDue}
              min={detected ? toISODate() : undefined}
              onChange={(e) => setNextDue(e.target.value)}
            />
          </>
        )}
        {bill && (
          <label className="col-span-2 flex items-center gap-2">
            <input
              type="checkbox"
              checked={cancelled}
              onChange={(e) => setCancelled(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            I’ve cancelled this
          </label>
        )}
      </div>

      {bill && (
        <div className="flex flex-col gap-3 border-t border-sep pt-4">
          <label className="flex items-center gap-2 font-semibold">
            <input
              type="checkbox"
              checked={splitOn}
              onChange={(e) => setSplitOn(e.target.checked)}
              className="accent-[var(--accent)]"
            />
            <Users size={14} className="text-ink-2" /> Split this bill
          </label>
          {splitOn && people.length < 2 && (
            <Notice>Add your flatmates on the Bills page first, then come back to split this.</Notice>
          )}
          {splitOn && people.length >= 2 && (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <Select label="Paid by" value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
                <Segmented label="Split" value={mode} options={MODES} onChange={changeMode} />
              </div>
              <ul className="overflow-hidden rounded-lg border border-sep">
                {people.map((p) => {
                  const on = included.has(p.id)
                  const share = shares?.find((s) => s.personId === p.id)
                  return (
                    <li
                      key={p.id}
                      className="flex h-9 items-center gap-2 border-b border-sep px-3 last:border-b-0"
                    >
                      <input
                        type="checkbox"
                        aria-label={`Include ${p.name}`}
                        checked={on}
                        onChange={() => toggle(p.id)}
                        className="accent-[var(--accent)]"
                      />
                      <span className={`flex-1 ${on ? '' : 'text-ink-3'}`}>
                        {p.name}
                        {p.id === paidBy && <span className="ml-1.5 text-[11px] text-ink-3">pays</span>}
                      </span>
                      {on && mode !== 'equal' && (
                        <span className="flex items-center gap-1 text-ink-2">
                          {mode === 'fixed' && '£'}
                          <input
                            aria-label={`${p.name}’s ${mode === 'fixed' ? 'amount' : 'percentage'}`}
                            inputMode="decimal"
                            value={values[p.id] ?? ''}
                            onChange={(e) => setValues((v) => ({ ...v, [p.id]: e.target.value }))}
                            className="h-6 w-20 rounded-md border border-sep bg-field px-1.5 text-right text-ink tabular-nums outline-none select-text focus:border-accent focus:ring-1 focus:ring-accent"
                          />
                          {mode === 'percent' && '%'}
                        </span>
                      )}
                      <span className="w-20 text-right tabular-nums">
                        {on && share ? formatPence(share.amount) : '—'}
                      </span>
                    </li>
                  )
                })}
              </ul>
              {splitError ? (
                <p className="text-[12px] text-danger">{splitError}</p>
              ) : (
                shares && (
                  <p className="text-[12px] text-ink-2">
                    {nameOf(paidBy) === 'Me' ? 'You pay' : `${nameOf(paidBy)} pays`} the bill; everyone else
                    owes their share each time it’s paid. Odd pennies go to whoever pays.
                  </p>
                )
              )}
            </>
          )}
        </div>
      )}

      {error && <Notice tone="error">{error}</Notice>}
    </Sheet>
  )
}
