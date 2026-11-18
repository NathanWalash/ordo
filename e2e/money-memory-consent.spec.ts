import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'

// A cloud model the user already agreed may see sender names and merchant names, but not exact
// amounts, dates and names. Ask Ordo needs that second, separate consent. No CLI is ever run here.
const MONZO = resolve('e2e/fixtures/memory-monzo.csv')

test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const userData = mkdtempSync(join(tmpdir(), 'ordo-e2e-memory-consent-'))
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({
      theme: 'light',
      ai: {
        provider: 'claude-cli',
        model: 'haiku',
        sortSenders: false,
        money: true,
        cloudConsent: 'claude-cli',
      },
    }),
  )
  // An empty folder for CLIs, so nothing real is found or run.
  app = await launchApp({
    ORDO_USER_DATA: userData,
    ORDO_AI_CLI_PATH: mkdtempSync(join(tmpdir(), 'ordo-no-cli-')),
  })
  page = await app.firstWindow()
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [file],
    })) as typeof dialog.showOpenDialog
  }, MONZO)
})

test.afterAll(async () => {
  await app?.close()
})

const nav = (name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true })

test('Ask Ordo waits for the separate consent before a cloud model sees amounts and names', async () => {
  await nav('Finances').click()
  await page.getByRole('button', { name: 'Import statement' }).click()
  await page
    .getByRole('dialog', { name: 'Import statement' })
    .getByRole('button', { name: 'Import', exact: true })
    .click()
  await nav('Ask Ordo').click()
  const box = page.getByRole('textbox', { name: 'Ask about your money' })
  await expect(box).toBeDisabled()
  await expect(
    page.getByText(/allow it to see exact amounts, dates and names in Settings → AI/),
  ).toBeVisible()
  // Ordo's own questions still work without any model.
  await expect(page.getByRole('list', { name: 'Questions for you' })).toContainText('Gabe S pays you')
})

test('the consent is asked for in its own dialog, and can be cancelled', async () => {
  await page.getByRole('button', { name: 'Open Settings' }).click()
  const toggle = page.getByRole('switch', { name: 'Send amounts, dates and names to Anthropic' })
  await expect(toggle).not.toBeChecked()
  await toggle.click()
  const dialog = page.getByRole('dialog', { name: 'Send your money details to Anthropic?' })
  await expect(dialog).toContainText('exact amounts, dates, account names and the names of people you pay')
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(toggle).not.toBeChecked()

  await toggle.click()
  await page.getByRole('button', { name: 'Allow for Ask Ordo' }).click()
  await expect(toggle).toBeChecked()
  await expect(
    page.getByText('and, for Ask Ordo, exact amounts, dates and names', { exact: false }),
  ).toBeVisible()
  const settings = await page.evaluate(() => window.ordo.settings.get())
  expect(settings.ai.moneyDetailsConsent).toBe('claude-cli')

  await nav('Ask Ordo').click()
  await expect(page.getByRole('textbox', { name: 'Ask about your money' })).toBeEnabled()
})

test('switching provider drops the consent', async () => {
  await nav('Settings').click()
  await page.getByRole('radio', { name: 'LM Studio' }).check()
  const settings = await page.evaluate(() => window.ordo.settings.get())
  expect(settings.ai).toMatchObject({ provider: 'lmstudio', cloudConsent: null, moneyDetailsConsent: null })
})
