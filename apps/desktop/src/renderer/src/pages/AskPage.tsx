import { useCallback, useEffect, useState } from 'react'
import { GraduationCap, MessageCircleQuestion } from 'lucide-react'
import type { AskProposalView, MemoryResult, MemoryView, QuestionView, SaveFactInput } from '@ordo/shared'
import { Button } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import { AskPanel } from '../components/money/ask/AskPanel'
import { ComparePanel } from '../components/money/ask/Compare'
import { EventsPanel } from '../components/money/ask/Events'
import { KnowsPanel } from '../components/money/ask/Knows'
import { LooseEndsPanel } from '../components/money/ask/LooseEnds'
import { QuestionsPanel } from '../components/money/ask/Questions'
import { TeachSheet } from '../components/money/ask/TeachSheet'
import { Notice } from '../components/money/ui'
import type { Route } from '../routes'

/**
 * Ask Ordo: questions about your money answered with Ordo's own numbers, the questions Ordo has
 * for you, loose ends, events and trips, and everything it has learned.
 */
export function AskPage({ onNavigate }: { onNavigate: (r: Route) => void }) {
  const [view, setView] = useState<MemoryView | null>(null)
  const [version, setVersion] = useState(0)
  const [teaching, setTeaching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void window.ordo.moneyMemory.view().then((v) => live && setView(v))
    return () => {
      live = false
    }
  }, [version])

  const refresh = useCallback(() => setVersion((v) => v + 1), [])

  const result = useCallback(
    (r: MemoryResult) => {
      setError(r.ok ? null : r.message)
      refresh()
      return r
    },
    [refresh],
  )

  const save = useCallback(
    async (input: SaveFactInput) => result(await window.ordo.moneyMemory.saveFact(input)),
    [result],
  )
  const forget = useCallback(
    async (id: string) => void result(await window.ordo.moneyMemory.deleteFact(id)),
    [result],
  )
  const answer = useCallback(
    async (q: QuestionView, answerId: string, via: 'question' | 'onboarding' = 'question') =>
      void result(await window.ordo.moneyMemory.answer({ questionId: q.id, answerId, via })),
    [result],
  )
  const saveProposal = async (p: AskProposalView) => (await save({ fact: p.fact, source: 'ask' })).ok

  if (!view) return null

  if (!view.hasTransactions)
    return (
      <EmptyState
        icon={<MessageCircleQuestion size={40} strokeWidth={1.5} />}
        title="Ask about your money"
        body="Import your bank statements on Finances first. Ordo then learns how your money works: paybacks, money you hold for others, trips and who owes you."
        action={
          <Button variant="primary" onClick={() => onNavigate('money/finances')}>
            Import a statement
          </Button>
        }
      />
    )

  return (
    <div className="@container min-h-full px-6 pt-5 pb-8">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h2 className="text-[20px] font-semibold tracking-tight">How your money works</h2>
          <p className="text-ink-2">
            Ordo learns from your answers. Everything stays on this computer unless you choose a cloud model.
          </p>
        </div>
        <Button variant="primary" icon={<GraduationCap size={14} />} onClick={() => setTeaching(true)}>
          Teach Ordo
        </Button>
      </div>

      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 items-start gap-4 @4xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-4">
          <AskPanel
            ask={view.ask}
            events={view.events}
            onOpenSettings={() => onNavigate('settings')}
            onSaveFact={saveProposal}
          />
          <ComparePanel initial={view.compare} categories={view.categories} accounts={view.accounts} />
          <EventsPanel events={view.events} onSave={save} onForget={forget} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <QuestionsPanel
            questions={view.questions}
            onAnswer={(q, a) => answer(q, a)}
            onTeach={() => setTeaching(true)}
          />
          <LooseEndsPanel view={view} onSave={save} />
          <KnowsPanel facts={view.facts} caveats={view.caveats} onSave={save} onForget={forget} />
        </div>
      </div>

      {teaching && (
        <TeachSheet
          view={view}
          onClose={() => setTeaching(false)}
          onAnswer={(q, a, via) => answer(q, a, via)}
          onSave={save}
        />
      )}
    </div>
  )
}
