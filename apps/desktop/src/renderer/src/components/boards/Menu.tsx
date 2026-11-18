import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'

export type MenuItem =
  | {
      label: string
      onSelect: () => void
      icon?: ReactNode
      /** Shown on the right, e.g. a keyboard shortcut. */
      hint?: string
      disabled?: boolean
      danger?: boolean
      checked?: boolean
      /** Choosing it leaves the menu open, for ticking several things. */
      keepOpen?: boolean
      /** A colour dot before the label, for labels and options. */
      swatch?: string
    }
  | { separator: true }
  | { heading: string }

/** Where to open: under a button, or at the pointer for a context menu. */
export type MenuAnchor = DOMRect | { x: number; y: number }

const GAP = 4
const WIDTH = 220

/**
 * A macOS-style pop-up menu: arrow keys move, Return chooses, Escape or a click outside closes,
 * and focus goes back to whatever opened it.
 */
export function Menu({
  label,
  anchor,
  items,
  onClose,
  width = WIDTH,
}: {
  label: string
  anchor: MenuAnchor
  items: MenuItem[]
  onClose: () => void
  width?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const opener = useRef<Element | null>(document.activeElement)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const h = el.offsetHeight
    const rect = anchor instanceof DOMRect ? anchor : null
    const x = rect ? rect.left : anchor.x
    const y = rect ? rect.bottom + GAP : anchor.y
    const left = Math.max(GAP, Math.min(x, window.innerWidth - width - GAP))
    // Open upwards when there's no room below.
    const top = y + h > window.innerHeight - GAP ? Math.max(GAP, (rect ? rect.top - GAP : y) - h) : y
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    el.style.visibility = 'visible'
    el.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')?.focus()
  }, [anchor, width])

  // The latest onClose, so the listeners below are added once and focus goes back only on close.
  const close = useRef(onClose)
  useLayoutEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    const back = opener.current
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close.current()
    const onBlur = () => close.current()
    window.addEventListener('mousedown', onDown)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('blur', onBlur)
      if (back instanceof HTMLElement && back.isConnected) back.focus()
    }
  }, [])

  const onKeyDown = (e: KeyboardEvent) => {
    const list = [
      ...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? []),
    ]
    const i = list.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      list[(i + step + list.length) % list.length]?.focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      ;(e.key === 'Home' ? list[0] : list.at(-1))?.focus()
    }
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className="glass-panel fixed z-50 flex flex-col rounded-lg p-1 text-[13px] outline-none"
      style={{ width, visibility: 'hidden', left: 0, top: 0 }}
    >
      {items.map((item, i) => {
        if ('separator' in item) return <div key={i} role="separator" className="mx-2 my-1 h-px bg-sep" />
        if ('heading' in item)
          return (
            <div key={i} className="px-2 pt-1.5 pb-0.5 text-[11px] font-semibold text-ink-3">
              {item.heading}
            </div>
          )
        return (
          <button
            key={i}
            type="button"
            role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={item.checked}
            aria-disabled={item.disabled || undefined}
            tabIndex={-1}
            onClick={() => {
              if (item.disabled) return
              if (!item.keepOpen) onClose()
              item.onSelect()
            }}
            className={`flex h-[26px] items-center gap-2 rounded-[5px] px-2 text-left outline-none ${
              item.disabled
                ? 'text-ink-3'
                : `focus:bg-accent focus:text-white hover:bg-accent hover:text-white ${item.danger ? 'text-danger' : ''}`
            } group`}
          >
            <span className="flex w-3.5 shrink-0 justify-center">
              {item.checked ? <Check size={13} /> : item.icon}
            </span>
            {item.swatch && (
              <span
                className="size-2 shrink-0 rounded-full ring-1 ring-black/10"
                style={{ background: item.swatch }}
                aria-hidden="true"
              />
            )}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.hint && (
              <span className="shrink-0 text-[12px] text-ink-3 group-hover:text-white/80 group-focus:text-white/80">
                {item.hint}
              </span>
            )}
          </button>
        )
      })}
    </div>,
    document.body,
  )
}
