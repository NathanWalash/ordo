import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BoardsError, BoardsStore } from './store'

let dir: string
let store: BoardsStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'boards-store-'))
  store = new BoardsStore(join(dir, 'boards.sqlite'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const titles = (boardId: string, columnId: string) =>
  store
    .cards(boardId)
    .filter((c) => c.columnId === columnId)
    .map((c) => c.title)

function simpleBoard() {
  const board = store.createBoard('Home', 'simple')
  const [todo, doing, done] = store.columns(board.id)
  return { board, todo: todo!, doing: doing!, done: done! }
}

describe('boards', () => {
  it('creates boards from templates with columns, labels and fields', () => {
    const simple = store.createBoard('  Home  jobs ', 'simple')
    expect(simple.name).toBe('Home jobs')
    expect(store.columns(simple.id).map((c) => [c.name, c.wipLimit, c.done])).toEqual([
      ['To do', null, false],
      ['Doing', null, false],
      ['Done', null, true],
    ])
    expect(store.labels(simple.id).map((l) => l.name)).toEqual(['Urgent', 'Waiting', 'Home'])

    const project = store.createBoard('Kitchen', 'project')
    const fields = store.fields(project.id)
    expect(fields.map((f) => [f.name, f.type])).toEqual([
      ['Priority', 'select'],
      ['Owner', 'person'],
      ['Estimate (hours)', 'number'],
      ['Link', 'url'],
    ])
    expect(fields[0]!.options.map((o) => o.name)).toEqual(['Low', 'Medium', 'High', 'Urgent'])

    const weekly = store.createBoard('Week', 'weekly')
    expect(store.columns(weekly.id)).toHaveLength(7)
    expect(store.boards().map((b) => b.name)).toEqual(['Home jobs', 'Kitchen', 'Week'])
  })

  it('renames, reorders and deletes boards, and undoes the delete', () => {
    const a = store.createBoard('A')
    const b = store.createBoard('B')
    const c = store.createBoard('C')
    store.renameBoard(b.id, 'Bee')
    store.moveBoard(c.id, 0)
    expect(store.boards().map((x) => x.name)).toEqual(['C', 'A', 'Bee'])
    const token = store.deleteBoard(a.id)
    expect(store.boards().map((x) => x.name)).toEqual(['C', 'Bee'])
    expect(store.restore(token)).toBe(true)
    expect(store.boards().map((x) => x.name)).toEqual(['C', 'A', 'Bee'])
    expect(store.restore(token)).toBe(false)
  })

  it('refuses empty names', () => {
    expect(() => store.createBoard('   ')).toThrow(BoardsError)
    expect(() => store.renameBoard('nope', 'x')).toThrow(/no longer there/)
  })
})

describe('columns', () => {
  it('adds, renames, reorders and deletes columns', () => {
    const { board, todo, doing, done } = simpleBoard()
    store.updateColumn(doing.id, { wipLimit: 3 })
    const later = store.addColumn(board.id, 'Later', 0)
    expect(store.columns(board.id).map((c) => c.name)).toEqual(['Later', 'To do', 'Doing', 'Done'])
    store.updateColumn(later.id, { name: 'Someday', wipLimit: 5 })
    store.moveColumn(later.id, 3)
    expect(store.columns(board.id).map((c) => [c.name, c.wipLimit])).toEqual([
      ['To do', null],
      ['Doing', 3],
      ['Done', null],
      ['Someday', 5],
    ])
    store.updateColumn(doing.id, { wipLimit: 0 })
    expect(store.column(doing.id)!.wipLimit).toBeNull()
    expect(() => store.updateColumn(todo.id, { wipLimit: 1.5 })).toThrow(/whole number/)

    const card = store.addCard({ boardId: board.id, columnId: done.id, title: 'Paint fence' })
    const token = store.deleteColumn(done.id)
    expect(store.columns(board.id).map((c) => c.name)).toEqual(['To do', 'Doing', 'Someday'])
    expect(store.card(card.id)).toBeUndefined()
    store.restore(token)
    expect(store.card(card.id)?.title).toBe('Paint fence')
  })

  it('keeps at least one column', () => {
    const board = store.createBoard('Solo')
    const cols = store.columns(board.id)
    store.deleteColumn(cols[0]!.id)
    store.deleteColumn(cols[1]!.id)
    expect(() => store.deleteColumn(cols[2]!.id)).toThrow(/at least one column/)
  })
})

describe('cards', () => {
  it('adds cards at the end, or at a position', () => {
    const { board, todo } = simpleBoard()
    store.addCard({ boardId: board.id, title: 'One' })
    store.addCard({ boardId: board.id, title: 'Two' })
    store.addCard({ boardId: board.id, columnId: todo.id, title: 'Zero', index: 0 })
    store.addCard({ boardId: board.id, columnId: todo.id, title: 'Half', index: 1 })
    expect(titles(board.id, todo.id)).toEqual(['Zero', 'Half', 'One', 'Two'])
  })

  it('moves cards within and between columns and remembers the order', () => {
    const { board, todo, doing } = simpleBoard()
    const [a, b, c] = ['A', 'B', 'C'].map((title) => store.addCard({ boardId: board.id, title }))
    store.moveCard(c!.id, undefined, 0)
    expect(titles(board.id, todo.id)).toEqual(['C', 'A', 'B'])
    store.moveCard(a!.id, doing.id, 0)
    store.moveCard(b!.id, doing.id, 0)
    expect(titles(board.id, todo.id)).toEqual(['C'])
    expect(titles(board.id, doing.id)).toEqual(['B', 'A'])

    // A fresh store on the same file reads the same order.
    store.close()
    store = new BoardsStore(join(dir, 'boards.sqlite'))
    expect(titles(board.id, doing.id)).toEqual(['B', 'A'])
  })

  it('refuses to move a card to another board’s column', () => {
    const { board } = simpleBoard()
    const other = store.createBoard('Other')
    const card = store.addCard({ boardId: board.id, title: 'x' })
    expect(() => store.moveCard(card.id, store.columns(other.id)[0]!.id, 0)).toThrow(/no longer there/)
  })

  it('keeps order through many moves to the same spot', () => {
    const { board, todo, doing } = simpleBoard()
    const cards = Array.from({ length: 30 }, (_, i) => store.addCard({ boardId: board.id, title: `c${i}` }))
    const expected: string[] = []
    for (let i = 0; i < 200; i++) {
      const card = cards[i % cards.length]!
      store.moveCard(card.id, doing.id, 1)
      const idx = expected.indexOf(card.title)
      if (idx >= 0) expected.splice(idx, 1)
      expected.splice(Math.min(1, expected.length), 0, card.title)
    }
    expect(titles(board.id, doing.id)).toEqual(expected)
    expect(titles(board.id, todo.id)).toEqual([])
  })

  it('edits title, notes, dates, labels and custom fields with checks', () => {
    const board = store.createBoard('Project', 'project')
    const [priority, owner, estimate, link] = store.fields(board.id)
    const [blocked] = store.labels(board.id)
    const card = store.addCard({ boardId: board.id, title: 'Quote for boiler' })
    const high = priority!.options.find((o) => o.name === 'High')!
    const edited = store.updateCard(card.id, {
      title: '  Get a quote  ',
      notes: '**Call** three firms',
      start: '2026-11-20',
      due: '2026-11-27',
      labelIds: [blocked!.id, blocked!.id],
      fields: {
        [priority!.id]: 'high',
        [owner!.id]: ' Sam ',
        [estimate!.id]: '2.5',
        [link!.id]: 'example.com/q',
      },
    })
    expect(edited).toMatchObject({
      title: 'Get a quote',
      notes: '**Call** three firms',
      start: '2026-11-20',
      due: '2026-11-27',
      labelIds: [blocked!.id],
      fields: {
        [priority!.id]: high.id,
        [owner!.id]: 'Sam',
        [estimate!.id]: 2.5,
        [link!.id]: 'https://example.com/q',
      },
    })
    // Fields not mentioned keep their value; null clears one.
    const cleared = store.updateCard(card.id, { fields: { [owner!.id]: null } })
    expect(cleared.fields[owner!.id]).toBeUndefined()
    expect(cleared.fields[priority!.id]).toBe(high.id)

    expect(() => store.updateCard(card.id, { title: ' ' })).toThrow(/title/)
    expect(() => store.updateCard(card.id, { due: '2026-02-30' })).toThrow(/due date/)
    expect(() => store.updateCard(card.id, { start: '2026-12-01' })).toThrow(/on or before/)
    expect(() => store.updateCard(card.id, { due: null })).toThrow(/needs an end date/)
    expect(() => store.updateCard(card.id, { labelIds: ['nope'] })).toThrow(/label/)
    expect(() => store.updateCard(card.id, { fields: { [link!.id]: 'javascript:alert(1)' } })).toThrow(
      /web link/,
    )
    expect(() => store.updateCard(card.id, { fields: { [estimate!.id]: 'lots' } })).toThrow(/number/)
    expect(() => store.updateCard(card.id, { fields: { nope: 'x' } })).toThrow(/field/)
    // A one-day range is just a due date.
    expect(store.updateCard(card.id, { start: '2026-11-27' }).start).toBeNull()
  })

  it('hides deleted labels and fields from cards, and shows them again on undo', () => {
    const board = store.createBoard('Project', 'project')
    const [priority] = store.fields(board.id)
    const [blocked] = store.labels(board.id)
    const card = store.addCard({
      boardId: board.id,
      title: 'x',
      labelIds: [blocked!.id],
      fields: { [priority!.id]: 'Low' },
    })
    const l = store.deleteLabel(blocked!.id)
    const f = store.deleteField(priority!.id)
    expect(store.card(card.id)).toMatchObject({ labelIds: [], fields: {} })
    store.restore(l)
    store.restore(f)
    expect(store.card(card.id)!.labelIds).toEqual([blocked!.id])
    expect(Object.keys(store.card(card.id)!.fields)).toEqual([priority!.id])
  })

  it('drops a select value whose option was removed', () => {
    const board = store.createBoard('Project', 'project')
    const [priority] = store.fields(board.id)
    const card = store.addCard({ boardId: board.id, title: 'x', fields: { [priority!.id]: 'Urgent' } })
    store.saveField({ ...priority!, options: priority!.options.filter((o) => o.name !== 'Urgent') })
    expect(store.card(card.id)!.fields).toEqual({})
  })

  it('archives and restores cards; restored cards go to the end of their column', () => {
    const { board, todo } = simpleBoard()
    const a = store.addCard({ boardId: board.id, title: 'A' })
    store.addCard({ boardId: board.id, title: 'B' })
    store.archiveCard(a.id, true)
    expect(titles(board.id, todo.id)).toEqual(['B'])
    expect(store.cards(board.id, { archived: true }).map((c) => c.title)).toEqual(['A'])
    expect(() => store.moveCard(a.id, todo.id, 0)).toThrow(/Restore/)
    store.archiveCard(a.id, false)
    expect(titles(board.id, todo.id)).toEqual(['B', 'A'])
    expect(
      store
        .allCards()
        .map((c) => c.title)
        .sort(),
    ).toEqual(['A', 'B'])
  })

  it('deletes and undeletes cards', () => {
    const { board } = simpleBoard()
    const a = store.addCard({ boardId: board.id, title: 'A' })
    const token = store.deleteCard(a.id)
    expect(store.cards(board.id)).toEqual([])
    expect(store.counts()).toEqual({ boards: 1, cards: 0 })
    expect(store.restore(token)).toBe(true)
    expect(store.counts()).toEqual({ boards: 1, cards: 1 })
  })
})

describe('labels and fields', () => {
  it('refuses duplicate names and bad colours', () => {
    const board = store.createBoard('x', 'simple')
    expect(() => store.saveLabel({ boardId: board.id, name: 'urgent', color: 'red' })).toThrow(/already/)
    expect(() => store.saveLabel({ boardId: board.id, name: 'New', color: 'mauve' as never })).toThrow(
      /colour/,
    )
    const label = store.saveLabel({ boardId: board.id, name: 'Garden', color: 'green' })
    expect(store.saveLabel({ ...label, name: 'Garden jobs' }).name).toBe('Garden jobs')
  })

  it('keeps a field’s type, tidies select options and reorders fields', () => {
    const board = store.createBoard('x', 'simple')
    const f = store.saveField({
      boardId: board.id,
      name: 'Size',
      type: 'select',
      options: [{ name: 'S' }, { name: 's' }, { name: 'M', color: 'blue' }],
    })
    expect(f.options.map((o) => [o.name, o.color])).toEqual([
      ['S', 'grey'],
      ['M', 'blue'],
    ])
    expect(store.saveField({ ...f, type: 'number' }).type).toBe('select')
    const g = store.saveField({ boardId: board.id, name: 'Done?', type: 'checkbox', showOnCard: true })
    store.moveField(g.id, 0)
    expect(store.fields(board.id).map((x) => x.name)).toEqual(['Done?', 'Size'])
  })
})

describe('checklists', () => {
  it('adds, ticks, reorders and deletes steps, and counts them on the card', () => {
    const { board } = simpleBoard()
    const card = store.addCard({ boardId: board.id, title: 'Move house' })
    const a = store.addChecklistItem(card.id, 'Book van')
    const b = store.addChecklistItem(card.id, 'Pack kitchen')
    store.addChecklistItem(card.id, 'Change address', 0)
    store.updateChecklistItem(a.id, { done: true })
    store.moveChecklistItem(b.id, 0)
    expect(store.checklist(card.id).map((i) => [i.text, i.done])).toEqual([
      ['Pack kitchen', false],
      ['Change address', false],
      ['Book van', true],
    ])
    expect(store.card(card.id)!.checklist).toEqual({ done: 1, total: 3 })
    const token = store.deleteChecklistItem(a.id)
    expect(store.card(card.id)!.checklist).toEqual({ done: 0, total: 2 })
    store.restore(token)
    expect(store.card(card.id)!.checklist).toEqual({ done: 1, total: 3 })
    expect(() => store.addChecklistItem(card.id, '  ')).toThrow(/step/)
  })
})

describe('links', () => {
  it('links to things once each, lists backlinks and removes links', () => {
    const { board } = simpleBoard()
    const a = store.addCard({ boardId: board.id, title: 'A' })
    const b = store.addCard({ boardId: board.id, title: 'B' })
    const target = { kind: 'event' as const, calendarId: 'cal', uid: 'u1', start: '2026-11-20T09:00:00.000Z' }
    const l1 = store.addLink(a.id, { target, title: 'Dentist', detail: 'Home · 09:00', date: '2026-11-20' })
    const l2 = store.addLink(a.id, { target, title: 'Dentist again' })
    expect(l2.id).toBe(l1.id)
    store.addLink(a.id, { target: { kind: 'card', cardId: b.id }, title: 'B' })
    expect(store.links(a.id).map((l) => l.title)).toEqual(['Dentist', 'B'])
    expect(store.card(a.id)!.links).toBe(2)
    expect(store.backlinks(b.id).map((x) => x.card.title)).toEqual(['A'])
    expect(() => store.addLink(a.id, { target: { kind: 'card', cardId: a.id }, title: 'A' })).toThrow(
      /itself/,
    )
    expect(() => store.addLink(a.id, { target: { kind: 'card', cardId: 'gone' }, title: 'x' })).toThrow()
    store.removeLink(l1.id)
    expect(store.links(a.id)).toHaveLength(1)
    // A deleted card's backlinks disappear with it.
    store.deleteCard(a.id)
    expect(store.backlinks(b.id)).toEqual([])
  })
})

describe('purgeDeleted', () => {
  it('removes old deletes for good, and leaves recent ones undoable', () => {
    const { board, todo } = simpleBoard()
    const keep = store.addCard({ boardId: board.id, title: 'Keep' })
    const old = store.addCard({ boardId: board.id, title: 'Old' })
    store.addChecklistItem(old.id, 'step')
    const oldToken = store.deleteCard(old.id)
    const later = new Date(Date.now() + 3 * 86_400_000)
    const recent = store.addCard({ boardId: board.id, title: 'Recent' })
    store.purgeDeleted(86_400_000, later)
    expect(store.restore(oldToken)).toBe(false)
    const recentToken = store.deleteCard(recent.id)
    store.purgeDeleted(86_400_000)
    expect(store.restore(recentToken)).toBe(true)
    expect(titles(board.id, todo.id)).toEqual(['Keep', 'Recent'])
    expect(keep).toBeTruthy()
  })

  it('purges a deleted board with its columns and cards', () => {
    const { board } = simpleBoard()
    store.addCard({ boardId: board.id, title: 'x' })
    store.deleteBoard(board.id)
    store.purgeDeleted(0, new Date(Date.now() + 1000))
    expect(store.restore({ kind: 'board', id: board.id })).toBe(false)
    expect(store.counts()).toEqual({ boards: 0, cards: 0 })
  })

  it('cascades: a purged column takes its cards, their steps and every link to them', () => {
    const { board, todo, doing } = simpleBoard()
    const keep = store.addCard({ boardId: board.id, columnId: todo.id, title: 'Keep' })
    const gone = store.addCard({ boardId: board.id, columnId: doing.id, title: 'Gone' })
    const step = store.addChecklistItem(gone.id, 'step')
    store.addLink(gone.id, { target: { kind: 'bill', billId: 'b' }, title: 'Bill' })
    store.addLink(keep.id, { target: { kind: 'card', cardId: gone.id }, title: 'Gone' })
    store.deleteColumn(doing.id)
    store.purgeDeleted(0, new Date(Date.now() + 1000))
    expect(store.restore({ kind: 'column', id: doing.id })).toBe(false)
    expect(store.restore({ kind: 'card', id: gone.id })).toBe(false)
    expect(store.restore({ kind: 'checklist', id: step.id })).toBe(false)
    expect(store.links(keep.id)).toEqual([])
    expect(store.links(gone.id)).toEqual([])
    expect(store.card(keep.id)?.title).toBe('Keep')
  })

  it('a purged board takes its labels and fields', () => {
    const board = store.createBoard('P', 'project')
    const [label] = store.labels(board.id)
    const [field] = store.fields(board.id)
    store.deleteBoard(board.id)
    store.purgeDeleted(0, new Date(Date.now() + 1000))
    expect(store.restore({ kind: 'label', id: label!.id })).toBe(false)
    expect(store.restore({ kind: 'field', id: field!.id })).toBe(false)
  })
})

describe('restore', () => {
  it('fits a card back in when one added since has taken its rank', () => {
    const { board, todo } = simpleBoard()
    store.addCard({ boardId: board.id, title: 'A' })
    const last = store.addCard({ boardId: board.id, title: 'B' })
    const token = store.deleteCard(last.id)
    const fresh = store.addCard({ boardId: board.id, title: 'C' })
    // The new card is appended after A, exactly where B was.
    expect(fresh.rank).toBe(last.rank)
    expect(store.restore(token)).toBe(true)
    const cards = store.cards(board.id).filter((c) => c.columnId === todo.id)
    expect(cards.map((c) => c.title)).toEqual(['A', 'B', 'C'])
    expect(new Set(cards.map((c) => c.rank)).size).toBe(3)
  })

  it('does the same for steps, columns and labels', () => {
    const { board } = simpleBoard()
    const card = store.addCard({ boardId: board.id, title: 'x' })
    const step = store.addChecklistItem(card.id, 'one')
    const t1 = store.deleteChecklistItem(step.id)
    store.addChecklistItem(card.id, 'two')
    store.restore(t1)
    expect(store.checklist(card.id).map((i) => i.text)).toEqual(['one', 'two'])
    expect(new Set(store.checklist(card.id).map((i) => i.rank)).size).toBe(2)

    const col = store.addColumn(board.id, 'Later')
    const t2 = store.deleteColumn(col.id)
    store.addColumn(board.id, 'Soon')
    store.restore(t2)
    expect(store.columns(board.id).map((c) => c.name)).toEqual(['To do', 'Doing', 'Done', 'Later', 'Soon'])
  })

  it('won’t put a card back into a column or board that has gone', () => {
    const { board, doing } = simpleBoard()
    const card = store.addCard({ boardId: board.id, columnId: doing.id, title: 'x' })
    const token = store.deleteCard(card.id)
    store.deleteColumn(doing.id)
    expect(store.restore(token)).toBe(false)
    expect(store.card(card.id)).toBeUndefined()

    const other = store.createBoard('Other')
    const step = store.addChecklistItem(store.addCard({ boardId: other.id, title: 'y' }).id, 's')
    const stepToken = store.deleteChecklistItem(step.id)
    store.deleteBoard(other.id)
    expect(store.restore(stepToken)).toBe(false)
  })

  it('checks names and limits again', () => {
    const board = store.createBoard('x', 'simple')
    const garden = store.saveLabel({ boardId: board.id, name: 'Garden', color: 'green' })
    const token = store.deleteLabel(garden.id)
    store.saveLabel({ boardId: board.id, name: 'garden', color: 'blue' })
    expect(() => store.restore(token)).toThrow(/already a label called Garden/)

    for (let i = store.labels(board.id).length; i < 50; i++)
      store.saveLabel({ boardId: board.id, name: `L${i}`, color: 'grey' })
    const one = store.labels(board.id)[0]!
    const t2 = store.deleteLabel(one.id)
    store.saveLabel({ boardId: board.id, name: 'Fiftieth', color: 'grey' })
    expect(() => store.restore(t2)).toThrow(/up to 50 labels/)
  })
})

describe('names', () => {
  it('strip control characters and bidi overrides', () => {
    const board = store.createBoard('Evil\u202e\u0007 board\n')
    expect(board.name).toBe('Evil board')
    const card = store.addCard({ boardId: board.id, title: 'gate⁦\u0000 fix' })
    expect(card.title).toBe('gate fix')
    expect(store.addChecklistItem(card.id, 'a\u001b[2Jb').text).toBe('a [2Jb')
  })
})
