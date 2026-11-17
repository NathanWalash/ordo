import { ipcRenderer } from 'electron'
import { MONEY_IPC, type MoneyApi } from '@ordo/shared'

/** `window.ordo.money`: one ipcRenderer.invoke per Money channel. */
export const moneyApi: MoneyApi = {
  pickStatement: () => ipcRenderer.invoke(MONEY_IPC.pickStatement),
  previewStatement: (input) => ipcRenderer.invoke(MONEY_IPC.previewStatement, input),
  importStatement: (input) => ipcRenderer.invoke(MONEY_IPC.importStatement, input),
  transactions: (query) => ipcRenderer.invoke(MONEY_IPC.transactions, query),
  removeAccount: (name) => ipcRenderer.invoke(MONEY_IPC.removeAccount, name),
  overview: () => ipcRenderer.invoke(MONEY_IPC.overview),
  confirmBill: (input) => ipcRenderer.invoke(MONEY_IPC.confirmBill, input),
  dismissBill: (key) => ipcRenderer.invoke(MONEY_IPC.dismissBill, key),
  saveBill: (input) => ipcRenderer.invoke(MONEY_IPC.saveBill, input),
  deleteBill: (id) => ipcRenderer.invoke(MONEY_IPC.deleteBill, id),
  savePerson: (input) => ipcRenderer.invoke(MONEY_IPC.savePerson, input),
  deletePerson: (id) => ipcRenderer.invoke(MONEY_IPC.deletePerson, id),
  saveSplit: (input) => ipcRenderer.invoke(MONEY_IPC.saveSplit, input),
  deleteSplit: (billId) => ipcRenderer.invoke(MONEY_IPC.deleteSplit, billId),
  settle: (input) => ipcRenderer.invoke(MONEY_IPC.settle, input),
  deleteSettlement: (id) => ipcRenderer.invoke(MONEY_IPC.deleteSettlement, id),
}
