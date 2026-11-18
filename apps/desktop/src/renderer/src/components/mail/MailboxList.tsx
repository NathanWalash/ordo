import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Archive, FileText, Folder, FolderOpen, Inbox, OctagonX, RefreshCw, Send, Trash2 } from 'lucide-react'
import { ROLE_NAMES, type MailboxInfo, type MailboxRole } from '@ordo/mail-core'

const ICONS: Record<MailboxRole, ReactNode> = {
  inbox: <Inbox size={15} />,
  drafts: <FileText size={15} />,
  sent: <Send size={15} />,
  archive: <Archive size={15} />,
  junk: <OctagonX size={15} />,
  trash: <Trash2 size={15} />,
}

/** What to call a folder: Mail's names for the special ones, the server's for the rest. */
export const mailboxName = (m: MailboxInfo) => (m.role ? ROLE_NAMES[m.role] : m.name)

interface Props {
  mailboxes: MailboxInfo[]
  current: string
  onSelect: (path: string) => void
  onRefresh: () => void
  refreshing: boolean
  footer: ReactNode
  /** A narrow window: icons only, with your own folders in a menu. */
  compact?: boolean
}

// Unread counts matter in the inbox and your own folders; Junk, Bin, Sent and Drafts don't need one.
const showsCount = (m: MailboxInfo) => m.unread > 0 && (m.role === 'inbox' || m.role === null)
const labelOf = (m: MailboxInfo) => (showsCount(m) ? `${mailboxName(m)}, ${m.unread} unread` : mailboxName(m))

/** The folder list, like Mail's Mailboxes sidebar: the special folders, then yours. */
export function MailboxList({ mailboxes, current, onSelect, onRefresh, refreshing, footer, compact }: Props) {
  const special = mailboxes.filter((m) => m.role)
  const folders = mailboxes.filter((m) => !m.role)
  const refresh = (
    <button
      type="button"
      onClick={onRefresh}
      disabled={refreshing}
      aria-label="Check for new mail"
      title="Check for new mail"
      className="flex size-6 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-60"
    >
      <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
    </button>
  )
  if (compact)
    return (
      <aside
        className="flex w-[44px] shrink-0 flex-col items-center border-r border-sep py-3"
        aria-label="Mailboxes"
      >
        {refresh}
        <ul className="mt-2 flex flex-col items-center gap-px">
          {special.map((m) => (
            <li key={m.path}>
              <RailButton
                label={labelOf(m)}
                active={m.path === current}
                dot={showsCount(m)}
                onClick={() => onSelect(m.path)}
              >
                {ICONS[m.role!]}
              </RailButton>
            </li>
          ))}
        </ul>
        {folders.length > 0 && <FolderMenu folders={folders} current={current} onSelect={onSelect} />}
      </aside>
    )
  return (
    <aside className="flex w-[188px] shrink-0 flex-col border-r border-sep" aria-label="Mailboxes">
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
        <div className="flex items-center justify-between px-1 pb-1">
          <h2 className="text-[11px] font-semibold text-ink-2">Mailboxes</h2>
          {refresh}
        </div>
        <ul className="flex flex-col gap-px">
          {special.map((m) => (
            <Item key={m.path} mailbox={m} active={m.path === current} onSelect={onSelect} />
          ))}
        </ul>
        {folders.length > 0 && (
          <>
            <h2 className="mt-4 px-1 pb-1 text-[11px] font-semibold text-ink-2">Folders</h2>
            <ul className="flex flex-col gap-px">
              {folders.map((m) => (
                <Item key={m.path} mailbox={m} active={m.path === current} onSelect={onSelect} />
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="border-t border-sep px-3.5 py-2.5 text-[11px] text-ink-2">{footer}</div>
    </aside>
  )
}

function Item({
  mailbox,
  active,
  onSelect,
}: {
  mailbox: MailboxInfo
  active: boolean
  onSelect: (path: string) => void
}) {
  const name = mailboxName(mailbox)
  const depth = mailbox.role ? 0 : Math.min(3, mailbox.path.split(mailbox.delimiter || '/').length - 1)
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(mailbox.path)}
        aria-current={active ? 'page' : undefined}
        aria-label={labelOf(mailbox)}
        title={mailbox.path}
        style={{ paddingLeft: 8 + depth * 12 }}
        className={`flex h-7 w-full items-center gap-2 rounded-md pr-2 text-left text-[13px] ${
          active ? 'bg-selected text-ink' : 'text-ink hover:bg-hover'
        }`}
      >
        <span className={active ? 'text-accent' : 'text-ink-2'}>
          {mailbox.role ? ICONS[mailbox.role] : <Folder size={15} />}
        </span>
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {showsCount(mailbox) && <span className="text-[11px] text-ink-2 tabular-nums">{mailbox.unread}</span>}
      </button>
    </li>
  )
}

function RailButton(props: {
  label: string
  active: boolean
  dot?: boolean
  onClick: () => void
  children: ReactNode
  expanded?: boolean
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-current={props.active ? 'page' : undefined}
      aria-label={props.label}
      aria-expanded={props.expanded}
      title={props.label}
      className={`relative flex size-8 items-center justify-center rounded-md ${
        props.active ? 'bg-selected text-accent' : 'text-ink-2 hover:bg-hover hover:text-ink'
      }`}
    >
      {props.children}
      {props.dot && (
        <span aria-hidden="true" className="absolute top-1 right-1 size-1.5 rounded-full bg-accent" />
      )}
    </button>
  )
}

/** Your own folders, in a menu from the rail. */
function FolderMenu(props: { folders: MailboxInfo[]; current: string; onSelect: (path: string) => void }) {
  const [open, setOpen] = useState(false)
  const menu = useRef<HTMLUListElement>(null)
  const active = props.folders.some((f) => f.path === props.current)
  useEffect(() => {
    if (!open) return
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const close = (e: MouseEvent) => {
      if (!menu.current?.parentElement?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div className="relative mt-2">
      <RailButton
        label="Folders"
        active={active}
        expanded={open}
        dot={props.folders.some(showsCount)}
        onClick={() => setOpen((o) => !o)}
      >
        <FolderOpen size={15} />
      </RailButton>
      {open && (
        <ul
          ref={menu}
          role="menu"
          aria-label="Folders"
          onKeyDown={(e) => {
            const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
            const i = items.indexOf(document.activeElement as HTMLElement)
            if (e.key === 'Escape') {
              e.stopPropagation()
              setOpen(false)
            } else if (e.key === 'ArrowDown') items[Math.min(items.length - 1, i + 1)]?.focus()
            else if (e.key === 'ArrowUp') items[Math.max(0, i - 1)]?.focus()
            else return
            e.preventDefault()
          }}
          className="glass-panel absolute top-0 left-10 z-30 max-h-[60vh] w-[220px] overflow-y-auto rounded-lg p-1"
        >
          {props.folders.map((f) => (
            <li key={f.path} role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false)
                  props.onSelect(f.path)
                }}
                className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-hover ${
                  f.path === props.current ? 'text-accent' : 'text-ink'
                }`}
              >
                <Folder size={14} className="shrink-0 text-ink-2" />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                {showsCount(f) && <span className="text-[11px] text-ink-2">{f.unread}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
