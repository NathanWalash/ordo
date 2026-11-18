import DOMPurify from 'dompurify'

/**
 * Email HTML, made safe to show in the message frame. Layered:
 *
 * 1. DOMPurify removes scripts, event handlers, forms, frames, embeds and anything else that
 *    can run code or submit data.
 * 2. Remote images are cut off unless the user chose Load images, and then come from the main
 *    process as data: URLs, so the frame itself never connects anywhere (no tracking pixels).
 * 3. The document gets a Content-Security-Policy that allows no scripts, no connections and no
 *    remote images, fonts or styles, on top of the app's own policy.
 * 4. It's shown in an <iframe sandbox> without allow-scripts, allow-forms, allow-popups or
 *    top navigation; links are handled by the window (see MessageFrame), and the main process
 *    cancels any request to load a page into the frame (blockFrameLoads in main).
 */

export const MESSAGE_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'"

const FORBID_TAGS = [
  'script',
  'form',
  'input',
  'button',
  'select',
  'option',
  'textarea',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'video',
  'audio',
  'source',
  'track',
  'picture',
  'link',
  'meta',
  'base',
  'svg',
  'math',
  'template',
  'noscript',
  'portal',
  'dialog',
]

const FORBID_ATTR = [
  'srcset',
  'background',
  'poster',
  'action',
  'formaction',
  'ping',
  'target',
  'lowsrc',
  'dynsrc',
]

const BASE_STYLE = `
html { background: #fff; }
body { margin: 0; padding: 16px 20px; color: #1d1d1f; background: #fff;
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  overflow-wrap: break-word; }
img { max-width: 100%; height: auto; }
img[data-ordo-blocked] { display: inline-block; min-width: 1px; min-height: 1px;
  background: repeating-linear-gradient(45deg, #f2f2f2, #f2f2f2 6px, #e8e8e8 6px, #e8e8e8 12px); }
pre { white-space: pre-wrap; }
a { color: #0068d6; }
`

export interface SanitiseOptions {
  /** Inline images from the message, by Content-ID (lower-case, no angle brackets). */
  inline: Record<string, string>
  /** Remote images the main process has fetched, by URL. Missing ones stay blocked. */
  loaded: Record<string, string>
}

export interface SanitisedEmail {
  /** A whole document for the frame's srcdoc. */
  html: string
  /** Remote image URLs that weren't shown. */
  blocked: string[]
}

/** A remote image address, made absolute (`//host` means https), or null if it isn't one. */
export function remoteUrl(src: string): string | null {
  const s = src.trim()
  if (/^https?:\/\//i.test(s)) return s
  if (s.startsWith('//')) return `https:${s}`
  return null
}

const SAFE_HREF = /^(https?:|mailto:)/i

export function sanitiseEmail(html: string, opts: SanitiseOptions): SanitisedEmail {
  const purify = DOMPurify(window)
  const root = purify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    FORBID_TAGS,
    FORBID_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
  }) as HTMLElement
  const doc = root.ownerDocument

  const blocked = new Set<string>()
  for (const img of Array.from(root.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? ''
    if (/^cid:/i.test(src)) {
      let cid = src.slice(4)
      try {
        cid = decodeURIComponent(cid)
      } catch {
        // Keep it as written.
      }
      const data = opts.inline[cid.toLowerCase()]
      if (data) img.setAttribute('src', data)
      else img.removeAttribute('src')
      continue
    }
    if (/^data:image\//i.test(src)) continue
    const remote = remoteUrl(src)
    img.removeAttribute('src')
    if (!remote) continue
    const data = opts.loaded[remote]
    if (data) img.setAttribute('src', data)
    else {
      blocked.add(remote)
      img.setAttribute('data-ordo-blocked', '')
      // Keep the layout roughly right without loading anything.
      if (!img.getAttribute('alt')) img.setAttribute('alt', '')
    }
  }

  for (const a of Array.from(root.querySelectorAll('a, area'))) {
    const href = a.getAttribute('href') ?? ''
    if (!SAFE_HREF.test(href.trim())) a.removeAttribute('href')
    a.setAttribute('rel', 'noreferrer noopener')
  }

  let head = root.querySelector('head')
  if (!head) {
    head = doc.createElement('head')
    root.insertBefore(head, root.firstChild)
  }
  const style = doc.createElement('style')
  style.textContent = BASE_STYLE
  head.insertBefore(style, head.firstChild)
  const csp = doc.createElement('meta')
  csp.setAttribute('http-equiv', 'Content-Security-Policy')
  csp.setAttribute('content', MESSAGE_CSP)
  head.insertBefore(csp, head.firstChild)
  const charset = doc.createElement('meta')
  charset.setAttribute('charset', 'utf-8')
  head.insertBefore(charset, head.firstChild)

  return { html: `<!doctype html>${root.outerHTML}`, blocked: [...blocked] }
}
