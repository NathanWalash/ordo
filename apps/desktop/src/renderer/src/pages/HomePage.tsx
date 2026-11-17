import type { ReactNode } from 'react'
import { Inbox, Sparkles, Wallet, ChevronRight, CalendarDays } from 'lucide-react'
import type { Route } from '../routes'

function greeting(d = new Date()) {
  const h = d.getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

export function HomePage({ onNavigate }: { onNavigate: (r: Route) => void }) {
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
  return (
    <div className="mx-auto w-full max-w-3xl px-8 py-8">
      <p className="text-ink-2">{today}</p>
      <h2 className="mt-1 text-[26px] font-semibold tracking-tight">{greeting()}</h2>

      <div className="mt-8 overflow-hidden rounded-xl border border-sep">
        <Row
          icon={<Inbox size={18} />}
          tint="var(--accent)"
          title="Mail"
          detail="Connect your iCloud account to see your inbox here."
          onClick={() => onNavigate('mail/inbox')}
        />
        <Row
          icon={<Sparkles size={18} />}
          tint="var(--newsletters)"
          title="Unclutter"
          detail="Find the senders filling your inbox, unsubscribe and clear them out."
          onClick={() => onNavigate('mail/unclutter')}
        />
        <Row
          icon={<CalendarDays size={18} />}
          tint="var(--danger)"
          title="Calendar"
          detail="Your iCloud calendars by month, week or as an agenda."
          onClick={() => onNavigate('calendar')}
        />
        <Row
          icon={<Wallet size={18} />}
          tint="var(--success)"
          title="Money"
          detail="Import bank statements, keep track of bills and split them with flatmates."
          onClick={() => onNavigate('money/finances')}
        />
      </div>
    </div>
  )
}

function Row(props: {
  icon: ReactNode
  tint: string
  title: string
  detail: string
  muted?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="flex w-full items-center gap-3 border-b border-sep px-4 py-3 text-left last:border-b-0 hover:bg-hover"
    >
      <span
        className="flex size-8 items-center justify-center rounded-lg text-white"
        style={{ background: props.tint, opacity: props.muted ? 0.5 : 1 }}
      >
        {props.icon}
      </span>
      <span className="flex-1">
        <span className="block text-[14px] font-medium">{props.title}</span>
        <span className="block text-ink-2">{props.detail}</span>
      </span>
      <ChevronRight size={16} className="text-ink-3" />
    </button>
  )
}
