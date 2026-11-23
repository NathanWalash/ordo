import { app, type IpcMainInvokeEvent } from 'electron'

/** What `isAppFrame` needs of a frame (Electron's WebFrameMain). */
interface FrameLike {
  url: string
  parent: unknown
}

/**
 * Whether a frame is Ordo's own page: the window's top-level frame (never the sandboxed message
 * frame or anything else inside it), showing the bundled renderer (`file:…/renderer/index.html`)
 * or, in development, the dev server's origin. Pure, for tests.
 */
export function isAppFrame(frame: FrameLike | null | undefined, devUrl?: string): boolean {
  if (!frame || frame.parent !== null) return false
  let url: URL
  try {
    url = new URL(frame.url)
  } catch {
    return false
  }
  if (devUrl) {
    try {
      if (url.protocol.startsWith('http') && url.origin === new URL(devUrl).origin) return true
    } catch {
      // A malformed dev URL never matches.
    }
  }
  return url.protocol === 'file:' && url.pathname.endsWith('/renderer/index.html')
}

/**
 * Defence in depth for IPC that changes something: the call came from Ordo's own page in its
 * window, not from content in another frame, even inside a click's user-activation window.
 */
export function fromAppWindow(e: IpcMainInvokeEvent): boolean {
  const devUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined
  return isAppFrame(e.senderFrame, devUrl)
}
