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
  try {
    // ignoreBOM: false (the default) drops a UTF-8 byte order mark.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}
