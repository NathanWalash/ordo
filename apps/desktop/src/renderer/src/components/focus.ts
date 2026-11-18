import { useEffect, type RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** The elements Tab can reach inside `root`, in order. */
export function tabbable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.closest('[inert]') && el.getClientRects().length > 0,
  )
}

/**
 * Keep Tab and Shift-Tab inside a dialog, wrapping at the ends, while it's open. Menus and
 * popovers opened from it live outside it and handle their own keys.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const root = ref.current
      if (e.key !== 'Tab' || !root) return
      const items = tabbable(root)
      if (!items.length) return
      const first = items[0]!
      const last = items.at(-1)!
      const inside = root.contains(document.activeElement)
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ref, active])
}
