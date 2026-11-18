import { Sparkles } from 'lucide-react'
import type { AppInfo } from '@ordo/shared'
import { PANEL_ID } from './assistant/AssistantPanel'

interface Props {
  title: string
  platform?: AppInfo['platform']
  assistant?: {
    open: boolean
    /** A confirmation card is waiting for an answer. */
    waiting: boolean
    shortcut: string
    onToggle: () => void
  }
}

export function Toolbar({ title, platform, assistant }: Props) {
  // On Windows the min/max/close overlay sits top-right; keep content clear of it.
  const right = platform === 'win32' ? 'pr-[140px]' : 'pr-3'
  const waiting = assistant && assistant.waiting && !assistant.open
  return (
    <header
      className={`glass-bar drag absolute inset-x-0 top-0 z-10 flex h-[52px] items-center border-b border-sep pl-5 ${right}`}
    >
      <h1 className="flex-1 truncate text-[15px] font-semibold">{title}</h1>
      {assistant && (
        <button
          type="button"
          onClick={assistant.onToggle}
          aria-expanded={assistant.open}
          aria-controls={assistant.open ? PANEL_ID : undefined}
          aria-keyshortcuts={assistant.shortcut === '⌘K' ? 'Meta+K' : 'Control+K'}
          title={`Assistant (${assistant.shortcut})`}
          className={`no-drag relative flex h-7 items-center gap-1.5 rounded-md pr-1.5 pl-2 text-[13px] font-medium ${
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
