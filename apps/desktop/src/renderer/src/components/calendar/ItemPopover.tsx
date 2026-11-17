import { useEffect, useLayoutEffect, useRef } from 'react'
import { MapPin, Repeat, X } from 'lucide-react'
import { OverlayIcon } from './ItemChips'
import { describeWhen, type CalendarItem } from './model'
import { formatAmount, OVERLAY_LABELS } from './overlays'

const WIDTH = 300
const GAP = 8

/** Read-only details for an event or overlay item, beside the element that was clicked. */
export function ItemPopover({
  item,
  anchor,
  onClose,
}: {
  item: CalendarItem
  anchor: DOMRect
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  // Place it to the right of the anchor if there's room, else to the left; keep it on screen.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const h = el.offsetHeight
    const right = anchor.right + GAP
    const left = right + WIDTH <= window.innerWidth - GAP ? right : Math.max(GAP, anchor.left - GAP - WIDTH)
    const top = Math.min(Math.max(GAP, anchor.top), window.innerHeight - h - GAP)
    el.style.left = `${left}px`
    el.style.top = `${Math.max(GAP, top)}px`
    el.style.visibility = 'visible'
  }, [anchor])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose()
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onDown)
    ref.current?.focus()
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  const when = describeWhen(item)
  const color = item.type === 'event' ? item.color : 'var(--ink-3)'
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={item.title}
      tabIndex={-1}
      className="fixed z-40 flex max-h-[calc(100vh-16px)] flex-col overflow-hidden rounded-xl border border-black/10 bg-sheet shadow-[0_12px_40px_rgb(0_0_0/0.22)] outline-none dark:border-white/10"
      style={{ width: WIDTH, visibility: 'hidden', left: 0, top: 0 }}
    >
      <div className="flex gap-3 p-4 pb-3">
        <span
          className="mt-1 w-1 shrink-0 self-stretch rounded-full"
          style={{ background: color }}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold leading-snug select-text">{item.title}</h2>
          {item.type === 'event' && item.event.location && (
            <p className="mt-1 flex items-start gap-1.5 text-[12px] text-ink-2 select-text">
              <MapPin size={13} className="mt-px shrink-0" />
              {item.event.location}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="-mr-1 -mt-1 flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"
        >
          <X size={14} />
        </button>
      </div>

      <div className="space-y-1 border-t border-sep px-4 py-3 text-[12px]">
        <p>{when.date}</p>
        <p className="text-ink-2">{when.time}</p>
        {item.type === 'event' && item.event.recurrenceId && (
          <p className="flex items-center gap-1.5 text-ink-2">
            <Repeat size={12} /> Repeats
          </p>
        )}
      </div>

      {item.type === 'event' ? (
        <>
          {item.calendar && (
            <div className="flex items-center gap-2 border-t border-sep px-4 py-2.5 text-[12px] text-ink-2">
              <span className="size-2.5 rounded-full" style={{ background: color }} aria-hidden="true" />
              {item.calendar.name}
              {item.calendar.readOnly && <span className="text-ink-3">· Read only</span>}
            </div>
          )}
          {item.event.notes && (
            <p className="min-h-0 overflow-y-auto whitespace-pre-wrap border-t border-sep px-4 py-3 text-[12px] leading-relaxed text-ink-2 select-text">
              {item.event.notes}
            </p>
          )}
        </>
      ) : (
        <div className="flex items-center gap-2 border-t border-sep px-4 py-2.5 text-[12px] text-ink-2">
          <OverlayIcon kind={item.overlay.kind} size={13} />
          {OVERLAY_LABELS[item.overlay.kind]}
          {item.overlay.amount && (
            <span className="ml-auto tabular-nums text-ink">{formatAmount(item.overlay.amount)}</span>
          )}
        </div>
      )}
    </div>
  )
}
