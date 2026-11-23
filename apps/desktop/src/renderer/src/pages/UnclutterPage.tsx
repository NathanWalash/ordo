import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Cpu, RefreshCw, ScanSearch, Sparkles } from 'lucide-react'
import { analyseSenders, type CategorisedSender } from '@ordo/mail-core'
import {
  AI_PROVIDERS,
  type AccountStatus,
  type AiSettings,
  type AiSortProgress,
  type ScanProgress,
} from '@ordo/shared'
import { Button } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import { ReviewSheet } from '../components/ReviewSheet'
import { SenderTable } from '../components/SenderTable'
import { SAMPLE_CATEGORY, sampleHeaders } from './sampleData'

interface Props {
  account: AccountStatus | null
  onConnect: () => void
  onScanned: () => void
  /** Open Settings, where AI sorting is set up. */
  onOpenSettings?: () => void
}

export function UnclutterPage({ account, onConnect, onScanned, onOpenSettings }: Props) {
  if (!account?.connected) return <SamplePreview onConnect={onConnect} />
  return <LiveUnclutter account={account} onScanned={onScanned} onOpenSettings={onOpenSettings} />
}

function SamplePreview({ onConnect }: { onConnect: () => void }) {
  const senders = useMemo(
    () =>
      analyseSenders(sampleHeaders(), new Set()).map((s) => ({
        ...s,
        category: SAMPLE_CATEGORY.get(s.address) ?? s.category,
      })),
    [],
  )
  return (
    <SenderTable
      senders={senders}
      banner={
        <div className="mb-3 flex items-center justify-between gap-3 rounded-md bg-hover px-3 py-2 text-ink-2">
          Sample data. Connect your iCloud account to scan your own inbox.
          <Button variant="primary" onClick={onConnect}>
            Connect iCloud
          </Button>
        </div>
      }
    />
  )
}

function LiveUnclutter({
  account,
  onScanned,
  onOpenSettings,
}: {
  account: Extract<AccountStatus, { connected: true }>
  onScanned: () => void
  onOpenSettings?: () => void
}) {
  const [senders, setSenders] = useState<CategorisedSender[] | null>(null)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ai, setAi] = useState<AiSettings | null>(null)
  const [sorting, setSorting] = useState<AiSortProgress | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [reviewing, setReviewing] = useState<{
    senders: CategorisedSender[]
    /** `unsubscribe`: one sender's Unsubscribe button rather than Review and clear. */
    purpose: 'clear' | 'unsubscribe'
  } | null>(null)
  // Bumped after a clean-up so the table starts with nothing selected.
  const [generation, setGeneration] = useState(0)

  // Several accounts: every account's senders together, or one account's.
  const several = account.accounts.length > 1
  const [scope, setScope] = useState<string>('all')
  const accountOf = useCallback((id: string) => account.accounts.find((a) => a.id === id), [account.accounts])
  const load = useCallback(
    async () => setSenders(await window.ordo.senders.list({ account: scope })),
    [scope],
  )
  useEffect(() => {
    let live = true
    void window.ordo.settings.get().then((s) => live && setAi(s.ai))
    return () => {
      live = false
    }
  }, [])
  // The senders again whenever the account shown changes.
  useEffect(() => {
    let live = true
    void window.ordo.senders.list({ account: scope }).then((s) => live && setSenders(s))
    return () => {
      live = false
    }
  }, [scope])

  const scan = async () => {
    setError(null)
    setProgress({ phase: 'inbox', checked: 0, total: 0 })
    const off = window.ordo.scan.onProgress(setProgress)
    try {
      const res = await window.ordo.scan.start()
      if (!res.ok) setError(res.message)
      await load()
      onScanned()
    } finally {
      off()
      setProgress(null)
    }
  }

  const aiReady = ai !== null && ai.provider !== 'none' && ai.sortSenders
  const aiName = AI_PROVIDERS.find((p) => p.id === ai?.provider)?.label ?? 'AI'
  const unsure = senders?.filter((s) => s.category === 'uncategorised').length ?? 0

  const sortWithAi = async () => {
    if (!aiReady) return onOpenSettings?.()
    setError(null)
    setNotice(null)
    setSorting({ done: 0, total: unsure })
    const off = window.ordo.ai.onProgress(setSorting)
    try {
      const res = await window.ordo.ai.categoriseSenders()
      if (!res.ok) setError(res.message)
      else {
        const parts = [
          res.changed
            ? `${aiName} sorted ${res.changed} ${res.changed === 1 ? 'sender' : 'senders'} out of Other.`
            : `${aiName} left everything in Other where it was.`,
        ]
        if (res.failed) parts.push(`${res.failed} couldn't be sorted.`)
        setNotice([...parts, ...res.errors].join(' '))
      }
      await load()
    } finally {
      off()
      setSorting(null)
    }
  }

  // The reload after a change, so focus waits for the row to show what happened.
  const reloading = useRef<Promise<void> | null>(null)
  const closeSheet = () => {
    const unsubscribed = reviewing?.purpose === 'unsubscribe' ? reviewing.senders[0]?.address : undefined
    setReviewing(null)
    // Back to that sender's row: its Unsubscribe button, or what replaced it.
    if (unsubscribed)
      void (reloading.current ?? Promise.resolve()).then(() =>
        requestAnimationFrame(() =>
          document
            .querySelector<HTMLElement>(`[data-unsubscribe-for="${CSS.escape(unsubscribed)}"]`)
            ?.focus(),
        ),
      )
  }

  const sheet = reviewing && (
    <ReviewSheet
      senders={reviewing.senders}
      purpose={reviewing.purpose}
      account={scope}
      onClose={closeSheet}
      onChanged={() => {
        // A clean-up starts the table afresh; unsubscribing from one sender keeps what's selected.
        if (reviewing.purpose === 'clear') setGeneration((g) => g + 1)
        reloading.current = load()
      }}
    />
  )

  let content
  if (progress) content = <Scanning progress={progress} />
  else if (senders === null) content = null
  else if (senders.length === 0)
    content = (
      <EmptyState
        icon={<ScanSearch size={40} strokeWidth={1.5} />}
        title="Scan your inbox"
        body={
          error ??
          "Ordo reads the sender, subject and list headers of each email, never the contents, and doesn't change anything."
        }
        action={
          <Button variant="primary" onClick={() => void scan()}>
            Scan inbox
          </Button>
        }
      />
    )
  else
    content = (
      <SenderTable
        key={generation}
        senders={senders}
        onReview={(chosen) => setReviewing({ senders: chosen, purpose: 'clear' })}
        onUnsubscribe={(s) => setReviewing({ senders: [s], purpose: 'unsubscribe' })}
        accountOf={several && scope === 'all' ? accountOf : undefined}
        banner={
          sorting ? (
            <div
              className="mb-3 flex items-center justify-between gap-3 rounded-md bg-hover px-3 py-2 text-ink-2"
              aria-live="polite"
            >
              <span className="flex items-center gap-1.5">
                <Sparkles size={13} /> Sorting with {aiName}… {sorting.done} of {sorting.total}
              </span>
              <Button onClick={() => void window.ordo.ai.stop()}>Stop</Button>
            </div>
          ) : error ? (
            <div className="mb-3 rounded-md bg-hover px-3 py-2 text-danger">{error}</div>
          ) : notice ? (
            <div className="mb-3 rounded-md bg-hover px-3 py-2 text-ink-2" role="status">
              {notice}
            </div>
          ) : null
        }
        actions={
          <>
            {several && (
              <select
                aria-label="Account"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                className="h-7 rounded-md border border-sep bg-field px-1.5 text-[13px] text-ink outline-none focus:border-accent focus:ring-1 focus:ring-accent"
              >
                <option value="all">All accounts</option>
                {account.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            )}
            {(unsure > 0 || aiReady) && (
              <Button
                icon={<Sparkles size={13} />}
                disabled={Boolean(sorting) || (aiReady && unsure === 0)}
                onClick={() => void sortWithAi()}
                title={
                  aiReady
                    ? `Ask ${aiName} to sort the ${unsure} ${unsure === 1 ? 'sender' : 'senders'} in Other. It sees names, addresses and subject lines, never message bodies.`
                    : 'Set up a model in Settings → AI'
                }
              >
                Sort with AI
              </Button>
            )}
            <Button
              icon={<RefreshCw size={13} />}
              onClick={() => void scan()}
              title={lastScanned(account.lastScan)}
            >
              Scan again
            </Button>
          </>
        }
      />
    )
  return (
    <>
      {content}
      {sheet}
    </>
  )
}

function Scanning({ progress }: { progress: ScanProgress }) {
  const pct = progress.total ? Math.min(100, (progress.checked / progress.total) * 100) : 0
  const line =
    progress.phase === 'sent'
      ? 'Checking who you’ve written to, so people are never cleared by mistake.'
      : progress.total
        ? `${progress.checked.toLocaleString()} of ${progress.total.toLocaleString()} emails checked. Ordo only reads headers; nothing in your mailbox changes.`
        : 'Connecting…'
  return (
    <div className="px-6 pt-5" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[20px] font-semibold tracking-tight">Scanning your inbox</h2>
        <span className="flex items-center gap-1.5 text-[12px] text-ink-2">
          <Cpu size={14} /> Sorting with rules
        </span>
      </div>
      <div
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-selected"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2.5 text-[12px] text-ink-2">{line}</p>
      <div className="mt-4">
        <Button onClick={() => void window.ordo.scan.stop()}>Stop scan</Button>
      </div>
    </div>
  )
}

function lastScanned(iso: string | null) {
  return iso ? `Last scanned ${new Date(iso).toLocaleString()}` : 'Not scanned yet'
}
