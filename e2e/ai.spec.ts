import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'

// A stand-in for LM Studio's OpenAI-compatible server.
let lmStudio: Server
const chats: unknown[] = []

function startFakeLmStudio(): Promise<string> {
  lmStudio = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/v1/models')
        return res.end(
          JSON.stringify({
            data: [{ id: 'gemma-4-26b-a4b-qat' }, { id: 'openai/gpt-oss-20b' }, { id: 'nomic-embed-text' }],
          }),
        )
      if (req.url === '/v1/chat/completions') {
        chats.push(JSON.parse(body))
        return res.end(
          JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hello, Ordo!' } }] }),
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

const userData = mkdtempSync(join(tmpdir(), 'ordo-e2e-ai-'))
const savedAi = () => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')).ai

test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const url = await startFakeLmStudio()
  app = await launchApp({
    ORDO_USER_DATA: userData,
    ORDO_LMSTUDIO_URL: url,
    // Nothing listens here, so Ollama reads as not running.
    ORDO_OLLAMA_URL: 'http://127.0.0.1:9',
    // An empty search path, so the Claude and Codex CLIs read as not installed on every machine.
    ORDO_AI_CLI_PATH: mkdtempSync(join(tmpdir(), 'ordo-e2e-nocli-')),
  })
  page = await app.firstWindow()
  // Tall enough to show the whole AI section in the screenshots.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(1240, 1080))
})

test.afterAll(async () => {
  await app.close()
  lmStudio.close()
})

const provider = (name: string) => page.getByRole('radio', { name, exact: true })
const ai = () => page.getByRole('region', { name: 'AI' })

test('Settings → AI lists each provider with what was detected', async () => {
  await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'AI' })).toBeVisible()
  await expect(provider('Off')).toBeChecked()

  await expect(ai().getByText('Running · 2 models')).toBeVisible()
  await expect(ai().getByText('Not running. Open Ollama.')).toBeVisible()
  await expect(ai().getByText('Not installed. Install Claude Code first.')).toBeVisible()
  await expect(ai().getByText('Not installed. Install the Codex CLI first.')).toBeVisible()
  await expect(provider('LM Studio')).toHaveAccessibleDescription('Running · 2 models')
})

test('picking LM Studio preselects gpt-oss-20b and saves it', async () => {
  await provider('LM Studio').check()
  await expect(provider('LM Studio')).toBeChecked()
  const model = ai().getByRole('combobox', { name: 'Model' })
  await expect(model).toHaveValue('openai/gpt-oss-20b')
  await expect(model.locator('option')).toHaveText(['gemma-4-26b-a4b-qat', 'openai/gpt-oss-20b'])
  await expect(ai().getByText('Stays on this computer.')).toBeVisible()
  await expect.poll(savedAi).toEqual({
    provider: 'lmstudio',
    model: 'openai/gpt-oss-20b',
    sortSenders: false,
    money: false,
    cloudConsent: null,
  })

  const toggle = page.getByRole('switch', { name: "Use AI to sort senders Ordo isn't sure about" })
  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect.poll(() => savedAi().sortSenders).toBe(true)
})

test('Test sends a tiny prompt and shows the reply and latency', async () => {
  await ai().getByRole('button', { name: 'Test', exact: true }).click()
  await expect(ai().getByRole('status')).toContainText('“Hello, Ordo!”')
  await expect(ai().getByRole('status')).toContainText(/\d+\.\d s/)
  expect(chats.at(-1)).toMatchObject({ model: 'openai/gpt-oss-20b', stream: false })

  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Light' }).click()
  await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(false)
  await page.screenshot({ path: 'test-results/ai-settings-light.png', animations: 'disabled' })
})

test('choosing Claude Code CLI asks before sending anything to Anthropic', async () => {
  await provider('Claude Code CLI').click()
  const dialog = page.getByRole('dialog', { name: 'Send sender details to Anthropic?' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(
    'Sender names, addresses and subject lines will be sent to Anthropic under your own account',
  )
  await page.screenshot({ path: 'test-results/ai-settings-confirm.png', animations: 'disabled' })

  // Cancel keeps the local provider.
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  await expect(provider('LM Studio')).toBeChecked()
  expect(savedAi().provider).toBe('lmstudio')

  await provider('Claude Code CLI').click()
  await page.getByRole('button', { name: 'Use Claude Code CLI' }).click()
  await expect(provider('Claude Code CLI')).toBeChecked()
  await expect(
    ai().getByText('Sender names, addresses and subject lines are sent to Anthropic'),
  ).toBeVisible()
  await expect
    .poll(savedAi)
    .toMatchObject({ provider: 'claude-cli', model: null, cloudConsent: 'claude-cli' })
})

test('Codex is marked experimental in its confirm', async () => {
  await provider('Codex CLI').click()
  const dialog = page.getByRole('dialog', { name: 'Send sender details to OpenAI?' })
  await expect(dialog).toContainText('Experimental')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(provider('Claude Code CLI')).toBeChecked()
})

test('the main process refuses a cloud provider without consent', async () => {
  const refused = await page
    .evaluate(() =>
      window.ordo.settings.set({
        ai: { provider: 'codex-cli', model: null, sortSenders: true, cloudConsent: null },
      }),
    )
    .catch((e: Error) => e.message)
  expect(String(refused)).toMatch(/Confirm before sending/)
  const test = await page.evaluate(() => window.ordo.ai.test({ provider: 'codex-cli', model: null }))
  expect(test).toEqual({ ok: false, message: 'Confirm that Ordo may use this provider first.' })
})

test('dark mode screenshot with LM Studio tested', async () => {
  await provider('LM Studio').check()
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark' }).click()
  await ai().getByRole('button', { name: 'Test', exact: true }).click()
  await expect(ai().getByRole('status')).toContainText('“Hello, Ordo!”')
  await page.screenshot({ path: 'test-results/ai-settings-dark.png', animations: 'disabled' })
})
