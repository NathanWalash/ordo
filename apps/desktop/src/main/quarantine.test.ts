import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { markAsDownloaded, quarantineValue, ZONE_IDENTIFIER } from './quarantine'

const dir = mkdtempSync(join(tmpdir(), 'ordo-quarantine-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('markAsDownloaded', () => {
  it('builds the macOS quarantine value', () => {
    expect(quarantineValue(new Date(0x6000_0000 * 1000))).toBe('0083;60000000;Ordo;')
  })

  it.runIf(process.platform === 'darwin')('sets com.apple.quarantine on macOS', async () => {
    const file = join(dir, 'invoice.pdf')
    writeFileSync(file, 'x')
    expect(await markAsDownloaded(file)).toBe(true)
    const value = execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', file]).toString().trim()
    expect(value).toMatch(/^0083;[0-9a-f]+;Ordo;$/)
  })

  it.runIf(process.platform === 'win32')('writes the Mark of the Web on Windows', async () => {
    const file = join(dir, 'invoice.pdf')
    writeFileSync(file, 'x')
    expect(await markAsDownloaded(file)).toBe(true)
    expect(readFileSync(`${file}:Zone.Identifier`, 'utf8')).toBe(ZONE_IDENTIFIER)
  })

  it('does nothing, and doesn’t fail, elsewhere or when the file has gone', async () => {
    expect(await markAsDownloaded(join(dir, 'x'), 'linux')).toBe(false)
    expect(await markAsDownloaded(join(dir, 'missing'), process.platform)).toBe(false)
  })
})
