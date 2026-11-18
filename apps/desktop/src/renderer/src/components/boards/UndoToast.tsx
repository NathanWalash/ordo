import { useCallback, useEffect, useRef, useState } from 'react'
import { Undo2, X } from 'lucide-react'
import type { UndoToken } from '@ordo/boards-core'
import { OverContent } from '../Sheet'

const SHOW_MS = 8000

/**
 * "Deleted “x”. Undo" at the bottom of the window after a delete. ⌘Z undoes while it's showing.
 * Errors show here too, without the button.
 */
export function useToast(onUndone: () => Promise<void>) {
  const [toast, setToast] = useState<{ message: string; token?: UndoToken; error?: boolean } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const show = useCallback((message: string, token?: UndoToken, error = false) => {
    clearTimeout(timer.current)
    setToast({ message, token, error })
    timer.current = setTimeout(() => setToast(null), SHOW_MS)
  }, [])

  const undo = useCallback(async () => {
    if (!toast?.token) return
    clearTimeout(timer.current)
    const r = await window.ordo.boards.restore(toast.token)
    setToast(r.ok ? { message: 'Put back.' } : { message: r.message, error: true })
    timer.current = setTimeout(() => setToast(null), 2500)
    await onUndone()
  }, [onUndone, toast])

  useEffect(() => {
    if (!toast?.token) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.matches?.('input, textarea')) return
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        void undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toast, undo])

  useEffect(() => () => clearTimeout(timer.current), [])

  const node = toast && (
    <OverContent>
      <div className="pointer-events-none absolute inset-x-0 bottom-5 z-[60] flex justify-center">
        <div
          role={toast.error ? 'alert' : 'status'}
          className="glass-panel pointer-events-auto flex h-10 items-center gap-3 rounded-xl pr-1.5 pl-4 text-[13px]"
        >
          <span className={`max-w-[360px] truncate ${toast.error ? 'text-danger' : ''}`}>
            {toast.message}
          </span>
          {toast.token && (
            <button
              type="button"
              onClick={() => void undo()}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 font-medium text-accent hover:bg-hover"
            >
              <Undo2 size={13} /> Undo <span className="text-[11px] font-normal text-ink-3">⌘Z</span>
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setToast(null)}
            className="flex size-7 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"
          >
            <X size={13} />
          </button>
        </div>
      </div>
    </OverContent>
  )

  return { show, node }
}
