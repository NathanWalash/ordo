import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readSettings, updateSettings, writeSettings } from './settings'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ordo-settings-'))
  file = join(dir, 'settings.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('readSettings', () => {
  it('gives the defaults when there is no file yet', () => {
    expect(readSettings(file)).toEqual({ theme: 'system' })
  })

  it('reads what was saved', () => {
    writeSettings(file, { theme: 'dark' })
    expect(readSettings(file)).toEqual({ theme: 'dark' })
  })

  it('falls back to the defaults for a corrupt or wrongly shaped file', () => {
    for (const bad of ['{not json', '', 'null', '"dark"', '[1,2]']) {
      writeFileSync(file, bad)
      expect(readSettings(file)).toEqual({ theme: 'system' })
    }
  })

  it('replaces an invalid field with its default and drops unknown keys', () => {
    writeFileSync(file, JSON.stringify({ theme: 'sepia', extra: 1 }))
    expect(readSettings(file)).toEqual({ theme: 'system' })
  })
})

describe('writeSettings', () => {
  it('creates the folder, writes readable JSON and leaves no temp file', () => {
    const nested = join(dir, 'a', 'settings.json')
    writeSettings(nested, { theme: 'light' })
    expect(JSON.parse(readFileSync(nested, 'utf8'))).toEqual({ theme: 'light' })
    expect(existsSync(`${nested}.tmp`)).toBe(false)
  })

  it('refuses to save invalid settings', () => {
    expect(() => writeSettings(file, { theme: 'sepia' } as never)).toThrow()
    expect(existsSync(file)).toBe(false)
  })
})

describe('updateSettings', () => {
  it('merges a change into the saved settings and returns them', () => {
    expect(updateSettings(file, { theme: 'dark' })).toEqual({ theme: 'dark' })
    expect(updateSettings(file, {})).toEqual({ theme: 'dark' })
    expect(readSettings(file)).toEqual({ theme: 'dark' })
  })

  it('rejects a bad change without touching the file', () => {
    writeSettings(file, { theme: 'light' })
    expect(() => updateSettings(file, { theme: 'neon' } as never)).toThrow()
    expect(() => updateSettings(file, { theme: 'dark', other: 1 } as never)).toThrow()
    expect(readSettings(file)).toEqual({ theme: 'light' })
  })

  it('recovers from a corrupt file on the next change', () => {
    writeFileSync(file, '{oops')
    expect(updateSettings(file, { theme: 'dark' })).toEqual({ theme: 'dark' })
    expect(readSettings(file)).toEqual({ theme: 'dark' })
  })
})
