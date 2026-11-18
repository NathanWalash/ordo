import { useEffect, useId, useRef, useState } from 'react'
import { Paperclip, PenLine, X } from 'lucide-react'
import { COMPOSE_LIMITS, parseAddressList, type AttachmentInfo } from '@ordo/mail-core'
import type { ComposeInput, MessageRef, PickedFile } from '@ordo/shared'
import { Button } from '../Button'
import { Sheet } from '../Sheet'
import { TextField } from '../TextField'
import { decodedSize, fileSize } from './format'

/** What the compose sheet starts with. */
export interface ComposeDraft {
  title: string
  to: string
  cc: string
  bcc: string
  subject: string
  body: string
  replyTo?: MessageRef
  /** Attachments carried over from a forwarded message (or a draft being edited). */
  forward?: { ref: MessageRef; attachments: AttachmentInfo[] }
  draft?: MessageRef
  /** Put the cursor in the message rather than in To. */
  focusBody?: boolean
}

interface Props {
  from: string
  initial: ComposeDraft
  onClose: () => void
  /** Sent; `warning` if a copy couldn't be kept in Sent. */
  onSent: (warning?: string) => void
  onSaved: () => void
}

type Field = 'to' | 'cc' | 'bcc'
type Errors = Partial<Record<Field | 'subject', string>>

/** Check the address fields as the main process will. */
function check(fields: Record<Field, string>, needRecipients: boolean): Errors {
  const errors: Errors = {}
  let count = 0
  for (const f of ['to', 'cc', 'bcc'] as const) {
    const parsed = parseAddressList(fields[f])
    count += parsed.addresses.length
    if (parsed.invalid.length) errors[f] = `Check this address: ${parsed.invalid[0]!.slice(0, 80)}`
  }
  if (needRecipients && count === 0 && !errors.to) errors.to = 'Add at least one person to send this to.'
  if (count > COMPOSE_LIMITS.recipients && !errors.to)
    errors.to = `Ordo sends to at most ${COMPOSE_LIMITS.recipients} people at once.`
  return errors
}

/**
 * Write, reply or forward. Plain text. Nothing is sent until you click Send: Return in a field
 * doesn't send, and closing with changes asks whether to keep a draft.
 */
export function ComposeSheet({ from, initial, onClose, onSent, onSaved }: Props) {
  const [fields, setFields] = useState({ to: initial.to, cc: initial.cc, bcc: initial.bcc })
  const [subject, setSubject] = useState(initial.subject)
  const [body, setBody] = useState(initial.body)
  const [showBcc, setShowBcc] = useState(Boolean(initial.bcc))
  const [files, setFiles] = useState<PickedFile[]>([])
  const [carried, setCarried] = useState<AttachmentInfo[]>(initial.forward?.attachments ?? [])
  const [draft, setDraft] = useState<MessageRef | undefined>(initial.draft)
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState<'send' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const [saved, setSaved] = useState(false)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const bodyId = useId()

  useEffect(() => {
    if (!initial.focusBody) return
    const el = bodyRef.current
    el?.focus()
    el?.setSelectionRange(0, 0)
  }, [initial.focusBody])

  const dirty =
    !saved &&
    (fields.to !== initial.to ||
      fields.cc !== initial.cc ||
      fields.bcc !== initial.bcc ||
      subject !== initial.subject ||
      body !== initial.body ||
      files.length > 0 ||
      carried.length !== (initial.forward?.attachments.length ?? 0))

  const input = (): ComposeInput => ({
    ...fields,
    bcc: showBcc ? fields.bcc : '',
    subject,
    body,
    attachments: files.map((f) => f.id),
    ...(initial.replyTo && { replyTo: initial.replyTo }),
    ...(initial.forward &&
      carried.length > 0 && { forward: { ...initial.forward.ref, parts: carried.map((a) => a.part) } }),
    ...(draft && { draft }),
  })

  const setField = (f: Field, v: string) => {
    setFields((x) => ({ ...x, [f]: v }))
    setSaved(false)
    if (errors[f]) setErrors((e) => ({ ...e, [f]: undefined }))
  }

  const send = () => {
    setError(null)
    const errs = check({ ...fields, bcc: showBcc ? fields.bcc : '' }, true)
    setErrors(errs)
    if (Object.values(errs).some(Boolean)) return
    setBusy('send')
    // Called straight from the click, so the preload sees the click that asked for it.
    void window.ordo.mail
      .send(input())
      .then((r) => {
        if (r.ok) onSent(r.warning)
        else setError(r.message)
      })
      .finally(() => setBusy(null))
  }

  const save = async (closeAfter: boolean) => {
    setError(null)
    setNote(null)
    const errs = check({ ...fields, bcc: showBcc ? fields.bcc : '' }, false)
    setErrors(errs)
    if (Object.values(errs).some(Boolean)) return setConfirmClose(false)
    setBusy('save')
    try {
      const r = await window.ordo.mail.saveDraft(input())
      if (!r.ok) {
        setError(r.message)
        setConfirmClose(false)
        return
      }
      if (r.draft) setDraft(r.draft)
      setSaved(true)
      onSaved()
      if (closeAfter) onClose()
      else setNote('Saved to Drafts.')
    } finally {
      setBusy(null)
    }
  }

  const attach = async () => {
    const picked = await window.ordo.mail.pickAttachments()
    if (!picked.length) return
    setFiles((f) => [...f, ...picked].slice(0, COMPOSE_LIMITS.attachments))
    setSaved(false)
  }

  const requestClose = () => {
    if (busy) return
    if (confirmClose) setConfirmClose(false)
    else if (dirty) setConfirmClose(true)
    else onClose()
  }

  const total = files.reduce((n, f) => n + f.size, 0) + carried.reduce((n, a) => n + decodedSize(a.size), 0)
  const tooBig = total > COMPOSE_LIMITS.attachmentBytes

  return (
    <Sheet
      title={initial.title}
      subtitle={`From ${from}`}
      icon={<PenLine size={20} />}
      width={640}
      busy={Boolean(busy)}
      onClose={requestClose}
      footer={
        confirmClose ? (
          <>
            <span className="flex-1 text-[13px] font-medium">Keep this message as a draft?</span>
            <Button onClick={onClose}>Don’t keep</Button>
            <Button onClick={() => setConfirmClose(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void save(true)} disabled={busy !== null}>
              Save draft
            </Button>
          </>
        ) : (
          <>
            <Button icon={<Paperclip size={13} />} onClick={() => void attach()} disabled={busy !== null}>
              Attach files…
            </Button>
            <span className="flex-1" />
            <Button onClick={() => void save(false)} disabled={busy !== null}>
              {busy === 'save' ? 'Saving…' : 'Save draft'}
            </Button>
            <Button onClick={requestClose} disabled={busy !== null}>
              Cancel
            </Button>
            <Button variant="primary" onClick={send} disabled={busy !== null || tooBig}>
              {busy === 'send' ? 'Sending…' : 'Send'}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <TextField
          label="To"
          value={fields.to}
          onChange={(e) => setField('to', e.target.value)}
          onBlur={() => setErrors((x) => ({ ...x, to: check(fields, false).to }))}
          error={errors.to}
          placeholder="name@example.com"
          autoComplete="off"
          spellCheck={false}
        />
        <TextField
          label="Cc"
          value={fields.cc}
          onChange={(e) => setField('cc', e.target.value)}
          onBlur={() => setErrors((x) => ({ ...x, cc: check(fields, false).cc }))}
          error={errors.cc}
          autoComplete="off"
          spellCheck={false}
        />
        {showBcc ? (
          <TextField
            label="Bcc"
            hint="People in Bcc get the message, but nobody else sees that they did."
            value={fields.bcc}
            onChange={(e) => setField('bcc', e.target.value)}
            onBlur={() => setErrors((x) => ({ ...x, bcc: check(fields, false).bcc }))}
            error={errors.bcc}
            autoComplete="off"
            spellCheck={false}
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowBcc(true)}
            className="self-start text-[12px] text-accent hover:underline"
          >
            Add Bcc
          </button>
        )}
        <TextField
          label="Subject"
          value={subject}
          maxLength={COMPOSE_LIMITS.subject}
          onChange={(e) => {
            setSubject(e.target.value.replace(/[\r\n]+/g, ' '))
            setSaved(false)
          }}
        />
        <div className="flex flex-col gap-1.5">
          <label htmlFor={bodyId} className="text-[13px] font-semibold">
            Message
          </label>
          <textarea
            id={bodyId}
            ref={bodyRef}
            value={body}
            maxLength={COMPOSE_LIMITS.body}
            onChange={(e) => {
              setBody(e.target.value)
              setSaved(false)
            }}
            className="h-[240px] resize-none rounded-md border border-sep bg-field px-2.5 py-2 text-[13px] leading-relaxed text-ink outline-none select-text focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </div>
        {(files.length > 0 || carried.length > 0) && (
          <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
            {carried.map((a) => (
              <Chip
                key={`fwd-${a.part}`}
                name={a.filename}
                size={decodedSize(a.size)}
                onRemove={() => {
                  setCarried((c) => c.filter((x) => x.part !== a.part))
                  setSaved(false)
                }}
              />
            ))}
            {files.map((f) => (
              <Chip
                key={f.id}
                name={f.name}
                size={f.size}
                onRemove={() => {
                  setFiles((x) => x.filter((y) => y.id !== f.id))
                  setSaved(false)
                }}
              />
            ))}
          </ul>
        )}
        {tooBig && (
          <p className="text-[12px] text-danger">
            The attachments add up to {fileSize(total)}. iCloud Mail can’t send more than about{' '}
            {fileSize(COMPOSE_LIMITS.attachmentBytes)} by email.
          </p>
        )}
        {error && (
          <p role="alert" className="text-[12px] text-danger">
            {error}
          </p>
        )}
        {note && (
          <p role="status" className="text-[12px] text-ink-2">
            {note}
          </p>
        )}
      </div>
    </Sheet>
  )
}

function Chip({ name, size, onRemove }: { name: string; size: number; onRemove: () => void }) {
  return (
    <li className="flex max-w-[260px] items-center gap-1.5 rounded-md border border-sep bg-field py-1 pr-1 pl-2 text-[12px]">
      <Paperclip size={12} className="shrink-0 text-ink-3" />
      <span className="min-w-0 truncate">{name}</span>
      <span className="shrink-0 text-ink-3">{fileSize(size)}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${name}`}
        className="flex size-5 shrink-0 items-center justify-center rounded text-ink-3 hover:bg-hover hover:text-ink"
      >
        <X size={12} />
      </button>
    </li>
  )
}
