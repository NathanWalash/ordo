import { useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react'
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
  width?: number
  onClose: () => void
  onSubmit?: () => void
  /** Escape and the overlay don't close the sheet while busy. */
  busy?: boolean
  footer: ReactNode
  children: ReactNode
}

/** A macOS-style sheet: slides over the content, Escape cancels, Return submits. */
export function Sheet({
  title,
  subtitle,
  icon,
  width = 480,
  onClose,
  onSubmit,
  busy,
  footer,
  children,
}: Props) {
  const titleId = useId()
  const panel = useRef<HTMLFormElement>(null)

  useEffect(() => {
    const first = panel.current?.querySelector<HTMLElement>('input:not([disabled]), select, textarea')
    first?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!busy) onSubmit?.()
  }

  return (
    <OverContent>
      <div className="absolute inset-0 z-20 flex justify-center overflow-auto bg-black/20 pt-12 pb-8 dark:bg-black/40">
        <form
          ref={panel}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onSubmit={submit}
          style={{ width }}
          className="flex h-fit max-w-[calc(100%-2rem)] flex-col gap-4 rounded-xl border border-black/10 bg-sheet p-6 pb-5 shadow-[0_20px_50px_rgb(0_0_0/0.25)] dark:border-white/10"
        >
          <div className="flex items-center gap-3.5">
            {icon && (
              <span className="flex size-11 shrink-0 items-center justify-center rounded-[10px] bg-accent text-white">
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
          {children}
          <div className="flex items-center gap-2 pt-1">{footer}</div>
        </form>
      </div>
    </OverContent>
  )
}
