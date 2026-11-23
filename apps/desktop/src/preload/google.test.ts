import { afterEach, describe, expect, it, vi } from 'vitest'
import { GOOGLE_IPC } from '@ordo/shared'

const invoke = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined))
vi.mock('electron', () => ({ ipcRenderer: { invoke, on: vi.fn(), removeListener: vi.fn() } }))
const { googleApi } = await import('./google')

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

const client = { clientId: '1234-abc.apps.googleusercontent.com', clientSecret: 's' }

/** Every call that changes a Google sign-in: name, call, and what should reach ipcRenderer.invoke. */
const changes: [string, () => Promise<unknown>, unknown[]][] = [
  ['setClient', () => googleApi.setClient(client), [GOOGLE_IPC.googleSetClient, client]],
  ['connect', () => googleApi.connect(), [GOOGLE_IPC.googleConnect, undefined]],
  [
    'connect again',
    () => googleApi.connect({ accountId: '123' }),
    [GOOGLE_IPC.googleConnect, { accountId: '123' }],
  ],
  ['signOut', () => googleApi.signOut('123'), [GOOGLE_IPC.googleSignOut, '123']],
  [
    'signOut with its mail accounts',
    () => googleApi.signOut('123', { removeMail: ['acc-2'] }),
    [GOOGLE_IPC.googleSignOut, '123', { removeMail: ['acc-2'] }],
  ],
  [
    'replaceFeed',
    () => googleApi.replaceFeed({ feedId: 'feed:1' }),
    [GOOGLE_IPC.googleReplaceFeed, { feedId: 'feed:1' }],
  ],
]

describe('the Google preload', () => {
  it.each(changes)('never passes on %s without a click or key press in the window', async (_name, call) => {
    for (const state of [false, undefined]) {
      activation(state)
      expect(await call()).toMatchObject({ ok: false, message: expect.stringMatching(/Click/) })
    }
    expect(invoke).not.toHaveBeenCalled()
  })

  it.each(changes)('passes on %s that follows a click', async (_name, call, expected) => {
    activation(true)
    await call()
    expect(invoke).toHaveBeenCalledWith(...expected)
  })

  it('always passes on reading, cancelling a sign-in and choosing a colour', async () => {
    activation(false)
    await googleApi.status()
    await googleApi.feedMatches()
    await googleApi.cancelConnect()
    await googleApi.setCalendarColor({ calendarId: 'x', color: null })
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      GOOGLE_IPC.googleStatus,
      GOOGLE_IPC.googleFeedMatches,
      GOOGLE_IPC.googleCancel,
      GOOGLE_IPC.googleSetColor,
    ])
  })
})
