import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ImapFlow } from 'imapflow'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { imapPort, seedMailbox, TEST_ACCOUNT } from './imap'
import { launchApp } from './launch'

// The Monzo fixture has one merchant no rule knows, Zorblax Studio, which Monzo files as "general".
const STATEMENT = resolve('packages/money-core/src/fixtures/monzo.csv')
const shots = process.env['ORDO_SCREENSHOTS'] === '1'

// Stand-in for LM Studio: answers "Shopping" for every merchant it's asked about, and keeps the prompts.
let lmStudio: Server
const prompts: string[] = []
const asked: Record<string, unknown>[] = []
const pairPrompts: string[] = []
const pairsAsked: Record<string, unknown>[] = []

/** The JSON lines between `<tag>` and `</tag>`. */
const block = (prompt: string, tag: string) =>
  prompt
    .slice(prompt.indexOf(`<${tag}>`) + tag.length + 2, prompt.indexOf(`</${tag}>`))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

const reply = (content: unknown) =>
  JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }] })

function startFakeLmStudio(): Promise<string> {
  lmStudio = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'openai/gpt-oss-20b' }] }))
      if (req.url === '/v1/chat/completions') {
        const prompt: string = JSON.parse(body).messages.at(-1).content
        if (prompt.includes('<pairs>')) {
          // Bill matching: says yes to every pair.
          pairPrompts.push(prompt)
          const pairs = block(prompt, 'pairs')
          pairsAsked.push(...pairs)
          return res.end(
            reply({ results: pairs.map((p) => ({ pair: p['pair'], match: true, confidence: 0.9 })) }),
          )
        }
        prompts.push(prompt)
        const merchants = block(prompt, 'merchants')
        asked.push(...merchants)
        const results = merchants.map((m) => ({
          merchant: m['merchant'],
          category: 'Shopping',
          confidence: 0.85,
        }))
        return res.end(reply({ results }))
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

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  // AI for Money already on with LM Studio, as if chosen in Settings → AI.
  const userData = mkdtempSync(join(tmpdir(), 'ordo-e2e-moneyai-'))
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({
      theme: 'light',
      ai: {
        provider: 'lmstudio',
        model: 'openai/gpt-oss-20b',
        sortSenders: false,
        money: true,
        cloudConsent: null,
      },
    }),
  )
  app = await launchApp({
    ORDO_USER_DATA: userData,
    ORDO_LMSTUDIO_URL: await startFakeLmStudio(),
    ...(imapPort && { ORDO_IMAP_HOST: '127.0.0.1', ORDO_IMAP_PORT: imapPort }),
  })
  page = await app.firstWindow()
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as typeof dialog.showOpenDialog
  }, STATEMENT)
})

test.afterAll(async () => {
  await app?.close()
  lmStudio?.close()
})

const nav = (name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true })
const table = () => page.getByRole('table', { name: 'Transactions' })
const zorblax = () => table().getByRole('row', { name: /Zorblax Studio/ })
const category = () => zorblax().getByRole('combobox', { name: 'Category for Zorblax Studio' })

test('Sort with AI categorises the one merchant left in Other, and sends nothing else', async () => {
  await nav('Finances').click()
  await page.getByRole('button', { name: 'Import statement' }).click()
  await page
    .getByRole('dialog', { name: 'Import statement' })
    .getByRole('button', { name: 'Import', exact: true })
    .click()
  await expect(page.getByText('Imported 25 transactions into Monzo.')).toBeVisible()
  await expect(category()).toHaveValue('Other')
  await expect(zorblax().getByLabel('Categorised by AI')).toHaveCount(0)
  // Listing never asks the model.
  expect(prompts).toHaveLength(0)

  await page.getByRole('button', { name: 'Sort with AI' }).click()
  await expect(page.getByText('LM Studio sorted 1 merchant out of Other.')).toBeVisible()
  await expect(category()).toHaveValue('Shopping')
  const sparkle = zorblax().getByLabel('Categorised by AI')
  await expect(sparkle).toBeVisible()
  await expect(sparkle.locator('xpath=..')).toHaveAttribute('title', 'Categorised by AI (85% sure)')

  // One merchant, four facts, nothing about the account, dates or exact amounts.
  expect(asked).toEqual([
    { merchant: 'Zorblax Studio', description: 'Zorblax Studio', direction: 'out', typicalAmount: '£10–£20' },
  ])
  expect(prompts).toHaveLength(1)
  for (const leak of ['Monzo', '2026', '14.50', '1450', 'Netflix', 'Acme', 'balance', 'account'])
    expect(prompts[0]).not.toContain(leak)

  // Spending by category counts it as Shopping now.
  await expect(page.getByRole('listitem').filter({ hasText: 'Shopping' })).toBeVisible()
  if (shots) await page.screenshot({ path: 'test-results/money-ai-finances.png' })
})

test('listing again applies the earlier answer without asking the model', async () => {
  await nav('Bills & Subscriptions').click()
  await nav('Finances').click()
  await expect(category()).toHaveValue('Shopping')
  await expect(zorblax().getByLabel('Categorised by AI')).toBeVisible()
  expect(prompts).toHaveLength(1)
})

test('your own category wins over AI, and Automatic goes back to it', async () => {
  await category().selectOption('Entertainment')
  await expect(category()).toHaveValue('Entertainment')
  await expect(zorblax().getByLabel('Categorised by AI')).toHaveCount(0)

  await nav('Bills & Subscriptions').click()
  await nav('Finances').click()
  await expect(category()).toHaveValue('Entertainment')

  // Sorting again leaves it alone: there's nothing in Other to ask about.
  await page.getByRole('button', { name: 'Sort with AI' }).click()
  await expect(page.getByText('Nothing was left in Other.')).toBeVisible()
  await expect(category()).toHaveValue('Entertainment')
  expect(prompts).toHaveLength(1)

  await category().selectOption('Automatic')
  await expect(category()).toHaveValue('Shopping')
  await expect(zorblax().getByLabel('Categorised by AI')).toBeVisible()
  expect(prompts).toHaveLength(1)
})

test('Settings → AI has the AI for Money switch with the privacy note', async () => {
  await nav('Settings').click()
  const toggle = page.getByRole('switch', { name: 'Use AI for Money (categories and bill matching)' })
  await expect(toggle).toBeChecked()
  await expect(page.getByText('Never balances, account details or dates.', { exact: false })).toBeVisible()
  await expect(page.getByText('Stays on this computer.')).toBeVisible()
  if (shots) {
    await expect(page.getByText(/^Running/).first()).toBeVisible()
    await toggle.evaluate((el) => el.scrollIntoView({ block: 'center' }))
    await page.screenshot({ path: 'test-results/money-ai-settings.png' })
  }
})

test.describe('with Mail connected (GreenMail)', () => {
  test.skip(!imapPort, 'Needs a local IMAP server: pnpm imap:start, then IMAP_TEST_PORT=3143')

  // Spotify is a monthly payment in the statement; "Sptfy" emails are too different for the rules.
  const TAG = Date.now().toString(36)

  test('bill matching sends name and domain pairs, and a match waits for review in Bills', async () => {
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
      `From: Sptfy <billing@sptfy-${TAG}.example>\r\nTo: ${TEST_ACCOUNT.email}\r\n` +
        `Subject: Your Sptfy Premium renews on 12 Dec for £12.99\r\nDate: Mon, 16 Nov 2026 10:00:00 +0000\r\n\r\nHi\r\n`,
    )
    await c.logout()

    await nav('Mail').click()
    await page.getByRole('button', { name: 'Connect iCloud' }).click()
    await page.getByLabel('Apple ID email').fill(TEST_ACCOUNT.email)
    await page.getByLabel('App-specific password').fill(TEST_ACCOUNT.password)
    await page.getByRole('dialog').getByRole('button', { name: 'Connect', exact: true }).click()
    await page.getByRole('button', { name: 'Scan inbox' }).click()
    // Earlier runs may have left other Sptfy emails in the shared test mailbox.
    await expect(page.getByRole('row', { name: new RegExp(`sptfy-${TAG}`) })).toBeVisible({ timeout: 15_000 })

    await nav('Finances').click()
    await page.getByRole('button', { name: 'Sort with AI' }).click()
    await expect(page.getByText(/It matched 1 bill to your email/)).toBeVisible()
    // Ordo keeps one hint per sender name and kind, so the domain may be from an earlier run's email.
    const spotify = pairsAsked.find((p) => p['emailSender'] === 'Sptfy')
    expect(spotify).toMatchObject({
      bankMerchant: 'Spotify',
      bankAmount: '£10–£20',
      cadence: 'monthly',
      emailSender: 'Sptfy',
      emailDomain: expect.stringMatching(/^sptfy-[a-z0-9]+\.example$/),
      emailKinds: ['renewal'],
    })
    for (const leak of ['Premium', '12 Dec', '12.99', '2026'])
      expect(pairPrompts.join('\n')).not.toContain(leak)

    await nav('Bills & Subscriptions').click()
    const review = page.getByRole('list', { name: 'Detected bills' })
    const row = review.getByRole('listitem').filter({ hasText: 'Spotify' })
    await expect(row.getByText('Matched by AI')).toBeVisible()
    await expect(row.getByText('Both', { exact: true })).toBeVisible()
    // Still waiting for you: nothing was confirmed.
    await expect(page.getByRole('button', { name: 'Confirm Spotify' })).toBeVisible()
    await expect(review.getByText('Sptfy', { exact: true })).toHaveCount(0)
    if (shots) await page.screenshot({ path: 'test-results/money-ai-bills.png' })
  })
})
