/**
 * Turn a statement file's bytes into text. Banks and spreadsheets save CSVs as UTF-8 (with or
 * without a byte order mark), as UTF-16 (Excel's "Unicode text") or in the Windows code page
 * (Excel's "CSV (Comma delimited)" on Windows, where £ is the single byte 0xA3). Reading them all
 * as UTF-8 turned UTF-16 into unreadable text and every £ amount into an unreadable cell.
 */
export function decodeStatement(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  // UTF-16 without a byte order mark: ASCII text with every other byte zero.
  const sample = bytes.subarray(0, 512)
  if (sample.length >= 4) {
    let evenZeros = 0
    let oddZeros = 0
    for (let i = 0; i < sample.length; i++) {
      if (sample[i] !== 0) continue
      if (i % 2) oddZeros++
      else evenZeros++
    }
    const half = sample.length / 2
    if (oddZeros > half * 0.6 && evenZeros < half * 0.1) return new TextDecoder('utf-16le').decode(bytes)
    if (evenZeros > half * 0.6 && oddZeros < half * 0.1) return new TextDecoder('utf-16be').decode(bytes)
  }
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body)
  } catch {
    return utf8OrWindows(body)
  }
}

/**
 * Text that isn't all valid UTF-8: valid UTF-8 sequences are read as UTF-8 and each byte that
 * isn't part of one as the Windows code page. A Windows file comes out as the Windows code page,
 * and one stray byte in a UTF-8 file no longer turns all of its `Café` and `€` into mojibake.
 */
function utf8OrWindows(bytes: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8', { ignoreBOM: true })
  const windows = new TextDecoder('windows-1252')
  const parts: string[] = []
  let run = 0
  for (let i = 0; i < bytes.length;) {
    const n = sequenceLength(bytes, i)
    if (n) {
      i += n
      continue
    }
    parts.push(utf8.decode(bytes.subarray(run, i)), windows.decode(bytes.subarray(i, i + 1)))
    run = ++i
  }
  parts.push(utf8.decode(bytes.subarray(run)))
  return parts.join('')
}

/** The length of the valid UTF-8 sequence starting at `i`, or 0 if there isn't one. */
function sequenceLength(b: Uint8Array, i: number): number {
  const c = b[i]!
  const cont = (j: number, lo = 0x80, hi = 0xbf) =>
    b[i + j] !== undefined && b[i + j]! >= lo && b[i + j]! <= hi
  if (c < 0x80) return 1
  if (c >= 0xc2 && c <= 0xdf) return cont(1) ? 2 : 0
  if (c >= 0xe0 && c <= 0xef) {
    const [lo, hi] = c === 0xe0 ? [0xa0, 0xbf] : c === 0xed ? [0x80, 0x9f] : [0x80, 0xbf]
    return cont(1, lo, hi) && cont(2) ? 3 : 0
  }
  if (c >= 0xf0 && c <= 0xf4) {
    const [lo, hi] = c === 0xf0 ? [0x90, 0xbf] : c === 0xf4 ? [0x80, 0x8f] : [0x80, 0xbf]
    return cont(1, lo, hi) && cont(2) && cont(3) ? 4 : 0
  }
  return 0
}
