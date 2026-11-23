import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
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
  Undo2,
  X,
} from 'lucide-react'
import {
  bodyText,
  checkLink,
  forwardBody,
  forwardSubject,
  formatAddressList,
  ownAddresses,
  parseMailtoLink,
  PROVIDERS,
  replyBody,
  replyRecipients,
  replySubject,
  type CheckedLink,
} from '@ordo/mail-core'
import type {
  AccountStatus,
  MailAccount,
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
import { ALL, mailboxName, MailboxList, type MailView } from '../components/mail/MailboxList'
import { keyOf, MessageList } from '../components/mail/MessageList'
import { Reader } from '../components/mail/Reader'
import { ShortcutsSheet } from '../components/mail/ShortcutsSheet'

const INBOX = 'INBOX'
/** Messages per page in the list; the main process returns at most 500 at a time. */
const PAGE = 200
const CHUNK = 500
/** Check for new mail this often while Mail is open. */
const POLL_MS = 5 * 60_000
/** Below this window width the folder list becomes a rail of icons. */
const COMPACT_WIDTH = 1100

interface Props {
  account: AccountStatus | null
  onConnect: () => void
  /** Show a different title in the toolbar (the mailbox), or null for the default. */
  onTitle: (title: string | null) => void
  /** Bumped when the assistant changed mail: reload what's on screen, keeping the open folder. */
  changed?: number
}

export function MailPage({ account, onConnect, onTitle, changed = 0 }: Props) {
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
  return (
    <MailClient
      key={account.accounts.map((a) => a.id).join()}
      accounts={account.accounts}
      onTitle={onTitle}
      changed={changed}
    />
  )
}

type Opened = { key: string; message?: MessageContent; error?: string }
type Toast = { text: string; undoId?: number; error?: boolean }
type Filter = 'all' | 'unread'
type Page = { total: number; messages: MessageSummary[] }

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
] as const

const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))

const timeNow = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth)
  useEffect(() => {
    const on = () => setWidth(window.innerWidth)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return width
}

/** The first view: every account's inbox together (with one account, its inbox). */
const startView = (accounts: MailAccount[]): MailView => ({
  account: accounts.length > 1 ? ALL : (accounts[0]?.id ?? ALL),
  mailbox: INBOX,
})

function MailClient({
  accounts,
  onTitle,
  changed,
}: {
  accounts: MailAccount[]
  onTitle: (t: string | null) => void
  changed: number
}) {
  const several = accounts.length > 1
  /** Each account's folders, by account id. */
  const [boxes, setBoxes] = useState<Record<string, MailboxInfo[]>>({})
  const [view, setView] = useState<MailView>(() => startView(accounts))
  const current = view.mailbox
  /** Accounts whose last check failed, and why. */
  const [accountProblems, setAccountProblems] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState<Filter>('all')
  const [list, setList] = useState<Page | null>(null)
  const [selected, setSelected] = useState<MessageSummary | null>(null)
  const [opened, setOpened] = useState<Opened | null>(null)
  const [openAttempt, setOpenAttempt] = useState(0)
  const [slow, setSlow] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [progress, setProgress] = useState<MailRefreshProgress | null>(null)
  const [problem, setProblem] = useState<{ text: string; at: Date } | null>(null)
  const [checkedAt, setCheckedAt] = useState<Date | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<MessageSummary[] | null>(null)
  const [server, setServer] = useState<{ busy: boolean; done: boolean; error?: string }>({
    busy: false,
    done: false,
  })
  const [toast, setToast] = useState<Toast | null>(null)
  const [compose, setCompose] = useState<ComposeDraft | null>(null)
  const [link, setLink] = useState<CheckedLink | null>(null)
  const [showKeys, setShowKeys] = useState(false)
  const compact = useWindowWidth() < COMPACT_WIDTH
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const readerRef = useRef<HTMLElement>(null)
  // What's on screen, for async work and the poll, which outlive the render that started them.
  const onScreen = useRef({ view, filter, shown: 0, query })
  useEffect(() => {
    onScreen.current = { view, filter, shown: list?.messages.length ?? 0, query }
  }, [view, filter, list, query])
  const loadingMore = useRef(false)
  const moving = useRef(new Set<string>())

  const accountById = useCallback((id: string) => accounts.find((a) => a.id === id), [accounts])
  const boxesOf = useCallback((account: string) => boxes[account] ?? [], [boxes])
  const unified = view.account === ALL
  const box = unified ? undefined : boxesOf(view.account).find((b) => b.path === current)
  const role = box?.role ?? (current === INBOX ? 'inbox' : null)
  const boxName = unified ? 'All Inboxes' : box ? mailboxName(box) : current === INBOX ? 'Inbox' : current
  const viewName = several && !unified ? `${boxName} – ${accountById(view.account)?.label ?? ''}` : boxName
  const nameOf = useCallback(
    (m: MessageSummary) => {
      const b = boxesOf(m.account).find((x) => x.path === m.mailbox)
      return b ? mailboxName(b) : m.mailbox
    },
    [boxesOf],
  )
  const roleOf = (account: string, path: string) =>
    boxesOf(account).find((b) => b.path === path)?.role ?? (path === INBOX ? 'inbox' : null)
  /** Each row's account, when there's more than one to tell apart. */
  const accountOf = several ? (m: MessageSummary) => accountById(m.account) : undefined
  /** Load every account's folders. */
  const loadBoxes = useCallback(async () => {
    const all = await Promise.all(
      accounts.map(async (a) => [a.id, await window.ordo.mail.mailboxes({ account: a.id })] as const),
    )
    return Object.fromEntries(all)
  }, [accounts])

  useEffect(() => {
    onTitle(viewName)
  }, [viewName, onTitle])
  useEffect(() => () => onTitle(null), [onTitle])

  /**
   * Read the folder list and the messages from the cache (no network): at least the first page,
   * or as many as are already shown, in chunks the main process accepts.
   */
  const load = useCallback(async () => {
    const { view: v, filter: f, shown } = onScreen.current
    const want = Math.max(PAGE, shown)
    const unread = f === 'unread' || undefined
    const pages: MessageSummary[] = []
    let total = 0
    for (let offset = 0; offset < want; offset += CHUNK) {
      const p = await window.ordo.mail.messages({
        account: v.account,
        mailbox: v.mailbox,
        limit: Math.min(CHUNK, want - offset),
        offset,
        unread,
      })
      total = p.total
      pages.push(...p.messages)
      if (p.messages.length < Math.min(CHUNK, want - offset)) break
    }
    const b = await loadBoxes()
    if (v !== onScreen.current.view || f !== onScreen.current.filter) return null
    setBoxes(b)
    setList({ total, messages: pages })
    return pages
  }, [loadBoxes])

  // The assistant moved, flagged or marked mail, or saved a draft: show it, in the same folder.
  // The selection becomes its fresh row (so its flag and read state are current), or goes if the
  // message moved away. A search on screen runs again. With Unread on, a message the assistant just
  // marked read stays open, as it does when you open it yourself.
  useEffect(() => {
    if (!changed) return
    let live = true
    void (async () => {
      const rows = await load()
      if (!live || !rows) return
      const { query: q, filter: f, view: v } = onScreen.current
      let found = rows
      if (q.trim()) {
        found = await window.ordo.mail.search({ query: q.trim(), limit: 200 })
        if (!live) return
        setResults(found)
      }
      const all =
        f === 'unread' && !q.trim()
          ? (await window.ordo.mail.messages({ account: v.account, mailbox: v.mailbox, limit: CHUNK }))
              .messages
          : []
      if (!live) return
      setSelected((s) => {
        if (!s) return s
        const same = (r: MessageSummary) => keyOf(r) === keyOf(s)
        return found.find(same) ?? all.find(same) ?? null
      })
    })()
    return () => {
      live = false
    }
  }, [changed, load])

  /** The next page, added to the end of the list. */
  const loadMore = async () => {
    const l = list
    if (!l || loadingMore.current || l.messages.length >= l.total) return
    loadingMore.current = true
    const { view: v, filter: f } = onScreen.current
    try {
      const p = await window.ordo.mail.messages({
        account: v.account,
        mailbox: v.mailbox,
        limit: PAGE,
        offset: l.messages.length,
        unread: f === 'unread' || undefined,
      })
      if (v !== onScreen.current.view || f !== onScreen.current.filter) return
      setList((cur) => {
        if (!cur) return cur
        const seen = new Set(cur.messages.map(keyOf))
        const added = p.messages.filter((m) => !seen.has(keyOf(m)))
        // Nothing new keeps the same rows, so the list doesn't ask for the same page again.
        if (!added.length) return cur.total === p.total ? cur : { total: p.total, messages: cur.messages }
        return { total: p.total, messages: [...cur.messages, ...added] }
      })
    } finally {
      loadingMore.current = false
    }
  }

  /**
   * Fetch new mail for a folder from the server, then show it. All Inboxes checks every account at
   * once; one that fails is named in the problem, and the others still show their new mail. The
   * timer passes `auto`, so accounts backing off after a failure aren't tried again each time.
   */
  const refresh = useCallback(
    async (v: MailView, auto = false) => {
      setRefreshing(true)
      // Progress from every account being checked, added up.
      const each = new Map<string, MailRefreshProgress>()
      const off = window.ordo.mail.onRefreshProgress((p) => {
        if (p.mailbox !== v.mailbox || (v.account !== ALL && p.account !== v.account)) return
        each.set(p.account, p)
        const all = [...each.values()]
        setProgress({
          account: v.account,
          mailbox: v.mailbox,
          checked: all.reduce((n, x) => n + x.checked, 0),
          total: all.reduce((n, x) => n + x.total, 0),
        })
      })
      try {
        const r = await window.ordo.mail.refresh({ account: v.account, mailbox: v.mailbox }, { auto })
        const label = (id: string) => accountById(id)?.label ?? 'An account'
        if (r.ok) {
          // Accounts skipped while backing off keep the problem they had.
          const failed = (r.failed ?? []).filter((f) => f.error !== 'busy')
          setAccountProblems((had) => {
            const next: Record<string, string> = {}
            for (const f of r.failed ?? [])
              if (f.error === 'busy' && had[f.account]) next[f.account] = had[f.account]!
            for (const f of failed) next[f.account] = f.message
            return next
          })
          const text = failed
            .map((f) => (several ? `${label(f.account)}: ${f.message}` : f.message))
            .join(' ')
          setProblem((p) => (!text ? null : p?.text === text ? p : { text, at: new Date() }))
          setCheckedAt(new Date())
          if (r.added > 0 && v === onScreen.current.view)
            setAnnouncement(`${r.added} new ${r.added === 1 ? 'message' : 'messages'}`)
        } else if (r.error !== 'busy')
          // Only a new problem is announced again.
          setProblem((p) => (p?.text === r.message ? p : { text: r.message, at: new Date() }))
        await load()
      } finally {
        off()
        setRefreshing(false)
        setProgress(null)
      }
    },
    [load, accountById, several],
  )
  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  // Show the cache straight away whenever the folder or filter changes.
  useEffect(() => {
    const t = setTimeout(() => void load(), 0)
    return () => clearTimeout(t)
  }, [load, view, filter])

  // Then check the server: on opening a folder, and every few minutes (always with what's on
  // screen now, not what was there when the timer started).
  useEffect(() => {
    const first = setTimeout(() => void refreshRef.current(view), 0)
    const every = setInterval(() => void refreshRef.current(onScreen.current.view, true), POLL_MS)
    return () => {
      clearTimeout(first)
      clearInterval(every)
    }
  }, [view])

  const changeQuery = (q: string) => {
    // Starting a search clears the selection, so the reading pane doesn't show a non-result.
    if (q.trim() && !query.trim()) setSelected(null)
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
    const { account, mailbox } = ms[0]!
    const same = ms.filter((m) => m.mailbox === mailbox && m.account === account)
    patch(new Set(same.map(keyOf)), flags)
    const r = await window.ordo.mail.setFlags({ account, mailbox, uids: same.map((m) => m.uid), ...flags })
    if (!r.ok) {
      setToast({ text: r.message, error: true })
      await load()
    } else setBoxes(await loadBoxes())
  }

  // Open the selected message, and mark it read. What's on screen is `opened` only while its
  // key matches the selection, so there's nothing to reset when the selection changes.
  useEffect(() => {
    if (!selected) return
    const key = keyOf(selected)
    let live = true
    // "Opening…" only if it takes a moment.
    const t = setTimeout(() => live && setSlow(true), 300)
    void window.ordo.mail
      .open({ account: selected.account, mailbox: selected.mailbox, uid: selected.uid })
      .then((r) => {
        if (!live) return
        setSlow(false)
        setOpened(r.ok ? { key, message: r.message } : { key, error: r.message })
        if (r.ok && !r.message.seen) void setFlags([selected], { seen: true })
      })
    return () => {
      live = false
      clearTimeout(t)
    }
    // Opening depends on which message (and Try again), not on its flags changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, openAttempt])

  const move = async (to: MoveTarget) => {
    const m = selected
    if (!m) return
    // A key held down sends the same move again and again: once is enough.
    const key = keyOf(m)
    if (moving.current.has(key)) return
    moving.current.add(key)
    try {
      const i = visible.findIndex((x) => keyOf(x) === key)
      const next = visible[i + 1] ?? visible[i - 1] ?? null
      const r = await window.ordo.mail.move({ account: m.account, mailbox: m.mailbox, uids: [m.uid], to })
      if (!r.ok) {
        setToast({ text: r.message, error: true })
        return
      }
      patch(new Set([key]), null)
      setSelected(next)
      // Gmail has no Archive folder: archiving there moves to All Mail.
      const gmailArchive = to === 'archive' && !boxesOf(m.account).some((b) => b.role === 'archive')
      const where = {
        archive: gmailArchive ? 'All Mail' : 'Archive',
        trash: 'Bin',
        inbox: 'Inbox',
        junk: 'Junk',
      }[to]
      setToast({ text: `Moved to ${where}.`, ...(r.undoId !== null && { undoId: r.undoId }) })
      setBoxes(await loadBoxes())
    } finally {
      moving.current.delete(key)
    }
  }

  const undo = async () => {
    if (!toast?.undoId) return
    const id = toast.undoId
    setToast({ text: 'Moving back…' })
    const r = await window.ordo.mail.undoMove(id)
    setToast(r.ok ? { text: 'Moved back.' } : { text: r.message, error: true })
    await load()
  }

  // Errors stay until dismissed; other notes go after a while.
  useEffect(() => {
    if (!toast || toast.error) return
    const t = setTimeout(() => setToast(null), toast.undoId ? 12_000 : 5_000)
    return () => clearTimeout(t)
  }, [toast])

  const message = opened?.message && opened.key === selectedKey ? opened.message : null

  /** The account the open message is in. */
  const messageAccount = selected?.account ?? accounts[0]?.id ?? ''

  const startReply = (all: boolean) => {
    if (!message) return
    // Every account's addresses: Reply all never copies in your other accounts.
    const r = replyRecipients(message, ownAddresses(...accounts.map((a) => a.email)), all, {
      inSent: roleOf(messageAccount, message.mailbox) === 'sent',
    })
    setCompose({
      title: all ? 'Reply all' : 'Reply',
      // A reply always goes from the account the message arrived in.
      account: messageAccount,
      lockAccount: true,
      to: formatAddressList(r.to),
      cc: formatAddressList(r.cc),
      bcc: '',
      subject: replySubject(message.subject),
      body: replyBody(message, bodyText(message), fullDate(message.date)),
      replyTo: { account: messageAccount, mailbox: message.mailbox, uid: message.uid },
      focusBody: true,
    })
  }

  const startForward = () => {
    if (!message) return
    setCompose({
      title: 'Forward',
      account: messageAccount,
      to: '',
      cc: '',
      bcc: '',
      subject: forwardSubject(message.subject),
      body: forwardBody(message, bodyText(message), fullDate(message.date)),
      forward: {
        ref: { account: messageAccount, mailbox: message.mailbox, uid: message.uid },
        attachments: message.attachments.filter((a) => !a.inline),
      },
    })
  }

  const editDraft = () => {
    if (!message) return
    const ref = { account: messageAccount, mailbox: message.mailbox, uid: message.uid }
    const files = message.attachments.filter((a) => !a.inline)
    setCompose({
      title: 'Draft',
      // A draft is finished from the account it was saved in.
      account: messageAccount,
      lockAccount: true,
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

  /** A new message starts from the account you're looking at (the first, in All Inboxes). */
  const viewAccount = unified ? (accounts[0]?.id ?? '') : view.account
  const newMessage = () =>
    setCompose({ title: 'New message', account: viewAccount, to: '', cc: '', bcc: '', subject: '', body: '' })

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
    setCompose({ title: 'New message', bcc: '', ...draft, account: onScreen.current.view.account })
  }, [])

  /** Search the open folder on the server: in All Inboxes, every account's inbox. */
  const searchServer = async () => {
    const q = query.trim()
    if (!q) return
    const v = view
    setServer({ busy: true, done: false })
    const ids = v.account === ALL ? accounts.map((a) => a.id) : [v.account]
    const all = await Promise.all(
      ids.map((account) =>
        window.ordo.mail.searchServer({ account, query: q, mailbox: v.mailbox, limit: 100 }),
      ),
    )
    // You've typed something else, or left the folder, since: these results are for nothing on screen.
    if (onScreen.current.query.trim() !== q || onScreen.current.view !== v) return
    const failed = all.find((r) => !r.ok)
    const found = all.flatMap((r) => (r.ok ? r.messages : []))
    if (failed && !failed.ok && found.length === 0)
      return setServer({ busy: false, done: false, error: failed.message })
    setResults((local) => {
      const seen = new Set((local ?? []).map(keyOf))
      return [...(local ?? []), ...found.filter((m) => !seen.has(keyOf(m)))].sort(
        (a, b) => b.date.getTime() - a.date.getTime(),
      )
    })
    setServer({ busy: false, done: true, ...(failed && !failed.ok && { error: failed.message }) })
  }

  const selectMailbox = (next: MailView) => {
    if (next.account === view.account && next.mailbox === view.mailbox) return void refresh(view)
    setView(next)
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

  const sheetOpen = compose !== null || link !== null || showKeys
  const actions = {
    move,
    undo,
    startReply,
    startForward,
    newMessage,
    step,
    toggleRead: () => selected && void setFlags([selected], { seen: !selected.seen }),
    toggleFlag: () => selected && void setFlags([selected], { flagged: !selected.flagged }),
    search: () => searchRef.current?.focus(),
    keys: () => setShowKeys(true),
  }
  const actionsRef = useRef(actions)
  useEffect(() => {
    actionsRef.current = actions
  })

  /**
   * Mail's own chords (⌘R, ⇧⌘R…) work wherever focus is, except while typing. Single keys
   * (Gmail's) only work in the message list or a message, so they never surprise anyone typing
   * elsewhere or using a screen reader (WCAG 2.1.4).
   */
  const handleKey = useCallback(
    (
      e: Pick<
        KeyboardEvent,
        'key' | 'metaKey' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'target' | 'preventDefault'
      >,
      singleKeys: boolean,
    ) => {
      if (sheetOpen || e.altKey) return false
      const a = actionsRef.current
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      let action: (() => void) | undefined
      if (e.metaKey) {
        if (e.ctrlKey) action = key === 'a' ? () => void a.move('archive') : undefined
        else if (key === 'n') action = a.newMessage
        else if (key === 'f' && !e.shiftKey) action = a.search
        else if (isTyping(e.target)) action = undefined
        else if (key === 'r') action = () => a.startReply(e.shiftKey)
        else if (key === 'f') action = a.startForward
        else if (key === 'u' && e.shiftKey) action = a.toggleRead
        else if (key === 'l' && e.shiftKey) action = a.toggleFlag
        else if (key === 'z' && !e.shiftKey) action = () => void a.undo()
        else if (key === 'Backspace') action = () => void a.move('trash')
      } else if (singleKeys && !e.ctrlKey && !isTyping(e.target)) {
        const single: Record<string, () => void> = {
          c: a.newMessage,
          '/': a.search,
          r: () => a.startReply(false),
          a: () => a.startReply(true),
          f: a.startForward,
          e: () => void a.move('archive'),
          '#': () => void a.move('trash'),
          Delete: () => void a.move('trash'),
          Backspace: () => void a.move('trash'),
          u: a.toggleRead,
          s: a.toggleFlag,
          z: () => void a.undo(),
          '?': a.keys,
        }
        action = single[key]
      }
      if (!action) return false
      e.preventDefault()
      action()
      return true
    },
    [sheetOpen],
  )

  // Chords from anywhere in the window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !e.metaKey) return
      handleKey(e, false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleKey])

  // Single keys from the message list and the reading pane (including the message frame).
  const onPaneKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (!e.metaKey) handleKey(e.nativeEvent, true)
  }
  const onFrameKey = useCallback((e: KeyboardEvent) => void handleKey(e, true), [handleKey])

  /** The selected message's account has a folder for this (Gmail's All Mail counts as Archive). */
  const hasRole = (r: MoveTarget) =>
    r === 'inbox' ||
    boxesOf(messageAccount).some((b) => b.role === r || (r === 'archive' && b.role === 'all'))
  const canAct = selected !== null
  const inDrafts =
    (selected ? roleOf(selected.account, selected.mailbox) === 'drafts' : role === 'drafts') ||
    (message?.draft ?? false)
  const searching = results !== null
  const emptyFolder = !searching && list !== null && list.messages.length === 0

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
    : problem
      ? `Couldn’t check at ${timeNow(problem.at)}. Showing downloaded mail.`
      : checkedAt
        ? `Updated ${timeNow(checkedAt)}`
        : several
          ? `${accounts.length} accounts`
          : (accounts[0]?.email ?? '')

  const serverSearch = (
    <ServerSearch
      mailbox={boxName}
      where={unified ? 'every account’s server' : serviceName(accountById(view.account))}
      busy={server.busy}
      done={server.done}
      error={server.error}
      onSearch={() => void searchServer()}
    />
  )

  return (
    <div className="relative flex h-full min-h-0">
      <ToolbarActions>
        <div role="group" aria-label="Mail" className="flex min-w-0 items-center gap-1">
          <ToolButton label="New message" keys="⌘N" aria="Meta+N" onClick={newMessage}>
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
              keys="⌃⌘A"
              aria="Control+Meta+A"
              disabled={!canAct || !hasRole('archive')}
              onClick={() => void move('archive')}
            >
              <Archive size={16} />
            </ToolButton>
          )}
          {role !== 'trash' && (
            <ToolButton
              label="Move to Bin"
              keys="⌘⌫"
              aria="Meta+Backspace"
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
          <ToolButton
            label="Reply"
            keys="⌘R"
            aria="Meta+R"
            disabled={!message}
            onClick={() => startReply(false)}
          >
            <Reply size={16} />
          </ToolButton>
          <ToolButton
            label="Reply all"
            keys="⇧⌘R"
            aria="Shift+Meta+R"
            disabled={!message}
            onClick={() => startReply(true)}
          >
            <ReplyAll size={16} />
          </ToolButton>
          <ToolButton
            label="Forward"
            keys="⇧⌘F"
            aria="Shift+Meta+F"
            disabled={!message}
            onClick={startForward}
          >
            <Forward size={16} />
          </ToolButton>
          <Divider />
          <ToolButton
            label="Flag"
            keys="⇧⌘L"
            aria="Shift+Meta+L"
            pressed={selected?.flagged ?? false}
            disabled={!canAct}
            onClick={actions.toggleFlag}
          >
            <Flag size={16} className={selected?.flagged ? 'fill-[#ff9500] text-[#ff9500]' : ''} />
          </ToolButton>
          <ToolButton
            label={selected && !selected.seen ? 'Mark as read' : 'Mark as unread'}
            keys="⇧⌘U"
            aria="Shift+Meta+U"
            disabled={!canAct}
            onClick={actions.toggleRead}
          >
            {selected && !selected.seen ? <MailOpen size={16} /> : <Mail size={16} />}
          </ToolButton>
          <div className="no-drag relative ml-2 w-[200px] min-w-[110px] shrink">
            <Search
              size={13}
              className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-ink-2"
            />
            <input
              ref={searchRef}
              type="search"
              role="searchbox"
              aria-label="Search mail"
              aria-keyshortcuts="Meta+F"
              placeholder="Search"
              title="Search (⌘F)"
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
              className="h-7 w-full rounded-md border border-sep bg-field pr-6 pl-7 text-[13px] text-ink outline-none select-text placeholder:text-ink-2 focus:border-accent focus:ring-1 focus:ring-accent [&::-webkit-search-cancel-button]:hidden"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => changeQuery('')}
                className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded text-ink-2 hover:text-ink"
              >
                <X size={13} />
              </button>
            )}
          </div>
        </div>
      </ToolbarActions>

      <MailboxList
        accounts={accounts}
        mailboxes={boxes}
        current={view}
        onSelect={selectMailbox}
        onRefresh={() => void refresh(view)}
        refreshing={refreshing}
        compact={compact}
        footer={footer}
        problems={accountProblems}
      />

      <section
        ref={listRef}
        aria-label="Messages"
        className={`flex shrink-0 flex-col border-r border-sep ${compact ? 'w-[270px]' : 'w-[320px]'}`}
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-sep px-4">
          <div className="min-w-0">
            <h2 className="truncate text-[13px] font-semibold">{listTitle}</h2>
            <p className="truncate text-[11px] text-ink-2">{countLine}</p>
          </div>
          {!searching && (
            <SegmentedControl label="Show" options={FILTERS} value={filter} onChange={setFilter} />
          )}
        </div>
        {problem && (
          <div className="mx-3 mt-2 flex items-center gap-2 rounded-md bg-hover px-3 py-2 text-[12px]">
            <p role="alert" className="min-w-0 flex-1 text-danger-text">
              {problem.text}
            </p>
            <Button onClick={() => void refresh(view)} disabled={refreshing} className="shrink-0">
              Try again
            </Button>
          </div>
        )}
        {firstSync ? (
          <FirstSync progress={progress} />
        ) : (
          <MessageList
            label={searching ? 'Search results' : `${viewName} messages`}
            messages={visible}
            selected={selectedKey}
            onSelect={setSelected}
            onKey={onPaneKey}
            showRecipients={!searching && (role === 'sent' || role === 'drafts')}
            showMailbox={searching ? nameOf : undefined}
            accountOf={unified || searching ? accountOf : undefined}
            onEndReached={() => {
              if (!searching) void loadMore()
            }}
            empty={
              list === null && !searching ? null : (
                <div className="flex flex-col items-center">
                  <p className="text-center text-[13px] text-ink-2">
                    {searching
                      ? 'Nothing found in downloaded mail.'
                      : filter === 'unread'
                        ? 'No unread messages.'
                        : refreshing
                          ? 'Checking for mail…'
                          : `Nothing in ${boxName}.`}
                  </p>
                  {searching && serverSearch}
                </div>
              )
            }
            footer={searching && serverSearch}
          />
        )}
      </section>

      <section
        ref={readerRef}
        aria-label="Reading pane"
        tabIndex={-1}
        onKeyDown={onPaneKey}
        className="relative min-w-0 flex-1 overflow-y-auto outline-none"
      >
        {!selected ? (
          emptyFolder || searching ? null : (
            <EmptyState
              icon={<Mail size={40} strokeWidth={1.5} />}
              title="No message selected"
              body="Choose a message to read it. Use the arrow keys to move through the list, and press ? for keyboard shortcuts."
            />
          )
        ) : opened?.key === selectedKey && opened.error ? (
          <EmptyState
            icon={<Mail size={40} strokeWidth={1.5} />}
            title="Couldn’t open this message"
            body={opened.error}
            action={<Button onClick={() => setOpenAttempt((n) => n + 1)}>Try again</Button>}
          />
        ) : message ? (
          <Reader
            key={selectedKey}
            message={message}
            isDraft={inDrafts}
            onLink={onLink}
            onEditDraft={editDraft}
            onFrameKey={onFrameKey}
          />
        ) : slow ? (
          <p className="p-6 text-[13px] text-ink-2">Opening…</p>
        ) : null}
      </section>

      {toast && !sheetOpen && (
        <div
          role={toast.error ? 'alert' : 'status'}
          className="absolute right-5 bottom-5 z-10 flex max-w-[420px] items-center gap-3 rounded-lg border border-sep bg-sheet py-1.5 pr-1.5 pl-4 text-[13px] shadow-[0_8px_24px_rgb(0_0_0/0.18)]"
        >
          <span className={`min-w-0 flex-1 ${toast.error ? 'text-danger-text' : ''}`}>{toast.text}</span>
          {toast.undoId ? (
            <Button icon={<Undo2 size={13} />} onClick={() => void undo()} title="Undo move (⌘Z)">
              Undo move
            </Button>
          ) : (
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setToast(null)}
              className="flex size-6 items-center justify-center rounded-full text-ink-2 hover:bg-hover hover:text-ink"
            >
              <X size={13} />
            </button>
          )}
        </div>
      )}
      <p role="status" className="sr-only">
        {announcement}
      </p>

      {compose && (
        <ComposeSheet
          accounts={accounts}
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
      {showKeys && <ShortcutsSheet onClose={() => setShowKeys(false)} />}
    </div>
  )
}

/** What the user calls an account's mail service: "iCloud", "Gmail", or its server. */
function serviceName(a: MailAccount | undefined): string {
  if (!a) return 'the server'
  return a.provider === 'other' ? a.imap.host : PROVIDERS[a.provider].name
}

function FirstSync({ progress }: { progress: MailRefreshProgress | null }) {
  const pct = progress?.total ? Math.min(100, (progress.checked / progress.total) * 100) : 0
  return (
    <div className="px-4 pt-5">
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
          ? `${progress.checked.toLocaleString()} of ${progress.total.toLocaleString()}. Ordo downloads the list of messages first. Each message downloads when you open it.`
          : 'Connecting…'}
      </p>
    </div>
  )
}

function ServerSearch(props: {
  mailbox: string
  /** Whose server: "iCloud", an account's name, or every account's. */
  where: string
  busy: boolean
  done: boolean
  error?: string
  onSearch: () => void
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 px-4 py-4 text-center">
      {props.done ? (
        <p className="text-[12px] text-ink-2">
          Searched all of {props.mailbox} on {props.where}.
        </p>
      ) : (
        <Button icon={<Search size={13} />} onClick={props.onSearch} disabled={props.busy}>
          {props.busy ? `Searching ${props.where}…` : `Search all of ${props.mailbox} on ${props.where}`}
        </Button>
      )}
      {props.error && <p className="text-[12px] text-danger-text">{props.error}</p>}
    </div>
  )
}

function Divider() {
  return <span aria-hidden="true" className="mx-1 h-5 w-px bg-sep" />
}

function ToolButton(props: {
  label: string
  /** The shortcut as Mac glyphs, for the tooltip. */
  keys?: string
  /** The shortcut for aria-keyshortcuts. */
  aria?: string
  disabled?: boolean
  pressed?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={props.label}
      aria-pressed={props.pressed}
      aria-keyshortcuts={props.aria}
      title={props.keys ? `${props.label} (${props.keys})` : props.label}
      className="no-drag flex size-8 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent"
    >
      {props.children}
    </button>
  )
}
