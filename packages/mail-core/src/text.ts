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

/** At most this much HTML is turned into text; the rest of a huge email is left out. */
export const HTML_TEXT_MAX = 256 * 1024

/** Elements whose content is never text: skipped up to their closing tag. */
const RAW = new Set(['head', 'script', 'style', 'title', 'template', 'noscript', 'textarea', 'xmp'])
/** Elements that start or end a line. */
const BLOCK = new Set([
  'p',
  'div',
  'tr',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'blockquote',
  'table',
  'section',
  'article',
  'header',
  'footer',
  'pre',
  'hr',
])

const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i

/**
 * Plain text from an email's HTML: paragraphs and line breaks kept, everything else dropped.
 *
 * A single pass that finds each closing marker with indexOf from where it is, so its time grows
 * with the length of the input whatever the input is (no regex backtracking over unclosed
 * comments or tags). An unclosed comment, tag or raw-text element drops the rest of the input.
 */
export function htmlToText(html: string, opts: HtmlToTextOptions = {}): string {
  // Link addresses are marked with OPEN…CLOSE so they survive as text, then become <…>.
  const src = (html.length > HTML_TEXT_MAX ? html.slice(0, HTML_TEXT_MAX) : html)
    .split(OPEN)
    .join('')
    .split(CLOSE)
    .join('')
  const lower = src.toLowerCase()
  const out: string[] = []
  let link: { href: string; from: number } | null = null
  let i = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt === -1) {
      out.push(src.slice(i))
      break
    }
    if (lt > i) out.push(src.slice(i, lt))
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      if (end === -1) break
      i = end + 3
      continue
    }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(src.slice(lt, lt + 40))
    if (!m && src[lt + 1] !== '!' && src[lt + 1] !== '?') {
      // Not a tag ("1 < 2"): a literal "<".
      out.push('<')
      i = lt + 1
      continue
    }
    const gt = src.indexOf('>', lt + 1)
    if (gt === -1) break
    i = gt + 1
    if (!m) continue // <!doctype>, <?xml?>
    const closing = m[1] === '/'
    const name = m[2]!.toLowerCase()
    if (!closing && RAW.has(name)) {
      const end = lower.indexOf(`</${name}`, gt + 1)
      if (end === -1) break
      const endGt = src.indexOf('>', end)
      i = endGt === -1 ? src.length : endGt + 1
      continue
    }
    if (name === 'br') out.push('\n')
    else if (name === 'li' && !closing) out.push('\n• ')
    else if (BLOCK.has(name)) out.push('\n')
    else if ((name === 'td' || name === 'th') && closing) out.push(' ')
    else if (name === 'a' && opts.links) {
      if (!closing) {
        const h = HREF.exec(src.slice(lt, gt))
        const href = h ? decodeEntities(h[1] ?? h[2] ?? h[3] ?? '').trim() : ''
        link = /^https?:\/\//i.test(href) ? { href, from: out.length } : null
      } else if (link) {
        const text = decodeEntities(out.slice(link.from).join('')).trim()
        const href = link.href
        if (text && text.replace(/\/$/, '') !== href.replace(/\/$/, '')) out.push(` ${OPEN}${href}${CLOSE}`)
        link = null
      }
    }
  }
  return tidy(decodeEntities(out.join(''))).split(OPEN).join('<').split(CLOSE).join('>')
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
