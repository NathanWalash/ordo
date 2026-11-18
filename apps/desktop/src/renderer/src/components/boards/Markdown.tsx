import { Fragment, useMemo, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import { linkHostNote, parseMarkdown, type Inline } from '@ordo/boards-core'

const textOf = (nodes: Inline[]): string =>
  nodes
    .map((n) =>
      n.type === 'text' || n.type === 'code' ? n.text : n.type === 'br' ? ' ' : textOf(n.children),
    )
    .join('')

/**
 * Card notes, drawn from the parsed tree element by element. No HTML is ever inserted, so notes
 * can't add markup or script; links are https only and open in the browser.
 */
export function Markdown({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdown(source), [source])
  return (
    <div className="space-y-2 text-[13px] leading-relaxed select-text">
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'heading': {
            const size = b.level === 1 ? 'text-[15px]' : 'text-[13px]'
            return (
              <p key={i} role="heading" aria-level={b.level + 2} className={`${size} font-semibold`}>
                <Inlines nodes={b.children} />
              </p>
            )
          }
          case 'paragraph':
            return (
              <p key={i}>
                <Inlines nodes={b.children} />
              </p>
            )
          case 'quote':
            return (
              <blockquote key={i} className="border-l-2 border-sep pl-3 text-ink-2">
                <Inlines nodes={b.children} />
              </blockquote>
            )
          case 'code':
            return (
              <pre key={i} className="overflow-x-auto rounded-md bg-hover px-3 py-2 font-mono text-[12px]">
                {b.text}
              </pre>
            )
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul'
            const tasks = b.items.some((it) => it.checked !== null)
            return (
              <Tag
                key={i}
                className={
                  tasks ? 'space-y-0.5' : `${b.ordered ? 'list-decimal' : 'list-disc'} space-y-0.5 pl-5`
                }
              >
                {b.items.map((it, j) => (
                  <li key={j} className={tasks ? 'flex items-start gap-2' : ''}>
                    {tasks && it.checked === null && (
                      <span className="flex size-3.5 shrink-0 items-center justify-center" aria-hidden="true">
                        <span className="mt-[8px] size-1 rounded-full bg-ink-2" />
                      </span>
                    )}
                    {it.checked !== null && (
                      <span
                        role="img"
                        aria-label={it.checked ? 'Done' : 'Not done'}
                        className="mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border border-ink-2 text-ink-2"
                      >
                        {it.checked && <Check size={10} strokeWidth={3} />}
                      </span>
                    )}
                    <span className={it.checked ? 'text-ink-2 line-through' : ''}>
                      <Inlines nodes={it.children} />
                    </span>
                  </li>
                ))}
              </Tag>
            )
          }
        }
      })}
    </div>
  )
}

function Inlines({ nodes }: { nodes: Inline[] }): ReactNode {
  return nodes.map((n, i) => {
    switch (n.type) {
      case 'text':
        return <Fragment key={i}>{n.text}</Fragment>
      case 'br':
        return <br key={i} />
      case 'code':
        return (
          <code key={i} className="rounded bg-hover px-1 py-px font-mono text-[12px]">
            {n.text}
          </code>
        )
      case 'strong':
        return (
          <strong key={i} className="font-semibold">
            <Inlines nodes={n.children} />
          </strong>
        )
      case 'em':
        return (
          <em key={i}>
            <Inlines nodes={n.children} />
          </em>
        )
      case 'link': {
        // Words that look like another address than the link's, or an international host, get the
        // real host beside them.
        const note = linkHostNote(n.href, textOf(n.children))
        // The main process only ever opens https links, in the browser.
        return (
          <Fragment key={i}>
            <a
              href={n.href}
              target="_blank"
              rel="noreferrer noopener"
              title={n.href}
              className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
              onClick={(e) => e.stopPropagation()}
            >
              <Inlines nodes={n.children} />
            </a>
            {note && <span className="text-[12px] text-ink-2"> ({note})</span>}
          </Fragment>
        )
      }
    }
  })
}
