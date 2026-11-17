import { describe, expect, it } from 'vitest'
import { IPC } from './index'
import { DEFAULT_SETTINGS, SETTINGS_IPC, SettingsPatchSchema, SettingsSchema } from './settings'

describe('settings contract', () => {
  it('accepts each theme and defaults to following the system', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('system')
    for (const theme of ['system', 'light', 'dark'])
      expect(SettingsSchema.parse({ theme })).toEqual({ theme })
  })

  it('rejects unknown themes and unknown keys in a patch', () => {
    expect(SettingsPatchSchema.safeParse({ theme: 'sepia' }).success).toBe(false)
    expect(SettingsPatchSchema.safeParse({ theme: 'dark', admin: true }).success).toBe(false)
    expect(SettingsPatchSchema.parse({})).toEqual({})
  })

  it('uses channel names that do not collide with the rest of the IPC contract', () => {
    const all = [...Object.values(IPC), ...Object.values(SETTINGS_IPC)]
    expect(new Set(all).size).toBe(all.length)
  })
})
