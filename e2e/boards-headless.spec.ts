import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { test, expect } from '@playwright/test'
import { BoardsStore } from '../packages/boards-core/src/store'
import { electronPath, headlessEnv, json, ordo, TEST_SWITCHES, tempProfile } from './headless'

// Boards without a window: the CLI and MCP tools against a throwaway profile, seeded directly.

test.describe.configure({ mode: 'serial' })

const profile = tempProfile()
const db = join(profile, 'boards.sqlite')

test.beforeAll(() => {
  const store = new BoardsStore(db)
  const board = store.createBoard('Home', 'simple')
  const urgent = store.labels(board.id).find((l) => l.name === 'Urgent')!
  store.addCard({ boardId: board.id, title: 'Fix the gate', due: '2026-12-01', labelIds: [urgent.id] })
  store.addCard({ boardId: board.id, title: 'Clear gutters' })
  store.close()
})

test('boards list and boards cards read without changing anything', async () => {
  const list = await ordo(['boards', 'list', '--json'], profile)
  expect(list.code).toBe(0)
  expect(json(list)).toEqual({ boards: [expect.objectContaining({ name: 'Home', cards: 2 })] })

  const cards = await ordo(['boards', 'cards', '--board', 'home'], profile)
  expect(cards.code).toBe(0)
  expect(cards.stdout).toMatch(/To do\s+2026-12-01\s+Fix the gate\s+\[Urgent\]/)
  expect(cards.stdout).toContain('Clear gutters')

  const filtered = await ordo(['boards', 'cards', '--label', 'urgent', '--json'], profile)
  expect(json<{ cards: { title: string }[] }>(filtered).cards.map((c) => c.title)).toEqual(['Fix the gate'])

  const missing = await ordo(['boards', 'cards', '--board', 'Garden', '--json'], profile)
  expect(missing.code).toBe(1)
  expect(json(missing)).toEqual({ error: { code: 'invalid', message: 'There’s no board called “Garden”.' } })
})

test('add-card and move-card need --allow-changes and --confirm', async () => {
  const refused = await ordo(
    ['boards', 'add-card', '--board', 'Home', '--title', 'Book the MOT', '--confirm'],
    profile,
  )
  expect(refused.code).toBe(3)
  const unconfirmed = await ordo(
    ['boards', 'add-card', '--board', 'Home', '--title', 'Book the MOT', '--allow-changes', '--json'],
    profile,
  )
  expect(unconfirmed.code).toBe(3)
  expect(json(unconfirmed)).toMatchObject({ error: { code: 'confirm_required' } })

  const added = await ordo(
    [
      'boards',
      'add-card',
      '--board',
      'Home',
      '--column',
      'Doing',
      '--title',
      'Book the MOT',
      '--due',
      '2026-12-05',
      '--allow-changes',
      '--confirm',
      '--json',
    ],
    profile,
  )
  expect(added.code).toBe(0)
  expect(json(added)).toMatchObject({
    card: { title: 'Book the MOT', board: 'Home', column: 'Doing', due: '2026-12-05' },
  })

  const moved = await ordo(
    [
      'boards',
      'move-card',
      'Fix the gate',
      '--column',
      'Doing',
      '--position',
      '1',
      '--allow-changes',
      '--confirm',
    ],
    profile,
  )
  expect(moved.code).toBe(0)
  expect(moved.stdout).toBe('Moved “Fix the gate” to Home › Doing.\n')

  // The file says the same.
  const store = new BoardsStore(db)
  const board = store.boards()[0]!
  const doing = store.columns(board.id).find((c) => c.name === 'Doing')!
  expect(
    store
      .cards(board.id)
      .filter((c) => c.columnId === doing.id)
      .map((c) => c.title),
  ).toEqual(['Fix the gate', 'Book the MOT'])
  store.close()
})

test.describe('MCP', () => {
  // The MCP server closes as soon as a client connects on Windows (see docs/headless.md).
  test.skip(process.platform === 'win32', 'MCP over stdio is not supported on Windows yet')

  test('board tools: read-only by default, changes need confirm: true', async () => {
    const connect = async (args: string[]) => {
      const client = new Client({ name: 'ordo-e2e', version: '1.0.0' })
      await client.connect(
        new StdioClientTransport({
          command: electronPath,
          args: [...TEST_SWITCHES, 'apps/desktop', '--headless', '--mcp', ...args],
          env: headlessEnv(profile),
          stderr: 'pipe',
        }),
      )
      return client
    }
    const text = (r: unknown) => JSON.parse(((r as CallToolResult).content[0] as { text: string }).text)

    const reader = await connect([])
    const names = (await reader.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['ordo_boards', 'ordo_board_cards']))
    expect(names).not.toContain('ordo_board_add_card')
    const cards = await reader.callTool({
      name: 'ordo_board_cards',
      arguments: { board: 'Home', column: 'Doing' },
    })
    expect(text(cards).cards.map((c: { title: string }) => c.title)).toEqual(['Fix the gate', 'Book the MOT'])
    await reader.close()

    const writer = await connect(['--allow-changes'])
    const refused = await writer.callTool({
      name: 'ordo_board_add_card',
      arguments: { board: 'Home', title: 'x' },
    })
    expect(text(refused).error.code).toBe('confirm_required')
    const added = await writer.callTool({
      name: 'ordo_board_add_card',
      arguments: { board: 'Home', title: 'Order skip', labels: ['Urgent'], confirm: true },
    })
    expect(text(added).card).toMatchObject({ title: 'Order skip', column: 'To do', labels: ['Urgent'] })
    await writer.close()
  })
})
