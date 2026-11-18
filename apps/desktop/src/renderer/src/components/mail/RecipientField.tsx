import { useId, type ClipboardEvent, type KeyboardEvent, type Ref } from 'react'
import { X } from 'lucide-react'
import { formatAddress, parseAddress, personLabel, splitAddressList } from '@ordo/mail-core'

export interface Recipients {
  /** Entries already turned into tokens, as typed or formatted. */
  tokens: string[]
  /** What's being typed now. */
  pending: string
}

/** Recipients from a field's text: complete entries become tokens. */
export function toRecipients(text: string): Recipients {
  return {
    tokens: splitAddressList(text).map((entry) => {
      const a = parseAddress(entry)
      return a ? formatAddress(a) : entry
    }),
    pending: '',
  }
}

/** The field's value for sending: the tokens and whatever is still being typed. */
export const recipientsText = (r: Recipients) => [...r.tokens, r.pending.trim()].filter(Boolean).join(', ')

interface Props {
  label: string
  value: Recipients
  onChange: (value: Recipients) => void
  error?: string
  hint?: string
  inputRef?: Ref<HTMLInputElement>
}

/**
 * To, Cc or Bcc as tokens. Each shows the name and always the real address, so a long name
 * can't push the address out of view. Type, then a comma, Return or Tab to add one; Backspace
 * in an empty field takes the last one off.
 */
export function RecipientField({ label, value, onChange, error, hint, inputRef }: Props) {
  const id = useId()
  const noteId = `${id}-note`
  const commit = (pending: string, extra: string[] = []) => {
    const added = [...splitAddressList(pending), ...extra].map((entry) => {
      const a = parseAddress(entry)
      return a ? formatAddress(a) : entry.trim()
    })
    onChange({ tokens: [...value.tokens, ...added.filter(Boolean)], pending: '' })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' || e.key === ',' || e.key === ';') && value.pending.trim()) {
      e.preventDefault()
      commit(value.pending)
    } else if (e.key === 'Tab' && !e.shiftKey && value.pending.trim()) commit(value.pending)
    else if (e.key === 'Backspace' && !value.pending && value.tokens.length) {
      e.preventDefault()
      onChange({ tokens: value.tokens.slice(0, -1), pending: '' })
    } else if (e.key === 'Enter') e.preventDefault() // Return never sends
  }

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text')
    if (!/[,;\n]/.test(text)) return
    e.preventDefault()
    commit(`${value.pending}${text.replace(/\n/g, ',')}`)
  }

  return (
    <div className="contents">
      <label htmlFor={id} className="pt-1.5 text-right text-[13px] text-ink-2">
        {label}
      </label>
      <div className="min-w-0">
        <div
          className={`flex min-h-7 flex-wrap items-center gap-1 rounded-md border bg-field px-1 py-0.5 focus-within:border-accent focus-within:ring-1 focus-within:ring-accent ${
            error ? 'border-danger ring-1 ring-danger' : 'border-sep'
          }`}
        >
          {value.tokens.length > 0 && (
            <ul aria-label={`${label} recipients`} className="contents">
              {value.tokens.map((t, i) => {
                const a = parseAddress(t)
                return (
                  <li
                    key={`${t}-${i}`}
                    className={`flex max-w-full min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-[12px] ${
                      a ? 'bg-selected' : 'bg-danger/15 text-danger-text'
                    }`}
                    title={a ? a.address : 'Not an email address'}
                  >
                    <span className="min-w-0 truncate">{a ? personLabel(a) : t}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${a ? a.address : t}`}
                      onClick={() =>
                        onChange({ tokens: value.tokens.filter((_, j) => j !== i), pending: value.pending })
                      }
                      className="flex size-4 shrink-0 items-center justify-center rounded text-ink-2 hover:text-ink"
                    >
                      <X size={11} />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          <input
            id={id}
            ref={inputRef}
            value={value.pending}
            onChange={(e) => onChange({ tokens: value.tokens, pending: e.target.value })}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onBlur={() => value.pending.trim() && commit(value.pending)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error || hint ? noteId : undefined}
            autoComplete="off"
            spellCheck={false}
            // The box around the tokens shows focus; a second ring on the input would double it.
            style={{ outline: 'none' }}
            className="h-6 min-w-[120px] flex-1 bg-transparent px-1 text-[13px] text-ink outline-none select-text placeholder:text-ink-2"
          />
        </div>
        {(error || hint) && (
          <p
            id={noteId}
            className={`mt-1 text-[11px] leading-snug ${error ? 'text-danger-text' : 'text-ink-2'}`}
          >
            {error ?? hint}
          </p>
        )}
      </div>
    </div>
  )
}
