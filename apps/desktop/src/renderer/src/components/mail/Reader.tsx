import { Fragment, useId, useMemo, useState, type ReactNode } from 'react'
import { Download, FileText, ImageOff, Paperclip, PenLine } from 'lucide-react'
import { displayName, type MessageContent } from '@ordo/mail-core'
import { Button } from '../Button'
import { decodedSize, fileSize, fullDate, initials, peopleWithAddresses } from './format'
import { MessageFrame } from './MessageFrame'
import { sanitiseEmail } from './sanitise'

interface Props {
  message: MessageContent
  /** The message is in Drafts: offer to carry on writing it. */
  isDraft: boolean
  onLink: (href: string, text: string) => void
  onEditDraft: () => void
  /** Keys pressed inside the message frame, for the window's shortcuts. */
  onFrameKey?: (e: KeyboardEvent) => void
}

/** The reading pane: who it's from, the safely rendered body and the attachments. */
export function Reader({ message, isDraft, onLink, onEditDraft, onFrameKey }: Props) {
  // Images loaded for this message only; nothing is remembered for next time.
  const [loaded, setLoaded] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [imageNote, setImageNote] = useState<string | null>(null)
  const [saveNote, setSaveNote] = useState<{ text: string; error: boolean } | null>(null)
  const subjectId = useId()

  const doc = useMemo(
    () => (message.html ? sanitiseEmail(message.html, { inline: message.inlineImages, loaded }) : null),
    [message.html, message.inlineImages, loaded],
  )

  const loadImages = async () => {
    if (!doc?.blocked.length) return
    setLoading(true)
    try {
      const r = await window.ordo.mail.loadImages({ urls: doc.blocked })
      setLoaded((l) => ({ ...l, ...r.images }))
      setImageNote(r.failed ? `${r.failed} ${r.failed === 1 ? 'image' : 'images'} couldn’t be loaded.` : null)
    } finally {
      setLoading(false)
    }
  }

  const files = message.attachments.filter((a) => !a.inline)
  const ref = { mailbox: message.mailbox, uid: message.uid }
  const save = async (part: string, name: string) => {
    setSaveNote(null)
    const r = await window.ordo.mail.saveAttachment({ ...ref, part })
    if (!r.ok) setSaveNote({ text: r.message, error: true })
    else if (r.saved) setSaveNote({ text: `Saved ${name}.`, error: false })
  }
  const saveAll = async () => {
    setSaveNote(null)
    const r = await window.ordo.mail.saveAllAttachments(ref)
    if (!r.ok) setSaveNote({ text: r.message, error: true })
    else if (r.saved)
      setSaveNote({ text: `Saved ${r.saved} ${r.saved === 1 ? 'file' : 'files'}.`, error: false })
  }

  const blocked = doc?.blocked.length ?? 0
  const subject = message.subject || '(No subject)'
  return (
    <article
      aria-labelledby={subjectId}
      className="mx-auto flex w-full max-w-[860px] flex-col gap-4 px-6 py-5"
    >
      <header className="flex flex-col gap-3">
        <h2 id={subjectId} className="text-[15px] leading-snug font-semibold break-words select-text">
          {subject}
        </h2>
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="flex size-9 shrink-0 items-center justify-center rounded-full bg-selected text-[13px] font-semibold text-ink-2"
          >
            {initials(message.from)}
          </span>
          <div className="min-w-0 flex-1 text-[12px] leading-relaxed text-ink-2 select-text">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                <span className="font-semibold">{displayName(message.from) || 'Unknown sender'}</span>
                {message.from && displayName(message.from) !== message.from.address && (
                  <span className="text-ink-2"> &lt;{message.from.address}&gt;</span>
                )}
              </span>
              <time dateTime={message.date.toISOString()}>{fullDate(message.date)}</time>
            </div>
            <Line label="To">{peopleWithAddresses(message.to) || '—'}</Line>
            {message.cc.length > 0 && <Line label="Cc">{peopleWithAddresses(message.cc)}</Line>}
            {message.replyTo.length > 0 && (
              <Line label="Reply to">{peopleWithAddresses(message.replyTo)}</Line>
            )}
          </div>
        </div>
        {isDraft && (
          <div>
            <Button icon={<PenLine size={13} />} onClick={onEditDraft}>
              Edit draft
            </Button>
          </div>
        )}
      </header>

      {blocked > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md bg-hover px-3 py-2 text-[12px] text-ink-2">
          <span className="flex min-w-0 flex-1 basis-[220px] items-center gap-2">
            <ImageOff size={14} className="shrink-0" />
            {`Ordo blocked ${blocked} remote ${blocked === 1 ? 'image' : 'images'} so the sender can’t tell you’ve opened it.`}
          </span>
          <Button onClick={() => void loadImages()} disabled={loading} className="shrink-0 whitespace-nowrap">
            {loading ? 'Loading…' : 'Load images'}
          </Button>
        </div>
      )}
      {imageNote && <p className="text-[12px] text-ink-2">{imageNote}</p>}

      {doc ? (
        <MessageFrame srcDoc={doc.html} styled={doc.styled} onLink={onLink} onKey={onFrameKey} />
      ) : message.text?.trim() ? (
        <PlainText text={message.text} onLink={onLink} />
      ) : (
        <p className="text-ink-2">This message has no text.</p>
      )}
      {message.truncated && (
        <p className="text-[12px] text-ink-2">
          This message is very long, so Ordo shows only the start of it.
        </p>
      )}

      {files.length > 0 && (
        <section aria-label="Attachments" className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-2">
              <Paperclip size={13} /> {files.length} {files.length === 1 ? 'attachment' : 'attachments'}
            </h3>
            {files.length > 1 && (
              <Button icon={<Download size={13} />} onClick={() => void saveAll()}>
                Save all…
              </Button>
            )}
          </div>
          <ul className="flex flex-wrap gap-2">
            {files.map((a) => (
              <li
                key={a.part}
                className="flex max-w-full min-w-0 basis-[240px] items-center gap-2 rounded-lg border border-sep bg-field py-1.5 pr-1.5 pl-2.5"
              >
                <FileText size={16} className="shrink-0 text-ink-2" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium">{a.filename}</span>
                  <span className="block text-[11px] text-ink-2">{fileSize(decodedSize(a.size))}</span>
                </span>
                <button
                  type="button"
                  onClick={() => void save(a.part, a.filename)}
                  aria-label={`Save ${a.filename}`}
                  title="Save…"
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-2 hover:bg-hover hover:text-ink"
                >
                  <Download size={14} />
                </button>
              </li>
            ))}
          </ul>
          {saveNote && (
            <p
              role={saveNote.error ? 'alert' : 'status'}
              className={`text-[12px] ${saveNote.error ? 'text-danger-text' : 'text-ink-2'}`}
            >
              {saveNote.text}
            </p>
          )}
        </section>
      )}
    </article>
  )
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="truncate">
      <span className="text-ink-2">{label}: </span>
      <span className="text-ink">{children}</span>
    </div>
  )
}

const URL_IN_TEXT = /(https?:\/\/[^\s<>"'()]+[^\s<>"'().,;:!?])/g

/** A plain-text body, with web addresses as links that go through the same check. */
function PlainText({ text, onLink }: { text: string; onLink: (href: string, text: string) => void }) {
  const parts = useMemo(() => text.split(URL_IN_TEXT), [text])
  return (
    <div className="font-sans text-[14px] leading-relaxed whitespace-pre-wrap break-words select-text">
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a
            key={i}
            href={p}
            onClick={(e) => {
              e.preventDefault()
              onLink(p, p)
            }}
            className="text-accent underline-offset-2 hover:underline"
          >
            {p}
          </a>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </div>
  )
}
