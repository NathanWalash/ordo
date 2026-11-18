import { describe, expect, it } from 'vitest'
import {
  AddCardSchema,
  BOARDS_METHODS,
  CandidateQuerySchema,
  CreateBoardSchema,
  LinkInputSchema,
  MoveCardSchema,
  UndoTokenSchema,
  UpdateCardSchema,
  boardsChannel,
} from './boards'
import { IPC, MODULES } from './index'
import { MONEY_IPC } from './money'

describe('Boards IPC contract', () => {
  it('has one channel per method, none clashing with the rest of the app', () => {
    const channels = BOARDS_METHODS.map(boardsChannel)
    expect(new Set(channels).size).toBe(channels.length)
    const others = new Set<string>([...Object.values(IPC), ...Object.values(MONEY_IPC)])
    expect(channels.filter((c) => others.has(c))).toEqual([])
    expect(boardsChannel('moveCard')).toBe('boards:moveCard')
  })

  it('registers Boards as a module', () => {
    expect(MODULES.find((m) => m.id === 'boards')).toEqual({ id: 'boards', name: 'Boards' })
  })

  it('defaults a new board to the Simple template and refuses unknown ones', () => {
    expect(CreateBoardSchema.parse({ name: 'Home' })).toEqual({ name: 'Home', template: 'simple' })
    expect(CreateBoardSchema.safeParse({ name: 'Home', template: 'kanban-pro' }).success).toBe(false)
  })

  it('checks card dates, field values and positions', () => {
    expect(AddCardSchema.safeParse({ boardId: 'b', title: 'x', due: '2026-12-01' }).success).toBe(true)
    expect(AddCardSchema.safeParse({ boardId: 'b', title: 'x', due: '2026-02-30' }).success).toBe(false)
    expect(UpdateCardSchema.safeParse({ id: 'c', fields: { f: { nested: true } } }).success).toBe(false)
    expect(UpdateCardSchema.safeParse({ id: 'c', fields: { f: null, g: 2, h: true, i: 'x' } }).success).toBe(
      true,
    )
    expect(MoveCardSchema.safeParse({ id: 'c', index: -1 }).success).toBe(false)
    expect(MoveCardSchema.safeParse({ id: 'c', index: 1.5 }).success).toBe(false)
    expect(MoveCardSchema.safeParse({ id: '', index: 0 }).success).toBe(false)
  })

  it('only accepts link targets it knows', () => {
    const ok = (target: unknown) => LinkInputSchema.safeParse({ cardId: 'c', target, title: 'x' }).success
    expect(ok({ kind: 'event', calendarId: 'cal', uid: 'u', start: '2026-11-20T09:00:00.000Z' })).toBe(true)
    expect(ok({ kind: 'event', calendarId: 'cal', uid: 'u', start: 'tomorrow' })).toBe(false)
    expect(ok({ kind: 'email', mailbox: 'INBOX', uid: 4 })).toBe(true)
    expect(ok({ kind: 'email', mailbox: 'INBOX', uid: 0 })).toBe(false)
    expect(ok({ kind: 'bill', billId: 'b' })).toBe(true)
    expect(ok({ kind: 'file', path: '/etc/passwd' })).toBe(false)
    expect(
      AddCardSchema.safeParse({
        boardId: 'b',
        title: 'x',
        link: { target: { kind: 'card', cardId: 'z' }, title: 'z' },
      }).success,
    ).toBe(true)
  })

  it('checks candidate queries and undo tokens', () => {
    expect(CandidateQuerySchema.parse({ cardId: 'c', kind: 'bill' })).toEqual({
      cardId: 'c',
      kind: 'bill',
      query: '',
    })
    expect(CandidateQuerySchema.safeParse({ cardId: 'c', kind: 'secrets' }).success).toBe(false)
    expect(UndoTokenSchema.safeParse({ kind: 'card', id: 'c' }).success).toBe(true)
    expect(UndoTokenSchema.safeParse({ kind: 'everything', id: 'c' }).success).toBe(false)
  })
})
