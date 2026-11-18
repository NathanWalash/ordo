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
  it('defaults to no provider, sorting off, Money off and Boards off', () => {
    expect(DEFAULT_SETTINGS.ai).toEqual({
      provider: 'none',
      model: null,
      sortSenders: false,
      money: false,
      boards: false,
      cloudConsent: null,
    })
  })

  it('treats AI for Boards as off when a saved file predates it, and only accepts a boolean', () => {
    const old = { provider: 'lmstudio', model: 'm', sortSenders: true, money: true, cloudConsent: null }
    expect(SettingsPatchSchema.parse({ ai: old }).ai?.boards).toBe(false)
    expect(SettingsPatchSchema.parse({ ai: { ...old, boards: true } }).ai?.boards).toBe(true)
    expect(SettingsPatchSchema.safeParse({ ai: { ...old, boards: 'yes' } }).success).toBe(false)
  })

  it('treats AI for Money as off when a saved file predates it, and only accepts a boolean', () => {
    const old = { provider: 'lmstudio', model: 'm', sortSenders: true, cloudConsent: null }
    expect(SettingsPatchSchema.parse({ ai: old })).toEqual({ ai: { ...old, money: false, boards: false } })
    expect(SettingsPatchSchema.parse({ ai: { ...old, money: true } }).ai?.money).toBe(true)
    expect(SettingsPatchSchema.safeParse({ ai: { ...old, money: 'yes' } }).success).toBe(false)
    // Money doesn't loosen the cloud rule: consent for that provider is still required.
    expect(
      SettingsPatchSchema.safeParse({ ai: { ...old, provider: 'claude-cli', money: true } }).success,
    ).toBe(false)
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
