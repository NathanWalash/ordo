import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type OrdoApi } from '@ordo/shared'

const api: OrdoApi = {
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
  },
}

contextBridge.exposeInMainWorld('ordo', api)
