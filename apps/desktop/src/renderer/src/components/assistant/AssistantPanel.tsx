import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import {
  ArrowUp,
  CalendarDays,
  Check,
  CircleAlert,
  CircleCheck,
  CircleX,
  Compass,
  Inbox,
  Loader2,
  MessageSquareText,
  Receipt,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  Wallet,
  X,
} from 'lucide-react'
import type { AssistantInfo } from '@ordo/shared'
import type { Route } from '../../routes'
import { Button } from '../Button'
import { elapsed, groupTrace, workedFor, type Item, type ReplyItem, type TraceEntry } from './conversation'
import { suggestionsFor, type SuggestionIcon } from './suggestions'
import type { Assistant } from './useAssistant'

interface Props {
  assistant: Assistant
  route: Route
  /** Shortcut label for the platform, e.g. "⌘K". */
  shortcut: string
  onClose: () => void
  onOpenSettings: () => void
}

const SUGGESTION_ICONS: Record<SuggestionIcon, ReactNode> = {
  mail: <Inbox size={14} />,
  calendar: <CalendarDays size={14} />,
  money: <Wallet size={14} />,
  bills: <Receipt size={14} />,
  sparkles: <Sparkles size={14} />,
}

/**
 * The assistant: a frosted panel on the right of the content, over whatever page is open. Opened
 * with ⌘K or ⌘J (Ctrl on Windows and Linux) or the toolbar button; Escape closes it.
 */
export function AssistantPanel({ assistant, route, shortcut, onClose, onOpenSettings }: Props) {
  const { info, items, busy } = assistant
  const titleId = useId()
  const input = useRef<HTMLTextAreaElement>(null)
  const log = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState('')

  const refreshInfo = assistant.refreshInfo
  useEffect(() => refreshInfo(), [refreshInfo])
  // Focus the composer once it can take input (it's disabled until a model is set up).
  const ready = info?.ready === true
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    if (ready) input.current?.focus()
    else panel.current?.focus()
  }, [ready])

  // Keep the newest message in view.
  useLayoutEffect(() => {
    const el = log.current
    if (el) el.scrollTop = el.scrollHeight
  }, [items])

  // Grow the composer with its text, up to five lines.
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 112)}px`
  }, [draft])

  const send = (text: string) => {
    const q = text.trim()
    if (!q || busy || !info?.ready) return
    setDraft('')
    void assistant.ask(q, route)
    input.current?.focus()
  }

  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send(draft)
    }
  }

  const onPanelKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
    }
  }

  return (
    <section
      ref={panel}
      tabIndex={-1}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      onKeyDown={onPanelKey}
      className="assistant-pop glass-panel no-drag absolute outline-none top-[60px] right-3 bottom-3 z-30 flex w-[392px] max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-[14px]"
    >
      <header className="flex items-center gap-2.5 border-b border-sep px-3.5 py-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-accent text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25)]">
          <Sparkles size={15} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-[13px] leading-tight font-semibold">
            Assistant
          </h2>
          <ProviderLine info={info} />
        </div>
        <IconButton
          label="Clear conversation"
          onClick={assistant.clear}
          disabled={busy || items.length === 0}
        >
          <RotateCcw size={14} />
        </IconButton>
        <IconButton label="Close assistant" onClick={onClose}>
          <X size={15} />
        </IconButton>
      </header>

      <div
        ref={log}
        role="log"
        aria-label="Conversation"
        aria-live="polite"
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3.5 py-4"
      >
        {info && !info.ready ? (
          <NotReady info={info} onOpenSettings={onOpenSettings} />
        ) : items.length === 0 ? (
          <Welcome route={route} onPick={send} disabled={!info?.ready || busy} />
        ) : (
          items.map((item) => <Message key={item.id} item={item} onAnswerCard={assistant.answerCard} />)
        )}
      </div>

      {info?.dataNotice && (
        <p className="mx-3.5 mb-2 flex gap-2 rounded-[8px] bg-warn-tint px-2.5 py-2 text-[11.5px] leading-snug text-ink">
          <ShieldAlert size={14} className="mt-px shrink-0 text-warn" aria-hidden />
          <span>{info.dataNotice}</span>
        </p>
      )}

      <form
        className="assistant-composer px-3 pb-3"
        onSubmit={(e) => {
          e.preventDefault()
          send(draft)
        }}
      >
        <div className="flex items-end gap-2 rounded-[12px] bg-field py-1.5 pr-1.5 pl-3 shadow-[0_0_0_1px_var(--sep),0_1px_2px_rgb(0_0_0/0.04)] focus-within:shadow-[0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-tint)]">
          <textarea
            ref={input}
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onComposerKey}
            maxLength={2000}
            disabled={!info?.ready}
            aria-label="Ask the assistant"
            placeholder="Ask about your mail, calendar or money"
            className="max-h-28 min-h-[22px] flex-1 resize-none bg-transparent py-[3px] text-[13px] leading-[18px] text-ink outline-none select-text placeholder:text-ink-3 disabled:opacity-60"
          />
          {busy ? (
            <button
              type="button"
              onClick={assistant.stop}
              aria-label="Stop"
              title="Stop"
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink text-content hover:opacity-85"
            >
              <Square size={10} fill="currentColor" aria-hidden />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              title="Send"
              disabled={!draft.trim() || !info?.ready}
              className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-opacity enabled:hover:brightness-110 disabled:opacity-35"
            >
              <ArrowUp size={15} strokeWidth={2.4} aria-hidden />
            </button>
          )}
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-ink-3">
          Ordo asks before changing anything · <kbd className="font-sans">{shortcut}</kbd> to open or close
        </p>
      </form>
    </section>
  )
}

function ProviderLine({ info }: { info: AssistantInfo | null }) {
  if (!info) return <p className="text-[11px] text-ink-3">Checking…</p>
  if (!info.label) return <p className="text-[11px] text-ink-3">No model chosen</p>
  const where = info.kind === 'cloud' ? 'Cloud' : 'Local'
  // "openai/gpt-oss-20b" → "gpt-oss-20b": the vendor prefix only crowds the line.
  const model = info.model?.split('/').at(-1)
  return (
    <p
      className="flex items-center gap-1.5 truncate text-[11px] text-ink-2"
      title={info.kind === 'cloud' ? `Sent to ${info.label}` : 'Runs on this computer'}
    >
      <span
        aria-hidden
        className={`size-1.5 shrink-0 rounded-full ${info.kind === 'cloud' ? 'bg-[var(--promotions)]' : 'bg-success'}`}
      />
      <span className="truncate">{[info.label, model, where].filter(Boolean).join(' · ')}</span>
    </p>
  )
}

function IconButton(props: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
      disabled={props.disabled}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-2 enabled:hover:bg-hover enabled:hover:text-ink disabled:opacity-35"
    >
      {props.children}
    </button>
  )
}

function NotReady({ info, onOpenSettings }: { info: AssistantInfo; onOpenSettings: () => void }) {
  return (
    <div className="assistant-rise m-auto flex max-w-[280px] flex-col items-center gap-2 text-center">
      <span className="mb-1 flex size-10 items-center justify-center rounded-[10px] bg-accent-tint text-accent">
        <Sparkles size={20} aria-hidden />
      </span>
      <h3 className="text-[15px] font-semibold">Set up a model first</h3>
      <p className="text-[12px] leading-relaxed text-ink-2">{info.message}</p>
      <p className="text-[12px] leading-relaxed text-ink-2">
        LM Studio or Ollama keep everything on this computer.
      </p>
      <Button variant="primary" className="mt-2" onClick={onOpenSettings}>
        Open Settings
      </Button>
    </div>
  )
}

function Welcome({
  route,
  onPick,
  disabled,
}: {
  route: Route
  onPick: (q: string) => void
  disabled: boolean
}) {
  return (
    <div className="assistant-rise mt-auto flex flex-col gap-4">
      <div className="px-1">
        <span className="mb-3 flex size-9 items-center justify-center rounded-[10px] bg-accent-tint text-accent shadow-[0_0_0_1px_var(--accent-tint),0_8px_24px_var(--accent-tint)]">
          <Sparkles size={18} aria-hidden />
        </span>
        <h3 className="text-[17px] leading-snug font-semibold tracking-[-0.01em]">What can I help with?</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-2">
          I can look things up in your mail, calendar and money, open pages for you, and make changes once you
          confirm them.
        </p>
      </div>
      <ul aria-label="Suggestions" className="flex flex-col gap-1">
        {suggestionsFor(route).map((s, i) => (
          <li key={s.text} className="assistant-rise" style={{ animationDelay: `${60 + i * 40}ms` }}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(s.text)}
              className="group flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left text-[12.5px] text-ink shadow-[0_0_0_1px_var(--sep)] enabled:hover:bg-hover disabled:opacity-50"
            >
              <span className="text-ink-3 group-hover:text-accent">{SUGGESTION_ICONS[s.icon]}</span>
              <span className="flex-1">{s.text}</span>
              <ArrowUp
                size={13}
                className="rotate-45 text-ink-3 opacity-0 group-hover:opacity-100"
                aria-hidden
              />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Message({
  item,
  onAnswerCard,
}: {
  item: Item
  onAnswerCard: (id: string, approve: boolean) => void
}) {
  if (item.kind === 'user')
    return (
      <div className="assistant-rise flex justify-end pl-10">
        <p className="rounded-[14px] rounded-br-[5px] bg-accent-tint px-3 py-1.5 text-[13px] leading-[18px] whitespace-pre-wrap text-ink select-text">
          {item.text}
        </p>
      </div>
    )
  return <Reply item={item} onAnswerCard={onAnswerCard} />
}

function Reply({
  item,
  onAnswerCard,
}: {
  item: ReplyItem
  onAnswerCard: (id: string, approve: boolean) => void
}) {
  const steps = item.trace.filter((t) => t.kind === 'tool').length
  const hasCard = item.trace.some((t) => t.kind === 'card')
  // A cancelled card already says nothing was changed.
  const showError = item.error && !(item.error.reason === 'cancelled' && hasCard)
  const footer = item.endedAt ? workedFor(item.endedAt - item.startedAt, steps) : null
  return (
    <article aria-label="Assistant reply" className="assistant-rise flex flex-col gap-2 pr-4">
      {groupTrace(item.trace).map((g) =>
        g.kind === 'tools' ? (
          <ul key={g.key} aria-label="Steps" className="flex flex-wrap gap-1.5">
            {g.entries.map((t) => (
              <ToolChip key={t.id} entry={t} />
            ))}
          </ul>
        ) : (
          <ConfirmationCard key={g.id} entry={g} onAnswer={onAnswerCard} />
        ),
      )}
      {item.status && <Working item={item} />}
      {item.answer && (
        <p className="text-[13px] leading-[1.55] whitespace-pre-wrap text-ink select-text [overflow-wrap:anywhere]">
          {item.answer}
        </p>
      )}
      {showError && item.error && (
        <p
          role={item.error.reason === 'failed' || item.error.reason === 'invalid' ? 'alert' : undefined}
          className="flex items-start gap-1.5 text-[12.5px] leading-snug text-ink-2"
        >
          {item.error.reason === 'stopped' || item.error.reason === 'cancelled' ? (
            <CircleX size={14} className="mt-px shrink-0 text-ink-3" aria-hidden />
          ) : (
            <CircleAlert size={14} className="mt-px shrink-0 text-danger" aria-hidden />
          )}
          {item.error.message}
        </p>
      )}
      {footer && <p className="text-[11px] text-ink-3 tabular-nums">{footer}</p>}
    </article>
  )
}

function Working({ item }: { item: ReplyItem }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])
  return (
    <p role="status" className="flex items-center gap-2 text-[12.5px]">
      <span className="shimmer-text font-medium">{item.status}</span>
      <span className="text-[11px] text-ink-3 tabular-nums">{elapsed(now - item.startedAt)}</span>
    </p>
  )
}

function ToolChip({ entry }: { entry: Extract<TraceEntry, { kind: 'tool' }> }) {
  const icon =
    entry.status === 'running' ? (
      <Loader2 size={12} className="animate-spin text-ink-3" aria-hidden />
    ) : entry.status === 'failed' ? (
      <CircleAlert size={12} className="text-danger" aria-hidden />
    ) : entry.toolKind === 'navigate' ? (
      <Compass size={12} className="text-accent" aria-hidden />
    ) : (
      <Check size={12} strokeWidth={2.6} className="text-success" aria-hidden />
    )
  return (
    <li
      className="flex max-w-full items-center gap-1.5 rounded-[6px] bg-field px-2 py-[3px] text-[11.5px] text-ink-2 shadow-[0_0_0_1px_var(--sep)]"
      title={entry.summary}
    >
      {icon}
      <span className="truncate text-ink">{entry.label}</span>
      {entry.summary && entry.status !== 'running' && (
        <span className="truncate text-ink-3 tabular-nums">· {entry.summary}</span>
      )}
    </li>
  )
}

function ConfirmationCard({
  entry,
  onAnswer,
}: {
  entry: Extract<TraceEntry, { kind: 'card' }>
  onAnswer: (id: string, approve: boolean) => void
}) {
  const { card, state } = entry
  const titleId = useId()
  const fromData = card.trigger.kind === 'data'
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  // Take focus when the card appears; Cancel is the safe default when the user didn't ask for it.
  useEffect(() => {
    if (state !== 'open') return
    ;(fromData || card.blocked ? cancelRef : confirmRef).current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <section
      role="group"
      aria-labelledby={titleId}
      className="assistant-rise flex flex-col gap-2.5 rounded-[12px] bg-field p-3 shadow-[var(--card-shadow)]"
    >
      <div className="flex items-start gap-2.5">
        <span
          className={`flex size-7 shrink-0 items-center justify-center rounded-[8px] ${
            fromData ? 'bg-warn-tint text-warn' : 'bg-accent-tint text-accent'
          }`}
        >
          {fromData ? <ShieldAlert size={15} aria-hidden /> : <ShieldCheck size={15} aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[10.5px] font-semibold tracking-[0.04em] text-ink-3 uppercase">
            Confirm a change
          </p>
          <h3 id={titleId} className="text-[13px] leading-snug font-semibold">
            {card.title}
          </h3>
        </div>
      </div>

      {card.details.length > 0 && (
        <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-[8px] bg-hover px-2.5 py-2 text-[12px] leading-snug select-text">
          {card.details.map((d, i) => (
            <li key={i} className="[overflow-wrap:anywhere]">
              {d}
            </li>
          ))}
        </ul>
      )}
      {card.notes.map((n, i) => (
        <p key={i} className="text-[11.5px] leading-snug text-ink-2">
          {n}
        </p>
      ))}

      <p
        className={`flex gap-2 rounded-[8px] px-2.5 py-2 text-[11.5px] leading-snug ${
          fromData ? 'bg-warn-tint text-ink' : 'text-ink-2 shadow-[0_0_0_1px_var(--sep)]'
        }`}
      >
        {fromData ? (
          <ShieldAlert size={13} className="mt-px shrink-0 text-warn" aria-hidden />
        ) : (
          <MessageSquareText size={13} className="mt-px shrink-0 text-ink-3" aria-hidden />
        )}
        <span className="min-w-0 [overflow-wrap:anywhere]">{card.trigger.text}</span>
      </p>

      {card.blocked && (
        <p className="flex gap-1.5 text-[12px] text-danger">
          <CircleAlert size={14} className="mt-px shrink-0" aria-hidden />
          {card.blocked}
        </p>
      )}

      {state === 'open' ? (
        <div className="flex justify-end gap-2 pt-0.5">
          <Button ref={cancelRef} onClick={() => onAnswer(entry.id, false)}>
            Cancel
          </Button>
          {!card.blocked && (
            <Button ref={confirmRef} variant="primary" onClick={() => onAnswer(entry.id, true)}>
              Confirm
            </Button>
          )}
        </div>
      ) : (
        <p role="status" className="flex items-center gap-1.5 text-[12px] font-medium text-ink-2">
          {state === 'approved' ? (
            <>
              <CircleCheck size={14} className="text-success" aria-hidden /> Confirmed
            </>
          ) : (
            <>
              <CircleX size={14} className="text-ink-3" aria-hidden /> Cancelled. Nothing was changed.
            </>
          )}
        </p>
      )}
    </section>
  )
}
