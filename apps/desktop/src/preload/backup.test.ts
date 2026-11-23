import { afterEach, describe, expect, it, vi } from 'vitest'
import { BACKUP_IPC } from '@ordo/shared'

const invoke = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined))
vi.mock('electron', () => ({ ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() } }))
const { backupApi } = await import('./backup')

const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
function activation(isActive: boolean | undefined) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: isActive === undefined ? {} : { userActivation: { isActive } },
  })
}
afterEach(() => {
  invoke.mockClear()
  if (real) Object.defineProperty(globalThis, 'navigator', real)
})

describe('the backup preload', () => {
  const input = { id: 'x', confirm: 'restore' as const }

  it('never passes on a restore without a click or key press in the window', async () => {
    for (const state of [false, undefined]) {
      activation(state)
      expect(await backupApi.restoreConfirm(input)).toMatchObject({ ok: false })
    }
    expect(invoke).not.toHaveBeenCalled()
  })

  it('passes on a restore that follows a click', async () => {
    activation(true)
    await backupApi.restoreConfirm(input)
    expect(invoke).toHaveBeenCalledWith(BACKUP_IPC.restoreConfirm, input)
  })
})
