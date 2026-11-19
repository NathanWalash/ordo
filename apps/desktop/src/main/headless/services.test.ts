import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// The real services, not the test fakes: only the Electron edge is stood in for.
const dir = vi.hoisted(() => ({ path: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => dir.path, getVersion: () => '9.9.9', isPackaged: true, on: vi.fn() },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  dialog: {},
  BrowserWindow: {},
  nativeTheme: { on: vi.fn(), shouldUseDarkColors: false },
  safeStorage: { isEncryptionAvailable: () => false },
}))
dir.path = mkdtempSync(join(tmpdir(), 'ordo-services-'))
const { mainServices } = await import('./services')
const mailClient = await import('../mail-client')

describe('mainServices', () => {
  it('has no way to send mail unless the assistant asks for it', () => {
    const headless = mainServices()
    expect(headless.mail.send).toBeUndefined()
    expect('send' in headless.mail).toBe(false)
    expect(mainServices({ send: false }).mail.send).toBeUndefined()
    // Only the app's assistant, which sends after its card, gets the window's own send.
    expect(mainServices({ send: true }).mail.send).toBe(mailClient.send)
  })

  it('changes mail through the window’s own functions', () => {
    const s = mainServices()
    expect(s.mail.move).toBe(mailClient.move)
    expect(s.mail.setFlags).toBe(mailClient.setFlags)
    expect(s.mail.undoMove).toBe(mailClient.undoMove)
    expect(s.mail.saveDraft).toBe(mailClient.saveDraft)
  })
})
