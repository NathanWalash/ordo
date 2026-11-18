import { useState } from 'react'
import { SquareKanban } from 'lucide-react'
import { TEMPLATES, type TemplateId } from '@ordo/boards-core'
import type { Board } from '@ordo/shared'
import { Button } from '../Button'
import { Sheet } from '../Sheet'
import { TextField } from '../TextField'

/** Name a new board and pick a template. */
export function NewBoardSheet({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (board: Board) => void
}) {
  const [name, setName] = useState('')
  const [template, setTemplate] = useState<TemplateId>('simple')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = async () => {
    setBusy(true)
    const r = await window.ordo.boards.createBoard({
      name: name.trim() || TEMPLATES.find((t) => t.id === template)!.name,
      template,
    })
    setBusy(false)
    if (r.ok) onCreated(r.value)
    else setError(r.message)
  }

  return (
    <Sheet
      title="New board"
      subtitle="Boards are kept on this computer."
      icon={<SquareKanban size={22} />}
      width={520}
      busy={busy}
      onClose={onClose}
      onSubmit={() => void create()}
      footer={
        <>
          <span className="flex-1" />
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Create board
          </Button>
        </>
      }
    >
      <TextField
        label="Name"
        value={name}
        maxLength={80}
        placeholder={TEMPLATES.find((t) => t.id === template)!.name}
        onChange={(e) => setName(e.target.value)}
        error={error ?? undefined}
      />
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 text-[13px] font-semibold">Start from</legend>
        <div role="radiogroup" aria-label="Template" className="grid grid-cols-3 gap-2">
          {TEMPLATES.map((t) => {
            const on = t.id === template
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setTemplate(t.id)}
                className={`flex flex-col gap-2 rounded-lg border p-2 text-left ${
                  on ? 'border-accent ring-1 ring-accent' : 'border-sep hover:bg-hover'
                }`}
              >
                <span
                  className="flex h-14 gap-[3px] overflow-hidden rounded-md bg-lane p-1.5"
                  aria-hidden="true"
                >
                  {t.columns.slice(0, 5).map((c, i) => (
                    <span key={c.name} className="flex flex-1 flex-col gap-[3px]">
                      <span className="h-[3px] rounded-full bg-ink-3/60" />
                      {Array.from({ length: Math.max(1, 3 - i) }, (_, j) => (
                        <span key={j} className="h-2.5 rounded-[2px] bg-card shadow-[var(--card-shadow)]" />
                      ))}
                    </span>
                  ))}
                </span>
                <span>
                  <span className="block text-[13px] font-medium">{t.name}</span>
                  <span className="block text-[11px] leading-snug text-ink-2">{t.description}</span>
                </span>
              </button>
            )
          })}
        </div>
      </fieldset>
    </Sheet>
  )
}
