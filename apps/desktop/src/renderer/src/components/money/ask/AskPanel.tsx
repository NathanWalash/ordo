import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowUp, Check, Laptop, Cloud, MessageCircleQuestion, Square } from 'lucide-react'
import type { MoneyAskOutcome, AskProposalView, AskStep, MemoryView } from '@ordo/shared'
import { Button } from '../../Button'
import { Notice } from '../ui'

interface Turn {
  question: string
  outcome: MoneyAskOutcome
  /** Proposals being saved, saved or skipped, by index. */
  done: Record<number, 'saving' | 'saved' | 'skipped'>
}

const SUGGESTIONS = [
  'What am I holding for other people?',
  'How does this month compare with last month?',
  'Who still owes me money?',
]

/**
 * Ask Ordo about your money. The model answers by calling Ordo's query functions, so every number
 * in an answer was worked out by Ordo. Suggested facts are only saved when you press Save.
 */
export function AskPanel({
  ask,
  events,
  onOpenSettings,
  onSaveFact,
}: {
  ask: MemoryView['ask']
  events: MemoryView['events']
  onOpenSettings: () => void
  onSaveFact: (p: AskProposalView) => Promise<boolean>
}) {
  const [text, setText] = useState('')
  const [turns, setTurns] = useState<Turn[]>([])
  const [busy, setBusy] = useState<{ question: string; step: AskStep | null } | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const end = useRef<HTMLDivElement>(null)

  // Braces matter: scrollIntoView returns a promise in newer Chromium, and an effect must not return one.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'nearest' })
  }, [turns.length, busy])

  const send = async (question: string) => {
    const q = question.trim()
    if (!q || busy || !ask.ready) return
    setText('')
    setBusy({ question: q, step: null })
    const off = window.ordo.moneyMemory.onAskStep((step) => setBusy({ question: q, step }))
    try {
      const history = turns
        .filter((t) => t.outcome.ok)
        .slice(-4)
        .map((t) => ({ question: t.question, answer: t.outcome.ok ? t.outcome.answer : '' }))
      const outcome = await window.ordo.moneyMemory.ask({ question: q, history })
      setTurns((ts) => [...ts, { question: q, outcome, done: {} }])
    } finally {
      off()
      setBusy(null)
      input.current?.focus()
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    void send(text)
  }

  const mark = (turn: number, i: number, state: Turn['done'][number] | null) =>
    setTurns((ts) =>
      ts.map((t, n) => {
        if (n !== turn) return t
        const done = { ...t.done }
        if (state) done[i] = state
        else delete done[i]
        return { ...t, done }
      }),
    )

  const trip = events[0]?.name
  const suggestions = trip ? [`How much did ${trip} cost me?`, ...SUGGESTIONS.slice(0, 2)] : SUGGESTIONS

  return (
    <section aria-labelledby="ask-title" className="rounded-xl border border-sep">
      <header className="flex min-h-10 items-center justify-between gap-2 border-b border-sep px-4 py-2">
        <h3 id="ask-title" className="flex items-center gap-1.5 text-[13px] font-semibold">
          <MessageCircleQuestion size={14} className="text-accent" /> Ask about your money
        </h3>
        {ask.provider && ask.ready && (
          <span className="flex items-center gap-1 text-[11px] text-ink-2">
            {ask.cloud ? <Cloud size={12} /> : <Laptop size={12} />}
            {ask.cloud ? 'Amounts, dates and names go to your cloud model' : 'Stays on this computer'}
          </span>
        )}
      </header>

      <div className="flex flex-col gap-3 px-4 py-3">
        {!ask.ready && (
          <div className="flex items-center justify-between gap-3 rounded-md bg-hover px-3 py-2 text-ink-2">
            <span>
              {ask.reason === 'consent'
                ? 'To ask questions with a cloud model, allow it to see exact amounts, dates and names in Settings → AI. A model on this computer needs no extra step.'
                : 'Choose a model in Settings → AI to ask questions. Ordo’s questions, loose ends and events below work without one.'}
            </span>
            <Button onClick={onOpenSettings}>Open Settings</Button>
          </div>
        )}

        {turns.length > 0 && (
          <ol className="flex flex-col gap-4" aria-label="Answers">
            {turns.map((t, n) => (
              <li key={n} className="flex flex-col gap-1.5">
                <p className="self-end rounded-lg bg-accent px-3 py-1.5 text-white">{t.question}</p>
                {t.outcome.ok ? (
                  <Answer
                    outcome={t.outcome}
                    done={t.done}
                    onSave={async (p, i) => {
                      // Disable Save straight away: a double click must not save the fact twice.
                      mark(n, i, 'saving')
                      mark(n, i, (await onSaveFact(p)) ? 'saved' : null)
                    }}
                    onSkip={(i) => mark(n, i, 'skipped')}
                    onOption={(o) => void send(o)}
                    disabled={!!busy}
                  />
                ) : (
                  <Notice tone="error">{t.outcome.message}</Notice>
                )}
              </li>
            ))}
          </ol>
        )}

        {busy && (
          <div
            className="flex items-center justify-between gap-3 rounded-md bg-hover px-3 py-2 text-ink-2"
            role="status"
          >
            <span>{busy.step ? `${busy.step.label}…` : 'Thinking…'}</span>
            <Button icon={<Square size={11} />} onClick={() => void window.ordo.moneyMemory.askStop()}>
              Stop
            </Button>
          </div>
        )}
        <div ref={end} />

        <form onSubmit={submit} className="flex items-end gap-2">
          <textarea
            ref={input}
            aria-label="Ask about your money"
            placeholder={
              ask.ready ? 'Ask about your money, or tell Ordo something…' : 'Set up a model to ask questions'
            }
            rows={1}
            maxLength={500}
            value={text}
            disabled={!ask.ready}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send(text)
              }
            }}
            className="no-drag min-h-7 flex-1 resize-none [field-sizing:content] rounded-md border border-sep bg-field px-2 py-1 text-[13px] text-ink outline-none select-text placeholder:text-ink-3 focus:border-accent focus:ring-1 focus:ring-accent disabled:opacity-60"
          />
          <Button
            type="submit"
            variant="primary"
            icon={<ArrowUp size={13} />}
            disabled={!ask.ready || !!busy || !text.trim()}
          >
            Ask
          </Button>
        </form>
        {ask.ready && turns.length === 0 && !busy && (
          <div className="flex flex-wrap gap-1.5" aria-label="Try asking">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void send(s)}
                className="no-drag rounded-full border border-sep px-2.5 py-0.5 text-[12px] text-ink-2 hover:bg-hover"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <p className="text-[11px] leading-snug text-ink-3">
          Ordo works out every number itself; the model only decides what to look up and how to say it.
        </p>
      </div>
    </section>
  )
}

function Answer({
  outcome,
  done,
  disabled,
  onSave,
  onSkip,
  onOption,
}: {
  outcome: Extract<MoneyAskOutcome, { ok: true }>
  done: Turn['done']
  disabled: boolean
  onSave: (p: AskProposalView, i: number) => void
  onSkip: (i: number) => void
  onOption: (o: string) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="whitespace-pre-line select-text leading-relaxed">
        {outcome.parts.map((p, i) =>
          p.kind === 'text' ? (
            <span key={i}>{p.text}</span>
          ) : (
            <Figure key={i} label={p.label} value={p.value} />
          ),
        )}
      </p>
      {outcome.steps.length > 0 && (
        <p className="text-[11px] text-ink-3">
          Looked at: {[...new Set(outcome.steps.map((s) => s.label))].join(' · ')}
        </p>
      )}
      {outcome.proposals.map((p, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-lg border border-sep px-3 py-2"
          aria-label={`Suggestion: ${p.summary}`}
          role="group"
        >
          <div className="min-w-0 flex-1">
            <div className="text-[12px] text-ink-2">Remember this?</div>
            <div>{p.summary}</div>
          </div>
          {done[i] === 'saved' ? (
            <span className="flex items-center gap-1 text-[12px] text-success">
              <Check size={13} /> Saved
            </span>
          ) : done[i] === 'skipped' ? (
            <span className="text-[12px] text-ink-3">Skipped</span>
          ) : (
            <>
              <Button
                className="h-6 px-2.5 text-[12px]"
                disabled={done[i] === 'saving'}
                onClick={() => onSkip(i)}
              >
                Not now
              </Button>
              <Button
                variant="primary"
                className="h-6 px-2.5 text-[12px]"
                disabled={done[i] === 'saving'}
                onClick={() => onSave(p, i)}
              >
                {done[i] === 'saving' ? 'Saving…' : 'Save'}
              </Button>
            </>
          )}
        </div>
      ))}
      {outcome.clarify && (
        <div
          className="flex flex-col gap-1.5 rounded-lg bg-hover px-3 py-2"
          role="group"
          aria-label="Ordo asks"
        >
          <div>{outcome.clarify.question}</div>
          <div className="flex flex-wrap gap-1.5">
            {outcome.clarify.options.map((o) => (
              <Button
                key={o}
                className="h-6 px-2.5 text-[12px]"
                disabled={disabled}
                onClick={() => onOption(o)}
              >
                {o}
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * One of Ordo's figures in an answer: its own label and the value it worked out, drawn apart from
 * the model's prose so words next to it can't change what it says.
 */
function Figure({ label, value }: { label: string; value: string }) {
  return (
    <span
      role="group"
      aria-label={`${label}: ${value}`}
      title={`${label}, worked out by Ordo`}
      className="mx-0.5 inline-flex items-baseline gap-1.5 rounded-md border border-sep bg-hover px-1.5 py-px align-baseline whitespace-nowrap"
    >
      <span className="text-[11px] text-ink-2">{label}</span>
      <span className="font-semibold tabular-nums">{value}</span>
    </span>
  )
}
