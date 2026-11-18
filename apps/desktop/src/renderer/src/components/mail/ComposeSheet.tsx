import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Paperclip, PenLine, X } from 'lucide-react'
import { COMPOSE_LIMITS, parseAddressList, type AttachmentInfo } from '@ordo/mail-core'
import type { ComposeInput, MessageRef, PickedFile } from '@ordo/shared'
import { Button } from '../Button'
import { Sheet } from '../Sheet'
import { decodedSize, fileSize } from './format'
import { RecipientField, recipientsText, toRecipients, type Recipients } from './RecipientField'

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
  /** Sent; `warning` if something after sending didn't work. */
  onSent: (warning?: string) => void
  onSaved: () => void
}

type Field = 'to' | 'cc' | 'bcc'
type Errors = Partial<Record<Field, string>>
const FIELDS: Field[] = ['to', 'cc', 'bcc']

/** Check the address fields as the main process will. */
function check(fields: Record<Field, string>, needRecipients: boolean): Errors {
  const errors: Errors = {}
  let count = 0
  for (const f of FIELDS) {
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
 * Write, reply or forward. Plain text. Nothing is sent until you click Send (or press ⌘Return):
 * Return in a field doesn't send, and closing with changes asks whether to keep a draft.
 */
export function ComposeSheet({ from, initial, onClose, onSent, onSaved }: Props) {
  const [recipients, setRecipients] = useState<Record<Field, Recipients>>(() => ({
    to: toRecipients(initial.to),
    cc: toRecipients(initial.cc),
    bcc: toRecipients(initial.bcc),
  }))
  const [subject, setSubject] = useState(initial.subject)
  const [body, setBody] = useState(initial.body)
  const [showBcc, setShowBcc] = useState(Boolean(initial.bcc))
  const [files, setFiles] = useState<PickedFile[]>([])
  // Attachments that live in another message: the forwarded one, or the saved draft.
  const [carried, setCarried] = useState<{ ref: MessageRef; attachments: AttachmentInfo[] } | null>(
    initial.forward ?? null,
  )
  const [draft, setDraft] = useState<MessageRef | undefined>(initial.draft)
  const [errors, setErrors] = useState<Errors>({})
  const [busy, setBusy] = useState<'send' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const [changed, setChanged] = useState(false)
  const bodyRef = useRef<HTMLTextAreaElement>(null)
  const saveRef = useRef<HTMLButtonElement>(null)
  const toRef = useRef<HTMLInputElement>(null)
  const ccRef = useRef<HTMLInputElement>(null)
  const bccRef = useRef<HTMLInputElement>(null)
  const bodyId = useId()
  const promptId = useId()

  useEffect(() => {
    if (!initial.focusBody) return
    const el = bodyRef.current
    el?.focus()
    el?.setSelectionRange(0, 0)
  }, [initial.focusBody])

  useEffect(() => {
    if (confirmClose) saveRef.current?.focus()
  }, [confirmClose])

  const text = (f: Field) => (f === 'bcc' && !showBcc ? '' : recipientsText(recipients[f]))
  const fields = { to: text('to'), cc: text('cc'), bcc: text('bcc') }

  const input = (): ComposeInput => ({
    ...fields,
    subject,
    body,
    attachments: files.map((f) => f.id),
    ...(initial.replyTo && { replyTo: initial.replyTo }),
    ...(carried?.attachments.length && {
      forward: { ...carried.ref, parts: carried.attachments.map((a) => a.part) },
    }),
    ...(draft && { draft }),
  })

  const touch = () => {
    setChanged(true)
    setNote(null)
  }

  const setField = (f: Field, v: Recipients) => {
    setRecipients((r) => ({ ...r, [f]: v }))
    touch()
    if (errors[f]) setErrors((e) => ({ ...e, [f]: undefined }))
  }

  /** Show what's wrong and put the cursor in the first field that needs fixing. */
  const invalid = (errs: Errors) => {
    setErrors(errs)
    const first = FIELDS.find((f) => errs[f])
    if (!first) return false
    if (first === 'bcc') setShowBcc(true)
    ;({ to: toRef, cc: ccRef, bcc: bccRef })[first].current?.focus()
    return true
  }

  const send = () => {
    if (busy) return
    setError(null)
    if (invalid(check(fields, true))) return
    setBusy('send')
    // Called straight from the click or key press, so the preload sees the gesture that asked.
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
    if (invalid(check(fields, false))) return setConfirmClose(false)
    setBusy('save')
    try {
      const r = await window.ordo.mail.saveDraft(input())
      if (!r.ok) {
        setError(r.message)
        setConfirmClose(false)
        return
      }
      if (r.draft) {
        // The files are in the new draft now (the old one is gone): carry them on from there.
        setDraft(r.draft)
        setCarried({ ref: r.draft, attachments: r.attachments })
        setFiles([])
      }
      setChanged(false)
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
    const room = COMPOSE_LIMITS.attachments - files.length - (carried?.attachments.length ?? 0)
    const kept = picked.slice(0, Math.max(0, room))
    setFiles((f) => [...f, ...kept])
    if (kept.length < picked.length)
      setNote(
        `Ordo attaches at most ${COMPOSE_LIMITS.attachments} files, so ${picked.length - kept.length} ${
          picked.length - kept.length === 1 ? 'was' : 'were'
        } left out.`,
      )
    if (kept.length) touch()
  }

  const requestClose = () => {
    if (busy) return
    if (confirmClose) setConfirmClose(false)
    else if (changed) setConfirmClose(true)
    else onClose()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault()
      send()
    }
  }

  const total =
    files.reduce((n, f) => n + f.size, 0) +
    (carried?.attachments ?? []).reduce((n, a) => n + decodedSize(a.size), 0)
  const tooBig = total > COMPOSE_LIMITS.attachmentBytes

  return (
    <Sheet
      title={initial.title}
      subtitle={`From ${from}`}
      icon={<PenLine size={20} />}
      width={640}
      fit
      busy={Boolean(busy)}
      onClose={requestClose}
      footer={
        confirmClose ? (
          <>
            <span id={promptId} role="status" className="flex-1 text-[13px] font-medium">
              Keep this message as a draft?
            </span>
            <Button onClick={onClose}>{draft ? 'Discard changes' : 'Don’t save'}</Button>
            <Button onClick={() => setConfirmClose(false)}>Cancel</Button>
            <Button ref={saveRef} variant="primary" onClick={() => void save(true)} disabled={busy !== null}>
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
            <Button
              variant="primary"
              onClick={send}
              disabled={busy !== null || tooBig}
              title="Send (⌘Return)"
              aria-keyshortcuts="Meta+Enter"
            >
              {busy === 'send' ? 'Sending…' : 'Send'}
            </Button>
          </>
        )
      }
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3" onKeyDown={onKeyDown}>
        <div className="grid grid-cols-[56px_1fr] items-start gap-x-3 gap-y-2">
          <RecipientField
            label="To"
            value={recipients.to}
            onChange={(v) => setField('to', v)}
            error={errors.to}
            inputRef={toRef}
          />
          <RecipientField
            label="Cc"
            value={recipients.cc}
            onChange={(v) => setField('cc', v)}
            error={errors.cc}
            inputRef={ccRef}
          />
          {showBcc ? (
            <RecipientField
              label="Bcc"
              hint="People in Bcc get the message, but nobody else sees that they did."
              value={recipients.bcc}
              onChange={(v) => setField('bcc', v)}
              error={errors.bcc}
              inputRef={bccRef}
            />
          ) : (
            <>
              <span />
              <button
                type="button"
                onClick={() => setShowBcc(true)}
                className="justify-self-start text-[12px] text-accent hover:underline"
              >
                Add Bcc
              </button>
            </>
          )}
          <label htmlFor={`${bodyId}-subject`} className="pt-1.5 text-right text-[13px] text-ink-2">
            Subject
          </label>
          <input
            id={`${bodyId}-subject`}
            value={subject}
            maxLength={COMPOSE_LIMITS.subject}
            onChange={(e) => {
              setSubject(e.target.value.replace(/[\r\n]+/g, ' '))
              touch()
            }}
            onKeyDown={(e) => e.key === 'Enter' && !e.metaKey && e.preventDefault()}
            className="h-7 min-w-0 rounded-md border border-sep bg-field px-2 text-[13px] text-ink outline-none select-text focus:border-accent focus:ring-1 focus:ring-accent"
          />
        </div>
        <label htmlFor={bodyId} className="sr-only">
          Message
        </label>
        <textarea
          id={bodyId}
          ref={bodyRef}
          value={body}
          maxLength={COMPOSE_LIMITS.body}
          onChange={(e) => {
            setBody(e.target.value)
            touch()
          }}
          className="h-[260px] min-h-[140px] shrink resize-none rounded-md border border-sep bg-field px-2.5 py-2 text-[13px] leading-relaxed text-ink outline-none select-text focus:border-accent focus:ring-1 focus:ring-accent"
        />
        {(files.length > 0 || (carried?.attachments.length ?? 0) > 0) && (
          <ul aria-label="Attachments" className="flex shrink-0 flex-wrap gap-1.5">
            {carried?.attachments.map((a) => (
              <Chip
                key={`carried-${a.part}`}
                name={a.filename}
                size={decodedSize(a.size)}
                onRemove={() => {
                  setCarried(
                    (c) => c && { ...c, attachments: c.attachments.filter((x) => x.part !== a.part) },
                  )
                  touch()
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
                  touch()
                }}
              />
            ))}
          </ul>
        )}
        {tooBig && (
          <p className="shrink-0 text-[12px] text-danger-text">
            The attachments add up to {fileSize(total)}. iCloud Mail can’t send more than about{' '}
            {fileSize(COMPOSE_LIMITS.attachmentBytes)} by email.
          </p>
        )}
        {error && (
          <p role="alert" className="shrink-0 text-[12px] text-danger-text">
            {error}
          </p>
        )}
        {note && (
          <p role="status" className="shrink-0 text-[12px] text-ink-2">
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
      <Paperclip size={12} className="shrink-0 text-ink-2" />
      <span className="min-w-0 truncate">{name}</span>
      <span className="shrink-0 text-ink-2">{fileSize(size)}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${name}`}
        className="flex size-6 shrink-0 items-center justify-center rounded text-ink-2 hover:bg-hover hover:text-ink"
      >
        <X size={12} />
      </button>
    </li>
  )
}
