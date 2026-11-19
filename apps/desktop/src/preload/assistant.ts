import { ipcRenderer, type IpcRendererEvent } from 'electron'
import { ASSISTANT_IPC, type AssistantApi, type AssistantEvent } from '@ordo/shared'

/**
 * Confirming a card only ever follows a click or key press in the window, as sending mail does:
 * an approval with no user activation (a script, a timer, anything an email could trick the page
 * into) never reaches the main process. Cancelling always does.
 */
const userActed = () =>
  (globalThis as { navigator?: { userActivation?: { isActive: boolean } } }).navigator?.userActivation
    ?.isActive === true

/** `window.ordo.assistant`. */
export const assistantApi: AssistantApi = {
  info: () => ipcRenderer.invoke(ASSISTANT_IPC.info),
  ask: (input) => ipcRenderer.invoke(ASSISTANT_IPC.ask, input),
  confirm: (input) =>
    input.approve && !userActed() ? Promise.resolve() : ipcRenderer.invoke(ASSISTANT_IPC.confirm, input),
  setCloudConsent: (input) => ipcRenderer.invoke(ASSISTANT_IPC.consent, input),
  stop: () => ipcRenderer.invoke(ASSISTANT_IPC.stop),
  clear: () => ipcRenderer.invoke(ASSISTANT_IPC.clear),
  onEvent: (listener) => {
    const handler = (_e: IpcRendererEvent, ev: AssistantEvent) => listener(ev)
    ipcRenderer.on(ASSISTANT_IPC.event, handler)
    return () => ipcRenderer.removeListener(ASSISTANT_IPC.event, handler)
  },
}
