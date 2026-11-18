import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Search } from 'lucide-react'
import type { ISODate, LinkCandidate, LinkKind } from '@ordo/boards-core'
import { SegmentedControl } from '../SegmentedControl'
import { LinkIcon } from './LinkRow'
import { dayLabel } from './model'

const KINDS: { value: LinkKind; label: string }[] = [
  { value: 'event', label: 'Events' },
  { value: 'email', label: 'Emails' },
  { value: 'bill', label: 'Bills' },
  { value: 'transaction', label: 'Payments' },
  { value: 'card', label: 'Cards' },
]

const EMPTY: Record<LinkKind, string> = {
  event: 'No events coming up. Connect iCloud or add a calendar in Calendar.',
  email: 'No emails. Connect iCloud and scan your inbox in Unclutter.',
  bill: 'No bills yet. Add them in Money, under Bills & Subscriptions.',
  transaction: 'No payments yet. Import a bank statement in Money.',
  card: 'No other cards yet.',
}

const WIDTH = 440

/** Find something in Calendar, Mail, Money or Boards to link a card to. */
export function LinkPicker({
  cardId,
  anchor,
  today,
  onPick,
  onClose,
}: {
  cardId: string
  anchor: DOMRect
  today: ISODate
  onPick: (c: LinkCandidate) => void
  onClose: () => void
}) {
  const [kind, setKind] = useState<LinkKind>('event')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<LinkCandidate[] | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - WIDTH - 8))
    const below = anchor.bottom + 6
    const top = below + 380 > window.innerHeight ? Math.max(8, anchor.top - 6 - 380) : below
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    input.current?.focus()
  }, [anchor])

  useEffect(() => {
    let live = true
    const t = setTimeout(
      () =>
        void window.ordo.boards.linkCandidates({ cardId, kind, query }).then((r) => {
          if (live) setResults(r)
        }),
      query ? 150 : 0,
    )
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [cardId, kind, query])

  const close = useRef(onClose)
  useLayoutEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close.current()
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      close.current()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [])

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Link to"
      className="glass-panel fixed z-50 flex h-[380px] flex-col overflow-hidden rounded-xl"
      style={{ width: WIDTH, left: 0, top: 0 }}
    >
      <div className="flex flex-col gap-2 border-b border-sep p-3">
        <SegmentedControl
          label="Kind"
          options={KINDS}
          value={kind}
          onChange={(k) => {
            setKind(k)
            setResults(null)
          }}
        />
        <label className="relative flex items-center">
          <Search size={13} className="pointer-events-none absolute left-2 text-ink-3" aria-hidden="true" />
          <input
            ref={input}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Search ${KINDS.find((k) => k.value === kind)!.label.toLowerCase()}`}
            aria-label="Search"
            className="h-7 w-full rounded-md border border-sep bg-field pr-2 pl-7 text-[13px] outline-none select-text placeholder:text-ink-3 focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </label>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto p-1.5" aria-label="Results" aria-busy={results === null}>
        {results?.length === 0 && (
          <li className="px-3 py-6 text-center text-[12px] leading-relaxed text-ink-3">
            {query ? 'Nothing matches.' : EMPTY[kind]}
          </li>
        )}
        {results?.map((c) => (
          <li key={c.key}>
            <button
              type="button"
              onClick={() => onPick(c)}
              className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-hover focus-visible:bg-hover"
            >
              <LinkIcon kind={c.target.kind} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{c.title}</span>
                {c.detail && <span className="block truncate text-[11px] text-ink-2">{c.detail}</span>}
              </span>
              {c.date && (
                <span className="shrink-0 text-[11px] text-ink-3 tabular-nums">
                  {dayLabel(c.date, today)}
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>,
    document.body,
  )
}
