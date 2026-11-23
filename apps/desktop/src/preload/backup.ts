import { ipcRenderer } from 'electron'
import { BACKUP_IPC, type BackupApi } from '@ordo/shared'

/**
 * Restoring replaces all of Ordo's data, so it only ever follows a click or key press in the
 * window, as sending mail does: a call with no user activation (a script, a timer, anything an
 * email could trick the page into) is refused here, before it reaches the main process.
 */
const userActed = () =>
  (globalThis as { navigator?: { userActivation?: { isActive: boolean } } }).navigator?.userActivation
    ?.isActive === true

/** `window.ordo.backup`: one ipcRenderer.invoke per Backup channel. */
export const backupApi: BackupApi = {
  status: () => ipcRenderer.invoke(BACKUP_IPC.status),
  chooseFolder: () => ipcRenderer.invoke(BACKUP_IPC.chooseFolder),
  setPassphrase: (input) => ipcRenderer.invoke(BACKUP_IPC.setPassphrase, input),
  forgetPassphrase: () => ipcRenderer.invoke(BACKUP_IPC.forgetPassphrase),
  update: (input) => ipcRenderer.invoke(BACKUP_IPC.update, input),
  run: (input) => ipcRenderer.invoke(BACKUP_IPC.run, input),
  restorePick: () => ipcRenderer.invoke(BACKUP_IPC.restorePick),
  restoreOpen: (input) => ipcRenderer.invoke(BACKUP_IPC.restoreOpen, input),
  restoreCancel: () => ipcRenderer.invoke(BACKUP_IPC.restoreCancel),
  restoreConfirm: (input) =>
    userActed()
      ? ipcRenderer.invoke(BACKUP_IPC.restoreConfirm, input)
      : Promise.resolve({ ok: false, message: 'Click Restore and Restart to restore.' }),
}
