import type { ReactNode } from 'react'
import { Archive, FileText, Folder, Inbox, OctagonX, RefreshCw, Send, Trash2 } from 'lucide-react'
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
}

/** The folder list, like Mail's Mailboxes sidebar: the special folders, then yours. */
export function MailboxList({ mailboxes, current, onSelect, onRefresh, refreshing, footer }: Props) {
  const special = mailboxes.filter((m) => m.role)
  const folders = mailboxes.filter((m) => !m.role)
  return (
    <aside className="flex w-[188px] shrink-0 flex-col border-r border-sep" aria-label="Mailboxes">
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3">
        <div className="flex items-center justify-between px-1 pb-1">
          <h2 className="text-[11px] font-semibold text-ink-3">Mailboxes</h2>
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
        </div>
        <ul className="flex flex-col gap-px">
          {special.map((m) => (
            <Item key={m.path} mailbox={m} active={m.path === current} onSelect={onSelect} />
          ))}
        </ul>
        {folders.length > 0 && (
          <>
            <h2 className="mt-4 px-1 pb-1 text-[11px] font-semibold text-ink-3">Folders</h2>
            <ul className="flex flex-col gap-px">
              {folders.map((m) => (
                <Item key={m.path} mailbox={m} active={m.path === current} onSelect={onSelect} />
              ))}
            </ul>
          </>
        )}
      </div>
      <div className="border-t border-sep px-3.5 py-2.5 text-[11px] text-ink-3">{footer}</div>
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
  // Unread counts matter in the inbox and your own folders; Junk, Bin, Sent and Drafts don't need one.
  const showCount = mailbox.unread > 0 && (mailbox.role === 'inbox' || mailbox.role === null)
  const depth = mailbox.role ? 0 : Math.min(3, mailbox.path.split(mailbox.delimiter || '/').length - 1)
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(mailbox.path)}
        aria-current={active ? 'page' : undefined}
        aria-label={showCount ? `${name}, ${mailbox.unread} unread` : name}
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
        {showCount && <span className="text-[11px] text-ink-3 tabular-nums">{mailbox.unread}</span>}
      </button>
    </li>
  )
}
