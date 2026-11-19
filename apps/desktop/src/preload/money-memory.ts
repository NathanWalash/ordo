import { ipcRenderer, type IpcRendererEvent } from 'electron'
import { MEMORY_IPC, type AskStep, type MoneyMemoryApi } from '@ordo/shared'

/** `window.ordo.moneyMemory`: one ipcRenderer.invoke per channel. */
export const moneyMemoryApi: MoneyMemoryApi = {
  view: () => ipcRenderer.invoke(MEMORY_IPC.view),
  saveFact: (input) => ipcRenderer.invoke(MEMORY_IPC.saveFact, input),
  deleteFact: (id) => ipcRenderer.invoke(MEMORY_IPC.deleteFact, id),
  answer: (input) => ipcRenderer.invoke(MEMORY_IPC.answer, input),
  compare: (input) => ipcRenderer.invoke(MEMORY_IPC.compare, input),
  ask: (input) => ipcRenderer.invoke(MEMORY_IPC.ask, input),
  askStop: () => ipcRenderer.invoke(MEMORY_IPC.askStop),
  onAskStep: (listener) => {
    const handler = (_e: IpcRendererEvent, s: AskStep) => listener(s)
    ipcRenderer.on(MEMORY_IPC.askStep, handler)
    return () => ipcRenderer.removeListener(MEMORY_IPC.askStep, handler)
  },
}
