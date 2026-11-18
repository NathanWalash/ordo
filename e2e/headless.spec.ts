import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { test, expect } from '@playwright/test'
import { imapPort, seedMailbox, TEST_ACCOUNT } from './imap'
import { launchApp } from './launch'
import { electronPath, headlessEnv, json, ordo, TEST_SWITCHES, tempProfile } from './headless'

// Ordo without a window: the CLI and the MCP server, spawned like a script or an agent would.
// No Playwright Electron here; the windowed app is only used once, to connect the account.

test.describe.configure({ mode: 'serial' })

const FIXTURE = 'packages/money-core/src/fixtures/monzo.csv'
const toolText = (r: unknown) => JSON.parse(((r as CallToolResult).content[0] as { text: string }).text)

async function mcpClient(userData: string, extraArgs: string[] = [], env: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: electronPath,
    args: [...TEST_SWITCHES, 'apps/desktop', '--headless', '--mcp', ...extraArgs],
    env: headlessEnv(userData, env),
    stderr: 'pipe',
  })
  const client = new Client({ name: 'ordo-e2e', version: '1.0.0' })
  await client.connect(transport)
  return client
}

test.describe('without an account', () => {
  const profile = tempProfile()

  test('--help prints the commands and exits 0', async () => {
    const r = await ordo(['--help'], profile)
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('Usage:')
    expect(r.stdout).toContain('cleanup run --sender <address>... --confirm')
    expect(r.stderr).not.toContain('Error')
  })

  test('status --json is one clean JSON document', async () => {
    const r = await ordo(['status', '--json'], profile)
    expect(r.code).toBe(0)
    expect(json(r)).toMatchObject({
      account: { connected: false },
      calendar: { connected: false },
      ai: { provider: 'none' },
      writeLock: null,
    })
  })

  test('bad arguments exit 2 with a JSON error', async () => {
    const r = await ordo(['senders', '--everything', '--json'], profile)
    expect(r.code).toBe(2)
    expect(json(r)).toEqual({ error: { code: 'usage', message: 'Unknown option --everything' } })
  })

  test('mail commands say to connect in the app first', async () => {
    const r = await ordo(['senders'], profile)
    expect(r.code).toBe(1)
    // Nothing on stdout (Electron on Windows may still print a blank line when it exits).
    expect(r.stdout.trim()).toBe('')
    expect(r.stderr).toContain('No iCloud account is connected')
  })

  test('changes are refused without --allow-changes and --confirm', async () => {
    const without = await ordo(['money', 'import', FIXTURE, '--confirm', '--json'], profile)
    expect(without.code).toBe(3)
    expect(json(without)).toMatchObject({ error: { code: 'changes_not_allowed' } })
    const unconfirmed = await ordo(['money', 'import', FIXTURE, '--allow-changes', '--json'], profile)
    expect(unconfirmed.code).toBe(3)
    expect(json(unconfirmed)).toMatchObject({ error: { code: 'confirm_required' } })
    expect(json(await ordo(['status', '--json'], profile))).toMatchObject({ counts: { transactions: 0 } })
  })

  test('money import reads a CSV statement, and only a CSV', async () => {
    const r = await ordo(['money', 'import', FIXTURE, '--allow-changes', '--confirm', '--json'], profile)
    expect(r.code).toBe(0)
    expect(json(r)).toEqual({ account: 'Monzo', added: 25, duplicates: 0 })

    const again = await ordo(['money', 'import', FIXTURE, '--allow-changes', '--confirm'], profile)
    expect(again.stdout).toBe('Imported 0 transactions into Monzo (25 already there).\n')

    const notCsv = await ordo(['money', 'import', 'package.json', '--allow-changes', '--confirm'], profile)
    expect(notCsv.code).toBe(1)
    expect(notCsv.stderr).toContain('Choose a .csv bank statement export.')

    const t = json<{ total: number; transactions: unknown[] }>(
      await ordo(['money', 'transactions', '--limit', '2', '--json'], profile),
    )
    expect(t.total).toBe(25)
    expect(t.transactions).toHaveLength(2)
  })

  test('money sort is gated like ai sort, and refuses while AI for Money is off', async () => {
    const without = await ordo(['money', 'sort', '--confirm', '--json'], profile)
    expect(without.code).toBe(3)
    expect(json(without)).toMatchObject({ error: { code: 'changes_not_allowed' } })
    const unconfirmed = await ordo(['money', 'sort', '--allow-changes', '--json'], profile)
    expect(unconfirmed.code).toBe(3)
    expect(json(unconfirmed)).toMatchObject({ error: { code: 'confirm_required' } })
    const off = await ordo(['money', 'sort', '--allow-changes', '--confirm', '--json'], profile)
    expect(off.code).toBe(1)
    expect(json(off)).toEqual({
      error: { code: 'failed', message: 'Choose a model in Settings → AI first.' },
    })
  })

  test('a write waits for another live Ordo process holding the lock (exit 4)', async () => {
    const lock = join(profile, 'ordo-write.lock')
    // This test runner is alive and isn't the Ordo process: it stands in for the app.
    writeFileSync(
      lock,
      JSON.stringify({
        pid: process.pid,
        owner: 'app',
        task: 'scanning the inbox',
        since: new Date().toISOString(),
      }),
    )
    try {
      const r = await ordo(['money', 'import', FIXTURE, '--allow-changes', '--confirm', '--json'], profile)
      expect(r.code).toBe(4)
      expect(json(r)).toEqual({
        error: {
          code: 'locked',
          message: 'Ordo is busy in another Ordo window (scanning the inbox). Try again when it finishes.',
        },
      })
      // Reads carry on, and status says who is busy.
      expect(json(await ordo(['status', '--json'], profile))).toMatchObject({
        writeLock: { owner: 'app', task: 'scanning the inbox' },
      })
    } finally {
      rmSync(lock, { force: true })
    }
  })

  test('the MCP server is read-only unless started with --allow-changes', async () => {
    const readOnly = await mcpClient(profile)
    try {
      const names = (await readOnly.listTools()).tools.map((t) => t.name)
      expect(names).toContain('ordo_senders')
      expect(names).toContain('ordo_cleanup_plan')
      expect(names).not.toContain('ordo_cleanup_run')
      expect(names).not.toContain('ordo_import_statement')
      expect(names).not.toContain('ordo_money_sort')
      const status = toolText(await readOnly.callTool({ name: 'ordo_status', arguments: {} }))
      expect(status).toMatchObject({ account: { connected: false }, counts: { transactions: 25 } })
    } finally {
      await readOnly.close()
    }

    const changes = await mcpClient(profile, ['--allow-changes'])
    try {
      const names = (await changes.listTools()).tools.map((t) => t.name)
      expect(names).toEqual(
        expect.arrayContaining([
          'ordo_cleanup_run',
          'ordo_undo',
          'ordo_import_statement',
          'ordo_ai_sort',
          'ordo_money_sort',
        ]),
      )
      const refused = await changes.callTool({ name: 'ordo_import_statement', arguments: { path: FIXTURE } })
      expect(refused.isError).toBe(true)
      expect(toolText(refused)).toMatchObject({ error: { code: 'confirm_required' } })
    } finally {
      await changes.close()
    }
  })
})

test.describe('with a connected account (GreenMail)', () => {
  test.skip(!imapPort, 'Set IMAP_TEST_PORT and run `pnpm imap:start` to test against a local IMAP server')

  const run = Date.now().toString(36)
  const PROMO = `promo-${run}@shop.example`
  const SAM = 'sam@friend.example'
  const profile = tempProfile()
  const imapEnv = () => ({ ORDO_IMAP_HOST: '127.0.0.1', ORDO_IMAP_PORT: imapPort! })
  const cli = (...args: string[]) => ordo(args, profile, imapEnv())

  function imap() {
    return new ImapFlow({
      host: '127.0.0.1',
      port: Number(imapPort),
      secure: false,
      auth: { user: TEST_ACCOUNT.email, pass: TEST_ACCOUNT.password },
      logger: false,
    })
  }

  async function countFrom(mailbox: string): Promise<number> {
    const c = imap()
    await c.connect()
    try {
      const lock = await c.getMailboxLock(mailbox)
      try {
        return ((await c.search({ from: PROMO }, { uid: true })) || []).length
      } finally {
        lock.release()
      }
    } finally {
      await c.logout()
    }
  }

  test.beforeAll(async () => {
    await seedMailbox()
    const c = imap()
    await c.connect()
    if (!(await c.list()).some((b) => b.specialUse === '\\Trash')) await c.mailboxCreate('Trash')
    for (const n of [1, 2])
      await c.append(
        'INBOX',
        `From: Shop ${run} <${PROMO}>\r\nTo: ${TEST_ACCOUNT.email}\r\nSubject: ${n * 10}% off today only\r\n` +
          `Date: Mon, 16 Nov 2026 1${n}:00:00 +0000\r\nList-Id: <deals.shop.example>\r\n` +
          `List-Unsubscribe: <https://shop.example/u/${run}>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n\r\nSale\r\n`,
      )
    await c.logout()

    // Connecting stays in the window (no passwords on command lines): do it once, then go headless.
    const app = await launchApp({ ORDO_USER_DATA: profile, ...imapEnv() })
    const page = await app.firstWindow()
    await page.getByRole('navigation').getByRole('button', { name: 'Mail' }).click()
    await page.getByRole('button', { name: 'Connect iCloud' }).click()
    await page.getByLabel('Apple ID email').fill(TEST_ACCOUNT.email)
    await page.getByLabel('App-specific password').fill(TEST_ACCOUNT.password)
    await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Unclutter' })).toBeVisible()
    await app.close()
  })

  test('status shows the account email and never the password', async () => {
    const r = await cli('status', '--json')
    expect(r.code).toBe(0)
    expect(json(r)).toMatchObject({ account: { connected: true, email: TEST_ACCOUNT.email } })
    expect(r.stdout + r.stderr).not.toContain(TEST_ACCOUNT.password)
  })

  test('scan fetches the inbox, with progress on stderr', async () => {
    const r = await cli('scan')
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^Scanned the inbox: \d+ new emails?, \d+ cached\.\n$/)
    expect(r.stderr).toContain('Scanning inbox')
  })

  test('senders --json lists Sam as a protected person', async () => {
    const r = await cli('senders', '--json', '--limit', '500')
    expect(r.code).toBe(0)
    const { senders } = json<{
      senders: { address: string; category: string; protected: boolean; emails: number }[]
    }>(r)
    expect(senders.find((s) => s.address === SAM)).toMatchObject({ category: 'people', protected: true })
    expect(senders.find((s) => s.address === PROMO)).toMatchObject({ emails: 2, protected: false })
  })

  test('cleanup plan is a dry run that refuses Sam', async () => {
    const r = await cli('cleanup', 'plan', '--sender', SAM, '--sender', PROMO, '--no-unsubscribe', '--json')
    expect(r.code).toBe(0)
    expect(json(r)).toEqual({
      senders: [
        {
          address: PROMO,
          name: `Shop ${run}`,
          category: expect.any(String),
          emails: 2,
          trash: true,
          unsubscribe: null,
        },
      ],
      rejected: [{ address: SAM, reason: 'Someone you’ve written to. Never included in bulk actions.' }],
      summary: { senders: 1, emailsToTrash: 2, unsubscribes: 0 },
    })
    expect(await countFrom('INBOX')).toBe(2)
  })

  test('cleanup run is refused without --allow-changes', async () => {
    const r = await cli('cleanup', 'run', '--sender', PROMO, '--no-unsubscribe', '--confirm')
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('--allow-changes')
    expect(await countFrom('INBOX')).toBe(2)
  })

  test('cleanup run with --allow-changes --confirm moves the mail, and history shows it', async () => {
    const r = await cli(
      'cleanup',
      'run',
      '--sender',
      PROMO,
      '--sender',
      SAM,
      '--no-unsubscribe',
      '--allow-changes',
      '--confirm',
      '--json',
    )
    expect(r.code).toBe(0)
    const out = json<{
      cleanup: { id: number; moved: number; canUndo: boolean }
      rejected: { address: string }[]
    }>(r)
    expect(out.cleanup).toMatchObject({ moved: 2, canUndo: true })
    expect(out.rejected).toEqual([{ address: SAM, reason: expect.stringContaining('Never included') }])
    expect(await countFrom('INBOX')).toBe(0)
    expect(await countFrom('Trash')).toBe(2)

    const history = json<{ cleanups: { id: number; moved: number; senders: { address: string }[] }[] }>(
      await cli('history', '--json'),
    )
    expect(history.cleanups[0]).toMatchObject({ id: out.cleanup.id, moved: 2, senders: [{ address: PROMO }] })
  })

  test('undo puts the emails back', async () => {
    const { cleanups } = json<{ cleanups: { id: number }[] }>(await cli('history', '--json'))
    const id = String(cleanups[0]!.id)
    expect((await cli('undo', id, '--confirm')).code).toBe(3)
    const r = await cli('undo', id, '--allow-changes', '--confirm')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe('Moved 2 emails back to the inbox.\n')
    expect(await countFrom('INBOX')).toBe(2)
    expect(await countFrom('Trash')).toBe(0)
  })

  test('the MCP server lists senders and refuses Sam in a plan', async () => {
    const client = await mcpClient(profile, [], imapEnv())
    try {
      const senders = toolText(
        await client.callTool({ name: 'ordo_senders', arguments: { category: 'people' } }),
      )
      expect(senders.senders).toEqual(
        expect.arrayContaining([expect.objectContaining({ address: SAM, protected: true })]),
      )
      const plan = toolText(
        await client.callTool({
          name: 'ordo_cleanup_plan',
          arguments: { senders: [SAM, PROMO], unsubscribe: false },
        }),
      )
      expect(plan.rejected).toEqual([{ address: SAM, reason: expect.stringContaining('Never included') }])
      expect(plan.senders).toEqual([expect.objectContaining({ address: PROMO, emails: 2 })])
    } finally {
      await client.close()
    }
  })

  test('mail sync, list, search and read work headless, and reading leaves mail unread', async () => {
    const sync = await cli('mail', 'sync', '--json')
    expect(sync.code).toBe(0)
    expect(json(sync)).toMatchObject({ mailbox: 'INBOX' })
    const boxes = json<{ mailboxes: { path: string; role: string | null }[] }>(
      await cli('mail', 'mailboxes', '--json'),
    )
    expect(boxes.mailboxes[0]).toMatchObject({ path: 'INBOX', role: 'inbox' })

    const found = json<{ messages: { uid: number; subject: string; unread: boolean }[] }>(
      await cli('mail', 'search', 'off today only', '--json'),
    )
    const promo = found.messages.find((m) => m.subject === '10% off today only')
    expect(promo?.unread).toBe(true)

    const read = await cli('mail', 'read', String(promo!.uid))
    expect(read.code).toBe(0)
    expect(read.stdout).toContain(`From:    Shop ${run} <${PROMO}>`)
    expect(read.stdout).toContain('Sale')

    // Read with BODY.PEEK in a read-only mailbox: still unread on the server.
    const c = imap()
    await c.connect()
    try {
      const lock = await c.getMailboxLock('INBOX')
      try {
        const m = await c.fetchOne(String(promo!.uid), { flags: true }, { uid: true })
        expect(m && m.flags?.has('\\Seen')).toBe(false)
      } finally {
        lock.release()
      }
    } finally {
      await c.logout()
    }

    const server = await cli('mail', 'search', `u/${run}`, '--server', '--json')
    expect(server.code).toBe(0)
    expect(await cli('mail', 'send', '--json')).toMatchObject({ code: 2 })
  })

  test('the MCP server reads mail but has no tool to send it', async () => {
    test.skip(process.platform === 'win32', 'MCP over stdio is not working on Windows yet')
    const client = await mcpClient(profile, ['--allow-changes'], imapEnv())
    try {
      const names = (await client.listTools()).tools.map((t) => t.name)
      expect(names).toEqual(
        expect.arrayContaining(['ordo_messages', 'ordo_read_message', 'ordo_search_mail']),
      )
      expect(names.filter((n) => /_(send|draft|reply|forward|compose)(_|$)/.test(n))).toEqual([])
      const list = toolText(await client.callTool({ name: 'ordo_messages', arguments: { limit: 5 } }))
      expect(list.messages.length).toBeGreaterThan(0)
    } finally {
      await client.close()
    }
  })

  test('the window shows a friendly message while another Ordo process is writing', async () => {
    const lock = join(profile, 'ordo-write.lock')
    writeFileSync(
      lock,
      JSON.stringify({
        pid: process.pid,
        owner: 'mcp',
        task: 'clearing senders',
        since: new Date().toISOString(),
      }),
    )
    const app = await launchApp({ ORDO_USER_DATA: profile, ...imapEnv() })
    try {
      const page = await app.firstWindow()
      await page.getByRole('navigation').getByRole('button', { name: 'Unclutter' }).click()
      await page.getByRole('button', { name: 'Scan again' }).click()
      await expect(
        page.getByText(
          'Ordo is busy in an AI agent using Ordo (clearing senders). Try again when it finishes.',
        ),
      ).toBeVisible()
    } finally {
      await app.close()
      rmSync(lock, { force: true })
    }
  })
})
