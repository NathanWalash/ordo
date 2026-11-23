import { ipcRenderer } from 'electron'
import { ACCOUNTS_IPC, type AccountsApi } from '@ordo/shared'

/** `window.ordo.accounts`: one ipcRenderer.invoke per Accounts channel. */
export const accountsApi: AccountsApi = {
  list: () => ipcRenderer.invoke(ACCOUNTS_IPC.list),
  test: (input) => ipcRenderer.invoke(ACCOUNTS_IPC.test, input),
  add: (input) => ipcRenderer.invoke(ACCOUNTS_IPC.add, input),
  update: (input) => ipcRenderer.invoke(ACCOUNTS_IPC.update, input),
  setPassword: (input) => ipcRenderer.invoke(ACCOUNTS_IPC.setPassword, input),
  remove: (id) => ipcRenderer.invoke(ACCOUNTS_IPC.remove, id),
}
