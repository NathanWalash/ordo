import { useState, type FormEvent } from 'react'
import { Trash2 } from 'lucide-react'
import type { AccountCaveat, FactView, MemoryResult, SaveFactInput } from '@ordo/shared'
import { Button } from '../../Button'
import { Panel } from '../ui'

const SOURCE: Record<FactView['source'], string> = {
  you: 'You added this',
  question: 'Your answer',
  onboarding: 'From Teach Ordo',
  ask: 'Saved from Ask Ordo',
}

/** Everything Ordo has learned, in plain sentences, each one easy to forget. */
export function KnowsPanel({
  facts,
  caveats,
  onSave,
  onForget,
}: {
  facts: FactView[]
  caveats: AccountCaveat[]
  onSave: (input: SaveFactInput) => Promise<MemoryResult>
  onForget: (id: string) => Promise<void>
}) {
  const [note, setNote] = useState('')
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? facts : facts.slice(0, 8)

  const addNote = async (e: FormEvent) => {
    e.preventDefault()
    if (!note.trim()) return
    const r = await onSave({ fact: { kind: 'note', text: note.trim() } })
    if (r.ok) setNote('')
  }

  const setDates = (c: AccountCaveat, dates: string) => {
    const existing = facts.find(
      (f) => f.kind === 'account' && f.account.toLowerCase() === c.account.toLowerCase(),
    )
    if (dates === 'auto') return existing ? void onForget(existing.id) : undefined
    void onSave({
      ...(existing && { id: existing.id }),
      fact: { kind: 'account', account: c.account, dates: dates as 'posting' | 'transaction' },
    })
  }

  return (
    <Panel title="What Ordo knows">
      {facts.length ? (
        <ul aria-label="What Ordo knows">
          {shown.map((f) => (
            <li key={f.id} className="group flex items-start gap-2 border-b border-sep px-4 py-2">
              <div className="min-w-0 flex-1">
                <div className="leading-snug">{f.summary}</div>
                <div className="text-[11px] text-ink-3">{SOURCE[f.source]}</div>
              </div>
              <button
                type="button"
                aria-label={`Forget: ${f.summary}`}
                title="Forget this"
                onClick={() => void onForget(f.id)}
                className="no-drag mt-0.5 rounded p-0.5 text-ink-3 hover:bg-hover hover:text-danger"
              >
                <Trash2 size={13} />
              </button>
            </li>
          ))}
          {facts.length > shown.length && (
            <li className="border-b border-sep px-4 py-1.5">
              <button
                type="button"
                className="no-drag text-[12px] text-accent"
                onClick={() => setShowAll(true)}
              >
                Show all {facts.length}
              </button>
            </li>
          )}
        </ul>
      ) : (
        <p className="border-b border-sep px-4 py-3 text-ink-2">
          Nothing yet. Answer a question or teach Ordo, and what it learns shows up here.
        </p>
      )}

      {caveats.length > 0 && (
        <div className="border-b border-sep px-4 py-2">
          <h4 className="mb-1 text-[11px] font-semibold text-ink-3">How your banks date payments</h4>
          <ul className="flex flex-col gap-1.5">
            {caveats.map((c) => (
              <li key={c.account} className="flex items-center justify-between gap-2 text-[12px]">
                <span className="min-w-0 text-ink-2">{c.text}</span>
                <select
                  aria-label={`How ${c.account} dates payments`}
                  value={c.from === 'you' ? c.dates : 'auto'}
                  onChange={(e) => setDates(c, e.target.value)}
                  className="no-drag h-6 shrink-0 rounded-[5px] border border-sep bg-field px-1 text-[12px] text-ink outline-none focus:border-accent"
                >
                  <option value="auto">Ordo’s guess</option>
                  <option value="transaction">Day I paid</option>
                  <option value="posting">Day it cleared</option>
                </select>
              </li>
            ))}
          </ul>
        </div>
      )}

      <form onSubmit={(e) => void addNote(e)} className="flex gap-2 px-4 py-2.5">
        <input
          aria-label="Tell Ordo something"
          placeholder="Tell Ordo something, like “HSBC is my bills account”"
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
          className="no-drag h-7 min-w-0 flex-1 rounded-md border border-sep bg-field px-2 text-[13px] text-ink outline-none select-text placeholder:text-ink-3 focus:border-accent focus:ring-1 focus:ring-accent"
        />
        <Button type="submit" disabled={!note.trim()}>
          Save
        </Button>
      </form>
    </Panel>
  )
}
