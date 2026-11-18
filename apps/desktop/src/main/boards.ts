import { join } from 'node:path'
import { app, ipcMain } from 'electron'
import { providerInfo } from '@ordo/ai'
import {
  addDays,
  cardsToCalendarItems,
  dueState,
  fieldText,
  fromISODate,
  plainText,
  parseMarkdown,
  resolveLinks,
  searchCandidates,
  suggestForCard,
  targetKey,
  toCandidates,
  toISODate,
  type Card,
  type CardSource,
  type LinkCandidate,
  type LinkKind,
  type LinkSources,
  type UndoToken,
} from '@ordo/boards-core'
import { BoardsError, BoardsStore } from '@ordo/boards-core/node'
import {
  AddCardSchema,
  AddChecklistItemSchema,
  AddColumnSchema,
  ArchiveCardSchema,
  BOARDS_METHODS,
  CandidateQuerySchema,
  CreateBoardSchema,
  DateRangeSchema,
  LinkInputSchema,
  MoveCardSchema,
  MoveSchema,
  RenameBoardSchema,
  SaveFieldSchema,
  SaveLabelSchema,
  UndoTokenSchema,
  UpdateCardSchema,
  UpdateChecklistItemSchema,
  UpdateColumnSchema,
  boardsChannel,
  type BoardSummary,
  type BoardView,
  type BoardsApi,
  type BoardsResult,
  type CalendarOverlayItem,
  type CardDetail,
  type SuggestOutcome,
} from '@ordo/shared'
import type { z } from 'zod'
import { aiSettings, message as aiMessage, resolveModel, usableProvider } from './ai'
import * as calendar from './calendar'
import { cachedInboxHeaders } from './mail'
import * as money from './money'
import { Locked, withWriteLock } from './writes'

let store: BoardsStore | null = null

/** Deleted boards, columns and cards can be undone for a day, then they're removed for good. */
const KEEP_DELETED_MS = 86_400_000

export function boardsStore(): BoardsStore {
  if (!store) {
    store = new BoardsStore(join(app.getPath('userData'), 'boards.sqlite'))
    try {
      store.purgeDeleted(KEEP_DELETED_MS)
    } catch {
      // Another Ordo is writing; it can tidy up next time.
    }
  }
  return store
}

const firstIssue = (e: { issues: { message: string }[] }) => e.issues[0]?.message ?? 'Check the details.'
const invalid = (message: string) => ({ ok: false as const, error: 'invalid' as const, message })

/**
 * Validate `raw`, then run `fn` with the write lock held, so the app, headless runs and agents
 * never change boards at the same time. Refusals from the store come back as messages.
 */
async function change<S extends z.ZodType, T>(
  schema: S,
  raw: unknown,
  fn: (input: z.output<S>, s: BoardsStore) => T,
): Promise<BoardsResult<T>> {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) return invalid(firstIssue(parsed.error))
  try {
    const result = await withWriteLock('changing a board', async () => fn(parsed.data, boardsStore()))
    if (result instanceof Locked) return { ok: false, error: 'locked', message: result.message }
    return { ok: true, value: result }
  } catch (err) {
    if (err instanceof BoardsError) return { ok: false, error: err.code, message: err.message }
    // Unexpected (the database stayed busy, say): the detail goes to the log, never to the window.
    console.error(err)
    return { ok: false, error: 'failed', message: 'Ordo couldn’t save that. Try again.' }
  }
}

const IdSchema = MoveSchema.shape.id

// Reading

export function list(): BoardSummary[] {
  const s = boardsStore()
  const today = toISODate()
  const cards = s.allCards()
  return s.boards().map((b) => {
    const done = new Set(
      s
        .columns(b.id)
        .filter((c) => c.done)
        .map((c) => c.id),
    )
    const mine = cards.filter((c) => c.boardId === b.id)
    return {
      ...b,
      cards: mine.length,
      overdue: mine.filter((c) => dueState(c, today, done.has(c.columnId)) === 'overdue').length,
    }
  })
}

export function board(raw: unknown): BoardView | null {
  const parsed = IdSchema.safeParse(raw)
  if (!parsed.success) return null
  const s = boardsStore()
  const b = s.board(parsed.data)
  if (!b) return null
  return {
    board: b,
    columns: s.columns(b.id),
    cards: s.cards(b.id),
    labels: s.labels(b.id),
    fields: s.fields(b.id),
  }
}

export function archived(raw: unknown): Card[] {
  const parsed = IdSchema.safeParse(raw)
  if (!parsed.success) return []
  return boardsStore()
    .cards(parsed.data, { archived: true })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** Other cards, with their board and column names, for linking. */
function cardSources(): CardSource[] {
  const s = boardsStore()
  const boards = new Map(s.boards().map((b) => [b.id, b.name]))
  const columns = new Map(
    [...boards.keys()].flatMap((id) => s.columns(id).map((c) => [c.id, c.name] as const)),
  )
  return s.allCards().map((c) => ({
    id: c.id,
    title: c.title,
    boardName: boards.get(c.boardId) ?? '',
    columnName: columns.get(c.columnId) ?? '',
    due: c.due,
  }))
}

/**
 * What the other modules have that a card could link to, for the kinds asked. Each module is
 * read on its own; one that isn't set up (or fails) just offers nothing.
 */
async function gather(kinds: ReadonlySet<LinkKind>, today = toISODate()): Promise<LinkSources> {
  const sources: LinkSources = {}
  if (kinds.has('event'))
    try {
      // The calendar cache covers a month back to a year ahead.
      const names = new Map(calendar.calendars().map((c) => [c.id, c.name]))
      sources.events = calendar
        .events({ start: fromISODate(addDays(today, -35)), end: fromISODate(addDays(today, 400)) })
        .map((e) => ({ ...e, calendarName: names.get(e.calendarId) }))
    } catch {
      sources.events = []
    }
  if (kinds.has('bill'))
    try {
      sources.bills = (await money.overview()).bills
        .filter((b) => b.status === 'active')
        .map((b) => ({ id: b.id, name: b.name, amount: b.amount, nextDue: b.nextDue, cadence: b.cadence }))
    } catch {
      sources.bills = []
    }
  if (kinds.has('transaction'))
    try {
      sources.transactions = money.storedTransactions()
    } catch {
      sources.transactions = []
    }
  if (kinds.has('email'))
    try {
      sources.emails = (cachedInboxHeaders() ?? []).map((h) => ({
        mailbox: h.mailbox,
        uid: h.uid,
        subject: h.subject,
        from: h.from,
        date: h.date,
      }))
    } catch {
      sources.emails = []
    }
  if (kinds.has('card')) sources.cards = cardSources()
  return sources
}

const allCandidates = (sources: LinkSources): LinkCandidate[] => Object.values(toCandidates(sources)).flat()

export async function card(raw: unknown): Promise<CardDetail | null> {
  const parsed = IdSchema.safeParse(raw)
  if (!parsed.success) return null
  const s = boardsStore()
  const c = s.card(parsed.data)
  if (!c) return null
  const links = s.links(c.id)
  const sources = await gather(new Set(links.map((l) => l.target.kind)))
  const cards = new Map(cardSources().map((x) => [x.id, x]))
  return {
    card: c,
    checklist: s.checklist(c.id),
    links: resolveLinks(links, allCandidates(sources)),
    backlinks: s.backlinks(c.id).map(({ card: from }) => ({
      cardId: from.id,
      title: from.title,
      boardName: cards.get(from.id)?.boardName ?? '',
      columnName: cards.get(from.id)?.columnName ?? '',
    })),
  }
}

/** Things of one kind a card could link to, matching the query, most useful first. */
export async function linkCandidates(raw: unknown): Promise<LinkCandidate[]> {
  const parsed = CandidateQuerySchema.safeParse(raw)
  if (!parsed.success) return []
  const { cardId, kind, query } = parsed.data
  const s = boardsStore()
  if (!s.card(cardId)) return []
  const today = toISODate()
  const linked = new Set(s.links(cardId).map((l) => targetKey(l.target)))
  let list = toCandidates(await gather(new Set([kind]), today))[kind].filter(
    (c) => !linked.has(c.key) && !(c.target.kind === 'card' && c.target.cardId === cardId),
  )
  const byDate = (dir: 1 | -1) => (a: LinkCandidate, b: LinkCandidate) =>
    dir * (a.date ?? '9999').localeCompare(b.date ?? '9999')
  if (kind === 'event' || kind === 'bill')
    list = list.filter((c) => !c.date || c.date >= addDays(today, -7)).sort(byDate(1))
  else if (kind === 'email' || kind === 'transaction') list = list.sort(byDate(-1))
  return searchCandidates(list, query, 50)
}

// Calendar

const DAY_MS = 86_400_000

/** Cards with a due date or range in `[start, end)`, as Calendar overlay items. */
export function dueDates(raw: unknown): CalendarOverlayItem[] {
  const parsed = DateRangeSchema.safeParse(raw)
  if (!parsed.success) return []
  const { start, end } = parsed.data
  if (end.getTime() - start.getTime() > 400 * DAY_MS) return []
  const s = boardsStore()
  const boards = s.boards()
  const done = new Set(
    boards.flatMap((b) =>
      s
        .columns(b.id)
        .filter((c) => c.done)
        .map((c) => c.id),
    ),
  )
  const items = cardsToCalendarItems(
    s.allCards(),
    { boardNames: new Map(boards.map((b) => [b.id, b.name])), doneColumns: done },
    { from: toISODate(start), to: toISODate(new Date(end.getTime() - 1)) },
  )
  return items.map((i) => ({
    id: `boards:${i.id}`,
    date: fromISODate(i.from),
    ...(i.to !== i.from && { until: fromISODate(i.to) }),
    title: i.title,
    kind: 'card',
    detail: i.boardName,
    route: `boards?card=${encodeURIComponent(i.cardId)}`,
  }))
}

// Changes. Each validates its input and takes the write lock.

export const createBoard = (raw: unknown) =>
  change(CreateBoardSchema, raw, (i, s) => s.createBoard(i.name, i.template))
export const renameBoard = (raw: unknown) =>
  change(RenameBoardSchema, raw, (i, s) => s.renameBoard(i.id, i.name))
export const moveBoard = (raw: unknown) =>
  change(MoveSchema, raw, (i, s) => (s.moveBoard(i.id, i.index), null))
export const deleteBoard = (raw: unknown) => change(IdSchema, raw, (id, s) => s.deleteBoard(id))

export const addColumn = (raw: unknown) =>
  change(AddColumnSchema, raw, (i, s) => s.addColumn(i.boardId, i.name, i.index))
export const updateColumn = (raw: unknown) =>
  change(UpdateColumnSchema, raw, ({ id, ...patch }, s) => s.updateColumn(id, patch))
export const moveColumn = (raw: unknown) =>
  change(MoveSchema, raw, (i, s) => (s.moveColumn(i.id, i.index), null))
export const deleteColumn = (raw: unknown) => change(IdSchema, raw, (id, s) => s.deleteColumn(id))

export const addCard = (raw: unknown) =>
  change(AddCardSchema, raw, ({ link, ...input }, s) => {
    const c = s.addCard(input)
    if (link) s.addLink(c.id, link)
    return s.card(c.id)!
  })
export const updateCard = (raw: unknown) =>
  change(UpdateCardSchema, raw, ({ id, ...patch }, s) => s.updateCard(id, patch))
export const moveCard = (raw: unknown) =>
  change(MoveCardSchema, raw, (i, s) => s.moveCard(i.id, i.columnId, i.index))
export const archiveCard = (raw: unknown) =>
  change(ArchiveCardSchema, raw, (i, s) => s.archiveCard(i.id, i.archived))
export const deleteCard = (raw: unknown) => change(IdSchema, raw, (id, s) => s.deleteCard(id))

export const addChecklistItem = (raw: unknown) =>
  change(AddChecklistItemSchema, raw, (i, s) => s.addChecklistItem(i.cardId, i.text, i.index))
export const updateChecklistItem = (raw: unknown) =>
  change(UpdateChecklistItemSchema, raw, ({ id, ...patch }, s) => s.updateChecklistItem(id, patch))
export const moveChecklistItem = (raw: unknown) =>
  change(MoveSchema, raw, (i, s) => (s.moveChecklistItem(i.id, i.index), null))
export const deleteChecklistItem = (raw: unknown) =>
  change(IdSchema, raw, (id, s) => s.deleteChecklistItem(id))

export const saveLabel = (raw: unknown) => change(SaveLabelSchema, raw, (i, s) => s.saveLabel(i))
export const deleteLabel = (raw: unknown) => change(IdSchema, raw, (id, s) => s.deleteLabel(id))
export const saveField = (raw: unknown) => change(SaveFieldSchema, raw, (i, s) => s.saveField(i))
export const moveField = (raw: unknown) =>
  change(MoveSchema, raw, (i, s) => (s.moveField(i.id, i.index), null))
export const deleteField = (raw: unknown) => change(IdSchema, raw, (id, s) => s.deleteField(id))

export const addLink = (raw: unknown) =>
  change(LinkInputSchema, raw, ({ cardId, ...link }, s) => (s.addLink(cardId, link), null))
export const removeLink = (raw: unknown) => change(IdSchema, raw, (id, s) => (s.removeLink(id), null))

export const restore = (raw: unknown) =>
  change(UndoTokenSchema, raw, (token: UndoToken, s) => {
    if (!s.restore(token)) throw new BoardsError('not-found', 'That can’t be undone any more.')
    return null
  })

// Suggest with AI

let suggesting: AbortController | null = null

/**
 * Ask the model chosen in Settings → AI to suggest a due date, checklist, labels and links for a
 * card. Ordo gathers the candidates (upcoming events and bills, recent emails, other cards) and
 * the model only picks among them by id. Same provider, model and cloud consent as everywhere
 * else. Read-only: the user accepts each suggestion, which is then an ordinary change.
 */
export async function suggest(raw: unknown): Promise<SuggestOutcome> {
  const parsed = IdSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'not-found', message: 'That card is no longer there.' }
  const ai = aiSettings()
  if (ai.provider === 'none')
    return { ok: false, error: 'no-ai', message: 'Choose a model in Settings → AI first.' }
  const provider = usableProvider(ai)
  if (!provider)
    return { ok: false, error: 'consent', message: 'Confirm that Ordo may use this provider first.' }
  if (suggesting) return { ok: false, error: 'busy', message: 'Already asking for suggestions.' }
  const s = boardsStore()
  const c = s.card(parsed.data)
  if (!c) return { ok: false, error: 'not-found', message: 'That card is no longer there.' }

  const ctrl = (suggesting = new AbortController())
  try {
    const today = toISODate()
    const sources = await gather(new Set(['event', 'bill', 'email', 'card']), today)
    const candidates = toCandidates({ ...sources, cards: sources.cards?.filter((x) => x.id !== c.id) })
    const result = await suggestForCard(
      {
        card: {
          title: c.title,
          notes: plainText(parseMarkdown(c.notes)),
          start: c.start,
          due: c.due,
          checklist: s.checklist(c.id).map((i) => i.text),
          labelIds: c.labelIds,
          linked: new Set(s.links(c.id).map((l) => targetKey(l.target))),
        },
        labels: s.labels(c.boardId),
        candidates: {
          event: candidates.event,
          bill: candidates.bill,
          email: candidates.email,
          card: candidates.card,
        },
        today,
      },
      provider,
      { model: await resolveModel(ai), signal: ctrl.signal, timeoutMs: 180_000 },
    )
    const info = providerInfo(provider.id)
    const { sent, ...suggestions } = result
    return {
      ok: true,
      suggestions,
      sent,
      provider: { label: info.label, kind: info.kind, ...(info.vendor && { vendor: info.vendor }) },
    }
  } catch (err) {
    return { ok: false, error: 'failed', message: aiMessage(err) }
  } finally {
    suggesting = null
  }
}

export function stopSuggest(): void {
  suggesting?.abort()
}

/** The service behind `window.ordo.boards`: one function per method, each taking unchecked input. */
const service: { [K in keyof BoardsApi]: (input: unknown) => unknown } = {
  list,
  board,
  card,
  archived,
  createBoard,
  renameBoard,
  moveBoard,
  deleteBoard,
  addColumn,
  updateColumn,
  moveColumn,
  deleteColumn,
  addCard,
  updateCard,
  moveCard,
  archiveCard,
  deleteCard,
  addChecklistItem,
  updateChecklistItem,
  moveChecklistItem,
  deleteChecklistItem,
  saveLabel,
  deleteLabel,
  saveField,
  moveField,
  deleteField,
  addLink,
  removeLink,
  linkCandidates,
  restore,
  dueDates,
  suggest,
  stopSuggest,
}

/** Register every Boards IPC handler. Arguments from the renderer are validated in each function. */
export function registerBoardsIpc(): void {
  for (const method of BOARDS_METHODS)
    ipcMain.handle(boardsChannel(method), (_e, input: unknown) => service[method](input))
}

export function closeBoards(): void {
  stopSuggest()
  store?.close()
  store = null
}

// By name: boards, columns, labels and cards named the way a person (or an agent) would, for
// headless mode and the assistant. Each resolves to ids and then calls the functions above.

type Found<T> = { ok: true; value: T } | { ok: false; error: 'not-found' | 'invalid'; message: string }
const missing = (message: string) => ({ ok: false as const, error: 'not-found' as const, message })
const fold = (s: string) => s.trim().toLocaleLowerCase()

/** One item whose id is `ref`, or whose name is `ref` ignoring case, or whose id starts with it. */
function pick<T extends { id: string }>(
  items: T[],
  ref: string,
  nameOf: (t: T) => string,
  what: string,
): Found<T> {
  const exact = items.find((i) => i.id === ref)
  if (exact) return { ok: true, value: exact }
  const named = items.filter((i) => fold(nameOf(i)) === fold(ref))
  if (named.length === 1) return { ok: true, value: named[0]! }
  if (named.length > 1)
    return { ok: false, error: 'invalid', message: `More than one ${what} is called “${ref}”. Use its id.` }
  const prefixed = ref.length >= 4 ? items.filter((i) => i.id.startsWith(ref)) : []
  if (prefixed.length === 1) return { ok: true, value: prefixed[0]! }
  return missing(`There’s no ${what} called “${ref}”.`)
}

export function findBoard(ref: string) {
  return pick(boardsStore().boards(), ref, (b) => b.name, 'board')
}

export function findColumn(boardId: string, ref: string) {
  return pick(boardsStore().columns(boardId), ref, (c) => c.name, 'column')
}

/** A card by id, id prefix or exact title (on one board, if given). */
export function findCard(ref: string, boardId?: string) {
  const s = boardsStore()
  const cards = boardId ? s.cards(boardId) : s.allCards()
  return pick(cards, ref, (c) => c.title, 'card')
}

/** A card as headless mode and agents see it: names instead of ids, where it can. */
export function cardRow(c: Card) {
  const s = boardsStore()
  const labels = new Map(s.labels(c.boardId).map((l) => [l.id, l.name]))
  const fields = s.fields(c.boardId)
  return {
    id: c.id,
    title: c.title,
    board: s.board(c.boardId)?.name ?? null,
    column: s.column(c.columnId)?.name ?? null,
    start: c.start,
    due: c.due,
    labels: c.labelIds.map((l) => labels.get(l)).filter((l): l is string => l !== undefined),
    checklist: c.checklist,
    links: c.links,
    fields: Object.fromEntries(
      fields.filter((f) => c.fields[f.id] !== undefined).map((f) => [f.name, fieldText(f, c.fields[f.id])]),
    ),
    archived: c.archivedAt !== null,
  }
}

/** Cards on a board (or every board), optionally in one column or with one label. */
export function cardsByRef(q: {
  board?: string
  column?: string
  label?: string
  archived?: boolean
}): Found<Card[]> {
  const s = boardsStore()
  let boards = s.boards()
  if (q.board) {
    const b = findBoard(q.board)
    if (!b.ok) return b
    boards = [b.value]
  } else if (q.column)
    return { ok: false, error: 'invalid', message: 'Name the board as well as the column.' }
  let cards = boards.flatMap((b) => s.cards(b.id, { archived: q.archived }))
  if (q.column) {
    const col = findColumn(boards[0]!.id, q.column)
    if (!col.ok) return col
    cards = cards.filter((c) => c.columnId === col.value.id)
  }
  if (q.label) {
    const want = fold(q.label)
    const ids = new Set(
      boards.flatMap((b) =>
        s
          .labels(b.id)
          .filter((l) => fold(l.name) === want)
          .map((l) => l.id),
      ),
    )
    cards = cards.filter((c) => c.labelIds.some((l) => ids.has(l)))
  }
  // Board order, then column order, then position in the column.
  const order = new Map(
    boards.flatMap((b, bi) => s.columns(b.id).map((c, ci) => [c.id, bi * 1000 + ci] as const)),
  )
  cards.sort(
    (a, b) =>
      (order.get(a.columnId) ?? 0) - (order.get(b.columnId) ?? 0) ||
      (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0),
  )
  return { ok: true, value: cards }
}

/** Add a card naming its board, column and labels. */
export async function addCardByRef(input: {
  board: string
  column?: string
  title: string
  notes?: string
  start?: string | null
  due?: string | null
  labels?: string[]
}): Promise<BoardsResult<Card>> {
  const b = findBoard(input.board)
  if (!b.ok) return b
  let columnId: string | undefined
  if (input.column) {
    const col = findColumn(b.value.id, input.column)
    if (!col.ok) return col
    columnId = col.value.id
  }
  const labels = boardsStore().labels(b.value.id)
  const labelIds: string[] = []
  for (const name of input.labels ?? []) {
    const l = pick(labels, name, (x) => x.name, 'label')
    if (!l.ok) return l
    labelIds.push(l.value.id)
  }
  return addCard({
    boardId: b.value.id,
    columnId,
    title: input.title,
    notes: input.notes,
    start: input.start ?? null,
    due: input.due ?? null,
    labelIds,
  })
}

/** Move a card (by id, id prefix or title) to a column and position (1 is the top). */
export async function moveCardByRef(input: {
  card: string
  board?: string
  column?: string
  position?: number
}): Promise<BoardsResult<Card>> {
  let boardId: string | undefined
  if (input.board) {
    const b = findBoard(input.board)
    if (!b.ok) return b
    boardId = b.value.id
  }
  const c = findCard(input.card, boardId)
  if (!c.ok) return c
  let columnId = c.value.columnId
  if (input.column) {
    const col = findColumn(c.value.boardId, input.column)
    if (!col.ok) return col
    columnId = col.value.id
  }
  // Position 1 is the top; without one the card goes to the end of the column.
  const index = input.position !== undefined ? Math.max(0, input.position - 1) : 100_000
  return moveCard({ id: c.value.id, columnId, index })
}
