import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
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
  Cloud,
  Inbox,
  Loader2,
  MessageSquareText,
  Paperclip,
  Receipt,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Send,
  Sparkles,
  SquareKanban,
  SquarePen,
  Square,
  Wallet,
  X,
} from 'lucide-react'
import {
  CARD_ARM_MS,
  SEND_ARM_MS,
  type AssistantInfo,
  type CardEmail,
  type CardRecipient,
} from '@ordo/shared'
import type { Route } from '../../routes'
import { Button } from '../Button'
import {
  answerBlocks,
  elapsed,
  groupTrace,
  WAITING,
  workedFor,
  type Item,
  type ReplyItem,
  type TraceEntry,
} from './conversation'
import { suggestionsFor, type SuggestionIcon } from './suggestions'
import type { Assistant } from './useAssistant'

export const PANEL_ID = 'assistant-panel'
export const COMPOSER_ID = 'assistant-composer'

interface Props {
  assistant: Assistant
  route: Route
  /** Shortcut label for the platform, e.g. "⌘K". */
  shortcut: string
  /** Beside the content (it shrinks to make room) rather than over it. */
  docked: boolean
  onClose: () => void
  onOpenSettings: () => void
}

const SUGGESTION_ICONS: Record<SuggestionIcon, ReactNode> = {
  mail: <Inbox size={14} />,
  calendar: <CalendarDays size={14} />,
  money: <Wallet size={14} />,
  bills: <Receipt size={14} />,
  sparkles: <Sparkles size={14} />,
  boards: <SquareKanban size={14} />,
}

/**
 * The assistant: a panel on the right of the content, over or beside whatever page is open. Opened
 * with ⌘K or ⌘J (Ctrl on Windows and Linux) or the toolbar button; Escape closes it.
 */
export function AssistantPanel({ assistant, route, shortcut, docked, onClose, onOpenSettings }: Props) {
  const { info, items, busy, waiting, draft, setDraft } = assistant
  const titleId = useId()
  const panel = useRef<HTMLElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const log = useRef<HTMLDivElement>(null)

  const refreshInfo = assistant.refreshInfo
  useEffect(() => refreshInfo(), [refreshInfo])

  const ready = info?.ready === true
  const needsConsent = ready && info?.cloud !== undefined && !info.cloud.consent
  const canAsk = ready && !needsConsent

  // Focus the composer when it can take input; otherwise the panel (Not ready moves it to its button).
  useEffect(() => {
    if (canAsk) input.current?.focus()
    else if (!info) panel.current?.focus()
  }, [canAsk, info])

  // After a card is answered, give focus back to the composer.
  const wasWaiting = useRef(waiting)
  useEffect(() => {
    if (wasWaiting.current && !waiting) {
      const frame = requestAnimationFrame(() => input.current?.focus())
      wasWaiting.current = waiting
      return () => cancelAnimationFrame(frame)
    }
    wasWaiting.current = waiting
  }, [waiting])

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
    if (!q || busy || !canAsk) return
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

  const size = docked
    ? 'w-[392px]'
    : 'w-[min(392px,calc(100%-1.5rem))] max-w-[50%] min-w-[320px] shadow-[var(--panel-shadow)]'

  return (
    <section
      id={PANEL_ID}
      ref={panel}
      tabIndex={-1}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      onKeyDown={onPanelKey}
      className={`assistant-pop assistant-surface no-drag absolute top-[60px] right-3 bottom-3 z-30 flex flex-col overflow-hidden rounded-xl ${size}`}
    >
      <header className="flex items-center gap-2.5 border-b border-sep px-3.5 py-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.25)]">
          <Sparkles size={15} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-[13px] leading-tight font-semibold">
            Assistant
          </h2>
          <ProviderLine info={info} />
        </div>
        <IconButton label="New conversation" onClick={assistant.clear}>
          <SquarePen size={15} />
        </IconButton>
        <IconButton label="Close assistant" onClick={onClose}>
          <X size={15} />
        </IconButton>
      </header>

      {!info ? (
        <div className="flex-1" />
      ) : !ready ? (
        <NotReady info={info} onOpenSettings={onOpenSettings} />
      ) : needsConsent && info.cloud ? (
        <CloudConsent
          info={info}
          onAllow={() => void assistant.setCloudConsent(true)}
          onOpenSettings={onOpenSettings}
        />
      ) : items.length === 0 ? (
        <Welcome
          route={route}
          info={info}
          onPick={send}
          onFill={(text) => {
            setDraft(text)
            requestAnimationFrame(() => {
              const el = input.current
              if (!el) return
              el.focus()
              el.setSelectionRange(text.length, text.length)
            })
          }}
          disabled={busy}
          onStopSharing={() => void assistant.setCloudConsent(false)}
        />
      ) : (
        <div
          ref={log}
          role="log"
          aria-label="Conversation"
          className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3.5 py-4"
        >
          {items.map((item) => (
            <Message
              key={item.id}
              item={item}
              onAnswerCard={assistant.answerCard}
              onRetry={busy ? undefined : (q) => void assistant.ask(q, route)}
              onOpenSettings={onOpenSettings}
            />
          ))}
        </div>
      )}

      {canAsk && (
        <form
          className="px-3 pt-2 pb-3"
          onSubmit={(e) => {
            e.preventDefault()
            send(draft)
          }}
        >
          {info?.cloud && items.length > 0 && (
            <p className="mb-2 flex items-center gap-1.5 px-1 text-[11px] text-ink-2">
              <Cloud size={12} className="shrink-0 text-warn" aria-hidden />
              <span className="flex-1 truncate">Sent to {info.cloud.vendor} under your account</span>
              <button
                type="button"
                onClick={() => void assistant.setCloudConsent(false)}
                className="rounded-sm text-accent hover:underline"
              >
                Stop sharing
              </button>
            </p>
          )}
          <div className="flex items-end gap-2 rounded-[10px] bg-field py-1.5 pr-1.5 pl-3 shadow-[0_0_0_1px_var(--sep),0_1px_2px_rgb(0_0_0/0.04)] focus-within:shadow-[0_0_0_1px_var(--accent),0_0_0_3px_var(--accent-tint)]">
            <textarea
              id={COMPOSER_ID}
              ref={input}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposerKey}
              maxLength={2000}
              disabled={waiting}
              aria-label="Ask the assistant"
              placeholder={waiting ? 'Answer the card above first' : 'Ask about your mail, calendar or money'}
              className="max-h-28 min-h-[22px] flex-1 resize-none bg-transparent py-[3px] text-[13px] leading-[18px] text-ink outline-none select-text placeholder:text-ink-2 disabled:opacity-60"
            />
            {busy ? (
              <button
                type="button"
                onClick={assistant.stop}
                aria-label="Stop"
                title="Stop"
                className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-white enabled:hover:brightness-110"
              >
                <Square size={10} fill="currentColor" aria-hidden />
              </button>
            ) : (
              <button
                type="submit"
                aria-label="Send"
                title="Send"
                disabled={!draft.trim()}
                className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-opacity enabled:hover:brightness-110 disabled:opacity-35"
              >
                <ArrowUp size={15} strokeWidth={2.4} aria-hidden />
              </button>
            )}
          </div>
          <p className="mt-1.5 px-1 text-[11px] text-ink-2">
            Ordo asks before changing anything · <kbd className="font-sans">{shortcut}</kbd>
          </p>
        </form>
      )}
    </section>
  )
}

function ProviderLine({ info }: { info: AssistantInfo | null }) {
  if (!info) return <p className="text-[11px] text-ink-2">Checking…</p>
  if (!info.label) return <p className="text-[11px] text-ink-2">No model chosen</p>
  const where = info.kind === 'cloud' ? 'Cloud' : 'Local'
  // "openai/gpt-oss-20b" → "gpt-oss-20b": the vendor prefix only crowds the line.
  const model = info.model?.split('/').at(-1)
  return (
    <p
      className="flex items-center gap-1.5 truncate text-[11px] text-ink-2"
      title={info.cloud ? `Sent to ${info.cloud.vendor}` : 'Runs on this computer'}
    >
      <span
        aria-hidden
        className={`size-1.5 shrink-0 rounded-full ${info.kind === 'cloud' ? 'bg-warn' : 'bg-success'}`}
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
    <div className="assistant-rise m-auto flex max-w-[280px] flex-col items-center gap-2 px-4 text-center">
      <h3 className="text-[15px] font-semibold">Set up a model first</h3>
      <p className="text-[13px] leading-relaxed text-ink-2">{info.message}</p>
      <p className="text-[13px] leading-relaxed text-ink-2">
        LM Studio or Ollama keep everything on this computer.
      </p>
      <Button variant="primary" className="mt-2" onClick={onOpenSettings} autoFocus>
        Open Settings
      </Button>
    </div>
  )
}

function CloudConsent({
  info,
  onAllow,
  onOpenSettings,
}: {
  info: AssistantInfo
  onAllow: () => void
  onOpenSettings: () => void
}) {
  const [declined, setDeclined] = useState(false)
  const headingId = useId()
  const cloud = info.cloud!
  return (
    <div
      role="region"
      aria-labelledby={headingId}
      className="assistant-rise mt-auto flex flex-col gap-3 overflow-y-auto px-4 py-4"
    >
      <span className="flex size-8 items-center justify-center rounded-lg bg-warn-tint text-warn">
        <Cloud size={16} aria-hidden />
      </span>
      <h3 id={headingId} className="text-[15px] leading-snug font-semibold">
        Let the assistant send your data to {cloud.vendor}?
      </h3>
      <p className="text-[13px] leading-relaxed text-ink-2">
        You’ve chosen {info.label}, so the assistant’s model runs at {cloud.vendor}. {cloud.sends} It goes
        under your own account, and your account’s terms apply.
      </p>
      <p className="text-[13px] leading-relaxed text-ink-2">
        This is separate from sorting with AI, which sends much less. LM Studio or Ollama keep everything on
        this computer.
      </p>
      {declined ? (
        <div className="flex flex-col gap-2">
          <p role="status" className="text-[13px] text-ink">
            Nothing was sent. Choose LM Studio or Ollama in Settings to use the assistant on this computer.
          </p>
          <div className="flex gap-2">
            <Button onClick={onOpenSettings}>Open Settings</Button>
            <Button variant="primary" onClick={onAllow}>
              Allow after all
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-end gap-2">
          <Button autoFocus onClick={() => setDeclined(true)}>
            Not now
          </Button>
          <Button variant="primary" onClick={onAllow}>
            Allow
          </Button>
        </div>
      )}
    </div>
  )
}

function Welcome({
  route,
  info,
  onPick,
  onFill,
  disabled,
  onStopSharing,
}: {
  route: Route
  info: AssistantInfo
  onPick: (q: string) => void
  /** Put an unfinished prompt in the question box. */
  onFill: (q: string) => void
  disabled: boolean
  onStopSharing: () => void
}) {
  return (
    <div className="assistant-rise mt-auto flex flex-col gap-4 overflow-y-auto px-3.5 pt-4">
      <div className="px-1">
        <h3 className="text-[15px] leading-snug font-semibold">What can I help with?</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">
          I can look things up in your mail, calendar and money, open pages for you, and make changes once you
          confirm them.
        </p>
      </div>
      <ul aria-label="Suggestions" className="flex flex-col gap-1">
        {suggestionsFor(route).map((s, i) => (
          <li key={s.text} className="assistant-rise" style={{ animationDelay: `${60 + i * 40}ms` }}>
            <button
              type="button"
              aria-description={s.fill ? 'Finish this in the box' : undefined}
              disabled={disabled}
              onClick={() => (s.fill ? onFill(s.text.replace(/\s*…$/, ' ')) : onPick(s.text))}
              className="group flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-[13px] text-ink shadow-[0_0_0_1px_var(--sep)] enabled:hover:bg-hover disabled:opacity-50"
            >
              <span className="text-ink-3 group-hover:text-accent" aria-hidden>
                {SUGGESTION_ICONS[s.icon]}
              </span>
              <span className="flex-1">{s.text}</span>
            </button>
          </li>
        ))}
      </ul>
      {info.cloud && (
        <p className="flex gap-2 rounded-[10px] bg-warn-tint px-2.5 py-2 text-[11px] leading-snug text-ink">
          <ShieldAlert size={14} className="mt-px shrink-0 text-warn" aria-hidden />
          <span className="flex-1">
            {info.cloud.sends} It goes to {info.cloud.vendor} under your own account.{' '}
            <button type="button" onClick={onStopSharing} className="text-accent hover:underline">
              Stop sharing
            </button>
          </span>
        </p>
      )}
    </div>
  )
}

function Message({
  item,
  onAnswerCard,
  onRetry,
  onOpenSettings,
}: {
  item: Item
  onAnswerCard: (id: string, approve: boolean) => void
  onRetry?: (question: string) => void
  onOpenSettings: () => void
}) {
  if (item.kind === 'user')
    return (
      <div className="assistant-rise flex justify-end pl-10">
        <p className="rounded-[10px] rounded-br-[4px] bg-accent-tint px-3 py-1.5 text-[13px] leading-[18px] whitespace-pre-wrap text-ink select-text [overflow-wrap:anywhere]">
          <span className="sr-only">You said: </span>
          {item.text}
        </p>
      </div>
    )
  return <Reply item={item} onAnswerCard={onAnswerCard} onRetry={onRetry} onOpenSettings={onOpenSettings} />
}

function Reply({
  item,
  onAnswerCard,
  onRetry,
  onOpenSettings,
}: {
  item: ReplyItem
  onAnswerCard: (id: string, approve: boolean) => void
  onRetry?: (question: string) => void
  onOpenSettings: () => void
}) {
  const hasCard = item.trace.some((t) => t.kind === 'card')
  // A card already says nothing was changed, or why it couldn't be.
  const showError =
    item.error && !((item.error.reason === 'cancelled' || item.error.reason === 'blocked') && hasCard)
  const canRetry = item.error && (item.error.reason === 'failed' || item.error.reason === 'invalid')
  const footer = workedFor(item)
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
          <ConfirmationCard key={g.id} entry={g} onAnswer={onAnswerCard} onOpenSettings={onOpenSettings} />
        ),
      )}
      {item.status && <Working item={item} />}
      {item.answer && <Answer text={item.answer} />}
      {showError && item.error && (
        <div className="flex flex-col items-start gap-2">
          <p className="flex items-start gap-1.5 text-[13px] leading-snug text-ink-2">
            {item.error.reason === 'stopped' || item.error.reason === 'cancelled' ? (
              <CircleX size={14} className="mt-0.5 shrink-0 text-ink-3" aria-hidden />
            ) : (
              <CircleAlert size={14} className="mt-0.5 shrink-0 text-danger" aria-hidden />
            )}
            {item.error.message}
          </p>
          {canRetry && onRetry && (
            <Button icon={<RotateCcw size={13} aria-hidden />} onClick={() => onRetry(item.question)}>
              Try again
            </Button>
          )}
        </div>
      )}
      {footer && <p className="text-[11px] text-ink-2 tabular-nums">{footer}</p>}
    </article>
  )
}

function Answer({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2 text-[13px] leading-[1.55] text-ink select-text [overflow-wrap:anywhere]">
      {answerBlocks(text).map((b, i) =>
        b.kind === 'p' ? (
          <p key={i} className="whitespace-pre-wrap">
            {b.text}
          </p>
        ) : (
          <ul key={i} className="flex list-disc flex-col gap-0.5 pl-4 marker:text-ink-3">
            {b.items.map((t, j) => (
              <li key={j}>{t}</li>
            ))}
          </ul>
        ),
      )}
    </div>
  )
}

function Working({ item }: { item: ReplyItem }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])
  const waiting = item.status === WAITING
  return (
    <p role="status" className="flex items-center gap-2 text-[13px]">
      <span className={waiting ? 'font-medium text-ink-2' : 'shimmer-text font-medium'}>{item.status}</span>
      {!waiting && (
        <span aria-hidden className="text-[11px] text-ink-2 tabular-nums">
          {elapsed(now - item.startedAt)}
        </span>
      )}
    </p>
  )
}

function ToolChip({ entry }: { entry: Extract<TraceEntry, { kind: 'tool' }> }) {
  const icon =
    entry.status === 'running' ? (
      <Loader2 size={12} className="animate-spin text-ink-3" aria-hidden />
    ) : entry.status === 'failed' ? (
      <CircleAlert size={12} className="text-danger" aria-hidden />
    ) : (
      <Check size={12} strokeWidth={2.6} className="text-success" aria-hidden />
    )
  return (
    <li
      className="flex max-w-full items-center gap-1.5 rounded-md bg-field px-2 py-[3px] text-[11px] text-ink-2 shadow-[0_0_0_1px_var(--sep)]"
      title={entry.summary}
    >
      {icon}
      <span className="truncate text-ink">{entry.label}</span>
      {entry.status === 'failed' && entry.summary && <span className="truncate">· {entry.summary}</span>}
    </li>
  )
}

function ConfirmationCard({
  entry,
  onAnswer,
  onOpenSettings,
}: {
  entry: Extract<TraceEntry, { kind: 'card' }>
  onAnswer: (id: string, approve: boolean) => void
  onOpenSettings: () => void
}) {
  const { card, state } = entry
  const eyebrowId = useId()
  const titleId = useId()
  const triggerId = useId()
  const noteId = useId()
  const group = useRef<HTMLElement>(null)
  const blocked = state === 'blocked'
  const kind = blocked ? null : card.trigger.kind
  const fromData = kind === 'data'
  const sends = card.action === 'send'
  const drafts = card.tool === 'ordo_mail_draft'
  const armMs = sends ? SEND_ARM_MS : CARD_ARM_MS
  const [cancelReady, setCancelReady] = useState(false)
  const [ready, setReady] = useState(false)

  // Take focus (the card itself, never a button) and ignore presses for a moment, so a key or click
  // meant for something else can't answer it. Send waits longer than Cancel.
  useEffect(() => {
    if (state !== 'open') return
    group.current?.focus()
    const a = setTimeout(() => setCancelReady(true), CARD_ARM_MS)
    const b = setTimeout(() => setReady(true), armMs)
    return () => {
      clearTimeout(a)
      clearTimeout(b)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const confirm = () => {
    if (ready && state === 'open') onAnswer(entry.id, true)
  }
  const cancel = () => {
    if (cancelReady && state === 'open') onAnswer(entry.id, false)
  }
  // Escape on an open card cancels it, rather than closing the panel with the card still waiting.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || state !== 'open') return
    e.preventDefault()
    e.stopPropagation()
    cancel()
  }

  const eyebrow = blocked ? 'Can’t do this yet' : fromData ? 'Check this first' : 'Needs your OK'
  const noteIds = card.notes.map((_, i) => `${noteId}-${i}`)
  const describedBy = blocked ? undefined : [triggerId, ...(sends ? noteIds : [])].join(' ')

  return (
    <section
      ref={group}
      tabIndex={-1}
      role="group"
      aria-labelledby={`${eyebrowId} ${titleId}`}
      aria-describedby={describedBy}
      onKeyDown={onKeyDown}
      className="assistant-rise flex flex-col gap-2.5 rounded-[10px] bg-field p-3 shadow-[var(--card-shadow)] outline-none focus-visible:shadow-[0_0_0_1px_var(--accent),0_0_0_4px_var(--accent-tint),var(--card-shadow)]"
    >
      <div className="flex items-start gap-2.5">
        <span
          className={`flex size-7 shrink-0 items-center justify-center rounded-lg ${
            blocked
              ? 'bg-hover text-ink-2'
              : fromData
                ? 'bg-warn-tint text-warn'
                : 'bg-accent-tint text-accent'
          }`}
        >
          {blocked ? (
            <CircleAlert size={15} aria-hidden />
          ) : fromData ? (
            <ShieldAlert size={15} aria-hidden />
          ) : (
            <ShieldCheck size={15} aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p id={eyebrowId} className={`text-[11px] font-medium ${fromData ? 'text-warn' : 'text-ink-2'}`}>
            {eyebrow}
          </p>
          <h3 id={titleId} className="text-[13px] leading-snug font-semibold [overflow-wrap:anywhere]">
            {card.title}
          </h3>
        </div>
      </div>

      {(kind === 'data' || kind === 'sender') && (
        <p
          id={triggerId}
          className="flex gap-2 rounded-lg bg-warn-tint px-2.5 py-2 text-[11px] leading-snug text-ink"
        >
          {kind === 'data' ? (
            <ShieldAlert size={13} className="mt-px shrink-0 text-warn" aria-hidden />
          ) : (
            <CircleAlert size={13} className="mt-px shrink-0 text-warn" aria-hidden />
          )}
          <span className="min-w-0 [overflow-wrap:anywhere]">{card.trigger.text}</span>
        </p>
      )}

      {card.email && <EmailPreview email={card.email} />}

      {card.details.length > 0 && (
        <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-lg bg-hover px-2.5 py-2 text-[11px] leading-snug text-ink select-text">
          {card.details.map((d, i) => (
            <li key={i} title={d.title} className="[overflow-wrap:anywhere]">
              <Arrows text={d.text} />
            </li>
          ))}
        </ul>
      )}
      {!blocked &&
        card.notes.map((n, i) => (
          <p key={i} id={noteIds[i]} className="text-[11px] leading-snug text-ink-2">
            {n}
          </p>
        ))}

      {kind === 'request' && (
        <p id={triggerId} className="flex items-center gap-2 text-[11px] text-ink-2">
          <MessageSquareText size={13} className="shrink-0 text-ink-3" aria-hidden />
          {card.trigger.text}
        </p>
      )}

      {blocked && card.blocked && (
        <div className="flex flex-col items-start gap-2">
          <p className="flex gap-1.5 text-[13px] leading-snug text-ink">
            <CircleAlert size={14} className="mt-0.5 shrink-0 text-danger" aria-hidden />
            {card.blocked}
          </p>
          {/Settings/.test(card.blocked) && <Button onClick={onOpenSettings}>Open Settings</Button>}
        </div>
      )}

      {state === 'open' ? (
        <div className="flex justify-end gap-2 pt-0.5">
          <Button aria-disabled={!cancelReady || undefined} onClick={cancel}>
            Cancel
          </Button>
          {sends ? (
            // Only a Send the user asked for is filled; one the card warns about is plain, in red.
            <Button
              variant={fromData ? 'secondary' : 'primary'}
              className={`relative overflow-hidden ${fromData ? 'text-danger-text!' : ''}`}
              icon={<Send size={13} aria-hidden className="relative" />}
              aria-disabled={!ready || undefined}
              title={ready ? undefined : 'Ready in a moment'}
              onClick={confirm}
            >
              {!ready && (
                <span
                  aria-hidden
                  className={`arm-fill pointer-events-none absolute inset-0 ${fromData ? 'bg-danger-text/15' : 'bg-white/30'}`}
                  style={{ '--arm-ms': `${armMs}ms` } as CSSProperties}
                />
              )}
              <span className="relative">{fromData ? 'Send anyway' : 'Send'}</span>
            </Button>
          ) : (
            <Button
              variant={fromData ? 'secondary' : 'primary'}
              aria-disabled={!ready || undefined}
              onClick={confirm}
            >
              {drafts ? 'Save draft' : fromData ? 'Confirm anyway' : 'Confirm'}
            </Button>
          )}
        </div>
      ) : state === 'approved' && (sends || drafts) ? (
        <Outcome
          result={entry.result}
          text={entry.resultText}
          done={sends ? 'Sent' : 'Saved to Drafts'}
          failed={sends ? 'Not sent' : 'Not saved'}
          working={sends ? 'Sending…' : 'Saving…'}
        />
      ) : state === 'approved' ? (
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
          <CircleCheck size={14} className="text-success" aria-hidden /> Confirmed
        </p>
      ) : state === 'cancelled' ? (
        <p className="flex items-center gap-1.5 text-[11px] font-medium text-ink-2">
          <CircleX size={14} className="text-ink-3" aria-hidden />
          {sends ? 'Cancelled. Nothing was sent.' : 'Cancelled. Nothing was changed.'}
        </p>
      ) : null}
    </section>
  )
}

/** How a confirmed send or draft went: done (with any warning), failed with why, or still going. */
function Outcome(props: {
  result?: 'done' | 'failed'
  text?: string
  done: string
  failed: string
  working: string
}) {
  const { result, text } = props
  return (
    <p role="status" className="flex items-start gap-1.5 text-[11px] leading-snug font-medium">
      {result === 'done' && text ? (
        <>
          <CircleAlert size={14} className="shrink-0 text-warn" aria-hidden />
          <span className="text-ink">{text}</span>
        </>
      ) : result === 'done' ? (
        <>
          <CircleCheck size={14} className="shrink-0 text-success" aria-hidden />
          <span className="text-ink-2">{props.done}</span>
        </>
      ) : result === 'failed' ? (
        <>
          <CircleAlert size={14} className="shrink-0 text-danger" aria-hidden />
          <span className="text-danger-text">
            {props.failed}
            {text ? `: ${text}` : ''}
          </span>
        </>
      ) : (
        <>
          <Loader2 size={14} className="shrink-0 animate-spin text-ink-3" aria-hidden />
          <span className="text-ink-2">{props.working}</span>
        </>
      )}
    </p>
  )
}

/** A card line with " → " drawn as an arrow, read out as "to". */
function Arrows({ text }: { text: string }) {
  const parts = text.split(' → ')
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <>
              <span aria-hidden> → </span>
              <span className="sr-only"> to </span>
            </>
          )}
          {p}
        </Fragment>
      ))}
    </>
  )
}

const kb = (n: number) =>
  n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`

/** An address that can wrap after its @ and its dots, rather than anywhere. */
function Breakable({ address }: { address: string }) {
  const parts = address.split(/(?<=[@.])/)
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {p}
          {i < parts.length - 1 && <wbr />}
        </Fragment>
      ))}
    </>
  )
}

/** To or Cc: one address per line, each the user didn't type marked as such. */
function Recipients({ label, list }: { label: string; list: CardRecipient[] }) {
  return (
    <div className="flex gap-2">
      <dt className="w-14 shrink-0 font-medium text-ink">
        {list.length > 1 ? `${label} (${list.length})` : label}
      </dt>
      <dd className="min-w-0 flex-1">
        {list.length === 0 ? (
          'No one yet'
        ) : (
          <ul className="flex flex-col gap-0.5">
            {list.map((r) => (
              <li key={r.address} className={`flex items-start gap-1 ${r.untyped ? 'text-warn' : ''}`}>
                {r.untyped && <ShieldAlert size={11} className="mt-px shrink-0" aria-hidden />}
                <span className="min-w-0">
                  <Breakable address={r.address} />
                  {r.untyped && <span className="sr-only">, you didn’t type this address</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </dd>
    </div>
  )
}

/**
 * An email on a card, in full: who it's from and to (addresses, never names), the subject, what the
 * assistant wrote (never cut or scrolled away), and below it the quoted or forwarded original in a
 * box of its own.
 */
function EmailPreview({ email }: { email: CardEmail }) {
  return (
    <div
      aria-live="off"
      className="flex flex-col overflow-hidden rounded-lg bg-hover text-[11px] leading-snug text-ink"
    >
      <dl className="flex flex-col gap-1 border-b border-sep px-2.5 py-2 select-text">
        <div className="flex gap-2">
          <dt className="w-14 shrink-0 font-medium text-ink">From</dt>
          <dd className="min-w-0 flex-1">
            <Breakable address={email.from} />
          </dd>
        </div>
        <Recipients label="To" list={email.to} />
        {email.cc.length > 0 && <Recipients label="Cc" list={email.cc} />}
        <div className="flex gap-2">
          <dt className="w-14 shrink-0 font-medium text-ink">Subject</dt>
          <dd className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">
            {email.subject || '(no subject)'}
          </dd>
        </div>
      </dl>
      <div role="group" aria-label="Email text" className="flex flex-col">
        <p className="px-2.5 py-2 whitespace-pre-wrap select-text [overflow-wrap:anywhere]">
          {email.text.trim() ? email.text : <span className="text-ink-2">(no text)</span>}
        </p>
        {email.original && <Original original={email.original} />}
      </div>
      {email.attachments.length > 0 && (
        <ul aria-label="Attachments" className="flex flex-col gap-0.5 border-t border-sep px-2.5 py-2">
          {email.attachments.map((a, i) => (
            <li key={i} className="flex items-center gap-1.5 [overflow-wrap:anywhere]">
              <Paperclip size={11} className="shrink-0 text-ink-3" aria-hidden />
              {a.name} <span className="text-ink-2">({kb(a.size)})</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The quoted or forwarded original: its own labelled box, scrolled, saying when there's more. */
function Original({ original }: { original: NonNullable<CardEmail['original']> }) {
  const labelId = useId()
  const box = useRef<HTMLPreElement>(null)
  const [more, setMore] = useState(false)
  useLayoutEffect(() => {
    const el = box.current
    if (el) setMore(el.scrollHeight > el.clientHeight + 1)
  }, [original.text])
  return (
    <section aria-labelledby={labelId} className="mx-2.5 mb-2 overflow-hidden rounded-md bg-field">
      <h4 id={labelId} className="px-2.5 pt-1.5 text-[11px] font-medium text-ink">
        {original.kind === 'quoted' ? 'Quoted email' : 'Forwarded email'}
      </h4>
      <div className="relative">
        <pre
          ref={box}
          tabIndex={0}
          className="max-h-48 overflow-y-auto px-2.5 pt-0.5 pb-2 font-sans whitespace-pre-wrap text-ink select-text [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-accent"
        >
          {original.text.replace(/^\n+/, '')}
        </pre>
        {more && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-t from-field to-transparent"
          />
        )}
      </div>
      {more && <p className="px-2.5 pb-1.5 text-[11px] text-ink-2">Scroll to read it all</p>}
    </section>
  )
}
