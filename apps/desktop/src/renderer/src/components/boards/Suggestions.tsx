import { Check, Sparkles, X } from 'lucide-react'
import type { CardSuggestions, ISODate, Label, LinkCandidate } from '@ordo/boards-core'
import type { SuggestProvider } from '@ordo/shared'
import { LinkRow } from './LinkRow'
import { chipStyle, dayLabel, labelColor } from './model'

export type Suggestion =
  | { kind: 'due'; date: ISODate; basedOn: LinkCandidate | null }
  | { kind: 'step'; text: string }
  | { kind: 'label'; label: Label }
  | { kind: 'link'; candidate: LinkCandidate }

/** The suggestions as a flat list, so each can be accepted or rejected on its own. */
export function flatten(s: CardSuggestions): Suggestion[] {
  return [
    ...(s.due ? [{ kind: 'due' as const, date: s.due.date, basedOn: s.due.basedOn }] : []),
    ...s.checklist.map((text) => ({ kind: 'step' as const, text })),
    ...s.labels.map((label) => ({ kind: 'label' as const, label })),
    ...s.links.map((candidate) => ({ kind: 'link' as const, candidate })),
  ]
}

export const suggestionKey = (s: Suggestion) =>
  s.kind === 'due'
    ? 'due'
    : s.kind === 'step'
      ? `step:${s.text}`
      : s.kind === 'label'
        ? `label:${s.label.id}`
        : `link:${s.candidate.key}`

/** What a model suggested for a card, each with Add and Dismiss. Nothing changes until you add it. */
export function Suggestions({
  items,
  provider,
  sent,
  today,
  onAccept,
  onReject,
  onAcceptAll,
  onDismiss,
}: {
  items: Suggestion[]
  provider: SuggestProvider
  /** How many related items went with the card, to say so. */
  sent: number
  today: ISODate
  onAccept: (s: Suggestion) => void
  onReject: (s: Suggestion) => void
  onAcceptAll: () => void
  onDismiss: () => void
}) {
  const actions = (s: Suggestion, what: string) => (
    <span className="mr-1 flex shrink-0 gap-0.5">
      <button
        type="button"
        aria-label={`Add ${what}`}
        title="Add"
        onClick={() => onAccept(s)}
        className="flex size-6 items-center justify-center rounded-md text-accent hover:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]"
      >
        <Check size={14} />
      </button>
      <button
        type="button"
        aria-label={`Dismiss ${what}`}
        title="Dismiss"
        onClick={() => onReject(s)}
        className="flex size-6 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"
      >
        <X size={14} />
      </button>
    </span>
  )

  return (
    <section
      aria-label="Suggestions"
      className="rounded-xl border border-[color-mix(in_srgb,var(--label-purple)_30%,transparent)] bg-[color-mix(in_srgb,var(--label-purple)_5%,transparent)]"
    >
      <header className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
        <Sparkles size={13} className="text-[var(--label-purple)]" />
        <h3 className="flex-1 text-[12px] font-semibold">Suggested by {provider.label}</h3>
        {items.length > 1 && (
          <button
            type="button"
            onClick={onAcceptAll}
            className="rounded px-1.5 text-[12px] font-medium text-accent hover:bg-hover"
          >
            Add all
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Close suggestions"
          className="flex size-6 items-center justify-center rounded-md text-ink-3 hover:bg-hover hover:text-ink"
        >
          <X size={13} />
        </button>
      </header>
      {items.length === 0 ? (
        <p className="px-3 pb-3 text-[12px] text-ink-2">No more suggestions for this card.</p>
      ) : (
        <ul className="px-1 pb-1.5">
          {items.map((s) => {
            if (s.kind === 'due')
              return (
                <li key="due" className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover">
                  <span className="min-w-0 flex-1 text-[13px]">
                    Due <strong className="font-semibold">{dayLabel(s.date, today)}</strong>
                    {s.basedOn && <span className="text-ink-2"> · from {s.basedOn.title}</span>}
                  </span>
                  {actions(s, `due date ${s.date}`)}
                </li>
              )
            if (s.kind === 'step')
              return (
                <li
                  key={suggestionKey(s)}
                  className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover"
                >
                  <span className="size-3.5 shrink-0 rounded-[4px] border border-ink-3" aria-hidden="true" />
                  <span className="min-w-0 flex-1 text-[13px]">{s.text}</span>
                  {actions(s, `step “${s.text}”`)}
                </li>
              )
            if (s.kind === 'label')
              return (
                <li
                  key={suggestionKey(s)}
                  className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover"
                >
                  <span
                    className="inline-flex h-[20px] items-center gap-1 rounded-[5px] px-1.5 text-[12px] font-medium"
                    style={chipStyle(s.label.color)}
                  >
                    <span
                      className="size-1.5 rounded-full"
                      style={{ background: labelColor(s.label.color) }}
                    />
                    {s.label.name}
                  </span>
                  <span className="flex-1" />
                  {actions(s, `label ${s.label.name}`)}
                </li>
              )
            return (
              <LinkRow
                key={suggestionKey(s)}
                kind={s.candidate.target.kind}
                title={s.candidate.title}
                detail={s.candidate.detail}
                date={s.candidate.date}
                today={today}
                actions={actions(s, `link to ${s.candidate.title}`)}
              />
            )
          })}
        </ul>
      )}
      <p className="border-t border-[color-mix(in_srgb,var(--label-purple)_18%,transparent)] px-3 py-1.5 text-[11px] text-ink-3">
        {provider.kind === 'local'
          ? `Asked ${provider.label} on this computer about this card and ${sent} related ${sent === 1 ? 'item' : 'items'}.`
          : `Sent this card and ${sent} related ${sent === 1 ? 'title' : 'titles'} to ${provider.vendor ?? provider.label}, under your own account.`}{' '}
        Nothing changes until you add it.
      </p>
    </section>
  )
}
