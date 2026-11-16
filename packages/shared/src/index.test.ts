import { describe, expect, it } from 'vitest'
import { AppInfoSchema, IPC, MODULES } from './index'

describe('module registry', () => {
  it('has unique module ids', () => {
    const ids = MODULES.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('IPC contract', () => {
  it('uses unique channel names', () => {
    const channels = Object.values(IPC)
    expect(new Set(channels).size).toBe(channels.length)
  })

  it('validates app info from the main process', () => {
    expect(
      AppInfoSchema.parse({ name: 'Ordo', version: '0.1.0', platform: 'darwin', accentColor: null }),
    ).toBeTruthy()
    expect(() =>
      AppInfoSchema.parse({ name: 'Ordo', version: '0.1.0', platform: 'beos', accentColor: null }),
    ).toThrow()
  })
})
