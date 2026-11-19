import { useState } from 'react'
import { GraduationCap } from 'lucide-react'
import type { MemoryResult, MemoryView, QuestionStep, QuestionView, SaveFactInput } from '@ordo/shared'
import { Button } from '../../Button'
import { Sheet } from '../../Sheet'
import { Notice } from '../ui'
import { QuestionCard } from './Questions'

const STEPS = ['accounts', 'people', 'regular', 'matches', 'more'] as const
type Step = (typeof STEPS)[number]

const TITLES: Record<Step, { title: string; intro: string }> = {
  accounts: {
    title: 'Your accounts',
    intro:
      'Some banks list a payment on the day it cleared, not the day you paid. Ordo uses this to warn you when the last few days may be missing.',
  },
  people: {
    title: 'People',
    intro:
      'Who are the people you pay and who pay you? Flatmates are added to Bills so you can split with them.',
  },
  regular: {
    title: 'Rent and regular money in',
    intro: 'Money someone pays you every month might be theirs to pass on, not your income.',
  },
  matches: {
    title: 'Paybacks',
    intro:
      'Was money that came in someone paying you back, or just passing through? Ordo shows how sure it is.',
  },
  more: {
    title: 'Anything else',
    intro: 'Tell Ordo anything else about how your money works, in your own words. It keeps it as a note.',
  },
}

/**
 * Teach Ordo about your money: a guided walk through your accounts, the people you pay, money
 * that comes in regularly and paybacks. Every answer becomes something Ordo knows.
 */
export function TeachSheet({
  view,
  onClose,
  onAnswer,
  onSave,
}: {
  view: MemoryView
  onClose: () => void
  onAnswer: (q: QuestionView, answerId: string, via: 'onboarding') => Promise<void>
  onSave: (input: SaveFactInput) => Promise<MemoryResult>
}) {
  const [step, setStep] = useState<Step>('accounts')
  const [note, setNote] = useState('')
  const [saved, setSaved] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const i = STEPS.indexOf(step)
  const questions = (s: QuestionStep) =>
    view.questions.filter((q) => q.step === s).slice(0, s === 'matches' ? 5 : 8)

  /** Save the note, if there is one. False when it couldn't be saved. */
  const saveNote = async () => {
    if (!note.trim()) return true
    const r = await onSave({ fact: { kind: 'note', text: note.trim() }, source: 'onboarding' })
    if (!r.ok) {
      setError(r.message)
      return false
    }
    setNote('')
    setSaved((n) => n + 1)
    return true
  }

  const setDates = async (account: string, dates: 'posting' | 'transaction') => {
    const existing = view.facts.find(
      (f) => f.kind === 'account' && f.account.toLowerCase() === account.toLowerCase(),
    )
    const r = await onSave({
      ...(existing && { id: existing.id }),
      fact: { kind: 'account', account, dates },
      source: 'onboarding',
    })
    if (!r.ok) setError(r.message)
  }

  const finish = async () => {
    if (await saveNote()) onClose()
  }

  return (
    <Sheet
      title="Teach Ordo about your money"
      subtitle={`Step ${i + 1} of ${STEPS.length}: ${TITLES[step].title}`}
      icon={<GraduationCap size={22} />}
      width={560}
      onClose={onClose}
      onSubmit={() => (step === 'more' ? void finish() : setStep(STEPS[i + 1]!))}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <span className="flex-1" />
          {i > 0 && <Button onClick={() => setStep(STEPS[i - 1]!)}>Back</Button>}
          <Button type="submit" variant="primary">
            {step === 'more' ? 'Done' : 'Next'}
          </Button>
        </>
      }
    >
      <p className="text-ink-2">{TITLES[step].intro}</p>

      {step === 'accounts' &&
        (view.caveats.length ? (
          <ul className="flex flex-col rounded-lg border border-sep" aria-label="Your accounts">
            {view.caveats.map((c) => (
              <li
                key={c.account}
                className="flex items-center gap-3 border-b border-sep px-3 py-2 last:border-b-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{c.account}</div>
                  <div className="text-[12px] text-ink-2">{c.text}</div>
                </div>
                <select
                  aria-label={`How ${c.account} dates payments`}
                  value={c.dates === 'unknown' ? '' : c.dates}
                  onChange={(e) => void setDates(c.account, e.target.value as 'posting' | 'transaction')}
                  className="no-drag h-7 shrink-0 rounded-md border border-sep bg-field px-2 text-[13px] text-ink outline-none focus:border-accent"
                >
                  {c.dates === 'unknown' && <option value="">Not sure</option>}
                  <option value="transaction">Day I paid</option>
                  <option value="posting">Day it cleared</option>
                </select>
              </li>
            ))}
          </ul>
        ) : (
          <Notice>Import a statement on Finances first.</Notice>
        ))}

      {(step === 'people' || step === 'regular' || step === 'matches') &&
        (questions(step).length ? (
          <ul
            className="max-h-[50vh] overflow-auto rounded-lg border border-sep"
            aria-label={TITLES[step].title}
          >
            {questions(step).map((q) => (
              <QuestionCard key={q.id} question={q} onAnswer={(a) => onAnswer(q, a, 'onboarding')} />
            ))}
          </ul>
        ) : (
          <Notice>Nothing to ask here right now.</Notice>
        ))}

      {step === 'more' && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor="teach-note" className="text-[13px] font-semibold">
            Note for Ordo
          </label>
          <textarea
            id="teach-note"
            rows={3}
            maxLength={200}
            value={note}
            placeholder="For example: HSBC is my bills account and Monzo is for everyday spending."
            onChange={(e) => setNote(e.target.value)}
            className="no-drag resize-none rounded-md border border-sep bg-field px-2 py-1.5 text-[13px] text-ink outline-none select-text placeholder:text-ink-3 focus:border-accent focus:ring-1 focus:ring-accent"
          />
          {saved > 0 && <p className="text-[12px] text-success">Saved.</p>}
          <p className="text-[12px] text-ink-2">
            With a model set up, you can also tell Ask Ordo things like “Genest’s £30 was for Halloween”, and
            it will suggest what to remember.
          </p>
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </Sheet>
  )
}
