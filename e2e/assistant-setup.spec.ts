import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from '@playwright/test'
import { launchApp } from './launch'

// Neither test talks to a model: the panel only reads the saved AI settings.
const noCli = () => ({
  ORDO_LMSTUDIO_URL: 'http://127.0.0.1:9',
  ORDO_OLLAMA_URL: 'http://127.0.0.1:9',
  ORDO_AI_CLI_PATH: mkdtempSync(join(tmpdir(), 'ordo-e2e-nocli-')),
})
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

test('without a model, the assistant says how to set one up', async () => {
  const app = await launchApp(noCli())
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible()
    await page.keyboard.press(`${mod}+k`)
    const panel = page.getByRole('dialog', { name: 'Assistant' })
    await expect(panel.getByRole('heading', { name: 'Set up a model first' })).toBeVisible()
    await expect(panel).toContainText('Choose a model in Settings → AI to use the assistant.')
    await expect(panel.getByRole('button', { name: 'Open Settings' })).toBeFocused()
    await expect(panel.getByRole('textbox', { name: 'Ask the assistant' })).toHaveCount(0)
    await page.screenshot({ path: 'test-results/assistant-no-model-light.png', animations: 'disabled' })
    await panel.getByRole('button', { name: 'Open Settings' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'AI' })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('a cloud provider needs its own OK for the assistant, which can be withdrawn', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'ordo-e2e-assistant-cloud-'))
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({
      theme: 'dark',
      ai: {
        provider: 'claude-cli',
        model: 'haiku',
        sortSenders: false,
        money: false,
        cloudConsent: 'claude-cli',
      },
    }),
  )
  const consent = () => {
    try {
      return JSON.parse(readFileSync(join(userData, 'assistant.json'), 'utf8')).cloudConsent
    } catch {
      return 'none saved'
    }
  }
  const app = await launchApp({ ORDO_USER_DATA: userData, ...noCli() })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible()
    await page.keyboard.press(`${mod}+k`)
    const panel = page.getByRole('dialog', { name: 'Assistant' })
    await expect(panel.getByText('Claude Code CLI · haiku · Cloud')).toBeVisible()
    const ask = panel.getByRole('region', { name: 'Let the assistant send your data to Anthropic?' })
    await expect(ask).toContainText(
      'transactions with amounts and dates, balances, bills, calendar events, sender names, addresses and subject lines, the text of emails it opens, your boards’ cards, and your mail accounts’ names and email addresses.',
    )
    // Nothing to type into until the user agrees.
    await expect(panel.getByRole('textbox', { name: 'Ask the assistant' })).toHaveCount(0)
    await expect(ask.getByRole('button', { name: 'Not now' })).toBeFocused()
    await page.screenshot({ path: 'test-results/assistant-cloud-consent-dark.png', animations: 'disabled' })

    await ask.getByRole('button', { name: 'Not now' }).click()
    await expect(ask).toContainText('Nothing was sent.')
    expect(consent()).toBe('none saved')

    await ask.getByRole('button', { name: 'Allow after all' }).click()
    await expect(panel.getByRole('textbox', { name: 'Ask the assistant' })).toBeVisible()
    await expect(panel).toContainText('It goes to Anthropic under your own account.')
    await expect.poll(consent).toBe('claude-cli')
    await page.screenshot({ path: 'test-results/assistant-cloud-dark.png', animations: 'disabled' })

    await panel.getByRole('button', { name: 'Stop sharing' }).click()
    await expect(ask).toBeVisible()
    await expect.poll(consent).toBe(null)
  } finally {
    await app.close()
  }
})
