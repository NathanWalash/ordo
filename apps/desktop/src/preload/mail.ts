import { ipcRenderer, type IpcRendererEvent } from 'electron'
import { MAIL_IPC, type MailApi, type MailRefreshProgress } from '@ordo/shared'

/**
 * Sending only ever follows a click or key press in the window: a call with no user activation
 * (a script, a timer, anything a message could trick the page into) is refused here, before it
 * reaches the main process.
 */
const userActed = () =>
  (globalThis as { navigator?: { userActivation?: { isActive: boolean } } }).navigator?.userActivation
    ?.isActive === true

/** `window.ordo.mail`: one ipcRenderer.invoke per Mail channel. */
export const mailApi: MailApi = {
  mailboxes: () => ipcRenderer.invoke(MAIL_IPC.mailboxes),
  refresh: (input) => ipcRenderer.invoke(MAIL_IPC.refresh, input),
  onRefreshProgress: (listener) => {
    const handler = (_e: IpcRendererEvent, p: MailRefreshProgress) => listener(p)
    ipcRenderer.on(MAIL_IPC.refreshProgress, handler)
    return () => ipcRenderer.removeListener(MAIL_IPC.refreshProgress, handler)
  },
  messages: (query) => ipcRenderer.invoke(MAIL_IPC.messages, query),
  search: (query) => ipcRenderer.invoke(MAIL_IPC.search, query),
  searchServer: (query) => ipcRenderer.invoke(MAIL_IPC.searchServer, query),
  open: (ref) => ipcRenderer.invoke(MAIL_IPC.open, ref),
  setFlags: (input) => ipcRenderer.invoke(MAIL_IPC.setFlags, input),
  move: (input) => ipcRenderer.invoke(MAIL_IPC.move, input),
  undoMove: (id) => ipcRenderer.invoke(MAIL_IPC.undoMove, id),
  loadImages: (input) => ipcRenderer.invoke(MAIL_IPC.loadImages, input),
  openLink: (url) => ipcRenderer.invoke(MAIL_IPC.openLink, url),
  saveAttachment: (ref) => ipcRenderer.invoke(MAIL_IPC.saveAttachment, ref),
  saveAllAttachments: (ref) => ipcRenderer.invoke(MAIL_IPC.saveAllAttachments, ref),
  pickAttachments: () => ipcRenderer.invoke(MAIL_IPC.pickAttachments),
  send: (input) =>
    userActed()
      ? ipcRenderer.invoke(MAIL_IPC.send, input)
      : Promise.resolve({ ok: false, error: 'invalid', message: 'Click Send to send a message.' }),
  saveDraft: (input) => ipcRenderer.invoke(MAIL_IPC.saveDraft, input),
}
