import { createContext, useContext, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import type { AppInfo } from '@ordo/shared'

/** Where pages put their own toolbar buttons; App provides it once the toolbar is on screen. */
export const ToolbarSlot = createContext<HTMLElement | null>(null)

interface Props {
  title: string
  platform?: AppInfo['platform']
  /** Receives the element pages' <ToolbarActions> render into. */
  slotRef?: Ref<HTMLDivElement>
}

export function Toolbar({ title, platform, slotRef }: Props) {
  // On Windows the min/max/close overlay sits top-right; keep content clear of it.
  const right = platform === 'win32' ? 'pr-[140px]' : 'pr-4'
  return (
    <header
      className={`glass-bar drag absolute inset-x-0 top-0 z-10 flex h-[52px] items-center gap-3 border-b border-sep pl-5 ${right}`}
    >
      <h1 className="max-w-[35%] min-w-0 shrink truncate text-[15px] font-semibold">{title}</h1>
      <div ref={slotRef} className="flex min-w-0 flex-1 items-center justify-end gap-1" />
    </header>
  )
}

/** Render buttons into the window's toolbar, to the right of the title. */
export function ToolbarActions({ children }: { children: ReactNode }) {
  const slot = useContext(ToolbarSlot)
  return slot ? createPortal(children, slot) : null
}
