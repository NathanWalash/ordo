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

describe('ConnectInputSchema', () => {
  it('accepts an email and app-specific password, with or without dashes', async () => {
    const { ConnectInputSchema } = await import('./index')
    expect(ConnectInputSchema.parse({ email: ' you@icloud.com ', password: 'abcd-efgh-ijkl-mnop' })).toEqual({
      email: 'you@icloud.com',
      password: 'abcd-efgh-ijkl-mnop',
    })
    expect(
      ConnectInputSchema.safeParse({ email: 'you@icloud.com', password: 'abcdefghijklmnop' }).success,
    ).toBe(true)
  })

  it('rejects a normal Apple ID password and a bad email with friendly messages', async () => {
    const { ConnectInputSchema } = await import('./index')
    const r = ConnectInputSchema.safeParse({ email: 'nope', password: 'hunter2' })
    expect(r.success).toBe(false)
    const messages = r.success ? [] : r.error.issues.map((i) => i.message)
    expect(messages).toContain('Enter the email address you use for iCloud Mail.')
    expect(messages).toContain('App-specific passwords look like abcd-efgh-ijkl-mnop.')
  })
})
