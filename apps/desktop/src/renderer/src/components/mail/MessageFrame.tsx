import { useCallback, useEffect, useRef, useState } from 'react'

interface Props {
  /** A sanitised document from sanitiseEmail. */
  srcDoc: string
  /** The email sets its own colours: show it on white. Otherwise it follows the app's look. */
  styled: boolean
  /** A link in the message was clicked: the window decides what happens. */
  onLink: (href: string, text: string) => void
  /** A key pressed while the message has focus, so the window's shortcuts still work. */
  onKey?: (e: KeyboardEvent) => void
}

const MIN_HEIGHT = 120

/**
 * The message, in a frame with `sandbox="allow-same-origin"` and nothing else: no scripts, no
 * forms, no pop-ups, no top-level navigation. allow-same-origin lets the window (not the
 * message) measure the frame and catch link clicks; with scripts off the message can't use it.
 * The frame grows to fit its content, so only the reading pane scrolls.
 */
export function MessageFrame({ srcDoc, styled, onLink, onKey }: Props) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(MIN_HEIGHT)
  const handlers = useRef({ onLink, onKey })
  useEffect(() => {
    handlers.current = { onLink, onKey }
  }, [onLink, onKey])
  const observer = useRef<ResizeObserver | null>(null)

  const measure = useCallback(() => {
    const doc = frame.current?.contentDocument
    if (!doc?.documentElement) return
    const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0)
    // The frame is border-box: add its 1px top and bottom borders.
    setHeight(Math.max(MIN_HEIGHT, h + 2))
  }, [])

  const attach = useCallback(() => {
    const doc = frame.current?.contentDocument
    if (!doc) return
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null
      const link = target?.closest?.('a, area')
      // Every click on a link is ours: the frame never follows one itself.
      if (!link) return
      e.preventDefault()
      e.stopPropagation()
      const href = link.getAttribute('href')
      if (href && (e.type === 'click' || e.button === 1))
        handlers.current.onLink(href, (link.textContent ?? '').trim().slice(0, 300))
    }
    doc.addEventListener('click', onClick, true)
    doc.addEventListener('auxclick', onClick, true)
    doc.addEventListener('keydown', (e) => handlers.current.onKey?.(e))
    // Images can change the height as they arrive, and so can the window's width.
    doc.addEventListener('load', measure, true)
    doc.addEventListener('dragstart', (e) => e.preventDefault(), true)
    observer.current?.disconnect()
    observer.current = new ResizeObserver(measure)
    if (doc.body) observer.current.observe(doc.body)
    observer.current.observe(doc.documentElement)
    measure()
  }, [measure])

  useEffect(() => {
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('resize', measure)
      observer.current?.disconnect()
    }
  }, [measure])

  return (
    <iframe
      ref={frame}
      title="Message body"
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      onLoad={attach}
      style={{ height }}
      className={`block w-full rounded-lg border border-sep ${styled ? 'bg-white' : 'bg-transparent'}`}
    />
  )
}
