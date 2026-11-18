import { z } from 'zod'
import {
  FIELD_TYPES,
  LABEL_COLORS,
  TEMPLATE_IDS,
  isISODate,
  type Board,
  type Card,
  type CardSuggestions,
  type ChecklistItem,
  type Column,
  type FieldDef,
  type Label,
  type LinkCandidate,
  type LinkKind,
  type ResolvedLink,
  type UndoToken,
} from '@ordo/boards-core'
import type { CalendarOverlayItem, DateRange } from './calendar'

export type {
  Board,
  Card,
  CardSuggestions,
  ChecklistItem,
  Column,
  FieldDef,
  Label,
  LinkCandidate,
  LinkKind,
  ResolvedLink,
  UndoToken,
}

const id = z.string().min(1).max(100)
const index = z.number().int().min(0).max(100_000)
const day = z.string().refine(isISODate, 'Choose a date.')
const name = z.string().max(200)

/** A board in the list, with how many cards it has and how many are overdue. */
export interface BoardSummary extends Board {
  cards: number
  overdue: number
}

/** Everything the board view draws. Cards are in column order, then rank. */
export interface BoardView {
  board: Board
  columns: Column[]
  cards: Card[]
  labels: Label[]
  fields: FieldDef[]
}

/** A card with its checklist and links looked up again. */
export interface CardDetail {
  card: Card
  checklist: ChecklistItem[]
  links: ResolvedLink[]
  /** Other cards that link to this one. */
  backlinks: { cardId: string; title: string; boardName: string; columnName: string }[]
}

/** `locked`: another Ordo process (the app, a headless command or an agent) is writing. */
/** `failed`: something unexpected, such as the database staying busy. */
export type BoardsFailure = 'not-found' | 'invalid' | 'limit' | 'locked' | 'failed'
export type BoardsResult<T = null> =
  { ok: true; value: T } | { ok: false; error: BoardsFailure; message: string }

export const CreateBoardSchema = z.object({ name, template: z.enum(TEMPLATE_IDS).default('simple') })
export const RenameBoardSchema = z.object({ id, name })
export const MoveSchema = z.object({ id, index })
export const AddColumnSchema = z.object({ boardId: id, name, index: index.optional() })
export const UpdateColumnSchema = z.object({
  id,
  name: name.optional(),
  wipLimit: z.number().int().min(0).max(999).nullable().optional(),
  done: z.boolean().optional(),
})

const fieldValues = z
  .record(id, z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]))
  .refine((r) => Object.keys(r).length <= 50, 'Too many fields.')

export const AddCardSchema = z.object({
  boardId: id,
  columnId: id.optional(),
  title: z.string().max(1000),
  notes: z.string().max(20_000).optional(),
  start: day.nullable().optional(),
  due: day.nullable().optional(),
  labelIds: z.array(id).max(50).optional(),
  fields: fieldValues.optional(),
  index: index.optional(),
  /** Link the new card to this straight away, e.g. the event it was made from. */
  link: z.lazy(() => LinkInputSchema.omit({ cardId: true })).optional(),
})
export const UpdateCardSchema = z.object({
  id,
  title: z.string().max(1000).optional(),
  notes: z.string().max(20_000).optional(),
  start: day.nullable().optional(),
  due: day.nullable().optional(),
  labelIds: z.array(id).max(50).optional(),
  fields: fieldValues.optional(),
})
export const MoveCardSchema = z.object({ id, columnId: id.optional(), index })
export const ArchiveCardSchema = z.object({ id, archived: z.boolean() })

export const AddChecklistItemSchema = z.object({
  cardId: id,
  text: z.string().max(1000),
  index: index.optional(),
})
export const UpdateChecklistItemSchema = z.object({
  id,
  text: z.string().max(1000).optional(),
  done: z.boolean().optional(),
})

export const SaveLabelSchema = z.object({ id: id.optional(), boardId: id, name, color: z.enum(LABEL_COLORS) })
export const SaveFieldSchema = z.object({
  id: id.optional(),
  boardId: id,
  name,
  type: z.enum(FIELD_TYPES),
  options: z
    .array(z.object({ id: id.optional(), name, color: z.enum(LABEL_COLORS).optional() }))
    .max(50)
    .optional(),
  showOnCard: z.boolean().optional(),
})

export const LinkTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('event'),
    calendarId: z.string().min(1).max(2000),
    uid: z.string().min(1).max(1000),
    // An instant for a timed event, the day for an all-day one.
    start: z.union([z.iso.datetime(), day]),
  }),
  z.object({
    kind: z.literal('email'),
    mailbox: z.string().min(1).max(200),
    uid: z.number().int().min(1),
    messageId: z.string().max(1000).optional(),
  }),
  z.object({ kind: z.literal('bill'), billId: id }),
  z.object({ kind: z.literal('transaction'), transactionId: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('card'), cardId: id }),
])

export const LinkInputSchema = z.object({
  cardId: id,
  target: LinkTargetSchema,
  title: z.string().max(1000),
  detail: z.string().max(1000).nullable().optional(),
  date: day.nullable().optional(),
})

export const LINK_KIND_VALUES = [
  'event',
  'email',
  'bill',
  'transaction',
  'card',
] as const satisfies readonly LinkKind[]

export const CandidateQuerySchema = z.object({
  cardId: id,
  kind: z.enum(LINK_KIND_VALUES),
  query: z.string().max(200).default(''),
})

export const UndoTokenSchema = z.object({
  kind: z.enum(['board', 'column', 'card', 'label', 'field', 'checklist']),
  id,
})

export type CreateBoardInput = z.input<typeof CreateBoardSchema>
export type AddColumnInput = z.input<typeof AddColumnSchema>
export type UpdateColumnInput = z.input<typeof UpdateColumnSchema>
export type AddCardInput = z.input<typeof AddCardSchema>
export type UpdateCardInput = z.input<typeof UpdateCardSchema>
export type MoveCardInput = z.input<typeof MoveCardSchema>
export type SaveLabelInput = z.input<typeof SaveLabelSchema>
export type SaveFieldInput = z.input<typeof SaveFieldSchema>
export type LinkInput = z.input<typeof LinkInputSchema>
export type CandidateQuery = z.input<typeof CandidateQuerySchema>

/** Who answered a suggestion, so the card can say where its details went. */
export interface SuggestProvider {
  label: string
  kind: 'local' | 'cloud'
  vendor?: string
}

export type SuggestOutcome =
  | {
      ok: true
      suggestions: CardSuggestions
      provider: SuggestProvider
      /** How many candidates and labels were sent. */
      sent: { candidates: number; labels: number }
    }
  /** `no-ai`: no model chosen; `consent`: a cloud provider without consent; `busy`: already asking. */
  | { ok: false; error: 'no-ai' | 'consent' | 'busy' | 'not-found' | 'failed'; message: string }

/** `window.ordo.boards`. Everything runs in the main process; data stays in `boards.sqlite`. */
export interface BoardsApi {
  list(): Promise<BoardSummary[]>
  board(boardId: string): Promise<BoardView | null>
  card(cardId: string): Promise<CardDetail | null>
  /** A board's archived cards, most recently changed first. */
  archived(boardId: string): Promise<Card[]>

  createBoard(input: CreateBoardInput): Promise<BoardsResult<Board>>
  renameBoard(input: { id: string; name: string }): Promise<BoardsResult<Board>>
  moveBoard(input: { id: string; index: number }): Promise<BoardsResult>
  deleteBoard(id: string): Promise<BoardsResult<UndoToken>>

  addColumn(input: AddColumnInput): Promise<BoardsResult<Column>>
  updateColumn(input: UpdateColumnInput): Promise<BoardsResult<Column>>
  moveColumn(input: { id: string; index: number }): Promise<BoardsResult>
  deleteColumn(id: string): Promise<BoardsResult<UndoToken>>

  addCard(input: AddCardInput): Promise<BoardsResult<Card>>
  updateCard(input: UpdateCardInput): Promise<BoardsResult<Card>>
  /** Move to `index` in a column of the same board (the card's own column if none is given). */
  moveCard(input: MoveCardInput): Promise<BoardsResult<Card>>
  archiveCard(input: { id: string; archived: boolean }): Promise<BoardsResult<Card>>
  deleteCard(id: string): Promise<BoardsResult<UndoToken>>

  addChecklistItem(input: {
    cardId: string
    text: string
    index?: number
  }): Promise<BoardsResult<ChecklistItem>>
  updateChecklistItem(input: {
    id: string
    text?: string
    done?: boolean
  }): Promise<BoardsResult<ChecklistItem>>
  moveChecklistItem(input: { id: string; index: number }): Promise<BoardsResult>
  deleteChecklistItem(id: string): Promise<BoardsResult<UndoToken>>

  saveLabel(input: SaveLabelInput): Promise<BoardsResult<Label>>
  deleteLabel(id: string): Promise<BoardsResult<UndoToken>>
  saveField(input: SaveFieldInput): Promise<BoardsResult<FieldDef>>
  moveField(input: { id: string; index: number }): Promise<BoardsResult>
  deleteField(id: string): Promise<BoardsResult<UndoToken>>

  addLink(input: LinkInput): Promise<BoardsResult>
  removeLink(id: string): Promise<BoardsResult>
  /** Things of one kind this card could link to, matching `query`. */
  linkCandidates(input: CandidateQuery): Promise<LinkCandidate[]>

  /** Put back something just deleted. */
  restore(token: UndoToken): Promise<BoardsResult>

  /** Cards with a due date or date range in `range`, for the Calendar. */
  dueDates(range: DateRange): Promise<CalendarOverlayItem[]>
  /**
   * Ask the model chosen in Settings → AI for a due date, checklist, labels and links for a card.
   * Ordo picks the candidates; the model only chooses among them. Nothing is changed.
   */
  suggest(cardId: string): Promise<SuggestOutcome>
  stopSuggest(): Promise<void>
}

/** Every Boards method; each is one IPC channel, `boards:<method>`. */
export const BOARDS_METHODS = [
  'list',
  'board',
  'card',
  'archived',
  'createBoard',
  'renameBoard',
  'moveBoard',
  'deleteBoard',
  'addColumn',
  'updateColumn',
  'moveColumn',
  'deleteColumn',
  'addCard',
  'updateCard',
  'moveCard',
  'archiveCard',
  'deleteCard',
  'addChecklistItem',
  'updateChecklistItem',
  'moveChecklistItem',
  'deleteChecklistItem',
  'saveLabel',
  'deleteLabel',
  'saveField',
  'moveField',
  'deleteField',
  'addLink',
  'removeLink',
  'linkCandidates',
  'restore',
  'dueDates',
  'suggest',
  'stopSuggest',
] as const satisfies readonly (keyof BoardsApi)[]

// Every method of the API has a channel, and nothing else does.
type Missing = Exclude<keyof BoardsApi, (typeof BOARDS_METHODS)[number]>
const _complete: Missing extends never ? true : Missing = true
void _complete

export const boardsChannel = (method: keyof BoardsApi) => `boards:${method}` as const
