import { useEffect, useRef, type KeyboardEvent, type ReactNode, type UIEvent } from 'react'
import { Flag, Paperclip, Reply } from 'lucide-react'
import { displayName } from '@ordo/mail-core'
import type { MessageSummary } from '@ordo/shared'
import { fullDate, listDate, people } from './format'
import { nearEnd } from './paging'

export const keyOf = (m: { mailbox: string; uid: number }) => `${m.mailbox}\u0000${m.uid}`

interface Props {
  label: string
  messages: MessageSummary[]
  selected: string | null
  onSelect: (m: MessageSummary) => void
  /** Show recipients instead of senders (Sent, Drafts). */
  showRecipients: boolean
  /** Show which folder each message is in (search across folders). */
  showMailbox?: (path: string) => string
  /** Near the bottom: load the next page. */
  onEndReached?: () => void
  /** Keys the list doesn't use itself (the window's shortcuts). */
  onKey?: (e: KeyboardEvent<HTMLElement>) => void
  empty: ReactNode
  footer?: ReactNode
}

/** What a screen reader says for a row: state, who, subject, when, and what's attached. */
function rowLabel(m: MessageSummary, who: string): string {
  return [
    m.seen ? '' : 'Unread.',
    m.flagged ? 'Flagged.' : '',
    `${who}: ${m.subject || '(No subject)'}.`,
    fullDate(m.date) + '.',
    m.hasAttachments ? 'Has attachments.' : '',
    m.answered ? 'Replied.' : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * The message list: a listbox you can move through with the arrow keys. Unread messages have a
 * dot and a bold sender, like Mail.
 */
export function MessageList({
  label,
  messages,
  selected,
  onSelect,
  showRecipients,
  showMailbox,
  onEndReached,
  onKey,
  empty,
  footer,
}: Props) {
  const list = useRef<HTMLUListElement>(null)
  const index = messages.findIndex((m) => keyOf(m) === selected)

  // Keep the selected row in view as the arrow keys move it.
  useEffect(() => {
    if (index < 0) return
    list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return onKey?.(e)
    let next = -1
    if (e.key === 'ArrowDown' || e.key === 'j') next = Math.min(messages.length - 1, index + 1)
    else if (e.key === 'ArrowUp' || e.key === 'k') next = Math.max(0, index - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = messages.length - 1
    const target = messages[next]
    if (next < 0 || !target) return onKey?.(e)
    e.preventDefault()
    e.stopPropagation()
    onSelect(target)
  }

  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    if (nearEnd(e.currentTarget)) onEndReached?.()
  }

  // Scroll events alone aren't enough: a page that finishes loading while the list is already at
  // the bottom (or that was asked for while another was still loading) brings no new scroll event,
  // and paging would stall. So check again whenever the rows change.
  const scroller = useRef<HTMLDivElement>(null)
  const endReached = useRef(onEndReached)
  useEffect(() => {
    endReached.current = onEndReached
  }, [onEndReached])
  useEffect(() => {
    const el = scroller.current
    if (el && messages.length && nearEnd(el)) endReached.current?.()
  }, [messages])

  if (!messages.length) return <div className="flex flex-1 items-center justify-center p-6">{empty}</div>
  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto" onScroll={onScroll}>
      <ul
        ref={list}
        role="listbox"
        aria-label={label}
        tabIndex={0}
        aria-activedescendant={index >= 0 ? `message-${index}` : undefined}
        onKeyDown={onKeyDown}
        // Tabbing in with nothing selected selects the first message, so focus is visible.
        onFocus={(e) => {
          if (e.target === e.currentTarget && index < 0 && messages[0]) onSelect(messages[0])
        }}
        className="group/list rounded-md py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset"
      >
        {messages.map((m, i) => {
          const on = i === index
          const who = showRecipients ? people(m.to) || 'No recipients' : displayName(m.from)
          const sub = on ? 'text-ink-2 group-focus/list:text-white' : 'text-ink-2'
          return (
            <li
              key={keyOf(m)}
              id={`message-${i}`}
              data-index={i}
              role="option"
              aria-selected={on}
              aria-label={rowLabel(m, who)}
              onMouseDown={(e) => {
                // Clicking a row focuses the list, so the arrow keys work straight away.
                e.preventDefault()
                list.current?.focus()
                onSelect(m)
              }}
              className={`relative mx-2 my-px flex cursor-default flex-col gap-0.5 rounded-md py-2 pr-2.5 pl-6 ${
                on ? 'bg-selected group-focus/list:bg-accent group-focus/list:text-white' : 'hover:bg-hover'
              }`}
            >
              {!m.seen && (
                <span
                  aria-hidden="true"
                  className={`absolute top-[13px] left-2 size-2 rounded-full ${
                    on ? 'bg-accent group-focus/list:bg-white' : 'bg-accent'
                  }`}
                />
              )}
              <div className="flex items-baseline gap-2">
                <span className={`min-w-0 flex-1 truncate text-[13px] ${m.seen ? '' : 'font-semibold'}`}>
                  {who}
                </span>
                <time dateTime={m.date.toISOString()} className={`shrink-0 text-[11px] ${sub}`}>
                  {listDate(m.date)}
                </time>
              </div>
              <div className="flex items-center gap-1.5">
                <span
                  className={`min-w-0 flex-1 truncate text-[12px] ${on ? 'text-ink group-focus/list:text-white' : 'text-ink'}`}
                >
                  {m.subject || '(No subject)'}
                </span>
                {m.answered && <Reply size={12} aria-hidden="true" className={`shrink-0 ${sub}`} />}
                {m.hasAttachments && <Paperclip size={12} aria-hidden="true" className={`shrink-0 ${sub}`} />}
                {m.flagged && (
                  <Flag
                    size={12}
                    aria-hidden="true"
                    className={`shrink-0 fill-current ${on ? 'text-[#ff9500] group-focus/list:text-white' : 'text-[#ff9500]'}`}
                  />
                )}
              </div>
              {showMailbox && <span className={`text-[11px] ${sub}`}>{showMailbox(m.mailbox)}</span>}
            </li>
          )
        })}
      </ul>
      {footer}
    </div>
  )
}
