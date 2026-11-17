import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type OrdoApi, type ScanProgress } from '@ordo/shared'
import { moneyApi } from './money'

const api: OrdoApi = {
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
  },
  account: {
    status: () => ipcRenderer.invoke(IPC.accountStatus),
    test: (input) => ipcRenderer.invoke(IPC.accountTest, input),
    connect: (input) => ipcRenderer.invoke(IPC.accountConnect, input),
    disconnect: () => ipcRenderer.invoke(IPC.accountDisconnect),
  },
  scan: {
    start: () => ipcRenderer.invoke(IPC.scanStart),
    stop: () => ipcRenderer.invoke(IPC.scanStop),
    onProgress: (listener) => {
      const handler = (_e: IpcRendererEvent, p: ScanProgress) => listener(p)
      ipcRenderer.on(IPC.scanProgress, handler)
      return () => ipcRenderer.removeListener(IPC.scanProgress, handler)
    },
  },
  senders: {
    list: () => ipcRenderer.invoke(IPC.sendersList),
  },
  money: moneyApi,
}

contextBridge.exposeInMainWorld('ordo', api)
