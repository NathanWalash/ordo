import { afterEach, describe, expect, it, vi } from 'vitest'
import { BACKUP_IPC } from '@ordo/shared'

const invoke = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined))
vi.mock('electron', () => ({ ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() } }))
const { backupApi } = await import('./backup')

const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
/** Whether the window has just had a click or key press (`navigator.userActivation.isActive`). */
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

const confirm = { id: 'x', confirm: 'restore' as const }
const newPassphrase = { passphrase: 'a new passphrase', remember: true, current: 'the old one' }

/** Every call that changes something: name, call, and what should reach ipcRenderer.invoke. */
const changes: [string, () => Promise<unknown>, unknown[]][] = [
  ['restoreConfirm', () => backupApi.restoreConfirm(confirm), [BACKUP_IPC.restoreConfirm, confirm]],
  [
    'restoreOpen',
    () => backupApi.restoreOpen({ passphrase: 'p' }),
    [BACKUP_IPC.restoreOpen, { passphrase: 'p' }],
  ],
  ['restorePick', () => backupApi.restorePick(), [BACKUP_IPC.restorePick]],
  ['setPassphrase', () => backupApi.setPassphrase(newPassphrase), [BACKUP_IPC.setPassphrase, newPassphrase]],
  ['forgetPassphrase', () => backupApi.forgetPassphrase(), [BACKUP_IPC.forgetPassphrase]],
  ['update', () => backupApi.update({ auto: false }), [BACKUP_IPC.update, { auto: false }]],
  ['chooseFolder', () => backupApi.chooseFolder(), [BACKUP_IPC.chooseFolder]],
  ['run', () => backupApi.run({}), [BACKUP_IPC.run, {}]],
]

describe('the backup preload', () => {
  it.each(changes)('never passes on %s without a click or key press in the window', async (_name, call) => {
    for (const state of [false, undefined]) {
      activation(state)
      expect(await call()).toMatchObject({ ok: false })
    }
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each(changes)('passes on %s that follows a click', async (_name, call, expected) => {
    activation(true)
    await call()
    expect(invoke).toHaveBeenCalledWith(...expected)
  })

  it('always passes on reading the status and cancelling a restore', async () => {
    activation(false)
    await backupApi.status()
    await backupApi.restoreCancel()
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([BACKUP_IPC.status, BACKUP_IPC.restoreCancel])
  })
})
