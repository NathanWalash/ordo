import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type OrdoApi, type ScanProgress } from '@ordo/shared'
import { SETTINGS_IPC, type Appearance } from '@ordo/shared'

const api: OrdoApi = {
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
  },
  settings: {
    get: () => ipcRenderer.invoke(SETTINGS_IPC.settingsGet),
    set: (patch) => ipcRenderer.invoke(SETTINGS_IPC.settingsSet, patch),
    appearance: () => ipcRenderer.invoke(SETTINGS_IPC.appearanceGet),
    onAppearance: (listener) => {
      const handler = (_e: IpcRendererEvent, a: Appearance) => listener(a)
      ipcRenderer.on(SETTINGS_IPC.appearanceChanged, handler)
      return () => ipcRenderer.removeListener(SETTINGS_IPC.appearanceChanged, handler)
    },
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
}

contextBridge.exposeInMainWorld('ordo', api)
