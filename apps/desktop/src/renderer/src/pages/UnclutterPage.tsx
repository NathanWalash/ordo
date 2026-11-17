import { useCallback, useEffect, useMemo, useState } from 'react'
import { Cpu, RefreshCw, ScanSearch } from 'lucide-react'
import { analyseSenders, type CategorisedSender } from '@ordo/mail-core'
import type { AccountStatus, ScanProgress } from '@ordo/shared'
import { Button } from '../components/Button'
import { EmptyState } from '../components/EmptyState'
import { SenderTable } from '../components/SenderTable'
import { SAMPLE_CATEGORY, sampleHeaders } from './sampleData'

interface Props {
  account: AccountStatus | null
  onConnect: () => void
  onScanned: () => void
}

export function UnclutterPage({ account, onConnect, onScanned }: Props) {
  if (!account?.connected) return <SamplePreview onConnect={onConnect} />
  return <LiveUnclutter account={account} onScanned={onScanned} />
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
}: {
  account: Extract<AccountStatus, { connected: true }>
  onScanned: () => void
}) {
  const [senders, setSenders] = useState<CategorisedSender[] | null>(null)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => setSenders(await window.ordo.senders.list()), [])
  useEffect(() => {
    let live = true
    void window.ordo.senders.list().then((s) => live && setSenders(s))
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

  if (progress) return <Scanning progress={progress} />
  if (senders === null) return null
  if (senders.length === 0)
    return (
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
  return (
    <SenderTable
      senders={senders}
      banner={error && <div className="mb-3 rounded-md bg-hover px-3 py-2 text-danger">{error}</div>}
      actions={
        <Button
          icon={<RefreshCw size={13} />}
          onClick={() => void scan()}
          title={lastScanned(account.lastScan)}
        >
          Scan again
        </Button>
      }
    />
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
