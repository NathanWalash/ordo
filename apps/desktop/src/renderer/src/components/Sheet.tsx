import { useEffect, useId, useRef, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

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
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The first thing to focus in a sheet: a field, then what the sheet marks, then its main button. */
function initialFocus(panel: HTMLElement): HTMLElement {
  return (
    panel.querySelector<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
    ) ??
    panel.querySelector<HTMLElement>('[data-autofocus]') ??
    panel.querySelector<HTMLElement>('button[type="submit"]:not([disabled])') ??
    panel.querySelector<HTMLElement>('button:not([disabled])') ??
    panel
  )
}

/**
 * A macOS-style sheet: slides over the content, Escape cancels, Return submits. Focus moves into
 * it, Tab stays inside it, and when it closes focus goes back where it was (or to the message
 * list).
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
}: Props) {
  const titleId = useId()
  const panel = useRef<HTMLFormElement>(null)

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const el = panel.current
    if (el) initialFocus(el).focus()
    return () => {
      // Back to where you were, if it's still there; otherwise to the message list.
      const back =
        before && before !== document.body && before.isConnected
          ? before
          : document.querySelector<HTMLElement>('[role="listbox"]')
      back?.focus()
    }
  }, [])

  const closeRef = useRef({ busy, onClose })
  useEffect(() => {
    closeRef.current = { busy, onClose }
  }, [busy, onClose])

  // Escape from anywhere in the window (focus may be outside the panel, e.g. in the message
  // frame behind it, whose key presses the panel never sees).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const { busy: b, onClose: close } = closeRef.current
      if (!b) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onPanelKey = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (!busy) onClose()
      return
    }
    if (e.key !== 'Tab' || !panel.current) return
    // Keep Tab inside the sheet: it's modal.
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (x) => x.offsetParent !== null,
    )
    if (!items.length) return
    const first = items[0]!
    const last = items[items.length - 1]!
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!busy) onSubmit?.()
  }

  return (
    <OverContent>
      <div
        className={`absolute inset-0 z-20 flex justify-center bg-black/20 pt-12 pb-8 dark:bg-black/40 ${
          fit ? 'items-start overflow-hidden pt-6 pb-6' : 'overflow-auto'
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
