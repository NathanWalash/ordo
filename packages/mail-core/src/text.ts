// Turning email HTML into plain text, for search, replies and the headless `mail read`.
// Pure string code (no DOM): the main process and headless mode have none. It only ever
// produces text; nothing it returns is rendered as HTML.

const NAMED: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  pound: '£',
  euro: '€',
  cent: '¢',
  yen: '¥',
  bull: '•',
  middot: '·',
  deg: '°',
  times: '×',
  divide: '÷',
  zwnj: '',
  zwj: '',
  shy: '',
  ensp: ' ',
  emsp: ' ',
  thinsp: ' ',
}

/** Decode HTML character references (named ones we know, and every numeric one). */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
        return ''
      return String.fromCodePoint(code)
    }
    const named = NAMED[ref.toLowerCase()]
    return named ?? whole
  })
}

export interface HtmlToTextOptions {
  /** Add a link's address after its text, `text <https://…>`, when they differ. Default false. */
  links?: boolean
}

const OPEN = String.fromCharCode(1)
const CLOSE = String.fromCharCode(2)

/** Plain text from an email's HTML: paragraphs and line breaks kept, everything else dropped. */
export function htmlToText(html: string, opts: HtmlToTextOptions = {}): string {
  // Link addresses are marked with OPEN…CLOSE so stripping tags leaves them alone.
  let s = html
    .split(OPEN)
    .join('')
    .split(CLOSE)
    .join('')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|script|style|title|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(head|script|style|title)\b[^>]*\/?>/gi, '')
  if (opts.links)
    s = s.replace(
      /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi,
      (...m) => {
        const href = decodeEntities(String(m[2] ?? m[3] ?? m[4] ?? '')).trim()
        const inner = String(m[5] ?? '')
        const text = decodeEntities(inner.replace(/<[^>]*>/g, '')).trim()
        if (
          !/^https?:\/\//i.test(href) ||
          !text ||
          text === href ||
          text.replace(/\/$/, '') === href.replace(/\/$/, '')
        )
          return inner
        return `${inner} ${OPEN}${href}${CLOSE}`
      },
    )
  s = s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(p|div|tr|h[1-6]|ul|ol|blockquote|table|section|article|header|footer|pre)\s*>/gi, '\n')
    .replace(/<(p|div|tr|h[1-6]|ul|ol|blockquote|table|section|article|header|footer|pre|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(td|th)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, '')
  return tidy(decodeEntities(s)).split(OPEN).join('<').split(CLOSE).join('>')
}

/** Collapse runs of spaces, trim each line and allow at most one blank line in a row. */
export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The text to show, quote or search: the plain-text body, or the HTML turned into text. */
export function bodyText(
  content: { text: string | null; html: string | null },
  opts: HtmlToTextOptions = {},
) {
  if (content.text?.trim()) return tidy(content.text)
  if (content.html) return htmlToText(content.html, opts)
  return ''
}

// C0 (except tab and newline), DEL, C1, and bidi overrides/isolates.
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g

/** Text from an email, safe to print in a terminal: control characters and bidi overrides removed. */
export function printable(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(UNSAFE_TEXT, '')
}
