import { mkdtempSync, writeFileSync } from 'node:fs'
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
    await expect(panel.getByRole('textbox', { name: 'Ask the assistant' })).toBeDisabled()
    await panel.getByRole('button', { name: 'Open Settings' }).click()
    await expect(page.getByRole('heading', { level: 2, name: 'AI' })).toBeVisible()
  } finally {
    await app.close()
  }
})

test('with a cloud provider, the panel says what the model will see and who gets it', async () => {
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
  const app = await launchApp({ ORDO_USER_DATA: userData, ...noCli() })
  try {
    const page = await app.firstWindow()
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible()
    await page.keyboard.press(`${mod}+k`)
    const panel = page.getByRole('dialog', { name: 'Assistant' })
    await expect(panel.getByText('Claude Code CLI · haiku · Cloud')).toBeVisible()
    await expect(panel).toContainText(
      'Your questions, and the Ordo data the assistant looks up to answer them (sender names and subject lines, calendar events, transactions, bills and balances), go to Anthropic under your own account.',
    )
    await page.screenshot({ path: 'test-results/assistant-cloud-dark.png', animations: 'disabled' })
  } finally {
    await app.close()
  }
})
