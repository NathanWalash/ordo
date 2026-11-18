// Decoding message parts ourselves, from the BODYSTRUCTURE the server reported. Node only
// (Buffer). Some servers answer BODY[n.MIME] for nested parts wrongly, so a part's encoding and
// charset come from BODYSTRUCTURE rather than from a second fetch of its headers.
import type { BodyNode } from './mime'

const lower = (s: string | undefined) => (s ?? '').toLowerCase()

/** Undo quoted-printable encoding (RFC 2045): `=XX` bytes and `=` soft line breaks. */
export function decodeQuotedPrintable(raw: Uint8Array): Uint8Array {
  const out = new Uint8Array(raw.length)
  let n = 0
  const hex = (c: number) =>
    c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!
    if (c !== 61 /* = */) {
      out[n++] = c
      continue
    }
    // Soft line break: "=\r\n" or "=\n", possibly with trailing spaces before it.
    let j = i + 1
    while (j < raw.length && (raw[j] === 32 || raw[j] === 9)) j++
    if (raw[j] === 13 && raw[j + 1] === 10) {
      i = j + 1
      continue
    }
    if (raw[j] === 10) {
      i = j
      continue
    }
    const hi = hex(raw[i + 1] ?? -1)
    const lo = hex(raw[i + 2] ?? -1)
    if (hi >= 0 && lo >= 0) {
      out[n++] = hi * 16 + lo
      i += 2
    } else out[n++] = c
  }
  return out.slice(0, n)
}

/** A part's bytes with its Content-Transfer-Encoding removed. */
export function decodeTransfer(raw: Uint8Array, encoding: string | undefined): Buffer {
  switch (lower(encoding)) {
    case 'base64':
      return Buffer.from(
        Buffer.from(raw)
          .toString('latin1')
          .replace(/[^A-Za-z0-9+/=]/g, ''),
        'base64',
      )
    case 'quoted-printable':
      return Buffer.from(decodeQuotedPrintable(raw))
    default:
      return Buffer.from(raw)
  }
}

/** Text in its declared charset as a string; unknown charsets are read as UTF-8. */
export function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  const label = lower(charset).trim() || 'utf-8'
  try {
    return new TextDecoder(label === 'us-ascii' || label === 'ascii' ? 'windows-1252' : label).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/**
 * Join format=flowed lines (RFC 3676): a line ending in a space continues on the next one,
 * except the signature separator "-- ". With DelSp=yes that space is removed too.
 */
export function unflow(text: string, delSp: boolean): string {
  const out: string[] = []
  let cur: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const soft = line.endsWith(' ') && line !== '-- '
    const piece = soft && delSp ? line.slice(0, -1) : line
    cur = cur === null ? piece : cur + piece
    if (!soft) {
      out.push(cur)
      cur = null
    }
  }
  if (cur !== null) out.push(cur)
  return out.join('\n')
}

/** A text part's raw bytes (still transfer-encoded) as a string, per its BODYSTRUCTURE entry. */
export function decodeTextPart(
  raw: Uint8Array,
  node: { encoding?: string; parameters?: Record<string, string> },
): string {
  const text = decodeCharset(decodeTransfer(raw, node.encoding), node.parameters?.['charset'])
  return lower(node.parameters?.['format']) === 'flowed'
    ? unflow(text, lower(node.parameters?.['delsp']) === 'yes')
    : text
}

/** The BODYSTRUCTURE entry for one part number. */
export function findPart(root: BodyNode, part: string): BodyNode | null {
  if ((root.part ?? '1') === part && !root.childNodes?.length) return root
  for (const child of root.childNodes ?? []) {
    const found = findPart(child, part)
    if (found) return found
  }
  return null
}
