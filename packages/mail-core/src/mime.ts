import type { AttachmentInfo } from './types'

/** The slice of an IMAP BODYSTRUCTURE node we use; matches imapflow's MessageStructureObject. */
export interface BodyNode {
  part?: string
  type: string
  encoding?: string
  parameters?: Record<string, string>
  id?: string
  size?: number
  disposition?: string
  dispositionParameters?: Record<string, string>
  childNodes?: BodyNode[]
}

/** Which parts of a message to download to show it. */
export interface BodyPlan {
  /** Part number of the HTML body, if any. */
  html: string | null
  /** Part number of the plain-text body, if any. */
  text: string | null
  attachments: AttachmentInfo[]
}

const ATTACHMENT_NAME_MAX = 200

/**
 * A file name from an untrusted message, safe to show and to offer in a save dialog: no folders,
 * no control or bidi characters, no leading dots, not too long.
 */
export function safeFilename(name: string | undefined, fallback = 'attachment'): string {
  const cleaned = (name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/^[\s.]+/, '')
    .trim()
  if (!cleaned) return fallback
  if (cleaned.length <= ATTACHMENT_NAME_MAX) return cleaned
  const dot = cleaned.lastIndexOf('.')
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : ''
  return cleaned.slice(0, ATTACHMENT_NAME_MAX - ext.length) + ext
}

const EXTENSIONS: Record<string, string> = {
  'message/rfc822': '.eml',
  'text/calendar': '.ics',
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
}

const lower = (s: string | undefined) => (s ?? '').toLowerCase()

/**
 * Walk a message's structure and decide what to show: the HTML and plain-text bodies (the
 * first of each that isn't an attachment) and every other part as an attachment. Inline images
 * with a Content-ID are kept as inline attachments, so `cid:` references in the HTML can be shown.
 */
export function planBodyParts(root: BodyNode): BodyPlan {
  const plan: BodyPlan = { html: null, text: null, attachments: [] }
  const visit = (node: BodyNode, isRoot: boolean) => {
    const type = lower(node.type)
    if (node.childNodes?.length) {
      for (const child of node.childNodes) visit(child, false)
      return
    }
    // A single-part message has no part number: its body is part 1.
    const part = node.part ?? (isRoot ? '1' : null)
    if (!part) return
    const disposition = lower(node.disposition)
    const filename = node.dispositionParameters?.['filename'] ?? node.parameters?.['name']
    const isAttachment = disposition === 'attachment' || (Boolean(filename) && !type.startsWith('text/'))
    if (!isAttachment && type === 'text/html' && plan.html === null) {
      plan.html = part
      return
    }
    if (!isAttachment && type === 'text/plain' && plan.text === null) {
      plan.text = part
      return
    }
    if (type.startsWith('multipart/')) return
    // A second text part with no name (a signature, a footer) isn't worth listing as a file.
    if (!isAttachment && type.startsWith('text/') && !filename) return
    const contentId = node.id?.replace(/^<|>$/g, '').trim() || undefined
    const inline = disposition !== 'attachment' && type.startsWith('image/') && Boolean(contentId)
    plan.attachments.push({
      part,
      filename: safeFilename(filename, `attachment${EXTENSIONS[type] ?? ''}`),
      contentType: type || 'application/octet-stream',
      size: node.size ?? 0,
      ...(contentId && { contentId }),
      inline,
    })
  }
  visit(root, true)
  return plan
}

/** Content-IDs the HTML refers to with `cid:` (lower-cased, without angle brackets). */
export function referencedCids(html: string): Set<string> {
  const out = new Set<string>()
  for (const m of html.matchAll(/cid:([^"'\s>)]+)/gi)) {
    try {
      out.add(decodeURIComponent(m[1]!).toLowerCase())
    } catch {
      out.add(m[1]!.toLowerCase())
    }
  }
  return out
}
