import type { ReactNode } from 'react'
import { AlertCircle, Plus, X } from 'lucide-react'
import type { CalendarListItem } from '@ordo/shared'
import type { CalendarOverlaySource } from './overlays'

interface Props {
  title: string
  calendars: CalendarListItem[]
  onToggle: (calendarId: string, visible: boolean) => void
  overlaySources: readonly CalendarOverlaySource[]
  /** Shows "Add calendar…" at the bottom of the list. */
  onAdd?: () => void
  /** Shows a remove button on calendars added by link or file. */
  onRemove?: (calendar: CalendarListItem) => void
  footer?: ReactNode
}

const added = (c: CalendarListItem) => c.source === 'link' || c.source === 'file'

/** Google calendars by account, in list order. */
function byAccount(calendars: CalendarListItem[]): [string, CalendarListItem[]][] {
  const groups = new Map<string, CalendarListItem[]>()
  for (const c of calendars)
    if (c.source === 'google')
      groups.set(c.account ?? 'Google', [...(groups.get(c.account ?? 'Google') ?? []), c])
  return [...groups]
}

/** The list of calendars with colour checkboxes, like the macOS Calendar sidebar. */
export function CalendarList({ title, calendars, onToggle, overlaySources, onAdd, onRemove, footer }: Props) {
  const own = calendars.filter((c) => !added(c) && c.source !== 'google')
  const google = byAccount(calendars)
  const others = calendars.filter(added)
  return (
    <aside className="flex w-[196px] shrink-0 flex-col border-r border-sep" aria-label="Calendars">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {(own.length > 0 || (others.length === 0 && google.length === 0)) && (
          <>
            <h2 className="px-1 pb-1 text-[11px] font-semibold text-ink-3">{title}</h2>
            {own.length === 0 && <p className="px-1 py-1 text-[12px] text-ink-3">No calendars yet</p>}
            <Calendars calendars={own} onToggle={onToggle} />
          </>
        )}
        {google.map(([account, list], i) => (
          <div key={account}>
            <h2
              className={`truncate px-1 pb-1 text-[11px] font-semibold text-ink-3 ${own.length || i ? 'mt-4' : ''}`}
              title={account}
            >
              {account}
            </h2>
            <Calendars calendars={list} onToggle={onToggle} />
          </div>
        ))}
        {others.length > 0 && (
          <>
            <h2
              className={`px-1 pb-1 text-[11px] font-semibold text-ink-3 ${own.length || google.length ? 'mt-4' : ''}`}
            >
              Other calendars
            </h2>
            <Calendars calendars={others} onToggle={onToggle} onRemove={onRemove} />
          </>
        )}
        {onAdd && (
          <button
            type="button"
            onClick={onAdd}
            className="no-drag mt-1 flex h-7 w-full items-center gap-2 rounded-md px-1 text-[13px] text-ink-2 hover:bg-hover hover:text-ink"
          >
            <Plus size={14} className="shrink-0" />
            Add calendar…
          </button>
        )}
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

function Calendars({
  calendars,
  onToggle,
  onRemove,
}: {
  calendars: CalendarListItem[]
  onToggle: Props['onToggle']
  onRemove?: Props['onRemove']
}) {
  return (
    <ul>
      {calendars.map((c) => (
        <li key={c.id} className="group flex h-7 items-center rounded-md hover:bg-hover">
          <label className="flex min-w-0 flex-1 items-center gap-2 px-1">
            <input
              type="checkbox"
              checked={c.visible}
              onChange={(e) => onToggle(c.id, e.target.checked)}
              aria-label={`Show ${c.name}`}
              className="size-3.5 shrink-0"
              style={{ accentColor: c.color ?? 'var(--accent)' }}
            />
            <span className="truncate text-[13px]" title={c.name}>
              {c.name}
            </span>
          </label>
          {c.syncError && (
            <span
              role="img"
              aria-label={`${c.name} didn’t update: ${c.syncError}`}
              title={c.syncError}
              className="mr-1 flex shrink-0 text-warn"
            >
              <AlertCircle size={12} />
            </span>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(c)}
              aria-label={`Remove ${c.name}`}
              title="Remove"
              className="no-drag mr-0.5 flex size-5 shrink-0 items-center justify-center rounded text-ink-3 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-black/5 hover:text-ink focus-visible:opacity-100 dark:hover:bg-white/10"
            >
              <X size={12} />
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}
