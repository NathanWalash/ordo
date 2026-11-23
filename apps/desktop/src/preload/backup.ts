import { ipcRenderer } from 'electron'
import { BACKUP_IPC, type BackupApi } from '@ordo/shared'

/**
 * Everything here that changes something (the folder, the passphrase, backup settings, backing
 * up, restoring) only ever follows a click or key press in the window, as sending mail does: a
 * call with no user activation (a script, a timer, anything an email could trick the page into)
 * is refused here, before it reaches the main process. Reading the status and cancelling a
 * restore always go through.
 */
const userActed = () =>
  (globalThis as { navigator?: { userActivation?: { isActive: boolean } } }).navigator?.userActivation
    ?.isActive === true

const refused = { ok: false as const, message: 'Click the button in Settings to do this.' }

/** `window.ordo.backup`: one ipcRenderer.invoke per Backup channel. */
export const backupApi: BackupApi = {
  status: () => ipcRenderer.invoke(BACKUP_IPC.status),
  chooseFolder: () => (userActed() ? ipcRenderer.invoke(BACKUP_IPC.chooseFolder) : Promise.resolve(refused)),
  setPassphrase: (input) =>
    userActed() ? ipcRenderer.invoke(BACKUP_IPC.setPassphrase, input) : Promise.resolve(refused),
  forgetPassphrase: () =>
    userActed() ? ipcRenderer.invoke(BACKUP_IPC.forgetPassphrase) : Promise.resolve(refused),
  update: (input) => (userActed() ? ipcRenderer.invoke(BACKUP_IPC.update, input) : Promise.resolve(refused)),
  run: (input) =>
    userActed()
      ? ipcRenderer.invoke(BACKUP_IPC.run, input)
      : Promise.resolve({ ...refused, error: 'invalid' as const }),
  restorePick: () =>
    userActed()
      ? ipcRenderer.invoke(BACKUP_IPC.restorePick)
      : Promise.resolve({ ok: false as const, cancelled: true as const }),
  restoreOpen: (input) =>
    userActed()
      ? ipcRenderer.invoke(BACKUP_IPC.restoreOpen, input)
      : Promise.resolve({ ...refused, error: 'invalid' as const }),
  restoreCancel: () => ipcRenderer.invoke(BACKUP_IPC.restoreCancel),
  restoreConfirm: (input) =>
    userActed()
      ? ipcRenderer.invoke(BACKUP_IPC.restoreConfirm, input)
      : Promise.resolve({ ok: false, message: 'Click Restore and Restart to restore.' }),
}
