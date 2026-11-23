import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type OrdoApi, type ScanProgress } from '@ordo/shared'
import type { CalendarSyncProgress } from '@ordo/shared'
import { SETTINGS_IPC, type Appearance } from '@ordo/shared'
import { AI_IPC, type AiSortProgress } from '@ordo/shared'
import { CLEANUP_IPC, type CleanupProgress } from '@ordo/shared'
import { GOOGLE_IPC } from '@ordo/shared'
import { mailApi } from './mail'
import { assistantApi } from './assistant'
import { moneyApi } from './money'
import { moneyMemoryApi } from './money-memory'
import { boardsApi } from './boards'
import { updatesApi } from './updates'
import { backupApi } from './backup'

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
    onChanged: (listener) => {
      const handler = () => listener()
      ipcRenderer.on(IPC.calendarChanged, handler)
      return () => ipcRenderer.removeListener(IPC.calendarChanged, handler)
    },
    calendars: () => ipcRenderer.invoke(IPC.calendarList),
    events: (range) => ipcRenderer.invoke(IPC.calendarEvents, range),
    setVisible: (input) => ipcRenderer.invoke(IPC.calendarSetVisible, input),
    addLink: (input) => ipcRenderer.invoke(IPC.calendarAddLink, input),
    importFile: () => ipcRenderer.invoke(IPC.calendarImportFile),
    remove: (calendarId) => ipcRenderer.invoke(IPC.calendarRemove, calendarId),
    details: (ref) => ipcRenderer.invoke(IPC.calendarDetails, ref),
    createEvent: (input) => ipcRenderer.invoke(IPC.calendarCreateEvent, input),
    updateEvent: (input) => ipcRenderer.invoke(IPC.calendarUpdateEvent, input),
    deleteEvent: (input) => ipcRenderer.invoke(IPC.calendarDeleteEvent, input),
  },
  google: {
    status: () => ipcRenderer.invoke(GOOGLE_IPC.googleStatus),
    setClient: (input) => ipcRenderer.invoke(GOOGLE_IPC.googleSetClient, input),
    connect: (input) => ipcRenderer.invoke(GOOGLE_IPC.googleConnect, input),
    cancelConnect: () => ipcRenderer.invoke(GOOGLE_IPC.googleCancel),
    signOut: (accountId) => ipcRenderer.invoke(GOOGLE_IPC.googleSignOut, accountId),
    setCalendarColor: (input) => ipcRenderer.invoke(GOOGLE_IPC.googleSetColor, input),
    feedMatches: () => ipcRenderer.invoke(GOOGLE_IPC.googleFeedMatches),
    replaceFeed: (input) => ipcRenderer.invoke(GOOGLE_IPC.googleReplaceFeed, input),
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
  moneyMemory: moneyMemoryApi,
  mail: mailApi,
  boards: boardsApi,
  assistant: assistantApi,
  updates: updatesApi,
  backup: backupApi,
}

contextBridge.exposeInMainWorld('ordo', api)
