import { useEffect, useState } from 'react'
import { FileSpreadsheet, ShieldCheck } from 'lucide-react'
import { formatPence } from '@ordo/money-core'
import type { ColumnMapping, ImportOutcome, StatementFile, StatementPreview } from '@ordo/shared'
import { Button } from '../Button'
import { Sheet } from '../Sheet'
import { TextField } from '../TextField'
import { formatDate, Notice, Select } from './ui'

interface Props {
  file: StatementFile
  onClose: () => void
  onImported: (outcome: Extract<ImportOutcome, { ok: true }>) => void
}

/** Check what a statement contains, pick the columns if needed, name the account, import. */
export function ImportSheet({ file, onClose, onImported }: Props) {
  const [mapping, setMapping] = useState<ColumnMapping | undefined>(undefined)
  const [preview, setPreview] = useState<StatementPreview | null>(null)
  const [account, setAccount] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(file.error ?? null)
  // Once detection fails, keep showing the column pickers even after the mapping works.
  const [custom, setCustom] = useState(false)

  useEffect(() => {
    if (file.error) return
    let live = true
    void window.ordo.money
      .previewStatement({ fileName: file.fileName, text: file.text, mapping })
      .then((p) => {
        if (!live) return
        setPreview(p)
        if (!p.ok && p.error === 'unrecognised') {
          setCustom(true)
          setMapping(p.suggested)
        }
      })
    return () => {
      live = false
    }
  }, [file, mapping])

  const accountName = account ?? preview?.suggestedAccount ?? ''

  const submit = async () => {
    if (!preview?.ok) return
    setBusy(true)
    setError(null)
    try {
      const res = await window.ordo.money.importStatement({
        fileName: file.fileName,
        text: file.text,
        accountName: accountName.trim() || undefined,
        mapping: custom ? mapping : undefined,
      })
      if (res.ok) onImported(res)
      else setError(res.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      title="Import statement"
      subtitle={file.fileName}
      icon={<FileSpreadsheet size={22} />}
      width={560}
      busy={busy}
      onClose={onClose}
      onSubmit={() => void submit()}
      footer={
        <>
          <span className="flex flex-1 items-center gap-1.5 text-[12px] text-ink-2">
            <ShieldCheck size={14} className="shrink-0" /> Stays on this computer. Nothing is uploaded.
          </span>
          <Button disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !preview?.ok}>
            {busy ? 'Importing…' : 'Import'}
          </Button>
        </>
      }
    >
      {error && <Notice tone="error">{error}</Notice>}
      {preview === null && !error && <p className="text-ink-2">Reading the file…</p>}

      {custom && preview && mapping && (
        <MappingEditor
          sample={preview.ok ? null : preview.sample}
          headers={preview.ok ? preview.headers : null}
          mapping={mapping}
          onChange={setMapping}
          message={preview.ok ? null : preview.message}
        />
      )}
      {!custom && preview && !preview.ok && <Notice tone="error">{preview.message}</Notice>}

      {preview?.ok && (
        <>
          <p className="text-ink-2">
            {preview.layout === 'Custom' ? 'Using your columns' : `Recognised as a ${preview.layout} export`}:{' '}
            <span className="text-ink">
              {preview.count.toLocaleString()} transactions from {formatDate(preview.from)} to{' '}
              {formatDate(preview.to)}
            </span>
            {preview.skipped > 0 && `, ${preview.skipped} other rows skipped`}.
          </p>
          <table className="w-full table-fixed border-collapse overflow-hidden rounded-md text-[12px]">
            <tbody>
              {preview.sample.map((t) => (
                <tr key={t.id} className="border-b border-sep last:border-b-0">
                  <td className="w-24 py-1 text-ink-2 tabular-nums">{formatDate(t.date, true)}</td>
                  <td className="truncate py-1">{t.merchant ?? t.description}</td>
                  <td className={`w-24 py-1 text-right tabular-nums ${t.amount > 0 ? 'text-success' : ''}`}>
                    {t.amount > 0 ? '+' : ''}
                    {formatPence(t.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <TextField
            label="Account name"
            value={accountName}
            maxLength={60}
            onChange={(e) => setAccount(e.target.value)}
            hint="Re-importing a statement for the same account skips transactions you already have."
          />
        </>
      )}
    </Sheet>
  )
}

function MappingEditor(props: {
  sample: string[][] | null
  headers: string[] | null
  mapping: ColumnMapping
  message: string | null
  onChange: (m: ColumnMapping) => void
}) {
  // Keep the first sample we saw, so the pickers don't jump around as the mapping changes.
  const [rows] = useState(() => props.sample ?? (props.headers ? [props.headers] : []))
  const m = props.mapping
  const width = Math.max(1, ...rows.map((r) => r.length))
  const hasHeader = m.headerRow >= 0
  const label = (c: number) => {
    const head = hasHeader ? rows[m.headerRow]?.[c] : undefined
    const example = rows[hasHeader ? m.headerRow + 1 : 0]?.[c]
    return `Column ${c + 1}${head ? `: ${head}` : example ? ` (${example})` : ''}`
  }
  const columns = Array.from({ length: width }, (_, c) => (
    <option key={c} value={c}>
      {label(c)}
    </option>
  ))
  const split = m.amount === undefined
  const set = (patch: Partial<ColumnMapping>) => props.onChange({ ...m, ...patch })

  return (
    <div className="flex flex-col gap-3">
      {props.message && <Notice>{props.message}</Notice>}
      {rows.length > 0 && (
        <div className="overflow-auto rounded-md border border-sep">
          <table className="w-full border-collapse text-[11px]">
            <tbody>
              {rows.slice(0, 4).map((r, i) => (
                <tr
                  key={i}
                  className={`border-b border-sep last:border-b-0 ${i === m.headerRow ? 'font-semibold' : ''}`}
                >
                  {Array.from({ length: width }, (_, c) => (
                    <td key={c} className="max-w-40 truncate px-2 py-1 text-ink-2">
                      {r[c]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={hasHeader}
          onChange={(e) => set({ headerRow: e.target.checked ? 0 : -1 })}
          className="accent-[var(--accent)]"
        />
        First row is a header
      </label>
      <div className="grid grid-cols-2 gap-3">
        <Select label="Date" value={m.date} onChange={(e) => set({ date: Number(e.target.value) })}>
          {columns}
        </Select>
        <Select
          label="Description"
          value={m.description}
          onChange={(e) => set({ description: Number(e.target.value) })}
        >
          {columns}
        </Select>
        <Select
          label="Amounts"
          value={split ? 'split' : 'one'}
          onChange={(e) =>
            set(
              e.target.value === 'one'
                ? { amount: m.debit ?? 0, debit: undefined, credit: undefined }
                : {
                    amount: undefined,
                    debit: m.amount ?? 0,
                    credit: Math.min(width - 1, (m.amount ?? 0) + 1),
                  },
            )
          }
        >
          <option value="one">One column, money out is negative</option>
          <option value="split">Separate money out and money in</option>
        </Select>
        {!split ? (
          <Select label="Amount" value={m.amount} onChange={(e) => set({ amount: Number(e.target.value) })}>
            {columns}
          </Select>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Select
              label="Money out"
              value={m.debit}
              onChange={(e) => set({ debit: Number(e.target.value) })}
            >
              {columns}
            </Select>
            <Select
              label="Money in"
              value={m.credit}
              onChange={(e) => set({ credit: Number(e.target.value) })}
            >
              {columns}
            </Select>
          </div>
        )}
      </div>
    </div>
  )
}
