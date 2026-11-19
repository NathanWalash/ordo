import { afterEach, describe, expect, it, vi } from 'vitest'
import { ASSISTANT_IPC } from '@ordo/shared'

const invoke = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined))
vi.mock('electron', () => ({ ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() } }))
const { assistantApi } = await import('./assistant')

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

describe('the assistant preload', () => {
  it('never passes on a Confirm without a click or key press in the window', async () => {
    for (const state of [false, undefined]) {
      activation(state)
      await assistantApi.confirm({ id: 'card', approve: true })
    }
    expect(invoke).not.toHaveBeenCalled()
  })

  it('passes on a Confirm that follows a click, and Cancel always', async () => {
    activation(true)
    await assistantApi.confirm({ id: 'card', approve: true })
    expect(invoke).toHaveBeenLastCalledWith(ASSISTANT_IPC.confirm, { id: 'card', approve: true })
    activation(false)
    await assistantApi.confirm({ id: 'card', approve: false })
    expect(invoke).toHaveBeenLastCalledWith(ASSISTANT_IPC.confirm, { id: 'card', approve: false })
    expect(invoke).toHaveBeenCalledTimes(2)
  })
})
