import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  FileText,
  Folder,
  FolderOpen,
  Inbox,
  Library,
  OctagonX,
  RefreshCw,
  Send,
  Trash2,
} from 'lucide-react'
import { ROLE_NAMES, type MailboxInfo, type MailboxRole } from '@ordo/mail-core'
import type { MailAccount } from '@ordo/shared'
import { AccountDot } from '../accounts/AccountChip'

const ICONS: Record<MailboxRole, ReactNode> = {
  inbox: <Inbox size={15} />,
  drafts: <FileText size={15} />,
  sent: <Send size={15} />,
  archive: <Archive size={15} />,
  all: <Library size={15} />,
  junk: <OctagonX size={15} />,
  trash: <Trash2 size={15} />,
}

/** What to call a folder: Mail's names for the special ones, the server's for the rest. */
export const mailboxName = (m: MailboxInfo) => (m.role ? ROLE_NAMES[m.role] : m.name)

/** Every account's inbox together. */
export const ALL = 'all'

/** Which folder is open: one account's, or (`all`) every account's inbox. */
export interface MailView {
  account: string
  mailbox: string
}

interface Props {
  accounts: MailAccount[]
  /** Each account's folders, by account id. */
  mailboxes: Record<string, MailboxInfo[]>
  current: MailView
  onSelect: (view: MailView) => void
  onRefresh: () => void
  refreshing: boolean
  footer: ReactNode
  /** Accounts whose last check failed, and why. */
  problems?: Record<string, string>
  /** A narrow window: icons only, with folders in menus. */
  compact?: boolean
}

// Unread counts matter in the inbox and your own folders; Junk, Bin, Sent and Drafts don't need one.
const showsCount = (m: MailboxInfo) => m.unread > 0 && (m.role === 'inbox' || m.role === null)
const labelOf = (m: MailboxInfo, account?: MailAccount) =>
  (account ? `${account.label}: ` : '') +
  (showsCount(m) ? `${mailboxName(m)}, ${m.unread} unread` : mailboxName(m))

const same = (a: MailView, b: MailView) => a.account === b.account && a.mailbox === b.mailbox

/**
 * The folder list, like Mail's Mailboxes sidebar. One account: its special folders, then its own.
 * Several: All Inboxes first, then each account with its own folders, which can be folded away.
 */
export function MailboxList({
  accounts,
  mailboxes,
  current,
  onSelect,
  onRefresh,
  refreshing,
  footer,
  problems = {},
  compact,
}: Props) {
  const [folded, setFolded] = useState<Set<string>>(new Set())
  const several = accounts.length > 1
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
  const inboxUnread = accounts.reduce(
    (n, a) => n + (mailboxes[a.id]?.find((m) => m.role === 'inbox')?.unread ?? 0),
    0,
  )
  const allView: MailView = { account: ALL, mailbox: 'INBOX' }
  const allLabel = inboxUnread > 0 ? `All Inboxes, ${inboxUnread} unread` : 'All Inboxes'

  if (compact)
    return (
      <aside
        className="flex w-[44px] shrink-0 flex-col items-center border-r border-sep py-3"
        aria-label="Mailboxes"
      >
        {refresh}
        {several ? (
          <ul className="mt-2 flex flex-col items-center gap-px">
            <li>
              <RailButton
                label={allLabel}
                active={same(current, allView)}
                dot={inboxUnread > 0}
                onClick={() => onSelect(allView)}
              >
                <Inbox size={15} />
              </RailButton>
            </li>
            {accounts.map((a) => (
              <li key={a.id}>
                <FolderMenu
                  label={`${a.label} folders`}
                  icon={<AccountDot color={a.color} size={10} />}
                  folders={mailboxes[a.id] ?? []}
                  active={current.account === a.id}
                  isCurrent={(m) => same(current, { account: a.id, mailbox: m.path })}
                  onSelect={(m) => onSelect({ account: a.id, mailbox: m.path })}
                />
              </li>
            ))}
          </ul>
        ) : (
          <SingleRail
            account={accounts[0]}
            mailboxes={accounts[0] ? (mailboxes[accounts[0].id] ?? []) : []}
            current={current}
            onSelect={onSelect}
          />
        )}
      </aside>
    )

  return (
    <aside className="flex w-[188px] shrink-0 flex-col border-r border-sep" aria-label="Mailboxes">
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
        <div className="flex items-center justify-between px-1 pb-1">
          <h2 className="text-[11px] font-semibold text-ink-2">Mailboxes</h2>
          {refresh}
        </div>
        {several ? (
          <>
            <ul className="flex flex-col gap-px">
              <li>
                <ItemButton
                  label={allLabel}
                  active={same(current, allView)}
                  icon={<Inbox size={15} />}
                  name="All Inboxes"
                  count={inboxUnread}
                  onClick={() => onSelect(allView)}
                />
              </li>
            </ul>
            {accounts.map((a) => {
              const open = !folded.has(a.id)
              const boxes = mailboxes[a.id] ?? []
              return (
                <div key={a.id} className="mt-3">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() =>
                      setFolded((f) => {
                        const next = new Set(f)
                        if (next.has(a.id)) next.delete(a.id)
                        else next.add(a.id)
                        return next
                      })
                    }
                    title={a.email}
                    className="flex h-6 w-full items-center gap-1.5 rounded-md px-1 text-left text-[11px] font-semibold text-ink-2 hover:bg-hover"
                  >
                    {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <AccountDot color={a.color} />
                    <span className="min-w-0 flex-1 truncate">{a.label}</span>
                    {problems[a.id] && (
                      <span title={problems[a.id]} className="text-danger-text">
                        <CircleAlert size={12} aria-label={`Couldn’t check ${a.label}`} />
                      </span>
                    )}
                  </button>
                  {open && (
                    <ul className="flex flex-col gap-px" aria-label={`${a.label} mailboxes`}>
                      {[...boxes.filter((m) => m.role), ...boxes.filter((m) => !m.role)].map((m) => (
                        <Item
                          key={m.path}
                          mailbox={m}
                          account={a}
                          active={same(current, { account: a.id, mailbox: m.path })}
                          onSelect={() => onSelect({ account: a.id, mailbox: m.path })}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              )
            })}
          </>
        ) : (
          <SingleList
            account={accounts[0]}
            mailboxes={accounts[0] ? (mailboxes[accounts[0].id] ?? []) : []}
            current={current}
            onSelect={onSelect}
          />
        )}
      </div>
      <div className="border-t border-sep px-3.5 py-2.5 text-[11px] text-ink-2">{footer}</div>
    </aside>
  )
}

/** One account: the special folders, then "Folders" with the rest, as before several accounts. */
function SingleList(props: {
  account?: MailAccount
  mailboxes: MailboxInfo[]
  current: MailView
  onSelect: (v: MailView) => void
}) {
  const id = props.account?.id ?? ALL
  const special = props.mailboxes.filter((m) => m.role)
  const folders = props.mailboxes.filter((m) => !m.role)
  const isActive = (m: MailboxInfo) =>
    props.current.mailbox === m.path && (props.current.account === id || props.current.account === ALL)
  return (
    <>
      <ul className="flex flex-col gap-px">
        {special.map((m) => (
          <Item
            key={m.path}
            mailbox={m}
            active={isActive(m)}
            onSelect={() => props.onSelect({ account: id, mailbox: m.path })}
          />
        ))}
      </ul>
      {folders.length > 0 && (
        <>
          <h2 className="mt-4 px-1 pb-1 text-[11px] font-semibold text-ink-2">Folders</h2>
          <ul className="flex flex-col gap-px">
            {folders.map((m) => (
              <Item
                key={m.path}
                mailbox={m}
                active={isActive(m)}
                onSelect={() => props.onSelect({ account: id, mailbox: m.path })}
              />
            ))}
          </ul>
        </>
      )}
    </>
  )
}

function SingleRail(props: {
  account?: MailAccount
  mailboxes: MailboxInfo[]
  current: MailView
  onSelect: (v: MailView) => void
}) {
  const id = props.account?.id ?? ALL
  const special = props.mailboxes.filter((m) => m.role)
  const folders = props.mailboxes.filter((m) => !m.role)
  const isActive = (m: MailboxInfo) =>
    props.current.mailbox === m.path && (props.current.account === id || props.current.account === ALL)
  return (
    <>
      <ul className="mt-2 flex flex-col items-center gap-px">
        {special.map((m) => (
          <li key={m.path}>
            <RailButton
              label={labelOf(m)}
              active={isActive(m)}
              dot={showsCount(m)}
              onClick={() => props.onSelect({ account: id, mailbox: m.path })}
            >
              {ICONS[m.role!]}
            </RailButton>
          </li>
        ))}
      </ul>
      {folders.length > 0 && (
        <div className="mt-2">
          <FolderMenu
            label="Folders"
            icon={<FolderOpen size={15} />}
            folders={folders}
            active={folders.some(isActive)}
            isCurrent={isActive}
            onSelect={(m) => props.onSelect({ account: id, mailbox: m.path })}
          />
        </div>
      )}
    </>
  )
}

function Item({
  mailbox,
  account,
  active,
  onSelect,
}: {
  mailbox: MailboxInfo
  /** Set when there are several accounts, for the screen reader label. */
  account?: MailAccount
  active: boolean
  onSelect: () => void
}) {
  const depth = mailbox.role ? 0 : Math.min(3, mailbox.path.split(mailbox.delimiter || '/').length - 1)
  return (
    <li>
      <ItemButton
        label={labelOf(mailbox, account)}
        title={mailbox.path}
        active={active}
        indent={(account ? 12 : 0) + depth * 12}
        icon={mailbox.role ? ICONS[mailbox.role] : <Folder size={15} />}
        name={mailboxName(mailbox)}
        count={showsCount(mailbox) ? mailbox.unread : 0}
        onClick={onSelect}
      />
    </li>
  )
}

function ItemButton(props: {
  label: string
  title?: string
  active: boolean
  indent?: number
  icon: ReactNode
  name: string
  count: number
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-current={props.active ? 'page' : undefined}
      aria-label={props.label}
      title={props.title}
      style={{ paddingLeft: 8 + (props.indent ?? 0) }}
      className={`flex h-7 w-full items-center gap-2 rounded-md pr-2 text-left text-[13px] ${
        props.active ? 'bg-selected text-ink' : 'text-ink hover:bg-hover'
      }`}
    >
      <span className={props.active ? 'text-accent' : 'text-ink-2'}>{props.icon}</span>
      <span className="min-w-0 flex-1 truncate">{props.name}</span>
      {props.count > 0 && <span className="text-[11px] text-ink-2 tabular-nums">{props.count}</span>}
    </button>
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

/** Folders in a menu from the rail: your own folders, or one account's. */
function FolderMenu(props: {
  label: string
  icon: ReactNode
  folders: MailboxInfo[]
  active: boolean
  isCurrent: (m: MailboxInfo) => boolean
  onSelect: (m: MailboxInfo) => void
}) {
  const [open, setOpen] = useState(false)
  const menu = useRef<HTMLUListElement>(null)
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
    <div className="relative">
      <RailButton
        label={props.label}
        active={props.active}
        expanded={open}
        dot={props.folders.some(showsCount)}
        onClick={() => setOpen((o) => !o)}
      >
        {props.icon}
      </RailButton>
      {open && (
        <ul
          ref={menu}
          role="menu"
          aria-label={props.label}
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
                  props.onSelect(f)
                }}
                className={`flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-hover ${
                  props.isCurrent(f) ? 'text-accent' : 'text-ink'
                }`}
              >
                <span className="shrink-0 text-ink-2">{f.role ? ICONS[f.role] : <Folder size={14} />}</span>
                <span className="min-w-0 flex-1 truncate">{mailboxName(f)}</span>
                {showsCount(f) && <span className="text-[11px] text-ink-2">{f.unread}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
