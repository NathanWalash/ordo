import { ipcRenderer } from 'electron'
import { ACCOUNTS_IPC, type AccountResult, type AccountsApi } from '@ordo/shared'

/**
 * Changing an account only ever follows a click or key press in the window: a call with no user
 * activation (a script, a timer, anything a message could trick the page into) is refused here,
 * before it reaches the main process. Listing accounts is always allowed.
 */
const userActed = () =>
  (globalThis as { navigator?: { userActivation?: { isActive: boolean } } }).navigator?.userActivation
    ?.isActive === true

const refused = (what: string): Promise<AccountResult> =>
  Promise.resolve({ ok: false, error: 'invalid', message: `Click ${what} to change your accounts.` })

/** `window.ordo.accounts`: one ipcRenderer.invoke per Accounts channel. */
export const accountsApi: AccountsApi = {
  list: () => ipcRenderer.invoke(ACCOUNTS_IPC.list),
  test: (input) => (userActed() ? ipcRenderer.invoke(ACCOUNTS_IPC.test, input) : refused('Test connection')),
  add: (input) => (userActed() ? ipcRenderer.invoke(ACCOUNTS_IPC.add, input) : refused('Add account')),
  update: (input) => (userActed() ? ipcRenderer.invoke(ACCOUNTS_IPC.update, input) : refused('Save')),
  setPassword: (input) =>
    userActed() ? ipcRenderer.invoke(ACCOUNTS_IPC.setPassword, input) : refused('Save'),
  // Nothing to return: without a click, nothing is removed.
  remove: (id) => (userActed() ? ipcRenderer.invoke(ACCOUNTS_IPC.remove, id) : Promise.resolve()),
  googleOptions: () => ipcRenderer.invoke(ACCOUNTS_IPC.googleOptions),
  addGoogle: (input) =>
    userActed() ? ipcRenderer.invoke(ACCOUNTS_IPC.addGoogle, input) : refused('Sign in with Google'),
  // Stopping a sign-in that's waiting for the browser changes nothing.
  cancelGoogle: () => ipcRenderer.invoke(ACCOUNTS_IPC.cancelGoogle),
  signInAgain: (input) =>
    userActed() ? ipcRenderer.invoke(ACCOUNTS_IPC.signInAgain, input) : refused('Sign in again'),
}
