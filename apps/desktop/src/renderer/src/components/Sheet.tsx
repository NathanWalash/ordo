import { useEffect, useId, useRef, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useFocusTrap } from './focus'

/**
 * Render over the content area (the app's <main>), whatever is scrolled, leaving the
 * sidebar usable, like ConnectSheet.
 */
export function OverContent({ children }: { children: ReactNode }) {
  return createPortal(children, document.querySelector('main') ?? document.body)
}

interface Props {
  title: string
  subtitle?: ReactNode
  icon?: ReactNode
  /** The icon tile's colour, e.g. for a warning. Defaults to the accent colour. */
  iconTone?: 'accent' | 'warning'
  width?: number
  /**
   * Fit the window's height: the body scrolls and the footer stays in view (for tall sheets
   * like Compose in a small window).
   */
  fit?: boolean
  onClose: () => void
  onSubmit?: () => void
  /** Escape and the overlay don't close the sheet while busy. */
  busy?: boolean
  /** Extra description for screen readers, by element id. */
  describedBy?: string
  footer: ReactNode
  children: ReactNode
  /** A selector for what to focus first; the first field by default. */
  initialFocus?: string
}

/** Where focus goes when a sheet opens, in order of preference. */
const FIRST_FOCUS = [
  '[data-autofocus]',
  'input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
  'button[type="submit"]:not([disabled])',
  'button:not([disabled])',
]

/**
 * A macOS-style sheet: slides over the content, Escape cancels, Return submits. Focus moves into
 * it when it opens (an autofocused control, the first field, the default button, any button),
 * Tab stays inside it, and focus goes back to where it was when it closes (or, if that has gone,
 * to the message list on Mail).
 */
export function Sheet({
  title,
  subtitle,
  icon,
  iconTone = 'accent',
  width = 480,
  fit,
  onClose,
  onSubmit,
  busy,
  describedBy,
  footer,
  children,
  initialFocus,
}: Props) {
  const titleId = useId()
  const panel = useRef<HTMLFormElement>(null)
  useFocusTrap(panel)

  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const el = panel.current
    if (el && !el.contains(document.activeElement)) {
      // An initialFocus selector first, then an autofocused control, the first field, the default
      // button, any button, and the sheet itself.
      const order = initialFocus ? [initialFocus, ...FIRST_FOCUS] : FIRST_FOCUS
      const first = order.map((s) => el.querySelector<HTMLElement>(s)).find(Boolean)
      ;(first ?? el).focus()
    }
    return () => {
      // Back to where focus was, if it's still there and nothing else has taken it; otherwise to
      // a list on the page, so the keyboard carries on where you were.
      if (document.activeElement && document.activeElement !== document.body) return
      if (before?.isConnected) before.focus()
      else document.querySelector<HTMLElement>('[role="listbox"]')?.focus()
    }
    // Only when the sheet opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Escape from anywhere in the window (focus may be outside the panel, e.g. in the message
  // frame behind it). Escape inside the panel is handled there and goes no further.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) =>
      e.key === 'Escape' && !e.defaultPrevented && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const onPanelKey = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    if (!busy) onClose()
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!busy) onSubmit?.()
  }

  return (
    <OverContent>
      <div
        className={`absolute inset-0 z-50 flex justify-center bg-black/20 dark:bg-black/40 ${
          fit ? 'items-start overflow-hidden pt-6 pb-6' : 'overflow-auto pt-12 pb-8'
        }`}
      >
        <form
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={describedBy}
          tabIndex={-1}
          onSubmit={submit}
          onKeyDown={onPanelKey}
          style={{ width }}
          className={`flex max-w-[calc(100%-2rem)] flex-col gap-4 rounded-xl border border-black/10 bg-sheet p-6 pb-5 shadow-[0_20px_50px_rgb(0_0_0/0.25)] outline-none dark:border-white/10 ${
            fit ? 'max-h-full min-h-0' : 'h-fit'
          }`}
        >
          <div className="flex shrink-0 items-center gap-3.5">
            {icon && (
              <span
                className={`flex size-11 shrink-0 items-center justify-center rounded-[10px] text-white ${
                  iconTone === 'warning' ? 'bg-[#ff9500]' : 'bg-accent'
                }`}
              >
                {icon}
              </span>
            )}
            <div className="min-w-0">
              <h2 id={titleId} className="truncate text-[15px] font-semibold">
                {title}
              </h2>
              {subtitle && <div className="text-[12px] leading-snug text-ink-2">{subtitle}</div>}
            </div>
          </div>
          {fit ? (
            <div className="-mx-6 flex min-h-0 flex-1 flex-col overflow-y-auto px-6">{children}</div>
          ) : (
            children
          )}
          <div className="flex shrink-0 items-center gap-2 pt-1">{footer}</div>
        </form>
      </div>
    </OverContent>
  )
}
