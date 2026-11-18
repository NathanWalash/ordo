import { useCallback, useEffect, useRef, useState } from 'react'
import { Undo2, X } from 'lucide-react'
import type { UndoToken } from '@ordo/boards-core'
import { OverContent } from '../Sheet'

const SHOW_MS = 8000
/** How many deletes in a row can still be undone, newest first. */
const MAX_UNDO = 10

interface Undo {
  token: UndoToken
  /** "Deleted “Clear the gutters”". */
  message: string
}

interface Toast {
  message: string
  error?: boolean
  action?: { label: string; onClick: () => void }
}

/**
 * A toast at the bottom of the window: "Deleted “x”. Undo" after a delete, errors, or a message
 * with one action. Deletes stack, so Undo (or ⌘Z) puts them back newest first. The toast stays
 * while the pointer or focus is on it, and every message is announced.
 */
export function useToast(options: { onUndone?: () => Promise<void>; announce?: (m: string) => void } = {}) {
  const [toast, setToast] = useState<Toast | null>(null)
  const [undos, setUndos] = useState<Undo[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const paused = useRef(false)
  const busy = useRef(false)
  const latest = useRef(options)
  useEffect(() => {
    latest.current = options
  })

  const hide = useCallback(() => {
    setToast(null)
    setUndos([])
  }, [])

  const restart = useCallback(
    (ms = SHOW_MS) => {
      clearTimeout(timer.current)
      if (!paused.current) timer.current = setTimeout(hide, ms)
    },
    [hide],
  )

  const show = useCallback(
    (message: string, extra: Omit<Toast, 'message'> = {}) => {
      setToast({ message, ...extra })
      latest.current.announce?.(message)
      restart()
    },
    [restart],
  )

  const offerUndo = useCallback(
    (token: UndoToken, message: string) => {
      setUndos((u) => [{ token, message }, ...u].slice(0, MAX_UNDO))
      show(message)
    },
    [show],
  )

  /** An error keeps anything that can still be undone. */
  const showError = useCallback((message: string) => show(message, { error: true }), [show])

  const undo = useCallback(async () => {
    const next = undos[0]
    if (!next || busy.current) return
    busy.current = true
    try {
      const r = await window.ordo.boards.restore(next.token)
      setUndos((u) => u.filter((x) => x !== next))
      if (r.ok) show(next.message.replace(/^Deleted /, 'Restored '))
      else show(r.message, { error: true })
      await latest.current.onUndone?.()
    } finally {
      busy.current = false
    }
  }, [show, undos])

  useEffect(() => {
    if (!undos.length) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.matches?.('input, textarea, select')) return
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        void undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undos, undo])

  useEffect(() => () => clearTimeout(timer.current), [])

  const pause = () => {
    paused.current = true
    clearTimeout(timer.current)
  }
  const resume = () => {
    paused.current = false
    restart(3000)
  }

  const node = toast && (
    <OverContent>
      <div className="pointer-events-none absolute inset-x-0 bottom-5 z-[60] flex justify-center">
        <div
          role={toast.error ? 'alert' : 'status'}
          onMouseEnter={pause}
          onMouseLeave={resume}
          onFocus={pause}
          onBlur={resume}
          className="glass-panel pointer-events-auto flex h-10 items-center gap-3 rounded-xl pr-1.5 pl-4 text-[13px]"
        >
          <span className={`max-w-[360px] truncate ${toast.error ? 'text-danger' : ''}`}>
            {toast.message}
          </span>
          {undos.length > 0 && (
            <button
              type="button"
              onClick={() => void undo()}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 font-medium text-accent hover:bg-hover"
            >
              <Undo2 size={13} /> Undo
              {undos.length > 1 && <span className="tabular-nums">({undos.length})</span>}
              <span className="text-[11px] font-normal text-ink-2">⌘Z</span>
            </button>
          )}
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                toast.action!.onClick()
                hide()
              }}
              className="h-7 rounded-md px-2 font-medium text-accent hover:bg-hover"
            >
              {toast.action.label}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={hide}
            className="flex size-7 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"
          >
            <X size={13} />
          </button>
        </div>
      </div>
    </OverContent>
  )

  return { show, offerUndo, showError, node }
}
