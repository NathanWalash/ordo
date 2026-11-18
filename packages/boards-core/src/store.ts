import { randomUUID } from 'node:crypto'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { isISODate } from './dates'
import { normaliseFieldValue } from './fields'
import { targetKey } from './links'
import { planMove, rankAfter, sortByRank, type Ranked } from './rank'
import { template } from './templates'
import {
  FIELD_TYPES,
  LABEL_COLORS,
  type Board,
  type Card,
  type CardLink,
  type ChecklistItem,
  type Column,
  type FieldDef,
  type FieldOption,
  type FieldType,
  type FieldValue,
  type ISODate,
  type Label,
  type LabelColor,
  type LinkTarget,
  type TemplateId,
  type UndoToken,
} from './types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rank TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS columns (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  name TEXT NOT NULL,
  rank TEXT NOT NULL,
  wip_limit INTEGER,
  done INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS columns_board ON columns (board_id);
CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  rank TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS fields (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  show_on_card INTEGER NOT NULL DEFAULT 0,
  rank TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  column_id TEXT NOT NULL,
  rank TEXT NOT NULL,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  start TEXT,
  due TEXT,
  label_ids TEXT NOT NULL DEFAULT '[]',
  field_values TEXT NOT NULL DEFAULT '{}',
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS cards_board ON cards (board_id);
CREATE INDEX IF NOT EXISTS cards_column ON cards (column_id, rank);
CREATE INDEX IF NOT EXISTS cards_due ON cards (due);
CREATE TABLE IF NOT EXISTS checklist (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  rank TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS checklist_card ON checklist (card_id);
CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  target_key TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  date TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (card_id, target_key)
);
CREATE INDEX IF NOT EXISTS links_target ON links (target_key);
`

/** Sizes the store refuses to go past, whoever is asking. */
export const LIMITS = {
  boards: 200,
  columns: 50,
  cards: 5000,
  labels: 50,
  fields: 30,
  options: 50,
  checklist: 200,
  links: 100,
  name: 80,
  title: 300,
  notes: 20_000,
  checklistText: 300,
  linkTitle: 300,
  wipLimit: 999,
} as const

export type BoardsErrorCode = 'not-found' | 'invalid' | 'limit'

/** A refused change, with a message fit to show the user. */
export class BoardsError extends Error {
  constructor(
    readonly code: BoardsErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'BoardsError'
  }
}

const notFound = (what: string) => new BoardsError('not-found', `That ${what} is no longer there.`)

type Row = Record<string, SQLInputValue>

const now = () => new Date().toISOString()
const json = <T>(text: unknown, fallback: T): T => {
  try {
    return typeof text === 'string' ? (JSON.parse(text) as T) : fallback
  } catch {
    return fallback
  }
}

// C0 and C1 control characters, DEL, and bidi overrides and isolates: never part of a name.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g

function cleanName(name: string, what: string, max: number = LIMITS.name): string {
  const s = String(name ?? '')
    .replace(UNSAFE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) throw new BoardsError('invalid', `Give the ${what} a name.`)
  if (s.length > max) throw new BoardsError('invalid', `That ${what} name is too long.`)
  return s
}

const isColor = (c: unknown): c is LabelColor => (LABEL_COLORS as readonly unknown[]).includes(c)

export interface NewCard {
  boardId: string
  /** Defaults to the first column. */
  columnId?: string
  title: string
  notes?: string
  start?: ISODate | null
  due?: ISODate | null
  labelIds?: string[]
  fields?: Record<string, unknown>
  /** Position in the column; the end by default. */
  index?: number
}

export interface CardPatch {
  title?: string
  notes?: string
  start?: ISODate | null
  due?: ISODate | null
  labelIds?: string[]
  /** Values to set by field id; null clears one. Fields not mentioned keep their value. */
  fields?: Record<string, unknown>
}

/**
 * Boards in their own local SQLite file (`boards.sqlite`). Deletes are soft for a while so they
 * can be undone; `purgeDeleted` removes them for good. Every write checks its input, so the app,
 * headless mode and an agent all get the same rules.
 */
export class BoardsStore {
  private db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    // The app and a headless Ordo may share this file: wait for the other's write instead of failing.
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
  }

  // Boards

  boards(): Board[] {
    const rows = this.all('SELECT * FROM boards WHERE deleted_at IS NULL')
    return sortByRank(rows.map(toBoard))
  }

  board(id: string): Board | undefined {
    const r = this.get('SELECT * FROM boards WHERE id = ? AND deleted_at IS NULL', id)
    return r ? toBoard(r) : undefined
  }

  createBoard(name: string, templateId: TemplateId = 'simple'): Board {
    const boards = this.boards()
    if (boards.length >= LIMITS.boards) throw new BoardsError('limit', 'That’s as many boards as Ordo keeps.')
    const t = template(templateId)
    const board: Board = {
      id: randomUUID(),
      name: cleanName(name, 'board'),
      rank: rankAfter(boards.at(-1)?.rank),
      createdAt: now(),
    }
    this.tx(() => {
      this.run(
        'INSERT INTO boards (id, name, rank, created_at) VALUES (?, ?, ?, ?)',
        board.id,
        board.name,
        board.rank,
        board.createdAt,
      )
      for (const c of t.columns) {
        const col = this.addColumn(board.id, c.name)
        if (c.wipLimit || c.done)
          this.updateColumn(col.id, { wipLimit: c.wipLimit ?? null, done: c.done ?? false })
      }
      for (const l of t.labels) this.saveLabel({ boardId: board.id, name: l.name, color: l.color })
      for (const f of t.fields)
        this.saveField({
          boardId: board.id,
          name: f.name,
          type: f.type,
          options: f.options ?? [],
          showOnCard: f.showOnCard ?? false,
        })
    })
    return board
  }

  renameBoard(id: string, name: string): Board {
    const board = this.board(id)
    if (!board) throw notFound('board')
    this.run('UPDATE boards SET name = ? WHERE id = ?', cleanName(name, 'board'), id)
    return this.board(id)!
  }

  moveBoard(id: string, index: number): void {
    if (!this.board(id)) throw notFound('board')
    this.applyMove('boards', this.boards(), id, index)
  }

  deleteBoard(id: string): UndoToken {
    if (!this.board(id)) throw notFound('board')
    this.run('UPDATE boards SET deleted_at = ? WHERE id = ?', now(), id)
    return { kind: 'board', id }
  }

  // Columns

  columns(boardId: string): Column[] {
    return sortByRank(
      this.all('SELECT * FROM columns WHERE board_id = ? AND deleted_at IS NULL', boardId).map(toColumn),
    )
  }

  column(id: string): Column | undefined {
    const r = this.get(
      'SELECT c.* FROM columns c JOIN boards b ON b.id = c.board_id ' +
        'WHERE c.id = ? AND c.deleted_at IS NULL AND b.deleted_at IS NULL',
      id,
    )
    return r ? toColumn(r) : undefined
  }

  addColumn(boardId: string, name: string, index?: number): Column {
    if (!this.board(boardId)) throw notFound('board')
    const columns = this.columns(boardId)
    if (columns.length >= LIMITS.columns) throw new BoardsError('limit', 'A board can have up to 50 columns.')
    const id = randomUUID()
    const rank = index === undefined ? rankAfter(columns.at(-1)?.rank) : planMove(columns, id, index).rank
    this.tx(() => {
      if (index !== undefined) this.applyMove('columns', columns, id, index, false)
      this.run(
        'INSERT INTO columns (id, board_id, name, rank, done) VALUES (?, ?, ?, ?, 0)',
        id,
        boardId,
        cleanName(name, 'column'),
        rank,
      )
    })
    return this.column(id)!
  }

  updateColumn(id: string, patch: { name?: string; wipLimit?: number | null; done?: boolean }): Column {
    const col = this.column(id)
    if (!col) throw notFound('column')
    const name = patch.name !== undefined ? cleanName(patch.name, 'column') : col.name
    let wip = patch.wipLimit !== undefined ? patch.wipLimit : col.wipLimit
    if (wip !== null) {
      if (!Number.isInteger(wip) || wip < 0 || wip > LIMITS.wipLimit)
        throw new BoardsError('invalid', 'A limit is a whole number of cards.')
      if (wip === 0) wip = null
    }
    const done = patch.done ?? col.done
    this.run('UPDATE columns SET name = ?, wip_limit = ?, done = ? WHERE id = ?', name, wip, done ? 1 : 0, id)
    return this.column(id)!
  }

  moveColumn(id: string, index: number): void {
    const col = this.column(id)
    if (!col) throw notFound('column')
    this.applyMove('columns', this.columns(col.boardId), id, index)
  }

  deleteColumn(id: string): UndoToken {
    const col = this.column(id)
    if (!col) throw notFound('column')
    if (this.columns(col.boardId).length <= 1)
      throw new BoardsError('invalid', 'A board needs at least one column.')
    this.run('UPDATE columns SET deleted_at = ? WHERE id = ?', now(), id)
    return { kind: 'column', id }
  }

  // Labels

  labels(boardId: string): Label[] {
    return sortByRank(
      this.all('SELECT * FROM labels WHERE board_id = ? AND deleted_at IS NULL', boardId).map(toLabel),
    )
  }

  saveLabel(input: { id?: string; boardId: string; name: string; color: LabelColor }): Label {
    if (!this.board(input.boardId)) throw notFound('board')
    if (!isColor(input.color)) throw new BoardsError('invalid', 'Choose a colour.')
    const name = cleanName(input.name, 'label', 40)
    const labels = this.labels(input.boardId)
    if (labels.some((l) => l.id !== input.id && l.name.toLowerCase() === name.toLowerCase()))
      throw new BoardsError('invalid', `There’s already a label called ${name}.`)
    if (input.id) {
      if (!labels.some((l) => l.id === input.id)) throw notFound('label')
      this.run('UPDATE labels SET name = ?, color = ? WHERE id = ?', name, input.color, input.id)
      return this.labels(input.boardId).find((l) => l.id === input.id)!
    }
    if (labels.length >= LIMITS.labels) throw new BoardsError('limit', 'A board can have up to 50 labels.')
    const id = randomUUID()
    this.run(
      'INSERT INTO labels (id, board_id, name, color, rank) VALUES (?, ?, ?, ?, ?)',
      id,
      input.boardId,
      name,
      input.color,
      rankAfter(labels.at(-1)?.rank),
    )
    return this.labels(input.boardId).find((l) => l.id === id)!
  }

  deleteLabel(id: string): UndoToken {
    if (!this.get('SELECT 1 FROM labels WHERE id = ? AND deleted_at IS NULL', id)) throw notFound('label')
    this.run('UPDATE labels SET deleted_at = ? WHERE id = ?', now(), id)
    return { kind: 'label', id }
  }

  // Custom fields

  fields(boardId: string): FieldDef[] {
    return sortByRank(
      this.all('SELECT * FROM fields WHERE board_id = ? AND deleted_at IS NULL', boardId).map(toField),
    )
  }

  saveField(input: {
    id?: string
    boardId: string
    name: string
    type: FieldType
    options?: { id?: string; name: string; color?: LabelColor }[]
    showOnCard?: boolean
  }): FieldDef {
    if (!this.board(input.boardId)) throw notFound('board')
    const name = cleanName(input.name, 'field', 40)
    const fields = this.fields(input.boardId)
    if (fields.some((f) => f.id !== input.id && f.name.toLowerCase() === name.toLowerCase()))
      throw new BoardsError('invalid', `There’s already a field called ${name}.`)
    const existing = input.id ? fields.find((f) => f.id === input.id) : undefined
    if (input.id && !existing) throw notFound('field')
    // A field keeps its type: values already saved were checked against it.
    const type = existing?.type ?? input.type
    if (!(FIELD_TYPES as readonly string[]).includes(type))
      throw new BoardsError('invalid', 'Choose a field type.')
    const options: FieldOption[] = []
    if (type === 'select') {
      for (const o of input.options ?? []) {
        const optName = cleanName(o.name, 'option', 40)
        if (options.some((x) => x.name.toLowerCase() === optName.toLowerCase())) continue
        options.push({ id: o.id || randomUUID(), name: optName, color: isColor(o.color) ? o.color : 'grey' })
      }
      if (options.length > LIMITS.options)
        throw new BoardsError('limit', 'A choice can have up to 50 options.')
    }
    const show = input.showOnCard ?? existing?.showOnCard ?? false
    if (existing) {
      this.run(
        'UPDATE fields SET name = ?, options = ?, show_on_card = ? WHERE id = ?',
        name,
        JSON.stringify(options),
        show ? 1 : 0,
        existing.id,
      )
      return this.fields(input.boardId).find((f) => f.id === existing.id)!
    }
    if (fields.length >= LIMITS.fields) throw new BoardsError('limit', 'A board can have up to 30 fields.')
    const id = randomUUID()
    this.run(
      'INSERT INTO fields (id, board_id, name, type, options, show_on_card, rank) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      input.boardId,
      name,
      type,
      JSON.stringify(options),
      show ? 1 : 0,
      rankAfter(fields.at(-1)?.rank),
    )
    return this.fields(input.boardId).find((f) => f.id === id)!
  }

  moveField(id: string, index: number): void {
    const r = this.get('SELECT board_id FROM fields WHERE id = ? AND deleted_at IS NULL', id)
    if (!r) throw notFound('field')
    this.applyMove('fields', this.fields(String(r['board_id'])), id, index)
  }

  deleteField(id: string): UndoToken {
    if (!this.get('SELECT 1 FROM fields WHERE id = ? AND deleted_at IS NULL', id)) throw notFound('field')
    this.run('UPDATE fields SET deleted_at = ? WHERE id = ?', now(), id)
    return { kind: 'field', id }
  }

  // Cards

  private static readonly CARD_SELECT =
    'SELECT k.*, ' +
    '(SELECT COUNT(*) FROM checklist i WHERE i.card_id = k.id AND i.deleted_at IS NULL) AS items, ' +
    '(SELECT COUNT(*) FROM checklist i WHERE i.card_id = k.id AND i.deleted_at IS NULL AND i.done = 1) AS items_done, ' +
    '(SELECT COUNT(*) FROM links l WHERE l.card_id = k.id) AS link_count ' +
    'FROM cards k JOIN columns c ON c.id = k.column_id JOIN boards b ON b.id = k.board_id ' +
    'WHERE k.deleted_at IS NULL AND c.deleted_at IS NULL AND b.deleted_at IS NULL'

  /** A board's cards, in column order then rank. Archived ones only with `archived: true`. */
  cards(boardId: string, options: { archived?: boolean } = {}): Card[] {
    const rows = this.all(
      `${BoardsStore.CARD_SELECT} AND k.board_id = ? AND k.archived_at IS ${options.archived ? 'NOT NULL' : 'NULL'}`,
      boardId,
    )
    return this.withLiveRefs(boardId, sortByRank(rows.map(toCard)))
  }

  /** Every card that isn't archived or deleted, on every board: for the Calendar and linking. */
  allCards(): Card[] {
    const rows = this.all(`${BoardsStore.CARD_SELECT} AND k.archived_at IS NULL`)
    return sortByRank(rows.map(toCard))
  }

  card(id: string): Card | undefined {
    const r = this.get(`${BoardsStore.CARD_SELECT} AND k.id = ?`, id)
    if (!r) return undefined
    const card = toCard(r)
    return this.withLiveRefs(card.boardId, [card])[0]
  }

  /** Cards in a column, not archived, in order. */
  private columnCards(columnId: string): Ranked[] {
    return sortByRank(
      this.all(
        'SELECT id, rank FROM cards WHERE column_id = ? AND deleted_at IS NULL AND archived_at IS NULL',
        columnId,
      ).map((r) => ({ id: String(r['id']), rank: String(r['rank']) })),
    )
  }

  addCard(input: NewCard): Card {
    const board = this.board(input.boardId)
    if (!board) throw notFound('board')
    const columns = this.columns(board.id)
    const column = input.columnId ? columns.find((c) => c.id === input.columnId) : columns[0]
    if (!column) throw notFound('column')
    const count = this.get(
      'SELECT COUNT(*) AS n FROM cards WHERE board_id = ? AND deleted_at IS NULL',
      board.id,
    )
    if (Number(count?.['n'] ?? 0) >= LIMITS.cards)
      throw new BoardsError('limit', 'A board can have up to 5,000 cards.')
    const id = randomUUID()
    const values = this.cardValues(board.id, {
      title: input.title,
      notes: input.notes ?? '',
      start: input.start ?? null,
      due: input.due ?? null,
      labelIds: input.labelIds ?? [],
      fields: {},
      patchFields: input.fields ?? {},
    })
    const t = now()
    this.tx(() => {
      const plan = planMove(this.columnCards(column.id), id, input.index ?? Number.POSITIVE_INFINITY)
      this.run(
        'INSERT INTO cards (id, board_id, column_id, rank, title, notes, start, due, label_ids, field_values, created_at, updated_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id,
        board.id,
        column.id,
        plan.rank,
        values.title,
        values.notes,
        values.start,
        values.due,
        JSON.stringify(values.labelIds),
        JSON.stringify(values.fields),
        t,
        t,
      )
      for (const u of plan.updates)
        if (u.id !== id) this.run('UPDATE cards SET rank = ? WHERE id = ?', u.rank, u.id)
    })
    return this.card(id)!
  }

  updateCard(id: string, patch: CardPatch): Card {
    const card = this.card(id)
    if (!card) throw notFound('card')
    const values = this.cardValues(card.boardId, {
      title: patch.title ?? card.title,
      notes: patch.notes ?? card.notes,
      start: patch.start !== undefined ? patch.start : card.start,
      due: patch.due !== undefined ? patch.due : card.due,
      labelIds: patch.labelIds ?? card.labelIds,
      fields: card.fields,
      patchFields: patch.fields ?? {},
    })
    this.run(
      'UPDATE cards SET title = ?, notes = ?, start = ?, due = ?, label_ids = ?, field_values = ?, updated_at = ? WHERE id = ?',
      values.title,
      values.notes,
      values.start,
      values.due,
      JSON.stringify(values.labelIds),
      JSON.stringify(values.fields),
      now(),
      id,
    )
    return this.card(id)!
  }

  /** Move a card to `index` in a column of the same board (its own column by default). */
  moveCard(id: string, columnId: string | undefined, index: number): Card {
    const card = this.card(id)
    if (!card) throw notFound('card')
    if (card.archivedAt) throw new BoardsError('invalid', 'Restore the card before moving it.')
    const to = columnId ?? card.columnId
    const column = this.column(to)
    if (!column || column.boardId !== card.boardId) throw notFound('column')
    this.tx(() => {
      const plan = planMove(this.columnCards(to), id, index)
      for (const u of plan.updates)
        this.run(
          u.id === id
            ? 'UPDATE cards SET rank = ?, column_id = ?, updated_at = ? WHERE id = ?'
            : 'UPDATE cards SET rank = ? WHERE id = ?',
          ...(u.id === id ? [u.rank, to, now(), u.id] : [u.rank, u.id]),
        )
    })
    return this.card(id)!
  }

  /** Archive a card, or bring it back (to the end of its column). */
  archiveCard(id: string, archived: boolean): Card {
    const card = this.card(id)
    if (!card) throw notFound('card')
    if (archived === Boolean(card.archivedAt)) return card
    if (archived) this.run('UPDATE cards SET archived_at = ?, updated_at = ? WHERE id = ?', now(), now(), id)
    else
      this.run(
        'UPDATE cards SET archived_at = NULL, rank = ?, updated_at = ? WHERE id = ?',
        rankAfter(this.columnCards(card.columnId).at(-1)?.rank),
        now(),
        id,
      )
    return this.card(id)!
  }

  deleteCard(id: string): UndoToken {
    if (!this.card(id)) throw notFound('card')
    this.run('UPDATE cards SET deleted_at = ? WHERE id = ?', now(), id)
    return { kind: 'card', id }
  }

  // Checklists

  checklist(cardId: string): ChecklistItem[] {
    return sortByRank(
      this.all('SELECT * FROM checklist WHERE card_id = ? AND deleted_at IS NULL', cardId).map(
        toChecklistItem,
      ),
    )
  }

  addChecklistItem(cardId: string, text: string, index?: number): ChecklistItem {
    if (!this.card(cardId)) throw notFound('card')
    const items = this.checklist(cardId)
    if (items.length >= LIMITS.checklist)
      throw new BoardsError('limit', 'A checklist can have up to 200 items.')
    const id = randomUUID()
    const plan = planMove(items, id, index ?? Number.POSITIVE_INFINITY)
    this.tx(() => {
      for (const u of plan.updates)
        if (u.id !== id) this.run('UPDATE checklist SET rank = ? WHERE id = ?', u.rank, u.id)
      this.run(
        'INSERT INTO checklist (id, card_id, text, done, rank) VALUES (?, ?, ?, 0, ?)',
        id,
        cardId,
        cleanText(text, 'Write the step.', LIMITS.checklistText),
        plan.rank,
      )
      this.touch(cardId)
    })
    return this.checklist(cardId).find((i) => i.id === id)!
  }

  updateChecklistItem(id: string, patch: { text?: string; done?: boolean }): ChecklistItem {
    const item = this.checklistItem(id)
    const text =
      patch.text !== undefined ? cleanText(patch.text, 'Write the step.', LIMITS.checklistText) : item.text
    const done = patch.done ?? item.done
    this.run('UPDATE checklist SET text = ?, done = ? WHERE id = ?', text, done ? 1 : 0, id)
    this.touch(item.cardId)
    return this.checklistItem(id)
  }

  moveChecklistItem(id: string, index: number): void {
    const item = this.checklistItem(id)
    this.applyMove('checklist', this.checklist(item.cardId), id, index)
  }

  deleteChecklistItem(id: string): UndoToken {
    const item = this.checklistItem(id)
    this.run('UPDATE checklist SET deleted_at = ? WHERE id = ?', now(), id)
    this.touch(item.cardId)
    return { kind: 'checklist', id }
  }

  private checklistItem(id: string): ChecklistItem {
    const r = this.get('SELECT * FROM checklist WHERE id = ? AND deleted_at IS NULL', id)
    if (!r || !this.card(String(r['card_id']))) throw notFound('step')
    return toChecklistItem(r)
  }

  // Links

  links(cardId: string): CardLink[] {
    return this.all('SELECT * FROM links WHERE card_id = ? ORDER BY created_at, rowid', cardId).map(toLink)
  }

  /** Cards (not deleted) that link to this one, with the link. */
  backlinks(cardId: string): { card: Card; link: CardLink }[] {
    const rows = this.all('SELECT * FROM links WHERE target_key = ?', targetKey({ kind: 'card', cardId }))
    return rows.flatMap((r) => {
      const card = this.card(String(r['card_id']))
      return card ? [{ card, link: toLink(r) }] : []
    })
  }

  /** Link a card to something. Linking the same thing twice returns the existing link. */
  addLink(
    cardId: string,
    input: { target: LinkTarget; title: string; detail?: string | null; date?: ISODate | null },
  ): CardLink {
    if (!this.card(cardId)) throw notFound('card')
    const key = targetKey(input.target)
    const existing = this.get('SELECT * FROM links WHERE card_id = ? AND target_key = ?', cardId, key)
    if (existing) return toLink(existing)
    if (input.target.kind === 'card') {
      if (input.target.cardId === cardId) throw new BoardsError('invalid', 'A card can’t link to itself.')
      if (!this.card(input.target.cardId)) throw notFound('card')
    }
    if (this.links(cardId).length >= LIMITS.links)
      throw new BoardsError('limit', 'A card can have up to 100 links.')
    const link: CardLink = {
      id: randomUUID(),
      cardId,
      target: input.target,
      title: cleanText(input.title, 'Give the link a title.', LIMITS.linkTitle),
      detail: input.detail ? String(input.detail).slice(0, LIMITS.linkTitle) : null,
      date: input.date && isISODate(input.date) ? input.date : null,
      createdAt: now(),
    }
    this.run(
      'INSERT INTO links (id, card_id, kind, target, target_key, title, detail, date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      link.id,
      cardId,
      link.target.kind,
      JSON.stringify(link.target),
      key,
      link.title,
      link.detail,
      link.date,
      link.createdAt,
    )
    this.touch(cardId)
    return link
  }

  removeLink(id: string): void {
    const r = this.get('SELECT card_id FROM links WHERE id = ?', id)
    if (!r) throw notFound('link')
    this.run('DELETE FROM links WHERE id = ?', id)
    this.touch(String(r['card_id']))
  }

  // Undo and clean-up

  /** Put back something deleted. False when it's gone for good (or was never deleted). */
  restore(token: UndoToken): boolean {
    const table = UNDO_TABLES[token.kind]
    if (!table) return false
    const row = this.get(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NOT NULL`, token.id)
    if (!row) return false
    const siblings = this.restoreChecks(token.kind, row)
    if (!siblings) return false
    return this.tx(() => {
      this.run(`UPDATE ${table} SET deleted_at = NULL WHERE id = ?`, token.id)
      // Something added since may have taken the same rank: then fit it back in just before.
      const rank = String(row['rank'])
      if (siblings.some((x) => x.rank === rank)) {
        const index = siblings.filter((x) => x.rank < rank).length
        for (const u of planMove(siblings, token.id, index).updates)
          this.run(`UPDATE ${table} SET rank = ? WHERE id = ?`, u.rank, u.id)
      }
      return true
    })
  }

  /**
   * Whether a deleted row can come back: what it belongs to is still there, and the limits and
   * unique names still hold. Returns the live items it's ranked among, or null when it can't
   * (its board or column has gone too). Throws a BoardsError for a limit or a name clash.
   */
  private restoreChecks(kind: UndoToken['kind'], row: Row): Ranked[] | null {
    const boardId = String(row['board_id'] ?? '')
    const unique = (items: { id: string; name: string }[], what: string) => {
      const name = String(row['name'])
      if (items.some((i) => i.name.toLowerCase() === name.toLowerCase()))
        throw new BoardsError('invalid', `There’s already a ${what} called ${name}.`)
    }
    const room = (n: number, max: number, message: string) => {
      if (n >= max) throw new BoardsError('limit', message)
    }
    switch (kind) {
      case 'board': {
        const boards = this.boards()
        room(boards.length, LIMITS.boards, 'That’s as many boards as Ordo keeps.')
        return boards
      }
      case 'column': {
        if (!this.board(boardId)) return null
        const columns = this.columns(boardId)
        room(columns.length, LIMITS.columns, 'A board can have up to 50 columns.')
        return columns
      }
      case 'card': {
        const column = this.column(String(row['column_id']))
        if (!column || column.boardId !== boardId) return null
        const n = this.get('SELECT COUNT(*) AS n FROM cards WHERE board_id = ? AND deleted_at IS NULL', boardId)
        room(Number(n?.['n'] ?? 0), LIMITS.cards, 'A board can have up to 5,000 cards.')
        // An archived card gets a new rank when it's restored, so it can't clash.
        return row['archived_at'] ? [] : this.columnCards(column.id)
      }
      case 'label': {
        if (!this.board(boardId)) return null
        const labels = this.labels(boardId)
        room(labels.length, LIMITS.labels, 'A board can have up to 50 labels.')
        unique(labels, 'label')
        return labels
      }
      case 'field': {
        if (!this.board(boardId)) return null
        const fields = this.fields(boardId)
        room(fields.length, LIMITS.fields, 'A board can have up to 30 fields.')
        unique(fields, 'field')
        return fields
      }
      case 'checklist': {
        const cardId = String(row['card_id'])
        if (!this.card(cardId)) return null
        const items = this.checklist(cardId)
        room(items.length, LIMITS.checklist, 'A checklist can have up to 200 items.')
        return items
      }
    }
  }

  /** Remove for good everything deleted more than `olderThanMs` ago. */
  purgeDeleted(olderThanMs: number, at: Date = new Date()): void {
    const cutoff = new Date(at.getTime() - olderThanMs).toISOString()
    this.tx(() => {
      const gone = (table: string) =>
        this.all(`SELECT id FROM ${table} WHERE deleted_at IS NOT NULL AND deleted_at < ?`, cutoff).map((r) =>
          String(r['id']),
        )
      for (const board of gone('boards')) {
        for (const t of ['columns', 'labels', 'fields'])
          this.run(`DELETE FROM ${t} WHERE board_id = ?`, board)
        this.run('UPDATE cards SET deleted_at = ? WHERE board_id = ?', cutoff, board)
        this.run('DELETE FROM boards WHERE id = ?', board)
      }
      for (const column of gone('columns')) {
        this.run('UPDATE cards SET deleted_at = ? WHERE column_id = ?', cutoff, column)
        this.run('DELETE FROM columns WHERE id = ?', column)
      }
      // Cards whose board or column went above are caught here (deleted_at = cutoff is not < cutoff,
      // so compare with <=).
      const cards = this.all(
        'SELECT id FROM cards WHERE deleted_at IS NOT NULL AND deleted_at <= ?',
        cutoff,
      ).map((r) => String(r['id']))
      for (const card of cards) {
        this.run('DELETE FROM checklist WHERE card_id = ?', card)
        this.run('DELETE FROM links WHERE card_id = ?', card)
        this.run('DELETE FROM links WHERE target_key = ?', targetKey({ kind: 'card', cardId: card }))
        this.run('DELETE FROM cards WHERE id = ?', card)
      }
      for (const t of ['labels', 'fields', 'checklist'])
        this.run(`DELETE FROM ${t} WHERE deleted_at IS NOT NULL AND deleted_at < ?`, cutoff)
    })
  }

  counts(): { boards: number; cards: number } {
    const n = (sql: string) => Number(this.get(sql)?.['n'] ?? 0)
    return {
      boards: n('SELECT COUNT(*) AS n FROM boards WHERE deleted_at IS NULL'),
      cards: n(
        'SELECT COUNT(*) AS n FROM cards k JOIN columns c ON c.id = k.column_id JOIN boards b ON b.id = k.board_id ' +
          'WHERE k.deleted_at IS NULL AND k.archived_at IS NULL AND c.deleted_at IS NULL AND b.deleted_at IS NULL',
      ),
    }
  }

  close(): void {
    this.db.close()
  }

  // Helpers

  /** Check and normalise a card's editable values against its board's labels and fields. */
  private cardValues(
    boardId: string,
    v: {
      title: string
      notes: string
      start: ISODate | null
      due: ISODate | null
      labelIds: string[]
      fields: Record<string, FieldValue>
      patchFields: Record<string, unknown>
    },
  ) {
    const title = cleanText(v.title, 'Give the card a title.', LIMITS.title)
    const notes = String(v.notes ?? '')
    if (notes.length > LIMITS.notes) throw new BoardsError('invalid', 'Those notes are too long.')
    if (v.due !== null && !isISODate(v.due)) throw new BoardsError('invalid', 'Choose a due date.')
    if (v.start !== null && !isISODate(v.start)) throw new BoardsError('invalid', 'Choose a start date.')
    if (v.start !== null && v.due === null)
      throw new BoardsError('invalid', 'A date range needs an end date.')
    if (v.start !== null && v.due !== null && v.start > v.due)
      throw new BoardsError('invalid', 'The start date must be on or before the due date.')
    const start = v.start === v.due ? null : v.start
    const labels = new Set(this.labels(boardId).map((l) => l.id))
    const labelIds = [...new Set(v.labelIds)]
    for (const l of labelIds) if (!labels.has(l)) throw notFound('label')
    const defs = this.fields(boardId)
    const fields: Record<string, FieldValue> = {}
    for (const def of defs) if (v.fields[def.id] !== undefined) fields[def.id] = v.fields[def.id]!
    for (const [fieldId, raw] of Object.entries(v.patchFields)) {
      const def = defs.find((f) => f.id === fieldId)
      if (!def) throw notFound('field')
      const r = normaliseFieldValue(def, raw)
      if (!r.ok) throw new BoardsError('invalid', r.message)
      if (r.value === null) delete fields[def.id]
      else fields[def.id] = r.value
    }
    return { title, notes, start, due: v.due, labelIds, fields }
  }

  /** Drop deleted labels and fields (and stale select options) from what cards show. */
  private withLiveRefs(boardId: string, cards: Card[]): Card[] {
    const labels = new Set(this.labels(boardId).map((l) => l.id))
    const defs = new Map(this.fields(boardId).map((f) => [f.id, f]))
    return cards.map((c) => ({
      ...c,
      labelIds: c.labelIds.filter((l) => labels.has(l)),
      fields: Object.fromEntries(
        Object.entries(c.fields).filter(([id, value]) => {
          const def = defs.get(id)
          return def && (def.type !== 'select' || def.options.some((o) => o.id === value))
        }),
      ),
    }))
  }

  private applyMove(
    table: 'boards' | 'columns' | 'fields' | 'checklist',
    items: Ranked[],
    id: string,
    index: number,
    includeSelf = true,
  ): void {
    const plan = planMove(items, id, index)
    this.tx(() => {
      for (const u of plan.updates)
        if (includeSelf || u.id !== id) this.run(`UPDATE ${table} SET rank = ? WHERE id = ?`, u.rank, u.id)
    })
  }

  private touch(cardId: string): void {
    this.run('UPDATE cards SET updated_at = ? WHERE id = ?', now(), cardId)
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[]
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined
  }

  private run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params)
  }

  private depth = 0

  /** Run `fn` in one transaction; nested calls join the outer one. */
  private tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++
      try {
        return fn()
      } finally {
        this.depth--
      }
    }
    this.db.exec('BEGIN IMMEDIATE')
    this.depth = 1
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    } finally {
      this.depth = 0
    }
  }
}

const UNDO_TABLES: Record<UndoToken['kind'], string> = {
  board: 'boards',
  column: 'columns',
  card: 'cards',
  label: 'labels',
  field: 'fields',
  checklist: 'checklist',
}

function cleanText(text: string, empty: string, max: number): string {
  const s = String(text ?? '')
    .replace(UNSAFE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) throw new BoardsError('invalid', empty)
  if (s.length > max) throw new BoardsError('invalid', 'That’s too long.')
  return s
}

const str = (v: SQLInputValue | undefined) => (v === null || v === undefined ? null : String(v))

function toBoard(r: Row): Board {
  return {
    id: String(r['id']),
    name: String(r['name']),
    rank: String(r['rank']),
    createdAt: String(r['created_at']),
  }
}

function toColumn(r: Row): Column {
  return {
    id: String(r['id']),
    boardId: String(r['board_id']),
    name: String(r['name']),
    rank: String(r['rank']),
    wipLimit: r['wip_limit'] === null ? null : Number(r['wip_limit']),
    done: Number(r['done']) === 1,
  }
}

function toLabel(r: Row): Label {
  const color = String(r['color'])
  return {
    id: String(r['id']),
    boardId: String(r['board_id']),
    name: String(r['name']),
    color: isColor(color) ? color : 'grey',
    rank: String(r['rank']),
  }
}

function toField(r: Row): FieldDef {
  return {
    id: String(r['id']),
    boardId: String(r['board_id']),
    name: String(r['name']),
    type: String(r['type']) as FieldType,
    options: json<FieldOption[]>(r['options'], []),
    showOnCard: Number(r['show_on_card']) === 1,
    rank: String(r['rank']),
  }
}

function toCard(r: Row): Card {
  return {
    id: String(r['id']),
    boardId: String(r['board_id']),
    columnId: String(r['column_id']),
    rank: String(r['rank']),
    title: String(r['title']),
    notes: String(r['notes'] ?? ''),
    start: str(r['start']),
    due: str(r['due']),
    labelIds: json<string[]>(r['label_ids'], []),
    fields: json<Record<string, FieldValue>>(r['field_values'], {}),
    archivedAt: str(r['archived_at']),
    createdAt: String(r['created_at']),
    updatedAt: String(r['updated_at']),
    checklist: { done: Number(r['items_done'] ?? 0), total: Number(r['items'] ?? 0) },
    links: Number(r['link_count'] ?? 0),
  }
}

function toChecklistItem(r: Row): ChecklistItem {
  return {
    id: String(r['id']),
    cardId: String(r['card_id']),
    text: String(r['text']),
    done: Number(r['done']) === 1,
    rank: String(r['rank']),
  }
}

function toLink(r: Row): CardLink {
  return {
    id: String(r['id']),
    cardId: String(r['card_id']),
    target: json<LinkTarget>(r['target'], { kind: 'card', cardId: '' }),
    title: String(r['title']),
    detail: str(r['detail']),
    date: str(r['date']),
    createdAt: String(r['created_at']),
  }
}
