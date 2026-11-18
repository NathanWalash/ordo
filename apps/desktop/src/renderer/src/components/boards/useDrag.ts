import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

export interface DragInfo<T, Target> {
  item: T
  /** Pointer position. */
  x: number
  y: number
  /** Where the pointer grabbed the element, so the lifted copy stays under it. */
  offsetX: number
  offsetY: number
  width: number
  height: number
  target: Target | null
}

interface Options<T, Target> {
  /** Where a drop at this point would land; null for nowhere. */
  findTarget: (x: number, y: number, item: T) => Target | null
  onDrop: (item: T, target: Target) => void
  /** Containers to scroll when the pointer nears their edges. */
  scrollers?: () => (HTMLElement | null)[]
}

const THRESHOLD = 4
const EDGE = 48
const SPEED = 14

/**
 * Pointer-driven drag and drop. The element stays put until the pointer has moved a few pixels,
 * so a click is still a click; then `drag` describes a lifted copy and the drop target. Escape
 * cancels. Containers scroll when the pointer nears their edges.
 */
export function useDrag<T, Target>(options: Options<T, Target>) {
  const [drag, setDrag] = useState<DragInfo<T, Target> | null>(null)
  /** True for the click that follows a drag, which shouldn't also open the item. */
  const suppressClick = useRef(false)
  const latest = useRef(options)
  useLayoutEffect(() => {
    latest.current = options
  })

  const begin = useCallback((e: ReactPointerEvent<HTMLElement>, item: T) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey) return
    const rect = e.currentTarget.getBoundingClientRect()
    const startX = e.clientX
    const startY = e.clientY
    let px = startX
    let py = startY
    let info: DragInfo<T, Target> | null = null
    let frame = 0

    const update = () => {
      if (!info) return
      info = { ...info, x: px, y: py, target: latest.current.findTarget(px, py, item) }
      setDrag(info)
    }

    const autoscroll = () => {
      let moved = false
      for (const el of latest.current.scrollers?.() ?? []) {
        if (!el) continue
        const r = el.getBoundingClientRect()
        if (py < r.top || py > r.bottom || px < r.left || px > r.right) continue
        const dx = px < r.left + EDGE ? -SPEED : px > r.right - EDGE ? SPEED : 0
        const dy = py < r.top + EDGE ? -SPEED : py > r.bottom - EDGE ? SPEED : 0
        if (dx && el.scrollWidth > el.clientWidth) {
          const before = el.scrollLeft
          el.scrollLeft += dx
          moved ||= el.scrollLeft !== before
        }
        if (dy && el.scrollHeight > el.clientHeight) {
          const before = el.scrollTop
          el.scrollTop += dy
          moved ||= el.scrollTop !== before
        }
      }
      if (moved) update()
      frame = requestAnimationFrame(autoscroll)
    }

    const move = (ev: PointerEvent) => {
      px = ev.clientX
      py = ev.clientY
      if (!info) {
        if (Math.hypot(px - startX, py - startY) < THRESHOLD) return
        info = {
          item,
          x: px,
          y: py,
          offsetX: startX - rect.left,
          offsetY: startY - rect.top,
          width: rect.width,
          height: rect.height,
          target: null,
        }
        document.documentElement.classList.add('dragging')
        frame = requestAnimationFrame(autoscroll)
      }
      ev.preventDefault()
      update()
    }

    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key, true)
      cancelAnimationFrame(frame)
      document.documentElement.classList.remove('dragging')
      if (info) {
        suppressClick.current = true
        setTimeout(() => (suppressClick.current = false), 0)
        const target = info.target
        if (commit && target !== null) latest.current.onDrop(item, target)
      }
      info = null
      setDrag(null)
    }
    const up = () => finish(true)
    const cancel = () => finish(false)
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      finish(false)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key, true)
  }, [])

  return { drag, begin, suppressClick }
}
