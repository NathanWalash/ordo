import { ipcRenderer } from 'electron'
import { GOOGLE_IPC, type GoogleApi } from '@ordo/shared'

/**
 * Calls that change a Google sign-in (the OAuth client, connecting, signing out, replacing a link
 * calendar) only ever follow a click or key press in the window, as with backups and sending
 * mail: a call with no user activation (a script, a timer, anything an email could trick the page
 * into) is refused here, before it reaches the main process. Reading, cancelling a sign-in that's
 * waiting and choosing a colour always go through.
 */
const userActed = () =>
  (globalThis as { navigator?: { userActivation?: { isActive: boolean } } }).navigator?.userActivation
    ?.isActive === true

const message = 'Click the button in Settings to do this.'
const refused = { ok: false as const, message }

/** `window.ordo.google`: one ipcRenderer.invoke per Google channel. */
export const googleApi: GoogleApi = {
  status: () => ipcRenderer.invoke(GOOGLE_IPC.googleStatus),
  setClient: (input) =>
    userActed() ? ipcRenderer.invoke(GOOGLE_IPC.googleSetClient, input) : Promise.resolve(refused),
  connect: (input) =>
    userActed()
      ? ipcRenderer.invoke(GOOGLE_IPC.googleConnect, input)
      : Promise.resolve({ ...refused, error: 'unknown' as const }),
  cancelConnect: () => ipcRenderer.invoke(GOOGLE_IPC.googleCancel),
  signOut: (accountId, options) =>
    userActed()
      ? ipcRenderer.invoke(GOOGLE_IPC.googleSignOut, accountId, ...(options ? [options] : []))
      : Promise.resolve(refused),
  setCalendarColor: (input) => ipcRenderer.invoke(GOOGLE_IPC.googleSetColor, input),
  feedMatches: () => ipcRenderer.invoke(GOOGLE_IPC.googleFeedMatches),
  replaceFeed: (input) =>
    userActed() ? ipcRenderer.invoke(GOOGLE_IPC.googleReplaceFeed, input) : Promise.resolve(refused),
}
