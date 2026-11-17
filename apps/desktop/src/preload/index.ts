import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type OrdoApi, type ScanProgress } from '@ordo/shared'
import type { CalendarSyncProgress } from '@ordo/shared'

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
  calendar: {
    status: () => ipcRenderer.invoke(IPC.calendarStatus),
    sync: (options) => ipcRenderer.invoke(IPC.calendarSync, options),
    onSyncProgress: (listener) => {
      const handler = (_e: IpcRendererEvent, p: CalendarSyncProgress) => listener(p)
      ipcRenderer.on(IPC.calendarSyncProgress, handler)
      return () => ipcRenderer.removeListener(IPC.calendarSyncProgress, handler)
    },
    calendars: () => ipcRenderer.invoke(IPC.calendarList),
    events: (range) => ipcRenderer.invoke(IPC.calendarEvents, range),
    setVisible: (input) => ipcRenderer.invoke(IPC.calendarSetVisible, input),
  },
}

contextBridge.exposeInMainWorld('ordo', api)
