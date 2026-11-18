/** A local calendar day, `YYYY-MM-DD`. */
export type ISODate = string

export const LABEL_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
  'grey',
] as const
export type LabelColor = (typeof LABEL_COLORS)[number]

export const FIELD_TYPES = ['text', 'number', 'date', 'select', 'checkbox', 'url', 'person'] as const
export type FieldType = (typeof FIELD_TYPES)[number]

export const TEMPLATE_IDS = ['simple', 'weekly', 'project'] as const
export type TemplateId = (typeof TEMPLATE_IDS)[number]

export interface Board {
  id: string
  name: string
  rank: string
  createdAt: string
}

export interface Column {
  id: string
  boardId: string
  name: string
  rank: string
  /** Soft limit on cards in this column; shown, never enforced. */
  wipLimit: number | null
  /** Cards here count as done: no overdue warnings, not on the Calendar. */
  done: boolean
}

export interface Label {
  id: string
  boardId: string
  name: string
  color: LabelColor
  rank: string
}

export interface FieldOption {
  id: string
  name: string
  color: LabelColor
}

/** A custom field the user defined for one board. */
export interface FieldDef {
  id: string
  boardId: string
  name: string
  type: FieldType
  /** Choices for a `select` field; empty for other types. */
  options: FieldOption[]
  /** Show the value on the card in the board, not only in its details. */
  showOnCard: boolean
  rank: string
}

/**
 * A custom field's value: text, URL, person and date (`YYYY-MM-DD`) are strings, a select is the
 * chosen option's id, a number is a number and a checkbox is a boolean.
 */
export type FieldValue = string | number | boolean

export interface ChecklistItem {
  id: string
  cardId: string
  text: string
  done: boolean
  rank: string
}

export interface Card {
  id: string
  boardId: string
  columnId: string
  rank: string
  title: string
  /** Plain text with simple markdown. Rendered without HTML. */
  notes: string
  /** First day of a date range; only set together with `due`. */
  start: ISODate | null
  /** Due date, or the last day of a date range. */
  due: ISODate | null
  labelIds: string[]
  /** Custom field values by field id. Fields without a value are absent. */
  fields: Record<string, FieldValue>
  archivedAt: string | null
  createdAt: string
  updatedAt: string
  checklist: { done: number; total: number }
  /** How many things this card links to. */
  links: number
}

/** What a link points at. Everything else about it is a snapshot for when it can't be found. */
export type LinkTarget =
  | {
      kind: 'event'
      calendarId: string
      uid: string
      /**
       * Which occurrence, so one meeting of a series can be linked: the start as an ISO instant,
       * or the day (`YYYY-MM-DD`) for an all-day event.
       */
      start: string
    }
  | {
      kind: 'email'
      mailbox: string
      uid: number
      /** The Message-ID header, when Ordo knows it. */
      messageId?: string
    }
  | { kind: 'bill'; billId: string }
  | { kind: 'transaction'; transactionId: string }
  | { kind: 'card'; cardId: string }

export type LinkKind = LinkTarget['kind']
export const LINK_KINDS: readonly LinkKind[] = ['event', 'email', 'bill', 'transaction', 'card']

export interface CardLink {
  id: string
  cardId: string
  target: LinkTarget
  /** Title when the link was made: the event, subject, bill or card name. */
  title: string
  /** A second line when it was made, e.g. the calendar and time, or the sender. */
  detail: string | null
  /** The day it happens or is due, when it was made. */
  date: ISODate | null
  createdAt: string
}

/** Something a card could link to, gathered from the other modules. */
export interface LinkCandidate {
  /** Stable key for the target (see `targetKey`). */
  key: string
  target: LinkTarget
  title: string
  detail: string | null
  /** The day it happens or is due, if it has one. */
  date: ISODate | null
}

/** A link with its target looked up again: `found` is false when it's gone or not on this computer. */
export interface ResolvedLink extends CardLink {
  found: boolean
}

/** Something deleted that can still be put back. */
export interface UndoToken {
  kind: 'board' | 'column' | 'card' | 'label' | 'field' | 'checklist'
  id: string
}
