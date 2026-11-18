import { createContext, useContext, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { Sparkles } from 'lucide-react'
import type { AppInfo } from '@ordo/shared'
import { PANEL_ID } from './assistant/AssistantPanel'

/** Where pages put their own toolbar buttons; App provides it once the toolbar is on screen. */
export const ToolbarSlot = createContext<HTMLElement | null>(null)

interface Props {
  title: string
  platform?: AppInfo['platform']
  /** Receives the element pages' <ToolbarActions> render into. */
  slotRef?: Ref<HTMLDivElement>
  assistant?: {
    open: boolean
    /** A confirmation card is waiting for an answer. */
    waiting: boolean
    shortcut: string
    onToggle: () => void
  }
}

export function Toolbar({ title, platform, slotRef, assistant }: Props) {
  // On Windows the min/max/close overlay sits top-right; keep content clear of it.
  const right = platform === 'win32' ? 'pr-[140px]' : 'pr-3'
  const waiting = assistant && assistant.waiting && !assistant.open
  return (
    <header
      className={`glass-bar drag absolute inset-x-0 top-0 z-10 flex h-[52px] items-center gap-3 border-b border-sep pl-5 ${right}`}
    >
      <h1 className="max-w-[35%] min-w-0 shrink truncate text-[15px] font-semibold">{title}</h1>
      {/* Pages put their own buttons here with <ToolbarActions>. */}
      <div ref={slotRef} className="flex min-w-0 flex-1 items-center justify-end gap-1" />
      {assistant && (
        <button
          type="button"
          onClick={assistant.onToggle}
          aria-expanded={assistant.open}
          aria-controls={assistant.open ? PANEL_ID : undefined}
          aria-keyshortcuts={assistant.shortcut === '⌘K' ? 'Meta+K' : 'Control+K'}
          title={`Assistant (${assistant.shortcut})`}
          className={`no-drag relative flex h-7 shrink-0 items-center gap-1.5 rounded-md pr-1.5 pl-2 text-[13px] font-medium ${
            assistant.open ? 'bg-selected text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink'
          }`}
        >
          <Sparkles size={14} className={assistant.open ? 'text-accent' : ''} aria-hidden />
          Assistant
          {waiting && (
            <>
              <span
                aria-hidden
                className="absolute top-1 left-[22px] size-2 rounded-full bg-warn ring-2 ring-content"
              />
              <span className="sr-only">, waiting for you</span>
            </>
          )}
          <kbd
            aria-hidden
            className="ml-0.5 rounded-[4px] px-1 font-sans text-[11px] text-ink-2 shadow-[0_0_0_1px_var(--sep)]"
          >
            {assistant.shortcut}
          </kbd>
        </button>
      )}
    </header>
  )
}

/** Render buttons into the window's toolbar, to the right of the title. */
export function ToolbarActions({ children }: { children: ReactNode }) {
  const slot = useContext(ToolbarSlot)
  return slot ? createPortal(children, slot) : null
}
