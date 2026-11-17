import { describe, expect, it } from 'vitest'
import { supportsMica } from './platform'

describe('supportsMica', () => {
  it('is true from Windows 11 (build 22000) on', () => {
    expect(supportsMica('win32', '10.0.22000')).toBe(true)
    expect(supportsMica('win32', '10.0.26100')).toBe(true)
  })
  it('is false on Windows 10, unknown versions and other platforms', () => {
    expect(supportsMica('win32', '10.0.19045')).toBe(false)
    expect(supportsMica('win32', '')).toBe(false)
    expect(supportsMica('darwin', '15.0.0')).toBe(false)
    expect(supportsMica('linux', '10.0.22000')).toBe(false)
  })
})
