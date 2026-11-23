import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_UPDATE_STORE, readUpdateStore, updateUpdateStore } from './store'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ordo-updates-'))
  file = join(dir, 'nested', 'updates.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('update store', () => {
  it('starts with checks on, never checked and nothing skipped', () => {
    expect(readUpdateStore(file)).toEqual({ checksEnabled: true, lastCheckedAt: null, skippedVersion: null })
  })

  it('merges changes and writes them atomically', () => {
    updateUpdateStore(file, { skippedVersion: '0.2.0' })
    const next = updateUpdateStore(file, { checksEnabled: false })
    expect(next).toEqual({ checksEnabled: false, lastCheckedAt: null, skippedVersion: '0.2.0' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(next)
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })

  it('falls back to defaults for a corrupt file or bad fields', () => {
    updateUpdateStore(file, {})
    for (const bad of ['{nope', '', 'null', '[]']) {
      writeFileSync(file, bad)
      expect(readUpdateStore(file)).toEqual(DEFAULT_UPDATE_STORE)
    }
    writeFileSync(file, JSON.stringify({ checksEnabled: 'yes', lastCheckedAt: 5, skippedVersion: '../../x' }))
    expect(readUpdateStore(file)).toEqual(DEFAULT_UPDATE_STORE)
  })

  it('keeps the good fields when one is bad', () => {
    updateUpdateStore(file, {})
    writeFileSync(file, JSON.stringify({ checksEnabled: false, skippedVersion: 7 }))
    expect(readUpdateStore(file)).toEqual({ checksEnabled: false, lastCheckedAt: null, skippedVersion: null })
  })

  it('refuses to save an invalid skipped version', () => {
    expect(() => updateUpdateStore(file, { skippedVersion: 'not a version' })).toThrow()
    expect(existsSync(file)).toBe(false)
  })
})
