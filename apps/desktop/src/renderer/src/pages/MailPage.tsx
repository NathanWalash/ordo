import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  Flag,
  Forward,
  Inbox,
  Mail,
  MailOpen,
  OctagonX,
  Reply,
  ReplyAll,
  Search,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react'
import {
  bodyText,
  checkLink,
  forwardBody,
  forwardSubject,
  formatAddressList,
  parseMailtoLink,
  replyBody,
  replyRecipients,
  replySubject,
  type CheckedLink,
} from '@ordo/mail-core'
import type {
  AccountStatus,
  MailboxInfo,
  MailRefreshProgress,
  MessageContent,
  MessageSummary,
  MoveTarget,
} from '@ordo/shared'
import { Button } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import { SegmentedControl } from '../components/SegmentedControl'
import { ToolbarActions } from '../components/Toolbar'
import { ComposeSheet, type ComposeDraft } from '../components/mail/ComposeSheet'
import { fullDate } from '../components/mail/format'
import { LinkSheet } from '../components/mail/LinkSheet'
import { mailboxName, MailboxList } from '../components/mail/MailboxList'
import { keyOf, MessageList } from '../components/mail/MessageList'
import { Reader } from '../components/mail/Reader'

const INBOX = 'INBOX'
const PAGE = 200
/** Check for new mail this often while Mail is open. */
const POLL_MS = 5 * 60_000

interface Props {
  account: AccountStatus | null
  onConnect: () => void
  /** Show a different title in the toolbar (the mailbox), or null for the default. */
  onTitle: (title: string | null) => void
}

export function MailPage({ account, onConnect, onTitle }: Props) {
  if (!account?.connected)
    return (
      <EmptyState
        icon={<Inbox size={40} strokeWidth={1.5} />}
        title="Connect your iCloud account"
        body="You'll need your Apple ID email and an app-specific password from account.apple.com. It's stored in your Keychain, never in a file."
        action={
          <Button variant="primary" onClick={onConnect}>
            Connect iCloud
          </Button>
        }
      />
    )
  return <MailClient key={account.email} email={account.email} onTitle={onTitle} />
}

type Opened = { key: string; message?: MessageContent; error?: string }
type Toast = { text: string; undoId?: number; error?: boolean }
type Filter = 'all' | 'unread'

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
] as const

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))

function MailClient({ email, onTitle }: { email: string; onTitle: (t: string | null) => void }) {
  const [boxes, setBoxes] = useState<MailboxInfo[]>([])
  const [current, setCurrent] = useState(INBOX)
  const [filter, setFilter] = useState<Filter>('all')
  const [limit, setLimit] = useState(PAGE)
  const [list, setList] = useState<{ total: number; messages: MessageSummary[] } | null>(null)
  const [selected, setSelected] = useState<MessageSummary | null>(null)
  const [opened, setOpened] = useState<Opened | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [progress, setProgress] = useState<MailRefreshProgress | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MessageSummary[] | null>(null)
  const [server, setServer] = useState<{ busy: boolean; done: boolean; error?: string }>({
    busy: false,
    done: false,
  })
  const [toast, setToast] = useState<Toast | null>(null)
  const [compose, setCompose] = useState<ComposeDraft | null>(null)
  const [link, setLink] = useState<CheckedLink | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // The folder on screen, for async work that finishes after you've moved on.
  const currentRef = useRef(current)
  useEffect(() => {
    currentRef.current = current
  }, [current])

  const box = boxes.find((b) => b.path === current)
  const role = box?.role ?? (current === INBOX ? 'inbox' : null)
  const boxName = box ? mailboxName(box) : current === INBOX ? 'Inbox' : current
  const nameOf = useCallback(
    (path: string) => {
      const b = boxes.find((x) => x.path === path)
      return b ? mailboxName(b) : path
    },
    [boxes],
  )

  useEffect(() => {
    onTitle(boxName)
  }, [boxName, onTitle])
  useEffect(() => () => onTitle(null), [onTitle])

  /** Read the folder list and the current page from the cache (no network). */
  const load = useCallback(async () => {
    const mailbox = current
    const [b, page] = await Promise.all([
      window.ordo.mail.mailboxes(),
      window.ordo.mail.messages({ mailbox, limit, unread: filter === 'unread' || undefined }),
    ])
    if (mailbox !== currentRef.current) return
    setBoxes(b)
    setList(page)
  }, [current, limit, filter])

  /** Fetch new mail for a folder from the server, then show it. */
  const refresh = useCallback(
    async (mailbox: string) => {
      setRefreshing(true)
      const off = window.ordo.mail.onRefreshProgress((p) => p.mailbox === mailbox && setProgress(p))
      try {
        const r = await window.ordo.mail.refresh({ mailbox })
        if (r.ok) {
          setProblem(null)
          setCheckedAt(new Date())
        } else if (r.error !== 'busy') setProblem(r.message)
        await load()
      } finally {
        off()
        setRefreshing(false)
        setProgress(null)
      }
    },
    [load],
  )

  // Show the cache straight away whenever the folder, filter or page size changes.
  useEffect(() => {
    const t = setTimeout(() => void load(), 0)
    return () => clearTimeout(t)
  }, [load])

  // Then check the server: on opening a folder, and every few minutes.
  useEffect(() => {
    const first = setTimeout(() => void refresh(current), 0)
    const every = setInterval(() => void refresh(currentRef.current), POLL_MS)
    return () => {
      clearTimeout(first)
      clearInterval(every)
    }
    // Only when the folder changes, not when `refresh` is recreated by a filter change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

  const changeQuery = (q: string) => {
    setQuery(q)
    setServer({ busy: false, done: false })
    if (!q.trim()) setResults(null)
  }

  // Local search as you type, across every folder in the cache.
  useEffect(() => {
    const q = query.trim()
    if (!q) return
    let live = true
    const t = setTimeout(() => {
      void window.ordo.mail.search({ query: q, limit: 200 }).then((r) => live && setResults(r))
    }, 150)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [query])

  const visible = results ?? list?.messages ?? []
  const selectedKey = selected ? keyOf(selected) : null

  /** Change messages in the lists on screen without reloading. */
  const patch = (keys: Set<string>, change: Partial<MessageSummary> | null) => {
    const apply = (ms: MessageSummary[]) =>
      change === null
        ? ms.filter((m) => !keys.has(keyOf(m)))
        : ms.map((m) => (keys.has(keyOf(m)) ? { ...m, ...change } : m))
    setList(
      (l) => l && { total: change === null ? l.total - keys.size : l.total, messages: apply(l.messages) },
    )
    setResults((r) => r && apply(r))
    setSelected((s) => (s && keys.has(keyOf(s)) ? (change === null ? s : { ...s, ...change }) : s))
  }

  const setFlags = async (ms: MessageSummary[], flags: { seen?: boolean; flagged?: boolean }) => {
    if (!ms.length) return
    const mailbox = ms[0]!.mailbox
    const same = ms.filter((m) => m.mailbox === mailbox)
    patch(new Set(same.map(keyOf)), flags)
    const r = await window.ordo.mail.setFlags({ mailbox, uids: same.map((m) => m.uid), ...flags })
    if (!r.ok) {
      setToast({ text: r.message, error: true })
      await load()
    } else setBoxes(await window.ordo.mail.mailboxes())
  }

  // Open the selected message, and mark it read. What's on screen is `opened` only while its
  // key matches the selection, so there's nothing to reset when the selection changes.
  useEffect(() => {
    if (!selected) return
    const key = keyOf(selected)
    let live = true
    void window.ordo.mail.open({ mailbox: selected.mailbox, uid: selected.uid }).then((r) => {
      if (!live) return
      setOpened(r.ok ? { key, message: r.message } : { key, error: r.message })
      if (r.ok && !r.message.seen) void setFlags([selected], { seen: true })
    })
    return () => {
      live = false
    }
    // Opening depends on which message, not on its flags changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey])

  const move = async (to: MoveTarget) => {
    const m = selected
    if (!m) return
    const i = visible.findIndex((x) => keyOf(x) === keyOf(m))
    const next = visible[i + 1] ?? visible[i - 1] ?? null
    const r = await window.ordo.mail.move({ mailbox: m.mailbox, uids: [m.uid], to })
    if (!r.ok) {
      setToast({ text: r.message, error: true })
      return
    }
    patch(new Set([keyOf(m)]), null)
    setSelected(next)
    const where = { archive: 'Archive', trash: 'Bin', inbox: 'Inbox', junk: 'Junk' }[to]
    setToast({ text: `Moved to ${where}.`, ...(r.undoId !== null && { undoId: r.undoId }) })
    setBoxes(await window.ordo.mail.mailboxes())
  }

  const undo = async () => {
    if (!toast?.undoId) return
    const id = toast.undoId
    setToast({ text: 'Moving back…' })
    const r = await window.ordo.mail.undoMove(id)
    setToast(r.ok ? { text: 'Moved back.' } : { text: r.message, error: true })
    await load()
  }

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.undoId ? 12_000 : 5_000)
    return () => clearTimeout(t)
  }, [toast])

  const message = opened?.message && opened.key === selectedKey ? opened.message : null

  const startReply = (all: boolean) => {
    if (!message) return
    const r = replyRecipients(message, [email], all)
    setCompose({
      title: all ? 'Reply all' : 'Reply',
      to: formatAddressList(r.to),
      cc: formatAddressList(r.cc),
      bcc: '',
      subject: replySubject(message.subject),
      body: replyBody(message, bodyText(message), fullDate(message.date)),
      replyTo: { mailbox: message.mailbox, uid: message.uid },
      focusBody: true,
    })
  }

  const startForward = () => {
    if (!message) return
    setCompose({
      title: 'Forward',
      to: '',
      cc: '',
      bcc: '',
      subject: forwardSubject(message.subject),
      body: forwardBody(message, bodyText(message), fullDate(message.date)),
      forward: {
        ref: { mailbox: message.mailbox, uid: message.uid },
        attachments: message.attachments.filter((a) => !a.inline),
      },
    })
  }

  const editDraft = () => {
    if (!message) return
    const ref = { mailbox: message.mailbox, uid: message.uid }
    const files = message.attachments.filter((a) => !a.inline)
    setCompose({
      title: 'Draft',
      to: formatAddressList(message.to),
      cc: formatAddressList(message.cc),
      bcc: formatAddressList(message.bcc),
      subject: message.subject,
      body: bodyText(message),
      draft: ref,
      ...(files.length && { forward: { ref, attachments: files } }),
      focusBody: true,
    })
  }

  const newMessage = () =>
    setCompose({ title: 'New message', to: '', cc: '', bcc: '', subject: '', body: '' })

  const onLink = useCallback((href: string, text: string) => {
    const checked = checkLink(href, text)
    if (checked.kind !== 'mailto') return setLink(checked)
    const draft = parseMailtoLink(checked.url)
    if (!draft)
      return setLink({
        kind: 'refused',
        url: checked.url,
        reason: 'Ordo can’t write to the address in this link.',
      })
    setCompose({ title: 'New message', bcc: '', ...draft })
  }, [])

  const searchServer = async () => {
    const q = query.trim()
    if (!q) return
    setServer({ busy: true, done: false })
    const r = await window.ordo.mail.searchServer({ query: q, mailbox: current, limit: 100 })
    if (!r.ok) return setServer({ busy: false, done: false, error: r.message })
    setResults((local) => {
      const seen = new Set((local ?? []).map(keyOf))
      return [...(local ?? []), ...r.messages.filter((m) => !seen.has(keyOf(m)))].sort(
        (a, b) => b.date.getTime() - a.date.getTime(),
      )
    })
    setServer({ busy: false, done: true })
  }

  const selectMailbox = (path: string) => {
    if (path === current) return void refresh(path)
    setCurrent(path)
    setLimit(PAGE)
    setSelected(null)
    setList(null)
    changeQuery('')
    setProblem(null)
  }

  const step = (dir: 1 | -1) => {
    const i = visible.findIndex((m) => keyOf(m) === selectedKey)
    const next = visible[i < 0 ? 0 : Math.min(visible.length - 1, Math.max(0, i + dir))]
    if (next) setSelected(next)
  }

  const sheetOpen = compose !== null || link !== null
  const handlers = {
    move,
    undo,
    startReply,
    startForward,
    newMessage,
    step,
    toggleRead: () => selected && void setFlags([selected], { seen: !selected.seen }),
    toggleFlag: () => selected && void setFlags([selected], { flagged: !selected.flagged }),
  }
  const handlersRef = useRef(handlers)
  useEffect(() => {
    handlersRef.current = handlers
  })

  // Keyboard shortcuts, like Mail and Gmail. Never while typing or while a sheet is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sheetOpen || e.defaultPrevented || e.altKey || e.ctrlKey) return
      const h = handlersRef.current
      if (e.metaKey) {
        if (e.key === 'n') h.newMessage()
        else if (e.key === 'f') searchRef.current?.focus()
        else return
        e.preventDefault()
        return
      }
      if (isTyping(e.target)) return
      const actions: Record<string, () => void> = {
        c: h.newMessage,
        '/': () => searchRef.current?.focus(),
        r: () => h.startReply(false),
        a: () => h.startReply(true),
        f: h.startForward,
        e: () => void h.move('archive'),
        '#': () => void h.move('trash'),
        Delete: () => void h.move('trash'),
        Backspace: () => void h.move('trash'),
        u: h.toggleRead,
        s: h.toggleFlag,
        z: () => void h.undo(),
        ArrowDown: () => h.step(1),
        j: () => h.step(1),
        ArrowUp: () => h.step(-1),
        k: () => h.step(-1),
      }
      const action = actions[e.key]
      if (!action) return
      e.preventDefault()
      action()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sheetOpen])

  const hasRole = (r: MoveTarget) => r === 'inbox' || boxes.some((b) => b.role === r)
  const canAct = selected !== null
  const inDrafts = role === 'drafts' || (message?.draft ?? false)
  const searching = results !== null

  const firstSync = refreshing && current === INBOX && progress && (list?.total ?? 0) === 0
  const listTitle = searching ? `Results for “${query.trim()}”` : boxName
  const countLine = searching
    ? `${visible.length} found${server.done ? '' : ' in downloaded mail'}`
    : list
      ? filter === 'unread'
        ? `${list.total.toLocaleString()} unread`
        : `${list.total.toLocaleString()} ${list.total === 1 ? 'message' : 'messages'}`
      : ''

  const footer = refreshing
    ? progress && progress.total > 0 && current === INBOX
      ? `Checking ${progress.checked.toLocaleString()} of ${progress.total.toLocaleString()}…`
      : 'Checking for new mail…'
    : checkedAt
      ? `Updated ${checkedAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
      : email

  return (
    <div className="relative flex h-full min-h-0">
      <ToolbarActions>
        <div role="toolbar" aria-label="Mail" className="flex min-w-0 items-center gap-1">
          <ToolButton label="New message" shortcut="C" onClick={newMessage}>
            <SquarePen size={16} />
          </ToolButton>
          <Divider />
          {role === 'archive' || role === 'trash' || role === 'junk' ? (
            <ToolButton label="Move to Inbox" disabled={!canAct} onClick={() => void move('inbox')}>
              <Inbox size={16} />
            </ToolButton>
          ) : (
            <ToolButton
              label={hasRole('archive') ? 'Archive' : 'This account has no Archive mailbox'}
              shortcut="E"
              disabled={!canAct || !hasRole('archive')}
              onClick={() => void move('archive')}
            >
              <Archive size={16} />
            </ToolButton>
          )}
          {role !== 'trash' && (
            <ToolButton
              label="Move to Bin"
              shortcut="Delete"
              disabled={!canAct}
              onClick={() => void move('trash')}
            >
              <Trash2 size={16} />
            </ToolButton>
          )}
          {role !== 'junk' && role !== 'trash' && role !== 'sent' && role !== 'drafts' && hasRole('junk') && (
            <ToolButton label="Move to Junk" disabled={!canAct} onClick={() => void move('junk')}>
              <OctagonX size={16} />
            </ToolButton>
          )}
          <Divider />
          <ToolButton label="Reply" shortcut="R" disabled={!message} onClick={() => startReply(false)}>
            <Reply size={16} />
          </ToolButton>
          <ToolButton label="Reply all" shortcut="A" disabled={!message} onClick={() => startReply(true)}>
            <ReplyAll size={16} />
          </ToolButton>
          <ToolButton label="Forward" shortcut="F" disabled={!message} onClick={startForward}>
            <Forward size={16} />
          </ToolButton>
          <Divider />
          <ToolButton
            label="Flag"
            shortcut="S"
            pressed={selected?.flagged ?? false}
            disabled={!canAct}
            onClick={handlers.toggleFlag}
          >
            <Flag size={16} className={selected?.flagged ? 'fill-[#ff9500] text-[#ff9500]' : ''} />
          </ToolButton>
          <ToolButton
            label={selected && !selected.seen ? 'Mark as read' : 'Mark as unread'}
            shortcut="U"
            disabled={!canAct}
            onClick={handlers.toggleRead}
          >
            {selected && !selected.seen ? <MailOpen size={16} /> : <Mail size={16} />}
          </ToolButton>
          <div className="no-drag relative ml-2 w-[200px] min-w-[120px] shrink">
            <Search
              size={13}
              className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-ink-3"
            />
            <input
              ref={searchRef}
              type="search"
              role="searchbox"
              aria-label="Search mail"
              placeholder="Search"
              value={query}
              onChange={(e) => changeQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  changeQuery('')
                  e.currentTarget.blur()
                } else if (e.key === 'Enter' && query.trim()) void searchServer()
                else if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  listRef.current?.querySelector<HTMLElement>('[role="listbox"]')?.focus()
                  if (!selected && visible[0]) setSelected(visible[0])
                }
              }}
              className="h-7 w-full rounded-md border border-sep bg-field pr-6 pl-7 text-[13px] text-ink outline-none select-text placeholder:text-ink-3 focus:border-accent focus:ring-1 focus:ring-accent [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => changeQuery('')}
                className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded text-ink-3 hover:text-ink"
              >
                <X size={13} />
              </button>
            )}
          </div>
        </div>
      </ToolbarActions>

      <MailboxList
        mailboxes={boxes}
        current={current}
        onSelect={selectMailbox}
        onRefresh={() => void refresh(current)}
        refreshing={refreshing}
        footer={<span aria-live="polite">{footer}</span>}
      />

      <section
        ref={listRef}
        aria-label="Messages"
        className="flex w-[320px] shrink-0 flex-col border-r border-sep max-[1100px]:w-[280px]"
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-sep px-4">
          <div className="min-w-0">
            <h2 className="truncate text-[13px] font-semibold">{listTitle}</h2>
            <p className="truncate text-[11px] text-ink-2">{countLine}</p>
          </div>
          {!searching && (
            <SegmentedControl
              label="Show"
              options={FILTERS}
              value={filter}
              onChange={(f) => {
                setFilter(f)
                setLimit(PAGE)
              }}
            />
          )}
        </div>
        {problem && (
          <p role="alert" className="mx-3 mt-2 rounded-md bg-hover px-3 py-2 text-[12px] text-danger">
            {problem}
          </p>
        )}
        {firstSync ? (
          <FirstSync progress={progress} />
        ) : (
          <MessageList
            label={searching ? 'Search results' : `${boxName} messages`}
            messages={visible}
            selected={selectedKey}
            onSelect={setSelected}
            showRecipients={!searching && (role === 'sent' || role === 'drafts')}
            showMailbox={searching ? nameOf : undefined}
            onEndReached={() => {
              if (!searching && list && list.messages.length < list.total && limit <= list.messages.length)
                setLimit((l) => l + PAGE)
            }}
            empty={
              list === null && !searching ? null : (
                <p className="text-center text-[13px] text-ink-3">
                  {searching
                    ? 'Nothing found in downloaded mail.'
                    : filter === 'unread'
                      ? 'No unread messages.'
                      : refreshing
                        ? 'Checking for mail…'
                        : 'No messages.'}
                </p>
              )
            }
            footer={
              searching && (
                <ServerSearch
                  mailbox={boxName}
                  busy={server.busy}
                  done={server.done}
                  error={server.error}
                  onSearch={() => void searchServer()}
                />
              )
            }
          />
        )}
        {searching && visible.length === 0 && (
          <ServerSearch
            mailbox={boxName}
            busy={server.busy}
            done={server.done}
            error={server.error}
            onSearch={() => void searchServer()}
          />
        )}
      </section>

      <section aria-label="Reading pane" className="relative min-w-0 flex-1 overflow-y-auto">
        {!selected ? (
          <EmptyState
            icon={<Mail size={40} strokeWidth={1.5} />}
            title="No message selected"
            body="Choose a message to read it. Use the arrow keys to move through the list."
          />
        ) : opened?.key === selectedKey && opened.error ? (
          <EmptyState
            icon={<Mail size={40} strokeWidth={1.5} />}
            title="Couldn’t open this message"
            body={opened.error}
          />
        ) : message ? (
          <Reader
            key={selectedKey}
            message={message}
            isDraft={inDrafts}
            onLink={onLink}
            onEditDraft={editDraft}
          />
        ) : (
          <p className="p-6 text-[13px] text-ink-3" aria-live="polite">
            Opening…
          </p>
        )}
      </section>

      {toast && !sheetOpen && (
        <div
          role="status"
          className="glass-panel absolute bottom-5 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-full py-1.5 pr-1.5 pl-4 text-[13px]"
        >
          <span className={toast.error ? 'text-danger' : ''}>{toast.text}</span>
          {toast.undoId ? (
            <Button onClick={() => void undo()} title="Undo (Z)">
              Undo
            </Button>
          ) : (
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setToast(null)}
              className="flex size-6 items-center justify-center rounded-full text-ink-3 hover:bg-hover hover:text-ink"
            >
              <X size={13} />
            </button>
          )}
        </div>
      )}

      {compose && (
        <ComposeSheet
          from={email}
          initial={compose}
          onClose={() => setCompose(null)}
          onSent={(warning) => {
            setCompose(null)
            setToast({ text: warning ?? 'Message sent.' })
            void load()
          }}
          onSaved={() => void load()}
        />
      )}
      {link && <LinkSheet link={link} onClose={() => setLink(null)} />}
    </div>
  )
}

function FirstSync({ progress }: { progress: MailRefreshProgress | null }) {
  const pct = progress?.total ? Math.min(100, (progress.checked / progress.total) * 100) : 0
  return (
    <div className="px-4 pt-5" aria-live="polite">
      <p className="text-[13px] font-medium">Downloading your inbox</p>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-selected"
        role="progressbar"
        aria-label="Downloading your inbox"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-[12px] leading-snug text-ink-2">
        {progress?.total
          ? `${progress.checked.toLocaleString()} of ${progress.total.toLocaleString()}. Only headers come down now; a message’s text is fetched when you open it.`
          : 'Connecting to iCloud…'}
      </p>
    </div>
  )
}

function ServerSearch(props: {
  mailbox: string
  busy: boolean
  done: boolean
  error?: string
  onSearch: () => void
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-4 py-4 text-center">
      {props.done ? (
        <p className="text-[12px] text-ink-3">Searched all of {props.mailbox} on iCloud.</p>
      ) : (
        <Button icon={<Search size={13} />} onClick={props.onSearch} disabled={props.busy}>
          {props.busy ? 'Searching iCloud…' : `Search all of ${props.mailbox} on iCloud`}
        </Button>
      )}
      {props.error && <p className="text-[12px] text-danger">{props.error}</p>}
    </div>
  )
}

function Divider() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px bg-sep" />
}

function ToolButton(props: {
  label: string
  shortcut?: string
  disabled?: boolean
  pressed?: boolean
  onClick: () => void
  children: ReactNode
}) {
  const title = props.shortcut ? `${props.label} (${props.shortcut})` : props.label
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={props.label}
      aria-pressed={props.pressed}
      title={title}
      className="no-drag flex size-8 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent"
    >
      {props.children}
    </button>
  )
}
