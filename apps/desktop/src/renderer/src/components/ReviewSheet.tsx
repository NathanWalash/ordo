import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  CircleCheck,
  CircleX,
  ExternalLink,
  Mail,
  MailX,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Undo2,
  Zap,
} from 'lucide-react'
import type {
  CategorisedSender,
  CleanupOutcome,
  CleanupProgress,
  CleanupSummary,
  UndoOutcome,
} from '@ordo/shared'
import { planMailto } from '@ordo/mail-core'
import { Button } from './Button'
import { CleanupSenderRows, plural, resultSentence, undoSentence } from './CleanupResults'
import { useFocusTrap } from './focus'
import { categoryColor } from './SenderTable'
import { Switch } from './Switch'

interface Props {
  /** The selected senders. People are filtered out here too, and again in the main process. */
  senders: CategorisedSender[]
  onClose: () => void
  /** A clean-up finished (or was undone): reload the sender analysis. */
  onChanged: () => void
  /**
   * `clear` (the default) reviews a bulk clean-up. `unsubscribe` is one sender's Unsubscribe button:
   * the sheet is titled for that sender and its main button says Unsubscribe.
   */
  purpose?: 'clear' | 'unsubscribe'
  /** Whether Move to Trash starts on for each sender. Defaults to on for a clean-up, off to unsubscribe. */
  initialTrash?: boolean
}

type Choice = { unsubscribe: boolean; trash: boolean }

const isInsecure = (s: CategorisedSender) =>
  s.unsubscribe.kind === 'link' && /^http:/i.test(s.unsubscribe.url)

/** The exact unsubscribe email Ordo would send (the main process recomputes and enforces it). */
const mailtoPlan = (s: CategorisedSender) =>
  s.unsubscribe.kind === 'mailto' ? planMailto(s.unsubscribe.url, s) : null

/** Plain http links and emails to another domain stay off until the user has read them and ticked. */
const needsTick = (s: CategorisedSender) => isInsecure(s) || Boolean(mailtoPlan(s)?.offDomain)

/**
 * How long the main button ignores presses after the sheet opens, so a second press of the key
 * or click that opened it can't unsubscribe (which can't be undone).
 */
export const REVIEW_ARM_MS = 500

/** Review sheet: per-sender choices, then progress, then the result with Undo. */
export function ReviewSheet({
  senders: selected,
  onClose,
  onChanged,
  purpose = 'clear',
  initialTrash = purpose === 'clear',
}: Props) {
  const senders = selected.filter((s) => s.category !== 'people')
  const single = purpose === 'unsubscribe'
  const [choices, setChoices] = useState<Record<string, Choice>>(() =>
    Object.fromEntries(
      senders.map((s) => [
        s.address,
        { unsubscribe: s.unsubscribe.kind !== 'none' && !needsTick(s), trash: initialTrash },
      ]),
    ),
  )
  const [progress, setProgress] = useState<CleanupProgress | null>(null)
  const [outcome, setOutcome] = useState<CleanupOutcome | null>(null)
  const [undo, setUndo] = useState<UndoOutcome | 'running' | null>(null)
  const clearButton = useRef<HTMLButtonElement>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLElement>(null)
  const [armed, setArmed] = useState(false)
  const working = progress !== null || undo === 'running'
  useFocusTrap(dialog)

  // Focus goes into the sheet: Cancel for one sender's Unsubscribe (Return there is safe), the main
  // button for a clean-up, and if that starts off (nothing on until a tick), the first switch, or
  // the sheet itself. Never left behind it.
  useEffect(() => {
    const root = dialog.current
    const enabled = (b: HTMLButtonElement | null) => (b && !b.disabled ? b : null)
    const first =
      (single ? cancelButton.current : enabled(clearButton.current)) ??
      root?.querySelector<HTMLElement>('[role="switch"]:not([disabled])') ??
      root
    first?.focus()
    const t = setTimeout(() => setArmed(true), REVIEW_ARM_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !working && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [working, onClose])

  const set = (address: string, patch: Partial<Choice>) =>
    setChoices((c) => ({ ...c, [address]: { ...c[address]!, ...patch } }))

  const unsubscribing = senders.filter((s) => choices[s.address]?.unsubscribe)
  const trashing = senders.filter((s) => choices[s.address]?.trash)
  const emails = trashing.reduce((n, s) => n + s.count, 0)
  // One sender's sheet says Unsubscribe, unless it's only been asked to move emails to Trash.
  const sayUnsubscribe = single && !(emails && !unsubscribing.length)

  const clear = async () => {
    setProgress({ phase: 'unsubscribe', done: 0, total: unsubscribing.length })
    const off = window.ordo.cleanup.onProgress(setProgress)
    try {
      const res = await window.ordo.cleanup.run({
        senders: senders.map((s) => ({
          address: s.address,
          ...choices[s.address]!,
          ...(isInsecure(s) && s.unsubscribe.kind === 'link' && { confirmedUrl: s.unsubscribe.url }),
          ...(mailtoPlan(s)?.offDomain && { confirmedRecipient: mailtoPlan(s)!.message.to }),
        })),
      })
      setOutcome(res)
      if (res.ok) onChanged()
    } finally {
      off()
      setProgress(null)
    }
  }

  const undoMove = async (c: CleanupSummary) => {
    setUndo('running')
    const res = await window.ordo.cleanup.undo(c.id)
    setUndo(res)
    if (res.ok) onChanged()
  }

  let body
  if (progress) body = <Working progress={progress} />
  else if (outcome?.ok)
    body = (
      <Result
        cleanup={outcome.cleanup}
        rejected={outcome.rejected}
        undo={undo}
        onUndo={undoMove}
        onDone={onClose}
      />
    )
  else
    body = (
      <>
        <div className="max-h-[min(52vh,440px)] overflow-auto border-y border-sep">
          <div className="glass-bar sticky top-0 z-[1] grid grid-cols-[minmax(0,1fr)_72px_118px_92px] items-center gap-3 px-5 py-1.5 text-[11px] font-medium text-ink-3 shadow-[inset_0_-1px_0_var(--sep)]">
            <span>Sender</span>
            <span className="text-right">Emails</span>
            <span>Unsubscribe</span>
            <span>Move to Trash</span>
          </div>
          <ul className="divide-y divide-[var(--sep)]">
            {senders.map((s) => (
              <ReviewRow
                key={s.address}
                sender={s}
                choice={choices[s.address]!}
                onChange={(patch) => set(s.address, patch)}
              />
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-3 px-6 pt-4 pb-5">
          <p className="text-[13px] font-medium" aria-live="polite">
            {summarySentence(unsubscribing.length, emails)}
          </p>
          <p className="flex gap-1.5 text-[12px] leading-snug text-ink-2">
            <ShieldCheck size={14} className="mt-px shrink-0" />
            {single && !emails
              ? 'Your emails stay in your inbox. Unsubscribing can’t be undone.'
              : 'Emails go to Trash, not deleted, and you can undo the move from History. Unsubscribing can’t be undone.'}
          </p>
          {outcome && !outcome.ok && (
            <p role="alert" className="text-[12px] text-danger">
              {outcome.message}
            </p>
          )}
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button ref={cancelButton} onClick={onClose}>
              Cancel
            </Button>
            <Button
              ref={clearButton}
              variant="primary"
              icon={sayUnsubscribe ? <MailX size={14} /> : <Trash2 size={14} />}
              disabled={!unsubscribing.length && !emails}
              // Ignores presses for a moment after the sheet opens (see REVIEW_ARM_MS).
              aria-disabled={armed ? undefined : true}
              onClick={() => armed && void clear()}
            >
              {sayUnsubscribe ? 'Unsubscribe' : 'Clear'}
            </Button>
          </div>
        </div>
      </>
    )

  const only = senders.length === 1 ? senders[0]! : null
  const name = only ? (only.name ?? only.address) : ''
  // One sender's unsubscribe, once it's run: did it work?
  const unsub = single && outcome?.ok ? outcome.cleanup.senders[0]?.unsubscribe : undefined
  const failed = unsub?.status === 'failed'
  const title = single
    ? outcome?.ok
      ? unsub?.status === 'done'
        ? `Unsubscribed from ${name}`
        : unsub?.status === 'opened'
          ? 'Finish in your browser'
          : failed
            ? 'Couldn’t unsubscribe'
            : 'Done'
      : progress
        ? 'Unsubscribing…'
        : `Unsubscribe from ${name}`
    : outcome?.ok
      ? 'Clean-up done'
      : progress
        ? 'Clearing…'
        : 'Review clean-up'
  const subtitle = outcome?.ok
    ? resultSentence(outcome.cleanup)
    : single && only
      ? `${only.address}. Your emails stay in your inbox unless you turn on Move to Trash.`
      : `${plural(senders.length, 'sender')} selected. People you’ve written to are never included.`
  const main = document.querySelector('main')
  const sheet = (
    <div className="absolute inset-0 z-20 flex justify-center bg-black/20 pt-16 dark:bg-black/40">
      <section
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-title"
        tabIndex={-1}
        // A held key repeats: never let a repeat press a button here.
        onKeyDown={(e) => {
          if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault()
        }}
        className="outline-none glass-panel flex h-fit max-h-[calc(100%-96px)] w-[680px] max-w-[calc(100%-32px)] flex-col overflow-hidden rounded-xl"
      >
        <header className="flex items-center gap-3.5 px-6 pt-5 pb-4">
          <span
            className={`flex size-11 shrink-0 items-center justify-center rounded-[10px] text-white ${failed ? 'bg-danger-strong' : outcome?.ok ? 'bg-success' : 'bg-accent'}`}
          >
            {failed ? (
              <CircleX size={22} />
            ) : outcome?.ok ? (
              <CircleCheck size={22} />
            ) : single ? (
              <MailX size={22} />
            ) : (
              <Trash2 size={22} />
            )}
          </span>
          <div className="min-w-0">
            <h2 id="review-title" className="text-[15px] font-semibold">
              {title}
            </h2>
            <p className="text-[12px] leading-snug text-ink-2">{subtitle}</p>
          </div>
        </header>
        {body}
      </section>
    </div>
  )
  return main ? createPortal(sheet, main) : sheet
}

export function summarySentence(unsubscribe: number, emails: number): string {
  const u = unsubscribe ? `unsubscribe from ${plural(unsubscribe, 'sender')}` : ''
  const m = emails ? `move ${plural(emails, 'email')} to Trash` : ''
  const text = [u, m].filter(Boolean).join(' and ')
  return text ? `${text[0]!.toUpperCase()}${text.slice(1)}` : 'Nothing to do. Turn on at least one action.'
}

function ReviewRow({
  sender: s,
  choice,
  onChange,
}: {
  sender: CategorisedSender
  choice: Choice
  onChange: (patch: Partial<Choice>) => void
}) {
  const name = s.name ?? s.address
  const insecure = isInsecure(s)
  const mailto = mailtoPlan(s)
  return (
    <li className="px-5 py-2">
      <div className="grid grid-cols-[minmax(0,1fr)_72px_118px_92px] items-center gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: categoryColor(s.category) }}
            />
            <span className="truncate font-medium">{name}</span>
          </div>
          <div className="truncate pl-4 text-[12px] text-ink-2">{s.address}</div>
        </div>
        <div className="text-right tabular-nums">{s.count.toLocaleString()}</div>
        <div className="flex items-center gap-2">
          <Switch
            size="mini"
            label={`Unsubscribe from ${name}`}
            checked={choice.unsubscribe}
            disabled={s.unsubscribe.kind === 'none'}
            onChange={(unsubscribe) => onChange({ unsubscribe })}
          />
          <MethodLabel sender={s} />
        </div>
        <div className="flex items-center">
          <Switch
            size="mini"
            label={`Move emails from ${name} to Trash`}
            checked={choice.trash}
            onChange={(trash) => onChange({ trash })}
          />
        </div>
      </div>
      {insecure && s.unsubscribe.kind === 'link' && (
        <p className="mt-1 flex items-start gap-1.5 pl-4 text-[12px] leading-snug text-ink-2">
          <TriangleAlert size={13} className="mt-px shrink-0" style={{ color: 'var(--promotions)' }} />
          <span className="min-w-0">
            Not secure. Turning this on opens{' '}
            <span className="break-all text-ink select-text">{s.unsubscribe.url}</span> in your browser.
          </span>
        </p>
      )}
      {mailto && (
        <p className="mt-1 flex items-start gap-1.5 pl-4 text-[12px] leading-snug text-ink-2">
          {mailto.offDomain && (
            <TriangleAlert size={13} className="mt-px shrink-0" style={{ color: 'var(--promotions)' }} />
          )}
          <span className="min-w-0 break-all select-text">
            {mailto.offDomain && `Email unsubscribe to a different domain (${mailto.message.to}). `}
            Sends “<span className="text-ink">{mailto.message.subject}</span>” to{' '}
            <span className="text-ink">{mailto.message.to}</span> from your iCloud address.
          </span>
        </p>
      )}
    </li>
  )
}

function MethodLabel({ sender }: { sender: CategorisedSender }) {
  const m = sender.unsubscribe
  const cls = 'flex items-center gap-1 text-[12px] text-ink-2'
  if (m.kind === 'one-click')
    return (
      <span className={cls} title="Ordo unsubscribes for you">
        <Zap size={12} /> One-click
      </span>
    )
  if (m.kind === 'link')
    return (
      <span className={cls} title={m.url}>
        <ExternalLink size={12} /> Opens link
      </span>
    )
  if (m.kind === 'mailto')
    return (
      <span className={cls} title={`Sends an email to ${m.address}`}>
        <Mail size={12} /> Email
      </span>
    )
  return <span className="text-[12px] text-ink-3">None</span>
}

function Working({ progress }: { progress: CleanupProgress }) {
  const pct = progress.total ? Math.min(100, (progress.done / progress.total) * 100) : 0
  const line =
    progress.phase === 'unsubscribe'
      ? `Unsubscribing… ${progress.done} of ${progress.total}`
      : progress.phase === 'move'
        ? `Moving emails to Trash… ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`
        : 'Finishing up…'
  return (
    <div className="px-6 pt-1 pb-6" aria-live="polite">
      <div
        className="h-1.5 overflow-hidden rounded-full bg-selected"
        role="progressbar"
        aria-label="Clean-up progress"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2.5 text-[12px] text-ink-2">{line}</p>
    </div>
  )
}

function Result({
  cleanup,
  rejected,
  undo,
  onUndo,
  onDone,
}: {
  cleanup: CleanupSummary
  rejected: { address: string; reason: string }[]
  undo: UndoOutcome | 'running' | null
  onUndo: (c: CleanupSummary) => void
  onDone: () => void
}) {
  const done = useRef<HTMLButtonElement>(null)
  useEffect(() => done.current?.focus(), [])
  const undone = undo !== null && undo !== 'running' && undo.ok
  return (
    <>
      <div className="max-h-[min(52vh,440px)] overflow-auto border-y border-sep">
        <CleanupSenderRows cleanup={cleanup} />
      </div>
      <div className="flex flex-col gap-2.5 px-6 pt-4 pb-5">
        {cleanup.error && (
          <p role="alert" className="flex gap-1.5 text-[12px] text-danger">
            <TriangleAlert size={14} className="mt-px shrink-0" />
            Stopped part-way: {cleanup.error}. Everything listed above was done.
          </p>
        )}
        {rejected.map((r) => (
          <p key={r.address} className="text-[12px] text-ink-2">
            Skipped {r.address}: {r.reason}
          </p>
        ))}
        {undo !== null && undo !== 'running' && (
          <p role="status" className={`text-[12px] ${undo.ok ? 'text-ink-2' : 'text-danger'}`}>
            {undo.ok ? undoSentence(undo) : undo.message}
          </p>
        )}
        <p className="text-[12px] text-ink-2">Unsubscribes can’t be undone. Past clean-ups are in History.</p>
        <div className="flex items-center justify-end gap-2 pt-1">
          {cleanup.canUndo && !undone && (
            <Button icon={<Undo2 size={14} />} disabled={undo === 'running'} onClick={() => onUndo(cleanup)}>
              {undo === 'running' ? 'Undoing…' : 'Undo move'}
            </Button>
          )}
          <Button ref={done} variant="primary" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    </>
  )
}
