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
