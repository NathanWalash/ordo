import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: true } }))
const { isAppFrame } = await import('./ipc-sender')

const top = (url: string) => ({ url, parent: null })
const PACKAGED = 'file:///Applications/Ordo.app/Contents/Resources/app.asar/out/renderer/index.html#/settings'

describe('isAppFrame', () => {
  it('accepts the bundled renderer in the top-level frame, on any OS', () => {
    expect(isAppFrame(top(PACKAGED))).toBe(true)
    expect(
      isAppFrame(top('file:///C:/Program%20Files/Ordo/resources/app.asar/out/renderer/index.html')),
    ).toBe(true)
  })

  it('accepts the dev server only when one is set, and only its origin', () => {
    const dev = 'http://localhost:5173'
    expect(isAppFrame(top('http://localhost:5173/#/settings'), dev)).toBe(true)
    expect(isAppFrame(top('http://localhost:5173/#/settings'))).toBe(false)
    expect(isAppFrame(top('http://localhost:5174/'), dev)).toBe(false)
    expect(isAppFrame(top('http://evil.example/'), 'not a url')).toBe(false)
  })

  it('refuses frames inside the window, other pages and missing frames', () => {
    expect(isAppFrame({ url: PACKAGED, parent: {} })).toBe(false)
    expect(isAppFrame(top('about:srcdoc'))).toBe(false)
    expect(isAppFrame(top('https://evil.example/renderer/index.html'))).toBe(false)
    expect(isAppFrame(top('file:///tmp/evil.html'))).toBe(false)
    expect(isAppFrame(top('not a url'))).toBe(false)
    expect(isAppFrame(null)).toBe(false)
    expect(isAppFrame(undefined)).toBe(false)
  })
})
