import { describe, expect, it } from 'vitest'
import { AI_IPC, DEFAULT_AI_SETTINGS, IPC } from './index'
import { DEFAULT_SETTINGS, SETTINGS_IPC, SettingsPatchSchema, SettingsSchema } from './settings'

describe('settings contract', () => {
  it('accepts each theme and defaults to following the system', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('system')
    for (const theme of ['system', 'light', 'dark'])
      expect(SettingsSchema.parse({ theme, ai: DEFAULT_AI_SETTINGS })).toEqual({
        theme,
        ai: DEFAULT_AI_SETTINGS,
      })
  })

  it('rejects unknown themes and unknown keys in a patch', () => {
    expect(SettingsPatchSchema.safeParse({ theme: 'sepia' }).success).toBe(false)
    expect(SettingsPatchSchema.safeParse({ theme: 'dark', admin: true }).success).toBe(false)
    expect(SettingsPatchSchema.parse({})).toEqual({})
  })

  it('uses channel names that do not collide with the rest of the IPC contract', () => {
    const all = [...Object.values(IPC), ...Object.values(SETTINGS_IPC), ...Object.values(AI_IPC)]
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('AI settings contract', () => {
  it('defaults to no provider and sorting off', () => {
    expect(DEFAULT_SETTINGS.ai).toEqual({
      provider: 'none',
      model: null,
      sortSenders: false,
      cloudConsent: null,
    })
  })

  it('only accepts a cloud provider with consent for that provider', () => {
    const base = { model: null, sortSenders: true }
    expect(
      SettingsPatchSchema.safeParse({ ai: { ...base, provider: 'lmstudio', cloudConsent: null } }).success,
    ).toBe(true)
    expect(
      SettingsPatchSchema.safeParse({ ai: { ...base, provider: 'claude-cli', cloudConsent: null } }).success,
    ).toBe(false)
    expect(
      SettingsPatchSchema.safeParse({ ai: { ...base, provider: 'codex-cli', cloudConsent: 'claude-cli' } })
        .success,
    ).toBe(false)
    expect(
      SettingsPatchSchema.safeParse({ ai: { ...base, provider: 'codex-cli', cloudConsent: 'codex-cli' } })
        .success,
    ).toBe(true)
  })
})
