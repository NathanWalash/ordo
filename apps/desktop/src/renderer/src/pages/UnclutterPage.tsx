import { useCallback, useEffect, useMemo, useState } from 'react'
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
  const [reviewing, setReviewing] = useState<CategorisedSender[] | null>(null)
  // Bumped after a clean-up so the table starts with nothing selected.
  const [generation, setGeneration] = useState(0)

  const load = useCallback(async () => setSenders(await window.ordo.senders.list()), [])
  useEffect(() => {
    let live = true
    void window.ordo.senders.list().then((s) => live && setSenders(s))
    void window.ordo.settings.get().then((s) => live && setAi(s.ai))
    return () => {
      live = false
    }
  }, [])

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

  const sheet = reviewing && (
    <ReviewSheet
      senders={reviewing}
      onClose={() => setReviewing(null)}
      onChanged={() => {
        setGeneration((g) => g + 1)
        void load()
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
        onReview={setReviewing}
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
        : 'Connecting to iCloud…'
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
