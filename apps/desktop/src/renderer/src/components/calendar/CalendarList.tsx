import type { ReactNode } from 'react'
import type { CalendarListItem } from '@ordo/shared'
import type { CalendarOverlaySource } from './overlays'

interface Props {
  title: string
  calendars: CalendarListItem[]
  onToggle: (calendarId: string, visible: boolean) => void
  overlaySources: readonly CalendarOverlaySource[]
  footer?: ReactNode
}

/** The list of calendars with colour checkboxes, like the macOS Calendar sidebar. */
export function CalendarList({ title, calendars, onToggle, overlaySources, footer }: Props) {
  return (
    <aside className="flex w-[196px] shrink-0 flex-col border-r border-sep" aria-label="Calendars">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <h2 className="px-1 pb-1 text-[11px] font-semibold text-ink-3">{title}</h2>
        {calendars.length === 0 && <p className="px-1 py-1 text-[12px] text-ink-3">No calendars yet</p>}
        <ul>
          {calendars.map((c) => (
            <li key={c.id}>
              <label className="flex h-7 items-center gap-2 rounded-md px-1 hover:bg-hover">
                <input
                  type="checkbox"
                  checked={c.visible}
                  onChange={(e) => onToggle(c.id, e.target.checked)}
                  aria-label={`Show ${c.name}`}
                  className="size-3.5 shrink-0"
                  style={{ accentColor: c.color ?? 'var(--accent)' }}
                />
                <span className="truncate text-[13px]">{c.name}</span>
              </label>
            </li>
          ))}
        </ul>
        {overlaySources.length > 0 && (
          <>
            <h2 className="mt-4 px-1 pb-1 text-[11px] font-semibold text-ink-3">From Ordo</h2>
            <ul>
              {overlaySources.map((s) => (
                <li key={s.id} className="flex h-7 items-center gap-2 px-1 text-[13px] text-ink-2">
                  <span className="size-3 shrink-0 rounded-[3px] border border-dashed border-ink-3" />
                  <span className="truncate">{s.name}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {footer && <div className="border-t border-sep px-4 py-2.5 text-[11px] text-ink-3">{footer}</div>}
    </aside>
  )
}
