import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_AI_SETTINGS } from '@ordo/shared'
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
    expect(readSettings(file)).toEqual({ theme: 'system', ai: DEFAULT_AI_SETTINGS })
  })

  it('reads what was saved', () => {
    writeSettings(file, { theme: 'dark', ai: DEFAULT_AI_SETTINGS })
    expect(readSettings(file)).toEqual({ theme: 'dark', ai: DEFAULT_AI_SETTINGS })
  })

  it('falls back to the defaults for a corrupt or wrongly shaped file', () => {
    for (const bad of ['{not json', '', 'null', '"dark"', '[1,2]']) {
      writeFileSync(file, bad)
      expect(readSettings(file)).toEqual({ theme: 'system', ai: DEFAULT_AI_SETTINGS })
    }
  })

  it('replaces an invalid field with its default and drops unknown keys', () => {
    writeFileSync(file, JSON.stringify({ theme: 'sepia', extra: 1 }))
    expect(readSettings(file)).toEqual({ theme: 'system', ai: DEFAULT_AI_SETTINGS })
  })
})

describe('writeSettings', () => {
  it('creates the folder, writes readable JSON and leaves no temp file', () => {
    const nested = join(dir, 'a', 'settings.json')
    writeSettings(nested, { theme: 'light', ai: DEFAULT_AI_SETTINGS })
    expect(JSON.parse(readFileSync(nested, 'utf8'))).toEqual({ theme: 'light', ai: DEFAULT_AI_SETTINGS })
    expect(existsSync(`${nested}.tmp`)).toBe(false)
  })

  it('refuses to save invalid settings', () => {
    expect(() => writeSettings(file, { theme: 'sepia' } as never)).toThrow()
    expect(existsSync(file)).toBe(false)
  })
})

describe('updateSettings', () => {
  it('merges a change into the saved settings and returns them', () => {
    expect(updateSettings(file, { theme: 'dark' })).toEqual({ theme: 'dark', ai: DEFAULT_AI_SETTINGS })
    expect(updateSettings(file, {})).toEqual({ theme: 'dark', ai: DEFAULT_AI_SETTINGS })
    expect(readSettings(file)).toEqual({ theme: 'dark', ai: DEFAULT_AI_SETTINGS })
  })

  it('rejects a bad change without touching the file', () => {
    writeSettings(file, { theme: 'light', ai: DEFAULT_AI_SETTINGS })
    expect(() => updateSettings(file, { theme: 'neon' } as never)).toThrow()
    expect(() => updateSettings(file, { theme: 'dark', other: 1 } as never)).toThrow()
    expect(readSettings(file)).toEqual({ theme: 'light', ai: DEFAULT_AI_SETTINGS })
  })

  it('recovers from a corrupt file on the next change', () => {
    writeFileSync(file, '{oops')
    expect(updateSettings(file, { theme: 'dark' })).toEqual({ theme: 'dark', ai: DEFAULT_AI_SETTINGS })
    expect(readSettings(file)).toEqual({ theme: 'dark', ai: DEFAULT_AI_SETTINGS })
  })
})

describe('AI settings', () => {
  const lmStudio = {
    provider: 'lmstudio',
    model: 'openai/gpt-oss-20b',
    sortSenders: true,
    cloudConsent: null,
  } as const

  it('migrates a file from before AI settings existed to AI off', () => {
    writeFileSync(file, JSON.stringify({ theme: 'dark' }))
    expect(readSettings(file)).toEqual({ theme: 'dark', ai: DEFAULT_AI_SETTINGS })
    expect(DEFAULT_AI_SETTINGS).toEqual({
      provider: 'none',
      model: null,
      sortSenders: false,
      cloudConsent: null,
    })
  })

  it('saves a local provider without any consent', () => {
    expect(updateSettings(file, { ai: lmStudio }).ai).toEqual(lmStudio)
    expect(readSettings(file)).toEqual({ theme: 'system', ai: lmStudio })
  })

  it('refuses a cloud provider without consent for that provider', () => {
    const claude = { provider: 'claude-cli', model: 'haiku', sortSenders: true } as const
    expect(() => updateSettings(file, { ai: { ...claude, cloudConsent: null } })).toThrow()
    expect(() => updateSettings(file, { ai: { ...claude, cloudConsent: 'codex-cli' } })).toThrow()
    expect(updateSettings(file, { ai: { ...claude, cloudConsent: 'claude-cli' } }).ai.provider).toBe(
      'claude-cli',
    )
  })

  it('turns AI off when the saved AI settings are invalid, keeping the theme', () => {
    for (const ai of [
      { provider: 'claude-cli', model: null, sortSenders: true, cloudConsent: null },
      { provider: 'gpt-9', model: null, sortSenders: true, cloudConsent: null },
      { provider: 'lmstudio', model: 3, sortSenders: 'yes', cloudConsent: null },
      'lmstudio',
    ]) {
      writeFileSync(file, JSON.stringify({ theme: 'light', ai }))
      expect(readSettings(file)).toEqual({ theme: 'light', ai: DEFAULT_AI_SETTINGS })
    }
  })

  it('rejects unknown keys inside the AI settings', () => {
    expect(() => updateSettings(file, { ai: { ...lmStudio, apiKey: 'sk-x' } as never })).toThrow()
  })
})
