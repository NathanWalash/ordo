import { ipcRenderer } from 'electron'
import { BOARDS_METHODS, boardsChannel, type BoardsApi } from '@ordo/shared'

/** `window.ordo.boards`: one ipcRenderer.invoke per Boards method, on `boards:<method>`. */
export const boardsApi = Object.fromEntries(
  BOARDS_METHODS.map((method) => [
    method,
    (input?: unknown) => ipcRenderer.invoke(boardsChannel(method), input),
  ]),
) as unknown as BoardsApi
