import { useEffect, useState } from 'react'
import type { Appearance } from '@ordo/shared'

/** The window's current appearance from the main process, kept up to date. Null until it loads. */
export function useAppearance(): Appearance | null {
  const [appearance, setAppearance] = useState<Appearance | null>(null)
  useEffect(() => {
    let live = true
    void window.ordo.settings.appearance().then((a) => live && setAppearance(a))
    const off = window.ordo.settings.onAppearance(setAppearance)
    return () => {
      live = false
      off()
    }
  }, [])
  return appearance
}

/** Mirror the appearance onto classes on <html> that the CSS keys off. Call once, in App. */
export function useAppearanceClasses(): void {
  const appearance = useAppearance()
  useEffect(() => {
    if (!appearance) return
    const root = document.documentElement.classList
    root.toggle('reduce-transparency', appearance.reducedTransparency)
    root.toggle('opaque-sidebar', appearance.opaqueSidebar)
  }, [appearance])
}
