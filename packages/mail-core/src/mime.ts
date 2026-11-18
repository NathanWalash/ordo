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
  /** Part numbers of the HTML body, in order (Apple Mail splits it around inline attachments). */
  html: string[]
  /** Part numbers of the plain-text body, in order. */
  text: string[]
  attachments: AttachmentInfo[]
}

/** At most this many attachments are listed, and this many inline images shown, per message. */
export const ATTACHMENTS_MAX = 100
export const INLINE_IMAGES_MAX = 50

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
  const plan: BodyPlan = { html: [], text: [], attachments: [] }
  let inlineImages = 0

  const attach = (node: BodyNode, part: string, type: string) => {
    if (plan.attachments.length >= ATTACHMENTS_MAX) return
    const disposition = lower(node.disposition)
    const filename = node.dispositionParameters?.['filename'] ?? node.parameters?.['name']
    const contentId = node.id?.replace(/^<|>$/g, '').trim() || undefined
    const inline =
      disposition !== 'attachment' &&
      type.startsWith('image/') &&
      Boolean(contentId) &&
      inlineImages < INLINE_IMAGES_MAX
    if (inline) inlineImages++
    plan.attachments.push({
      part,
      filename: safeFilename(filename, `attachment${EXTENSIONS[type] ?? ''}`),
      contentType: type || 'application/octet-stream',
      size: node.size ?? 0,
      ...(contentId && { contentId }),
      inline,
    })
  }

  const visit = (node: BodyNode, isRoot: boolean, into: BodyPlan) => {
    const type = lower(node.type)
    // A single-part message has no part number: its body is part 1.
    const part = node.part ?? (isRoot ? '1' : null)
    // An attached or returned email is a file, whatever is inside it.
    if (type.startsWith('message/')) {
      if (part) attach(node, part, type)
      return
    }
    if (node.childNodes?.length) {
      if (type !== 'multipart/alternative') {
        for (const child of node.childNodes) visit(child, false, into)
        return
      }
      // Alternatives: the last version with HTML and the first with plain text, not all of them.
      const versions = node.childNodes.map((child) => {
        const v: BodyPlan = { html: [], text: [], attachments: [] }
        visit(child, false, v)
        return v
      })
      into.html.push(...([...versions].reverse().find((v) => v.html.length)?.html ?? []))
      into.text.push(...(versions.find((v) => v.text.length)?.text ?? []))
      return
    }
    if (!part) return
    const disposition = lower(node.disposition)
    const filename = node.dispositionParameters?.['filename'] ?? node.parameters?.['name']
    const isAttachment = disposition === 'attachment' || (Boolean(filename) && !type.startsWith('text/'))
    if (!isAttachment && type === 'text/html') into.html.push(part)
    else if (!isAttachment && type === 'text/plain') into.text.push(part)
    else if (!isAttachment && type.startsWith('text/') && !filename) return
    else if (!type.startsWith('multipart/')) attach(node, part, type)
  }
  visit(root, true, plan)
  return plan
}

/** At most this many HTML (and this many plain-text) parts are joined into a body. */
export const BODY_PARTS_MAX = 20

const SHOWN_IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|bmp)$/

/**
 * The inline images to download and show: ones the HTML uses, of a type Ordo shows, that fit
 * the budget by their reported size. Every other "inline" image is marked as an attachment, so
 * it's listed rather than vanishing.
 */
export function chooseInlineImages(
  attachments: AttachmentInfo[],
  used: Set<string>,
  budget: number,
): AttachmentInfo[] {
  const out: AttachmentInfo[] = []
  let left = budget
  for (const a of attachments) {
    if (!a.inline) continue
    const cid = a.contentId?.toLowerCase()
    // Base64 is a third bigger than the image it holds.
    const size = Math.round((a.size * 3) / 4)
    if (!cid || !used.has(cid) || !SHOWN_IMAGE_TYPES.test(a.contentType) || size > left) {
      a.inline = false
      continue
    }
    left -= size
    out.push(a)
  }
  return out
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
