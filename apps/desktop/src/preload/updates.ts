import { ipcRenderer, type IpcRendererEvent } from 'electron'
import { UPDATES_IPC, type UpdateState, type UpdatesApi } from '@ordo/shared'

/** `window.ordo.updates`: one ipcRenderer.invoke per update channel. */
export const updatesApi: UpdatesApi = {
  state: () => ipcRenderer.invoke(UPDATES_IPC.state),
  check: () => ipcRenderer.invoke(UPDATES_IPC.check),
  open: () => ipcRenderer.invoke(UPDATES_IPC.open),
  skip: (version) => ipcRenderer.invoke(UPDATES_IPC.skip, version),
  setChecksEnabled: (enabled) => ipcRenderer.invoke(UPDATES_IPC.setChecksEnabled, enabled),
  onChanged: (listener) => {
    const handler = (_e: IpcRendererEvent, s: UpdateState) => listener(s)
    ipcRenderer.on(UPDATES_IPC.changed, handler)
    return () => ipcRenderer.removeListener(UPDATES_IPC.changed, handler)
  },
}
