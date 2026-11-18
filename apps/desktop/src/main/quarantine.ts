import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** macOS's quarantine value: "downloaded by an app", now, by Ordo (see LSQuarantine). */
export function quarantineValue(now = new Date()): string {
  return `0083;${Math.floor(now.getTime() / 1000).toString(16)};Ordo;`
}

/** The Windows Mark of the Web: the file came from the internet zone. */
export const ZONE_IDENTIFIER = '[ZoneTransfer]\r\nZoneId=3\r\n'

/**
 * Mark a file saved from an email as downloaded, as a browser would, so the system warns before
 * opening it: the `com.apple.quarantine` attribute on macOS (Gatekeeper), the Zone.Identifier
 * stream on Windows (SmartScreen, Office Protected View). Elsewhere there's nothing to set.
 * Never throws: the file is saved either way.
 */
export async function markAsDownloaded(path: string, platform = process.platform): Promise<boolean> {
  try {
    if (platform === 'darwin') {
      await run('/usr/bin/xattr', ['-w', 'com.apple.quarantine', quarantineValue(), path])
      return true
    }
    if (platform === 'win32') {
      await writeFile(`${path}:Zone.Identifier`, ZONE_IDENTIFIER)
      return true
    }
  } catch {
    // A file system without extended attributes or streams: nothing more to do.
  }
  return false
}
