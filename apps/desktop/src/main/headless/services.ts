import { app } from 'electron'
import * as mail from '../mail'
import * as cleanup from '../cleanup'
import * as mailClient from '../mail-client'
import * as calendar from '../calendar'
import * as money from '../money'
import * as memory from '../money-memory'
import * as boards from '../boards'
import { aiSettings, categoriseSenders, sendersWithAi, status as aiStatus } from '../ai'
import { lockHolder } from '../writes'
import { listAccounts } from '../account'
import type { OrdoServices } from './commands'

/**
 * The real services: the same main-process functions the app's IPC handlers call, so headless
 * mode gets every check the window does and no shortcuts. Progress goes to a callback instead
 * of a window.
 *
 * Sending mail is only there for the app's own assistant (`{ send: true }`), which sends only
 * after the user confirms a card. Headless runs and the MCP server never get it.
 */
export function mainServices(options: { send?: boolean } = {}): OrdoServices {
  return {
    version: app.getVersion(),
    account: mail.status,
    // Every account's inbox, each on its own connection.
    scan: mail.scanAll,
    senders: sendersWithAi,
    cleanup: {
      plan: cleanup.plan,
      run: cleanup.run,
      history: cleanup.history,
      undo: cleanup.undo,
    },
    // Changes go through the window's own functions (the write lock, folder checks, undo).
    // No send here unless the assistant asked for it.
    mail: {
      accounts: listAccounts,
      mailboxes: mailClient.mailboxes,
      refresh: (input, onProgress) => mailClient.refresh(input, onProgress),
      messages: mailClient.messages,
      search: mailClient.search,
      searchServer: mailClient.searchServer,
      open: mailClient.open,
      cached: mailClient.cached,
      setFlags: mailClient.setFlags,
      move: mailClient.move,
      lastMove: mailClient.lastMove,
      undoMove: mailClient.undoMove,
      saveDraft: mailClient.saveDraft,
      ...(options.send === true && { send: mailClient.send }),
    },
    calendar: {
      status: calendar.status,
      sync: (onProgress) => calendar.sync({}, onProgress),
      calendars: calendar.calendars,
      events: calendar.events,
      locate: calendar.locateEvent,
      details: calendar.eventDetails,
      createEvent: calendar.createEvent,
      updateEvent: calendar.updateEvent,
      deleteEvent: calendar.deleteEvent,
    },
    money: {
      overview: money.overview,
      transactions: money.transactions,
      importFile: money.importStatementFile,
      counts: money.counts,
      aiSort: (onProgress) => money.aiSort(onProgress),
      memory: memory.view,
      answer: memory.answer,
      forget: memory.deleteFact,
      compare: memory.compare,
    },
    ai: {
      settings: aiSettings,
      status: () => aiStatus(false),
      sort: (onProgress) => categoriseSenders({}, onProgress),
    },
    boards: {
      list: boards.list,
      cards: ({ labels, ...q }) => {
        const all = boards.cardsByRef(q)
        if (!all.ok) return all
        const want = (labels ?? []).map((l) => l.toLocaleLowerCase())
        const rows = all.value.map(boards.cardRow)
        return {
          ok: true,
          value: want.length
            ? rows.filter((c) => c.labels.some((l) => want.includes(l.toLocaleLowerCase())))
            : rows,
        }
      },
      addCard: async (input) => {
        const r = await boards.addCardByRef(input)
        return r.ok ? { ok: true, value: boards.cardRow(r.value) } : r
      },
      moveCard: async (input) => {
        const r = await boards.moveCardByRef(input)
        return r.ok ? { ok: true, value: boards.cardRow(r.value) } : r
      },
      resolve: (q) => boards.resolveRefs(q),
    },
    lockHolder,
  }
}
