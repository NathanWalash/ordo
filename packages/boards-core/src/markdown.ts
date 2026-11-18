// A small markdown reader for card notes. It produces a tree of plain objects that the UI turns
// into React elements one by one: there is no HTML anywhere, so notes can never inject markup or
// script. Raw HTML in notes is shown as the text it is. Links must be https.

import { safeUrl } from './fields'

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'br' }

export type Block =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: 1 | 2 | 3; children: Inline[] }
  | { type: 'list'; ordered: boolean; items: { checked: boolean | null; children: Inline[] }[] }
  | { type: 'quote'; children: Inline[] }
  | { type: 'code'; text: string }

/** Notes longer than this are cut before parsing; the store limits them anyway. */
export const MAX_NOTES = 20_000

const MAX_DEPTH = 4
const ESCAPABLE = /[\\`*_[\]()#>!-]/
const AUTOLINK = /https:\/\/[^\s<>"'`]+/y

/** Is `c` a character a `_` emphasis may start after (so snake_case isn't italic)? */
const boundary = (c: string | undefined) => c === undefined || /[\s([{"'*~-]/.test(c)

function findClosing(src: string, mark: string, from: number): number {
  for (let j = from; j < src.length; j++) {
    if (src[j] === '\\') {
      j++
      continue
    }
    if (src.startsWith(mark, j) && src[j - 1] !== ' ') {
      if (mark.length === 1 && src[j + 1] === mark) {
        j++ // part of a double marker, not the single closing one
        continue
      }
      return j
    }
  }
  return -1
}

/** The `)` that closes a link target starting at `from`, allowing balanced brackets inside. */
function closingParen(src: string, from: number): number {
  let depth = 0
  // A link is never longer than this, so a run of unclosed `](` stays cheap.
  const end = Math.min(src.length, from + 2048)
  for (let j = from; j < end; j++) {
    const c = src[j]
    if (c === '\n') return -1
    if (c === '(') depth++
    else if (c === ')') {
      if (depth === 0) return j
      depth--
    }
  }
  return -1
}

export function parseInline(src: string, depth = 0, inLink = false): Inline[] {
  // Marks known to have no closer at or after a position. Once a scan from p finds none, a scan
  // from anywhere later can't either, so unclosed marks cost one scan in all, not one each.
  const none = new Map<string, number>()
  const closing = (mark: string, from: number, find: () => number) => {
    if (from >= (none.get(mark) ?? Infinity)) return -1
    const at = find()
    if (at === -1) none.set(mark, Math.min(from, none.get(mark) ?? Infinity))
    return at
  }
  const out: Inline[] = []
  let text = ''
  const flush = () => {
    if (text) out.push({ type: 'text', text })
    text = ''
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    if (c === '\\' && i + 1 < src.length && ESCAPABLE.test(src[i + 1]!)) {
      text += src[i + 1]
      i += 2
      continue
    }
    if (c === '\n') {
      flush()
      out.push({ type: 'br' })
      i++
      continue
    }
    if (c === '`') {
      const end = closing('`', i + 1, () => src.indexOf('`', i + 1))
      if (end > i + 1) {
        flush()
        out.push({ type: 'code', text: src.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    if (depth < MAX_DEPTH && (src.startsWith('**', i) || src.startsWith('__', i))) {
      const mark = src.slice(i, i + 2)
      // The opening rules first: they're cheap, the search for a closer isn't.
      const opens = src[i + 2] !== ' ' && (mark === '**' || boundary(src[i - 1]))
      const end = opens ? closing(mark, i + 2, () => findClosing(src, mark, i + 2)) : -1
      if (end > i + 2) {
        flush()
        out.push({ type: 'strong', children: parseInline(src.slice(i + 2, end), depth + 1, inLink) })
        i = end + 2
        continue
      }
    }
    if (depth < MAX_DEPTH && (c === '*' || c === '_') && src[i + 1] !== c) {
      const opens = src[i + 1] !== ' ' && (c === '*' || boundary(src[i - 1]))
      const end = opens ? closing(c, i + 1, () => findClosing(src, c, i + 1)) : -1
      if (end > i + 1) {
        flush()
        out.push({ type: 'em', children: parseInline(src.slice(i + 1, end), depth + 1, inLink) })
        i = end + 1
        continue
      }
    }
    if (!inLink && c === '[') {
      const mid = closing('](', i + 1, () => src.indexOf('](', i + 1))
      const close = mid > i ? closingParen(src, mid + 2) : -1
      if (mid > i + 1 && close > mid + 2 && !src.slice(i + 1, mid).includes('\n')) {
        const href = safeUrl(src.slice(mid + 2, close).trim())
        const label = src.slice(i + 1, mid)
        flush()
        if (href) out.push({ type: 'link', href, children: parseInline(label, depth + 1, true) })
        else out.push(...parseInline(label, depth + 1, true))
        i = close + 1
        continue
      }
    }
    if (!inLink && c === 'h' && boundary(src[i - 1])) {
      AUTOLINK.lastIndex = i
      const m = AUTOLINK.exec(src)
      if (m) {
        // Leave trailing punctuation outside the link, as people write "see https://x.example."
        const raw = m[0].replace(/[.,;:!?)\]]+$/, '')
        const href = safeUrl(raw)
        if (href) {
          flush()
          out.push({ type: 'link', href, children: [{ type: 'text', text: raw }] })
          i += raw.length
          continue
        }
      }
    }
    text += c
    i++
  }
  flush()
  return out
}

// `s`: `.` takes every character, so nothing on a line can stop these matching it whole.
const LIST_ITEM = /^\s{0,3}(?:([-*+])|(\d{1,3})[.)])\s+(.*)$/s
const TASK = /^\[( |x|X)\]\s+(.*)$/s
const HEADING = /^\s{0,3}(#{1,3})\s+(.*)$/s

/** Split notes into blocks: paragraphs, headings, lists, quotes and fenced code. */
export function parseMarkdown(source: string): Block[] {
  // Unicode line and paragraph separators (and NEL) are line breaks too.
  const lines = source
    .slice(0, MAX_NOTES)
    .replace(/\r\n?|[\u0085\u2028\u2029]/g, '\n')
    .split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) {
      i++
      continue
    }
    if (/^\s{0,3}```/.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s{0,3}```/.test(lines[i]!)) body.push(lines[i++]!)
      i++ // the closing fence, if there is one
      blocks.push({ type: 'code', text: body.join('\n') })
      continue
    }
    const heading = HEADING.exec(line)
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1]!.length as 1 | 2 | 3,
        children: parseInline(heading[2]!.replace(/\s#+\s*$/, '').trim()),
      })
      i++
      continue
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!))
        body.push(lines[i++]!.replace(/^\s{0,3}>\s?/, ''))
      blocks.push({ type: 'quote', children: parseInline(body.join('\n')) })
      continue
    }
    const first = LIST_ITEM.exec(line)
    if (first) {
      const ordered = first[2] !== undefined
      const items: { checked: boolean | null; children: Inline[] }[] = []
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]!)
        if (!m || (m[2] !== undefined) !== ordered) break
        const task = TASK.exec(m[3]!)
        items.push(
          task
            ? { checked: task[1] !== ' ', children: parseInline(task[2]!) }
            : { checked: null, children: parseInline(m[3]!) },
        )
        i++
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }
    const body: string[] = []
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !LIST_ITEM.test(lines[i]!) &&
      !/^\s{0,3}(#{1,3}\s|>|```)/.test(lines[i]!)
    )
      body.push(lines[i++]!)
    // Every block takes at least one line, so a line no rule above wanted can't stall the loop.
    if (body.length === 0) body.push(lines[i++]!)
    blocks.push({ type: 'paragraph', children: parseInline(body.join('\n')) })
  }
  return blocks
}

/** The notes as plain text, markup removed: for search and the AI prompt. */
export function plainText(blocks: Block[]): string {
  const inline = (xs: Inline[]): string =>
    xs
      .map((x) =>
        x.type === 'text' || x.type === 'code' ? x.text : x.type === 'br' ? '\n' : inline(x.children),
      )
      .join('')
  return blocks
    .map((b) =>
      b.type === 'code'
        ? b.text
        : b.type === 'list'
          ? b.items.map((it) => `- ${inline(it.children)}`).join('\n')
          : inline(b.children),
    )
    .join('\n')
}
