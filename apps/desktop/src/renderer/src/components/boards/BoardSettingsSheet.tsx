import { useState, type ReactNode } from 'react'
import {
  CalendarDays,
  CircleDot,
  Hash,
  Link2,
  Plus,
  Settings2,
  SquareCheck,
  Trash2,
  Type,
  UserRound,
  X,
} from 'lucide-react'
import {
  FIELD_TYPES,
  FIELD_TYPE_LABELS,
  LABEL_COLORS,
  type FieldDef,
  type FieldType,
  type Label,
  type LabelColor,
  type UndoToken,
} from '@ordo/boards-core'
import type { BoardView } from '@ordo/shared'
import { Button } from '../Button'
import { SegmentedControl } from '../SegmentedControl'
import { Sheet } from '../Sheet'
import { Switch } from '../Switch'
import { Menu, type MenuAnchor } from './Menu'
import { LABEL_COLOR_NAMES, labelColor } from './model'

export const FIELD_ICONS: Record<FieldType, ReactNode> = {
  text: <Type size={13} />,
  number: <Hash size={13} />,
  date: <CalendarDays size={13} />,
  select: <CircleDot size={13} />,
  checkbox: <SquareCheck size={13} />,
  url: <Link2 size={13} />,
  person: <UserRound size={13} />,
}

interface Props {
  view: BoardView
  onClose: () => void
  onChanged: () => Promise<void>
  offerUndo: (token: UndoToken, message: string) => void
}

/** A board's labels and custom fields. */
export function BoardSettingsSheet({ view, onClose, onChanged, offerUndo }: Props) {
  const [tab, setTab] = useState<'labels' | 'fields'>('labels')
  const [error, setError] = useState<string | null>(null)

  const run = async <T,>(p: Promise<{ ok: true; value: T } | { ok: false; message: string }>) => {
    const r = await p
    setError(r.ok ? null : r.message)
    await onChanged()
    return r.ok ? r.value : null
  }

  return (
    <Sheet
      title="Labels and fields"
      subtitle={view.board.name}
      icon={<Settings2 size={22} />}
      initialFocus={tab === 'labels' ? '[aria-label="New label name"]' : undefined}
      width={560}
      onClose={onClose}
      onSubmit={onClose}
      footer={
        <>
          {error ? (
            <p role="alert" className="flex-1 text-[12px] text-danger">
              {error}
            </p>
          ) : (
            <span className="flex-1" />
          )}
          <Button type="submit" variant="primary">
            Done
          </Button>
        </>
      }
    >
      <div className="flex justify-center">
        <SegmentedControl
          label="Show"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'labels', label: 'Labels' },
            { value: 'fields', label: 'Fields' },
          ]}
        />
      </div>
      {tab === 'labels' ? (
        <LabelsEditor view={view} run={run} offerUndo={offerUndo} />
      ) : (
        <FieldsEditor view={view} run={run} offerUndo={offerUndo} />
      )}
    </Sheet>
  )
}

type Run = <T>(p: Promise<{ ok: true; value: T } | { ok: false; message: string }>) => Promise<T | null>

function LabelsEditor({
  view,
  run,
  offerUndo,
}: {
  view: BoardView
  run: Run
  offerUndo: Props['offerUndo']
}) {
  const api = window.ordo.boards
  const [name, setName] = useState('')
  const [color, setColor] = useState<LabelColor>('blue')
  const save = (l: Label, patch: Partial<Pick<Label, 'name' | 'color'>>) =>
    run(
      api.saveLabel({
        id: l.id,
        boardId: l.boardId,
        name: patch.name ?? l.name,
        color: patch.color ?? l.color,
      }),
    )
  const add = async () => {
    if (!name.trim()) return
    if (await run(api.saveLabel({ boardId: view.board.id, name, color }))) setName('')
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-sep rounded-lg border border-sep" aria-label="Labels">
        {view.labels.length === 0 && <li className="px-3 py-2.5 text-[12px] text-ink-2">No labels yet.</li>}
        {view.labels.map((l) => (
          <li key={l.id} className="flex items-center gap-2 px-2 py-1.5">
            <ColorButton
              color={l.color}
              label={`Colour of ${l.name}`}
              onChange={(c) => void save(l, { color: c })}
            />
            <InlineText value={l.name} label="Label name" onSave={(v) => void save(l, { name: v })} />
            <DeleteButton
              label={`Delete ${l.name}`}
              onClick={async () => {
                const token = await run(api.deleteLabel(l.id))
                if (token) offerUndo(token, `Deleted the ${l.name} label`)
              }}
            />
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <ColorButton color={color} label="Colour of the new label" onChange={setColor} />
        <input
          value={name}
          maxLength={40}
          placeholder="New label"
          aria-label="New label name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void add()
            }
          }}
          className="h-7 min-w-0 flex-1 rounded-md border border-sep bg-field px-2 text-[13px] outline-none select-text placeholder:text-ink-3 focus:border-accent focus:ring-1 focus:ring-accent"
        />
        <Button icon={<Plus size={13} />} onClick={() => void add()} disabled={!name.trim()}>
          Add label
        </Button>
      </div>
    </div>
  )
}

function FieldsEditor({
  view,
  run,
  offerUndo,
}: {
  view: BoardView
  run: Run
  offerUndo: Props['offerUndo']
}) {
  const api = window.ordo.boards
  const [name, setName] = useState('')
  const [type, setType] = useState<FieldType>('text')
  const save = (f: FieldDef, patch: { name?: string; options?: NewOption[]; showOnCard?: boolean }) =>
    run(
      api.saveField({
        id: f.id,
        boardId: f.boardId,
        type: f.type,
        name: patch.name ?? f.name,
        options: patch.options ?? f.options,
        showOnCard: patch.showOnCard ?? f.showOnCard,
      }),
    )
  const add = async () => {
    if (!name.trim()) return
    if (await run(api.saveField({ boardId: view.board.id, name, type, showOnCard: type === 'select' })))
      setName('')
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col divide-y divide-sep rounded-lg border border-sep" aria-label="Fields">
        {view.fields.length === 0 && (
          <li className="px-3 py-2.5 text-[12px] text-ink-2">
            No fields yet. Fields add your own details to every card, like a priority or an owner.
          </li>
        )}
        {view.fields.map((f) => (
          <li key={f.id} className="flex flex-col gap-1.5 px-2 py-1.5">
            <div className="flex items-center gap-2">
              <span
                className="flex size-6 shrink-0 items-center justify-center text-ink-2"
                title={FIELD_TYPE_LABELS[f.type]}
              >
                {FIELD_ICONS[f.type]}
              </span>
              <InlineText value={f.name} label="Field name" onSave={(v) => void save(f, { name: v })} />
              <span className="w-[72px] shrink-0 text-[12px] text-ink-2">{FIELD_TYPE_LABELS[f.type]}</span>
              <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-ink-2">
                On card
                <Switch
                  size="mini"
                  label={`Show ${f.name} on cards`}
                  checked={f.showOnCard}
                  onChange={(on) => void save(f, { showOnCard: on })}
                />
              </span>
              <DeleteButton
                label={`Delete ${f.name}`}
                onClick={async () => {
                  const token = await run(api.deleteField(f.id))
                  if (token) offerUndo(token, `Deleted the ${f.name} field`)
                }}
              />
            </div>
            {f.type === 'select' && (
              <OptionsEditor
                field={f}
                used={(optionId) => view.cards.filter((c) => c.fields[f.id] === optionId).length}
                onSave={(options) => void save(f, { options })}
              />
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        <input
          value={name}
          maxLength={40}
          placeholder="New field"
          aria-label="New field name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void add()
            }
          }}
          className="h-7 min-w-0 flex-1 rounded-md border border-sep bg-field px-2 text-[13px] outline-none select-text placeholder:text-ink-3 focus:border-accent focus:ring-1 focus:ring-accent"
        />
        <select
          value={type}
          aria-label="New field type"
          onChange={(e) => setType(e.target.value as FieldType)}
          className="h-7 rounded-md border border-sep bg-field px-2 text-[13px] text-ink shadow-[0_1px_1px_rgb(0_0_0/0.06)] outline-none focus:border-accent focus:ring-1 focus:ring-accent"
        >
          {FIELD_TYPES.map((t) => (
            <option key={t} value={t}>
              {FIELD_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <Button icon={<Plus size={13} />} onClick={() => void add()} disabled={!name.trim()}>
          Add field
        </Button>
      </div>
    </div>
  )
}

/** A select option; new ones have no id yet. */
type NewOption = { id?: string; name: string; color: LabelColor }

function OptionsEditor({
  field,
  used,
  onSave,
}: {
  field: FieldDef
  /** How many cards have this option chosen. */
  used: (optionId: string) => number
  onSave: (options: NewOption[]) => void
}) {
  const [name, setName] = useState('')
  const [removing, setRemoving] = useState<{ id: string; name: string; cards: number } | null>(null)
  const remove = (id: string) => onSave(field.options.filter((x) => x.id !== id))
  const add = () => {
    if (!name.trim()) return
    const used = new Set(field.options.map((o) => o.color))
    const color = LABEL_COLORS.find((c) => !used.has(c)) ?? 'grey'
    onSave([...field.options, { name: name.trim(), color }])
    setName('')
  }
  return (
    <div className="ml-8 flex flex-wrap items-center gap-1.5">
      {field.options.map((o) => (
        <span
          key={o.id}
          className="inline-flex h-7 items-center gap-0.5 rounded-md border border-sep pr-0.5 pl-0.5 text-[12px]"
        >
          <ColorButton
            small
            color={o.color}
            label={`Colour of ${o.name}`}
            onChange={(c) => onSave(field.options.map((x) => (x.id === o.id ? { ...x, color: c } : x)))}
          />
          {o.name}
          <button
            type="button"
            aria-label={`Remove ${o.name}`}
            onClick={() => {
              // Cards using it lose it, so ask first.
              const cards = used(o.id)
              if (cards) setRemoving({ id: o.id, name: o.name, cards })
              else remove(o.id)
            }}
            className="flex size-6 items-center justify-center rounded text-ink-2 hover:bg-hover hover:text-ink"
          >
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        value={name}
        maxLength={40}
        placeholder="Add option"
        aria-label={`New option for ${field.name}`}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add()
          }
        }}
        onBlur={add}
        className="h-7 w-28 rounded-md border border-dashed border-sep bg-transparent px-1.5 text-[12px] outline-none select-text placeholder:text-ink-3 focus:border-accent"
      />
      {removing && (
        <div
          role="alert"
          className="flex w-full items-center gap-2 rounded-md bg-hover px-2.5 py-1.5 text-[12px]"
        >
          <span className="flex-1">
            {removing.cards === 1 ? '1 card uses' : `${removing.cards} cards use`} {removing.name}. Remove it
            from
            {removing.cards === 1 ? ' it' : ' them'}?
          </span>
          <Button onClick={() => setRemoving(null)}>Keep</Button>
          <Button
            className="!bg-danger !text-white"
            onClick={() => {
              remove(removing.id)
              setRemoving(null)
            }}
          >
            Remove
          </Button>
        </div>
      )}
    </div>
  )
}

function InlineText({ value, label, onSave }: { value: string; label: string; onSave: (v: string) => void }) {
  const [text, setText] = useState(value)
  const [prev, setPrev] = useState(value)
  if (prev !== value) {
    setPrev(value)
    setText(value)
  }
  const commit = () => {
    const v = text.trim()
    if (v && v !== value) onSave(v)
    else setText(value)
  }
  return (
    <input
      value={text}
      aria-label={label}
      maxLength={40}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        }
        if (e.key === 'Escape') {
          e.stopPropagation()
          setText(value)
        }
      }}
      className="h-7 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-[13px] outline-none select-text hover:border-sep focus:border-accent focus:bg-field focus:ring-1 focus:ring-accent"
    />
  )
}

function DeleteButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title="Delete"
      onClick={onClick}
      className="flex size-6 shrink-0 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-danger"
    >
      <Trash2 size={13} />
    </button>
  )
}

/** A colour swatch that opens a menu of the label colours. */
export function ColorButton({
  color,
  label,
  onChange,
  small,
}: {
  color: LabelColor
  label: string
  onChange: (c: LabelColor) => void
  small?: boolean
}) {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  return (
    <>
      <button
        type="button"
        aria-label={`${label}: ${LABEL_COLOR_NAMES[color]}`}
        aria-haspopup="menu"
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
        className={`flex shrink-0 items-center justify-center rounded-md hover:bg-hover ${small ? 'size-6' : 'size-7'}`}
      >
        <span
          className={`rounded-full ring-1 ring-black/10 ring-inset ${small ? 'size-2.5' : 'size-3.5'}`}
          style={{ background: labelColor(color) }}
        />
      </button>
      {anchor && (
        <Menu
          label="Colour"
          anchor={anchor}
          width={160}
          onClose={() => setAnchor(null)}
          items={LABEL_COLORS.map((c) => ({
            label: LABEL_COLOR_NAMES[c],
            hint: c === color ? '✓' : undefined,
            icon: <span className="size-2.5 rounded-full" style={{ background: labelColor(c) }} />,
            onSelect: () => onChange(c),
          }))}
        />
      )}
    </>
  )
}
