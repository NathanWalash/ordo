import { app } from 'electron'
import * as mail from '../mail'
import * as cleanup from '../cleanup'
import * as calendar from '../calendar'
import * as money from '../money'
import { aiSettings, categoriseSenders, sendersWithAi, status as aiStatus } from '../ai'
import { lockHolder } from '../writes'
import type { OrdoServices } from './commands'

/**
 * The real services: the same main-process functions the app's IPC handlers call, so headless
 * mode gets every check the window does and no shortcuts. Progress goes to a callback instead
 * of a window.
 */
export function mainServices(): OrdoServices {
  return {
    version: app.getVersion(),
    account: mail.status,
    scan: mail.scan,
    senders: sendersWithAi,
    cleanup: {
      plan: cleanup.plan,
      run: cleanup.run,
      history: cleanup.history,
      undo: cleanup.undo,
    },
    calendar: {
      status: calendar.status,
      sync: (onProgress) => calendar.sync({}, onProgress),
      calendars: calendar.calendars,
      events: calendar.events,
    },
    money: {
      overview: money.overview,
      transactions: money.transactions,
      importFile: money.importStatementFile,
      counts: money.counts,
      aiSort: (onProgress) => money.aiSort(onProgress),
    },
    ai: {
      settings: aiSettings,
      status: () => aiStatus(false),
      sort: (onProgress) => categoriseSenders({}, onProgress),
    },
    lockHolder,
  }
}
