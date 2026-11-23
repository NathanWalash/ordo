import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACCOUNTS_IPC } from '@ordo/shared'

const invoke = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined))
vi.mock('electron', () => ({ ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() } }))
const { accountsApi } = await import('./accounts')

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

const add = { provider: 'gmail', email: 'jo@gmail.com', password: 'x' } as const

describe('the accounts preload', () => {
  it('never passes on a change without a click or key press in the window', async () => {
    for (const state of [false, undefined]) {
      activation(state)
      expect(await accountsApi.add(add)).toMatchObject({ ok: false, error: 'invalid' })
      expect(await accountsApi.test({ id: 'acc-1' })).toMatchObject({ ok: false })
      expect(await accountsApi.update({ id: 'acc-1', label: 'Work' })).toMatchObject({ ok: false })
      expect(await accountsApi.setPassword({ id: 'acc-1', password: 'x' })).toMatchObject({ ok: false })
      expect(await accountsApi.addGoogle({})).toMatchObject({ ok: false, error: 'invalid' })
      expect(await accountsApi.signInAgain({ id: 'acc-1' })).toMatchObject({ ok: false, error: 'invalid' })
      await accountsApi.remove('acc-1')
    }
    expect(invoke).not.toHaveBeenCalled()
  })

  it('passes on Sign in with Google after a click, and reading its options or cancelling always', async () => {
    activation(false)
    await accountsApi.googleOptions()
    await accountsApi.cancelGoogle()
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      ACCOUNTS_IPC.googleOptions,
      ACCOUNTS_IPC.cancelGoogle,
    ])
    activation(true)
    await accountsApi.addGoogle({ googleAccountId: '123', label: 'Work' })
    await accountsApi.signInAgain({ id: 'acc-2' })
    expect(invoke).toHaveBeenCalledWith(ACCOUNTS_IPC.addGoogle, { googleAccountId: '123', label: 'Work' })
    expect(invoke).toHaveBeenLastCalledWith(ACCOUNTS_IPC.signInAgain, { id: 'acc-2' })
  })

  it('passes on changes that follow a click, and listing always', async () => {
    activation(false)
    await accountsApi.list()
    expect(invoke).toHaveBeenLastCalledWith(ACCOUNTS_IPC.list)
    activation(true)
    await accountsApi.add(add)
    await accountsApi.remove('acc-1')
    expect(invoke).toHaveBeenCalledWith(ACCOUNTS_IPC.add, add)
    expect(invoke).toHaveBeenLastCalledWith(ACCOUNTS_IPC.remove, 'acc-1')
  })
})
