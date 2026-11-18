import { useState } from 'react'
import type { MatchConfidence, QuestionView } from '@ordo/shared'
import { Button } from '../../Button'
import { Panel } from '../ui'

const CONFIDENCE: Record<MatchConfidence, { label: string; color: string; title: string }> = {
  exact: { label: 'Exact', color: 'var(--success)', title: 'The amounts match exactly, soon after' },
  likely: { label: 'Likely', color: 'var(--accent)', title: 'The amounts match closely' },
  check: { label: 'To check', color: 'var(--promotions)', title: 'Possible, but check it' },
}

export function ConfidenceBadge({ confidence }: { confidence: MatchConfidence }) {
  const c = CONFIDENCE[confidence]
  return (
    <span
      title={c.title}
      className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] px-1.5 text-[11px] font-medium"
      style={{ color: c.color, background: `color-mix(in srgb, ${c.color} 14%, transparent)` }}
    >
      {c.label}
    </span>
  )
}

/** One question with one-tap answers. The first answer is the likely one. */
export function QuestionCard({
  question: q,
  onAnswer,
}: {
  question: QuestionView
  onAnswer: (answerId: string) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const answer = async (id: string) => {
    setBusy(true)
    try {
      await onAnswer(id)
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className="flex flex-col gap-2 border-b border-sep px-4 py-3 last:border-b-0" aria-label={q.text}>
      <div className="flex items-start gap-2">
        <p className="flex-1 leading-snug">{q.text}</p>
        {q.confidence && <ConfidenceBadge confidence={q.confidence} />}
      </div>
      {q.detail && <p className="-mt-1 text-[12px] leading-snug text-ink-2">{q.detail}</p>}
      <div className="flex flex-wrap gap-1.5">
        {q.answers.map((a, i) => (
          <Button
            key={a.id}
            variant={i === 0 ? 'primary' : 'secondary'}
            className="h-6 px-2.5 text-[12px]"
            disabled={busy}
            onClick={() => void answer(a.id)}
          >
            {a.label}
          </Button>
        ))}
      </div>
    </li>
  )
}

/** Ordo's questions, a few at a time. Every answer is remembered. */
export function QuestionsPanel({
  questions,
  onAnswer,
  onTeach,
}: {
  questions: QuestionView[]
  onAnswer: (q: QuestionView, answerId: string) => Promise<void>
  onTeach: () => void
}) {
  const shown = questions.slice(0, 4)
  return (
    <Panel
      title={
        <>
          Questions for you{' '}
          {questions.length > 0 && <span className="font-normal text-ink-3">{questions.length}</span>}
        </>
      }
      actions={
        questions.length > shown.length ? (
          <Button className="h-6 px-2.5 text-[12px]" onClick={onTeach}>
            See all
          </Button>
        ) : undefined
      }
    >
      {shown.length ? (
        <ul aria-label="Questions for you">
          {shown.map((q) => (
            <QuestionCard key={q.id} question={q} onAnswer={(a) => onAnswer(q, a)} />
          ))}
        </ul>
      ) : (
        <p className="px-4 py-3 text-ink-2">
          No questions right now. Ordo asks when something doesn’t add up.
        </p>
      )}
    </Panel>
  )
}
