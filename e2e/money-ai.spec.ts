import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'

// The Monzo fixture has one merchant no rule knows, Zorblax Studio, which Monzo files as "general".
const STATEMENT = resolve('packages/money-core/src/fixtures/monzo.csv')
const shots = process.env['ORDO_SCREENSHOTS'] === '1'

// Stand-in for LM Studio: answers "Shopping" for every merchant it's asked about, and keeps the prompts.
let lmStudio: Server
const prompts: string[] = []
const asked: Record<string, unknown>[] = []

function startFakeLmStudio(): Promise<string> {
  lmStudio = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'openai/gpt-oss-20b' }] }))
      if (req.url === '/v1/chat/completions') {
        const prompt: string = JSON.parse(body).messages.at(-1).content
        prompts.push(prompt)
        const block = prompt.slice(prompt.indexOf('<merchants>') + 11, prompt.indexOf('</merchants>'))
        const merchants = block
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
        asked.push(...merchants)
        const results = merchants.map((m) => ({
          merchant: m['merchant'],
          category: 'Shopping',
          confidence: 0.85,
        }))
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
  app = await launchApp({ ORDO_USER_DATA: userData, ORDO_LMSTUDIO_URL: await startFakeLmStudio() })
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
