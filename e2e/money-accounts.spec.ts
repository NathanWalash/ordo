import { resolve } from 'node:path'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'

// Made-up statements in the layouts real banks export.
const HSBC = resolve('packages/money-core/src/fixtures/hsbc.csv')
const MONZO_SEARCH = resolve('packages/money-core/src/fixtures/monzo-search.csv')

test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  app = await launchApp()
  page = await app.firstWindow()
  await page.getByRole('navigation').getByRole('button', { name: 'Finances', exact: true }).click()
})

test.afterAll(async () => {
  await app.close()
})

/** The native open dialog can't be driven from a test: hand it this file. */
async function pick(path: string) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [file],
    })) as typeof dialog.showOpenDialog
  }, path)
}

async function importAs(path: string, layout: string, account: string) {
  await pick(path)
  await page.getByRole('button', { name: 'Import statement' }).click()
  const sheet = page.getByRole('dialog', { name: 'Import statement' })
  await expect(sheet.getByText(`Recognised as a ${layout} export`)).toBeVisible()
  await sheet.getByLabel('Account name').fill(account)
  await sheet.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(sheet).toBeHidden()
}

test("imports HSBC's headerless export and the Monzo app's search export as two accounts", async () => {
  await importAs(HSBC, 'HSBC', 'HSBC current')
  await expect(page.getByText('Imported 10 transactions into HSBC current.')).toBeVisible()
  await importAs(MONZO_SEARCH, 'Monzo', 'Monzo')
  await expect(page.getByText('Imported 6 transactions into Monzo.')).toBeVisible()

  const table = page.getByRole('table', { name: 'Transactions' })
  await expect(table.getByRole('row').filter({ hasText: 'City Council' })).toContainText('Bills')
  await expect(table.getByRole('row').filter({ hasText: 'Non-Sterling' })).toContainText('Fees')
})

test('a transfer between your own accounts is paired and left out of All accounts totals', async () => {
  const table = page.getByRole('table', { name: 'Transactions' })
  await expect(table.getByText('to your Monzo account')).toBeVisible()
  await expect(table.getByText('from your HSBC current account')).toBeVisible()

  // All accounts: the £30 moved from HSBC to Monzo is neither money in nor money out.
  const moneyIn = page.getByText('Money in', { exact: true }).locator('..')
  await expect(moneyIn).toContainText('£2,166.44')

  // One account: the £30 still left HSBC.
  await page.getByRole('combobox').first().selectOption('HSBC current')
  await expect(table.getByText('to your Monzo account')).toBeVisible()
  await expect(page.getByText('Money out', { exact: true }).locator('..')).toContainText('£870.46')
})
