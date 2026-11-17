import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImapFlow } from 'imapflow'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { imapPort, seedMailbox, TEST_ACCOUNT } from './imap'
import { launchApp } from './launch'

// A sender the rules can't place: no list headers, not a no-reply address, never written to.
const TAG = Date.now().toString(36)
const QUIET = `Quiet Co ${TAG}`

// Stand-in for LM Studio: answers "promotions" for every sender it's asked about.
let lmStudio: Server
const asked: string[] = []

function startFakeLmStudio(): Promise<string> {
  lmStudio = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'openai/gpt-oss-20b' }] }))
      if (req.url === '/v1/chat/completions') {
        const prompt: string = JSON.parse(body).messages.at(-1).content
        const block = prompt.slice(prompt.indexOf('<senders>') + 9, prompt.indexOf('</senders>'))
        const addresses = block
          .split('\n')
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { address: string }).address)
        asked.push(...addresses)
        const results = addresses.map((address) => ({ address, category: 'promotions', confidence: 0.9 }))
        return res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: JSON.stringify({ results }) } }],
          }),
        )
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  return new Promise((resolve) =>
    lmStudio.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(lmStudio.address() as AddressInfo).port}`),
    ),
  )
}

test.describe.configure({ mode: 'serial' })
test.skip(!imapPort, 'Needs a local IMAP server: pnpm imap:start, then IMAP_TEST_PORT=3143')

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  if (!imapPort) return
  await seedMailbox()
  const c = new ImapFlow({
    host: '127.0.0.1',
    port: Number(imapPort),
    secure: false,
    auth: { user: TEST_ACCOUNT.email, pass: TEST_ACCOUNT.password },
    logger: false,
  })
  await c.connect()
  await c.append(
    'INBOX',
    `From: ${QUIET} <hello-${TAG}@quiet.example>\r\nTo: ${TEST_ACCOUNT.email}\r\nSubject: Your weekly picks\r\nDate: Mon, 16 Nov 2026 10:00:00 +0000\r\n\r\nHi\r\n`,
  )
  await c.logout()

  // AI sorting already set up with LM Studio, as if chosen in Settings → AI.
  const userData = mkdtempSync(join(tmpdir(), 'ordo-e2e-aisort-'))
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({
      theme: 'system',
      ai: { provider: 'lmstudio', model: 'openai/gpt-oss-20b', sortSenders: true, cloudConsent: null },
    }),
  )
  app = await launchApp({
    ORDO_USER_DATA: userData,
    ORDO_LMSTUDIO_URL: await startFakeLmStudio(),
    ORDO_IMAP_HOST: '127.0.0.1',
    ORDO_IMAP_PORT: imapPort,
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  lmStudio?.close()
})

const row = () => page.getByRole('row', { name: new RegExp(QUIET) })

test('Sort with AI moves unsure senders out of Other and never sends people', async () => {
  await page.getByRole('navigation').getByRole('button', { name: 'Inbox' }).click()
  await page.getByRole('button', { name: 'Connect iCloud' }).click()
  await page.getByLabel('Apple ID email').fill(TEST_ACCOUNT.email)
  await page.getByLabel('App-specific password').fill(TEST_ACCOUNT.password)
  await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
  await page.getByRole('button', { name: 'Scan inbox' }).click()
  await expect(row()).toBeVisible({ timeout: 15_000 })
  await expect(row().getByLabel('Sorted by AI')).toHaveCount(0)

  await page.getByRole('button', { name: 'Sort with AI' }).click()
  await expect(page.getByRole('status')).toContainText('LM Studio sorted')
  await expect(row().getByLabel('Sorted by AI')).toBeVisible()
  expect(asked).toContain(`hello-${TAG}@quiet.example`)
  expect(asked).not.toContain('sam@friend.example')
  if (process.env['ORDO_E2E_SCREENSHOTS'] === '1')
    await page.screenshot({ path: 'test-results/screenshots/unclutter-ai-sorted.png' })

  // It now counts as a promotion.
  await page.getByRole('button', { name: /^Promotions/ }).click()
  await expect(row()).toBeVisible()
})

test('earlier AI answers are kept without asking the model again', async () => {
  const before = asked.length
  await page.getByRole('navigation').getByRole('button', { name: 'Home' }).click()
  await page.getByRole('navigation').getByRole('button', { name: 'Unclutter' }).click()
  await expect(row().getByLabel('Sorted by AI')).toBeVisible()
  expect(asked.length).toBe(before)
})
