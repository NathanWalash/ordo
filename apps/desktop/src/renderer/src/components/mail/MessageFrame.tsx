import { useCallback, useEffect, useRef, useState } from 'react'

interface Props {
  /** A sanitised document from sanitiseEmail. */
  srcDoc: string
  /** A link in the message was clicked: the window decides what happens. */
  onLink: (href: string, text: string) => void
}

const MIN_HEIGHT = 120

/**
 * The message, in a frame with `sandbox="allow-same-origin"` and nothing else: no scripts, no
 * forms, no pop-ups, no top-level navigation. allow-same-origin lets the window (not the
 * message) measure the frame and catch link clicks; with scripts off the message can't use it.
 */
export function MessageFrame({ srcDoc, onLink }: Props) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(MIN_HEIGHT)
  const linkRef = useRef(onLink)
  useEffect(() => {
    linkRef.current = onLink
  }, [onLink])

  const measure = useCallback(() => {
    const doc = frame.current?.contentDocument
    if (!doc?.documentElement) return
    setHeight(Math.max(MIN_HEIGHT, doc.documentElement.scrollHeight))
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
      if (href && (e.type === 'click' || (e as MouseEvent).button === 1))
        linkRef.current(href, (link.textContent ?? '').trim().slice(0, 300))
    }
    doc.addEventListener('click', onClick, true)
    doc.addEventListener('auxclick', onClick, true)
    // Images can change the height as they arrive.
    doc.addEventListener('load', measure, true)
    doc.addEventListener('dragstart', (e) => e.preventDefault(), true)
    measure()
  }, [measure])

  useEffect(() => {
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure])

  return (
    <iframe
      ref={frame}
      title="Message"
      sandbox="allow-same-origin"
      referrerPolicy="no-referrer"
      srcDoc={srcDoc}
      onLoad={attach}
      style={{ height }}
      className="block w-full rounded-lg border border-sep bg-white"
    />
  )
}
