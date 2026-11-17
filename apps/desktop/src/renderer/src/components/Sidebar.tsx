import type { ReactNode } from 'react'
import { House, Inbox, Sparkles, Wallet, Settings } from 'lucide-react'
import type { AppInfo } from '@ordo/shared'
import type { Route } from '../routes'

interface Props {
  route: Route
  onNavigate: (r: Route) => void
  platform?: AppInfo['platform']
}

export function Sidebar({ route, onNavigate, platform }: Props) {
  // macOS traffic lights sit over the sidebar; leave room for them.
  const top = platform === 'darwin' ? 'pt-[52px]' : 'pt-3'
  return (
    <nav className={`sidebar drag flex w-[220px] shrink-0 flex-col px-2.5 pb-3 ${top}`} aria-label="Modules">
      <div className="no-drag flex flex-col gap-px">
        <Item
          icon={<House size={15} />}
          label="Home"
          active={route === 'home'}
          onClick={() => onNavigate('home')}
        />
      </div>

      <Section label="Mail">
        <Item
          icon={<Inbox size={15} />}
          label="Inbox"
          active={route === 'mail/inbox'}
          onClick={() => onNavigate('mail/inbox')}
        />
        <Item
          icon={<Sparkles size={15} />}
          label="Unclutter"
          active={route === 'mail/unclutter'}
          onClick={() => onNavigate('mail/unclutter')}
        />
      </Section>

      <Section label="Finance">
        <Item
          icon={<Wallet size={15} />}
          label="Overview"
          badge="Soon"
          active={route === 'finance'}
          onClick={() => onNavigate('finance')}
        />
      </Section>

      <div className="no-drag mt-auto">
        <Item
          icon={<Settings size={15} />}
          label="Settings"
          active={route === 'settings'}
          onClick={() => onNavigate('settings')}
        />
      </div>
    </nav>
  )
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="no-drag mt-4 flex flex-col gap-px">
      <div className="px-2 pb-1 text-[11px] font-semibold text-ink-3">{label}</div>
      {children}
    </div>
  )
}

function Item(props: {
  icon: ReactNode
  label: string
  active: boolean
  badge?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-current={props.active ? 'page' : undefined}
      className={`flex h-7 items-center gap-2 rounded-md px-2 text-left text-[13px] ${
        props.active ? 'bg-selected text-ink' : 'text-ink hover:bg-hover'
      }`}
    >
      <span className={props.active ? 'text-accent' : 'text-ink-2'}>{props.icon}</span>
      <span className="flex-1">{props.label}</span>
      {props.badge && <span className="text-[11px] text-ink-3">{props.badge}</span>}
    </button>
  )
}
