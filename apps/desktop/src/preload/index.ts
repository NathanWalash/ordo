import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type OrdoApi, type ScanProgress } from '@ordo/shared'
import type { CalendarSyncProgress } from '@ordo/shared'
import { SETTINGS_IPC, type Appearance } from '@ordo/shared'
import { AI_IPC, type AiSortProgress } from '@ordo/shared'
import { CLEANUP_IPC, type CleanupProgress } from '@ordo/shared'
import { ASSISTANT_IPC, type AssistantEvent } from '@ordo/shared'
import { moneyApi } from './money'

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
  ai: {
    status: (refresh) => ipcRenderer.invoke(AI_IPC.aiStatus, refresh),
    test: (input) => ipcRenderer.invoke(AI_IPC.aiTest, input),
    categoriseSenders: (input) => ipcRenderer.invoke(AI_IPC.aiCategorise, input),
    stop: () => ipcRenderer.invoke(AI_IPC.aiStop),
    onProgress: (listener) => {
      const handler = (_e: IpcRendererEvent, p: AiSortProgress) => listener(p)
      ipcRenderer.on(AI_IPC.aiProgress, handler)
      return () => ipcRenderer.removeListener(AI_IPC.aiProgress, handler)
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
    addLink: (input) => ipcRenderer.invoke(IPC.calendarAddLink, input),
    importFile: () => ipcRenderer.invoke(IPC.calendarImportFile),
    remove: (calendarId) => ipcRenderer.invoke(IPC.calendarRemove, calendarId),
  },
  cleanup: {
    run: (request) => ipcRenderer.invoke(CLEANUP_IPC.run, request),
    onProgress: (listener) => {
      const handler = (_e: IpcRendererEvent, p: CleanupProgress) => listener(p)
      ipcRenderer.on(CLEANUP_IPC.progress, handler)
      return () => ipcRenderer.removeListener(CLEANUP_IPC.progress, handler)
    },
    history: () => ipcRenderer.invoke(CLEANUP_IPC.history),
    undo: (id) => ipcRenderer.invoke(CLEANUP_IPC.undo, id),
  },
  money: moneyApi,
  assistant: {
    info: () => ipcRenderer.invoke(ASSISTANT_IPC.info),
    ask: (input) => ipcRenderer.invoke(ASSISTANT_IPC.ask, input),
    confirm: (input) => ipcRenderer.invoke(ASSISTANT_IPC.confirm, input),
    setCloudConsent: (input) => ipcRenderer.invoke(ASSISTANT_IPC.consent, input),
    stop: () => ipcRenderer.invoke(ASSISTANT_IPC.stop),
    clear: () => ipcRenderer.invoke(ASSISTANT_IPC.clear),
    onEvent: (listener) => {
      const handler = (_e: IpcRendererEvent, ev: AssistantEvent) => listener(ev)
      ipcRenderer.on(ASSISTANT_IPC.event, handler)
      return () => ipcRenderer.removeListener(ASSISTANT_IPC.event, handler)
    },
  },
}

contextBridge.exposeInMainWorld('ordo', api)
