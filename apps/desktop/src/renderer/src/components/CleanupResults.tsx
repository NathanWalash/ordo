import { CircleCheck, CircleX, ExternalLink, Minus } from 'lucide-react'
import type { CleanupSummary, UndoResult } from '@ordo/shared'
import { categoryColor } from './SenderTable'

type Outcome = CleanupSummary['senders'][number]['unsubscribe']

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** "Moved 1,812 emails to Trash. Unsubscribed from 3 senders; 1 link to finish in your browser; 1 failed." */
export function resultSentence(c: CleanupSummary): string {
  const outcomes = c.senders.map((s) => s.unsubscribe?.status)
  const done = outcomes.filter((s) => s === 'done').length
  const opened = outcomes.filter((s) => s === 'opened').length
  const failed = outcomes.filter((s) => s === 'failed').length
  const parts: string[] = []
  if (c.moved) parts.push(`Moved ${plural(c.moved, 'email')} to Trash.`)
  const unsub: string[] = []
  if (done) unsub.push(`unsubscribed from ${plural(done, 'sender')}`)
  if (opened) unsub.push(`${plural(opened, 'link')} to finish in your browser`)
  if (failed) unsub.push(`${failed} failed`)
  if (unsub.length) {
    const text = unsub.join('; ')
    parts.push(`${text[0]!.toUpperCase()}${text.slice(1)}.`)
  }
  return parts.join(' ') || 'Nothing changed.'
}

export function undoSentence(r: UndoResult): string {
  if (r.reason === 'already-undone') return 'This clean-up was already undone.'
  if (r.reason === 'no-map')
    return 'Your mail server didn’t say where the emails went, so Ordo can’t put them back. Find them in Trash.'
  if (r.reason === 'trash-renumbered')
    return `Trash has been reset since this clean-up, so none of the ${plural(r.missing, 'email')} could be found. Look in Trash.`
  const back = `Moved ${plural(r.restored, 'email')} back to your inbox.`
  return r.missing ? `${back} ${plural(r.missing, 'email')} weren’t in Trash any more.` : back
}

/** The status of one unsubscribe, with an icon. */
export function UnsubscribeOutcome({ outcome }: { outcome: Outcome }) {
  if (!outcome || outcome.status === 'skipped')
    return (
      <span className="flex items-center gap-1 text-ink-3">
        <Minus size={13} /> Not unsubscribed
      </span>
    )
  if (outcome.status === 'done')
    return (
      <span className="flex items-center gap-1 text-ink">
        <CircleCheck size={13} className="shrink-0 text-success" />
        {outcome.method === 'mailto' ? 'Unsubscribe email sent' : 'Unsubscribed'}
      </span>
    )
  if (outcome.status === 'opened')
    return (
      <span className="flex items-center gap-1 text-ink">
        <ExternalLink size={13} className="shrink-0 text-accent" /> Opened. Finish in your browser
      </span>
    )
  return (
    <span className="flex min-w-0 items-center gap-1 text-danger" title={outcome.detail}>
      <CircleX size={13} className="shrink-0" />
      <span className="truncate">Failed: {outcome.detail ?? 'unknown error'}</span>
    </span>
  )
}

/** One row per sender: name, unsubscribe result, emails moved. */
export function CleanupSenderRows({ cleanup }: { cleanup: CleanupSummary }) {
  return (
    <ul className="divide-y divide-[var(--sep)]">
      {cleanup.senders.map((s) => (
        <li
          key={s.address}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_96px] items-center gap-3 px-4 py-2"
        >
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: categoryColor(s.category) }}
              />
              <span className="truncate font-medium">{s.name ?? s.address}</span>
            </div>
            <div className="truncate pl-4 text-[12px] text-ink-2">{s.address}</div>
          </div>
          <div className="min-w-0 text-[12px]">
            <UnsubscribeOutcome outcome={s.unsubscribe} />
          </div>
          <div className="text-right text-[12px] tabular-nums text-ink-2">
            {s.trash ? `${plural(s.moved, 'email')} moved` : 'Kept in inbox'}
          </div>
        </li>
      ))}
    </ul>
  )
}

export { plural }
