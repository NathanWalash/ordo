import { useState, type DragEvent } from 'react'
import { decodeStatement } from '@ordo/money-core'
import type { ImportOutcome, StatementFile } from '@ordo/shared'
import { OverContent } from '../Sheet'
import { ImportSheet } from './ImportSheet'

const MAX_BYTES = 20 * 1024 * 1024

/**
 * Importing statements from the Import button (native open dialog) or by dropping a
 * CSV onto the page. Returns drop handlers for the page and the sheet to render.
 */
export function useStatementImport(onImported: (o: Extract<ImportOutcome, { ok: true }>) => void) {
  const [file, setFile] = useState<StatementFile | null>(null)
  const [dragging, setDragging] = useState(false)

  const pick = async () => {
    const f = await window.ordo.money.pickStatement()
    if (f) setFile(f)
  }

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')

  const dropProps = {
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      setDragging(true)
    },
    onDragLeave: (e: DragEvent) => {
      if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node))
        setDragging(false)
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      setDragging(false)
      const f = e.dataTransfer.files[0]
      if (!f) return
      if (f.size > MAX_BYTES) {
        setFile({ fileName: f.name, text: '', error: 'That file is too big to be a bank statement export.' })
        return
      }
      void f
        .arrayBuffer()
        .then((buffer) => setFile({ fileName: f.name, text: decodeStatement(new Uint8Array(buffer)) }))
        .catch(() => setFile({ fileName: f.name, text: '', error: 'Ordo couldn’t read that file.' }))
    },
  }

  const overlay = dragging && (
    <OverContent>
      <div className="pointer-events-none absolute inset-x-3 top-[55px] bottom-3 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent/10 text-[15px] font-medium text-accent">
        Drop a CSV statement to import it
      </div>
    </OverContent>
  )

  const sheet = file && (
    <ImportSheet
      file={file}
      onClose={() => setFile(null)}
      onImported={(o) => {
        setFile(null)
        onImported(o)
      }}
    />
  )

  return { pick, dropProps, overlay, sheet }
}
