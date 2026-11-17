import { useCallback, useEffect, useState } from 'react'
import { History, TriangleAlert, Undo2 } from 'lucide-react'
import type { CleanupSummary, UndoOutcome } from '@ordo/shared'
import { Button } from '../components/Button'
import { CleanupSenderRows, plural, resultSentence, undoSentence } from '../components/CleanupResults'
import { EmptyState } from '../components/EmptyState'

/** Past clean-ups, newest first, each with per-sender results and Undo move. */
export function HistoryPage() {
  const [cleanups, setCleanups] = useState<CleanupSummary[] | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [messages, setMessages] = useState<Record<number, UndoOutcome>>({})

  const load = useCallback(async () => setCleanups(await window.ordo.cleanup.history()), [])
  useEffect(() => {
    let live = true
    void window.ordo.cleanup.history().then((c) => live && setCleanups(c))
    return () => {
      live = false
    }
  }, [])

  const undo = async (id: number) => {
    setBusy(id)
    try {
      const res = await window.ordo.cleanup.undo(id)
      setMessages((m) => ({ ...m, [id]: res }))
      await load()
    } finally {
      setBusy(null)
    }
  }

  if (cleanups === null) return null
  if (!cleanups.length)
    return (
      <EmptyState
        icon={<History size={40} strokeWidth={1.5} />}
        title="No clean-ups yet"
        body="When you clear senders in Unclutter, they’re listed here, and you can move their emails back from Trash."
      />
    )
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6">
      <p className="text-[12px] text-ink-2">
        Undo moves a clean-up’s emails from Trash back to your inbox. Unsubscribes can’t be undone.
      </p>
      {cleanups.map((c) => (
        <CleanupCard
          key={c.id}
          cleanup={c}
          busy={busy === c.id}
          disabled={busy !== null}
          message={messages[c.id]}
          onUndo={() => void undo(c.id)}
        />
      ))}
    </div>
  )
}

function CleanupCard(props: {
  cleanup: CleanupSummary
  busy: boolean
  disabled: boolean
  message?: UndoOutcome
  onUndo: () => void
}) {
  const c = props.cleanup
  const when = c.at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const titleId = `cleanup-${c.id}`
  let status: string | null = null
  if (c.undoneAt)
    status = `Undone ${c.undoneAt.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}: ${plural(c.restored ?? 0, 'email')} restored`
  else if (c.moved && !c.canUndo)
    status = 'Undo isn’t available: the server didn’t report where the emails went'
  return (
    <section aria-labelledby={titleId} className="overflow-hidden rounded-xl border border-sep bg-content">
      <header className="flex items-center justify-between gap-3 border-b border-sep bg-hover/50 px-4 py-2.5">
        <div className="min-w-0">
          <h2 id={titleId} className="text-[13px] font-semibold">
            {when}
          </h2>
          <p className="text-[12px] text-ink-2">
            {plural(c.senders.length, 'sender')}. {resultSentence(c)}
          </p>
        </div>
        {c.canUndo && (
          <Button
            icon={<Undo2 size={14} />}
            disabled={props.disabled}
            onClick={props.onUndo}
            aria-describedby={titleId}
          >
            {props.busy ? 'Undoing…' : 'Undo move'}
          </Button>
        )}
      </header>
      <CleanupSenderRows cleanup={c} />
      {(c.error || status || props.message) && (
        <footer className="flex flex-col gap-1 border-t border-sep px-4 py-2 text-[12px] text-ink-2">
          {c.error && (
            <span className="flex items-center gap-1.5 text-danger">
              <TriangleAlert size={13} /> Stopped part-way: {c.error}
            </span>
          )}
          {props.message && (
            <span role="status" className={props.message.ok ? '' : 'text-danger'}>
              {props.message.ok ? undoSentence(props.message) : props.message.message}
            </span>
          )}
          {status && !props.message && <span>{status}</span>}
        </footer>
      )}
    </section>
  )
}
