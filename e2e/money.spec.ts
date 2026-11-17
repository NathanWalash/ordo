import { resolve } from 'node:path'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'

const STATEMENT = resolve('packages/money-core/src/fixtures/monzo.csv')
const shots = process.env['ORDO_SCREENSHOTS'] === '1'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  app = await launchApp()
  page = await app.firstWindow()
  // Stand in for the native open dialog: it can't be driven from a test.
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [path],
    })) as typeof dialog.showOpenDialog
  }, STATEMENT)
})

test.afterAll(async () => {
  await app.close()
})

/** With ORDO_SCREENSHOTS=1, save light and dark screenshots to test-results/ for review. */
async function shoot(name: string) {
  if (!shots) return
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.screenshot({ path: `test-results/money-${name}-${scheme}.png` })
  }
  await page.emulateMedia({ colorScheme: null })
}

const nav = (name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true })

test('Money lives in the sidebar with Finances and Bills', async () => {
  await expect(nav('Finances')).toBeVisible()
  await expect(nav('Bills & Subscriptions')).toBeVisible()
  await nav('Finances').click()
  await expect(page.getByRole('heading', { level: 1, name: 'Finances' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Import a bank statement' })).toBeVisible()
  await expect(page.getByText('Your statements stay on this computer.')).toBeVisible()
  await shoot('finances-empty')
})

test('imports a statement and lists its transactions', async () => {
  await page.getByRole('button', { name: 'Import statement' }).click()
  const sheet = page.getByRole('dialog', { name: 'Import statement' })
  await expect(sheet.getByText('Recognised as a Monzo export')).toBeVisible()
  await expect(sheet.getByText(/24 transactions from 28 Jul 2026 to 15 Nov 2026/)).toBeVisible()
  await expect(sheet.getByLabel('Account name')).toHaveValue('Monzo')
  await sheet.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(sheet).toBeHidden()

  await expect(page.getByText('Imported 24 transactions into Monzo.')).toBeVisible()
  const table = page.getByRole('table', { name: 'Transactions' })
  await expect(table.getByRole('row', { name: /Netflix/ })).toHaveCount(4)
  await expect(table.getByRole('row').filter({ hasText: 'Acme Ltd' }).first()).toContainText('+£2,450.00')
  await shoot('finances')

  // Importing the same file again adds nothing.
  await page.getByRole('button', { name: 'Import statement' }).click()
  await page
    .getByRole('dialog', { name: 'Import statement' })
    .getByRole('button', { name: 'Import', exact: true })
    .click()
  await expect(page.getByText('Imported 0 transactions into Monzo. 24 were already here')).toBeVisible()
})

test('detected subscriptions can be confirmed', async () => {
  await nav('Bills & Subscriptions').click()
  const review = page.getByRole('list', { name: 'Detected bills' })
  await expect(review.getByText('Netflix', { exact: true })).toBeVisible()
  await expect(review.getByText('Spotify', { exact: true })).toBeVisible()
  await expect(review.getByText('Price went up')).toBeVisible()

  await page.getByRole('button', { name: 'Confirm Netflix' }).click()
  await expect(review.getByText('Netflix', { exact: true })).toHaveCount(0)
  const bills = page.getByRole('table', { name: 'Bills' })
  await expect(bills.getByRole('row', { name: /Netflix/ })).toContainText('£10.99')
  await expect(bills.getByRole('row', { name: /Netflix/ })).toContainText('Bank')
  await expect(page.getByRole('heading', { name: '£10.99 a month' })).toBeVisible()

  await page.getByRole('button', { name: 'Dismiss Thames Water' }).click()
  await expect(review.getByText('Thames Water')).toHaveCount(0)
})

test('splits a bill with a flatmate and settles up', async () => {
  await page.getByLabel('Flatmate name').fill('Sam')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.getByRole('list', { name: 'Flatmates' }).getByText('Sam')).toBeVisible()

  await page.getByRole('table', { name: 'Bills' }).getByRole('button', { name: 'Netflix' }).click()
  const sheet = page.getByRole('dialog', { name: 'Netflix' })
  await sheet.getByLabel('Split this bill').check()
  await expect(sheet.getByLabel('Include Sam')).toBeChecked()
  await expect(sheet.getByLabel('Include Me')).toBeChecked()
  // £10.99 between two: the payer (me) keeps the odd penny.
  await expect(sheet.getByRole('listitem').filter({ hasText: 'Sam' })).toContainText('£5.49')
  await expect(sheet.getByRole('listitem').filter({ hasText: 'Me' })).toContainText('£5.50')
  await shoot('split-sheet')
  await sheet.getByRole('button', { name: 'Save' }).click()
  await expect(sheet).toBeHidden()

  const balances = page.getByRole('list', { name: 'Balances' })
  await expect(balances).toContainText('Sam owes you £5.49')
  await expect(page.getByRole('table', { name: 'Bills' })).toContainText('Split with Sam · your share £5.50')
  await shoot('bills')

  await balances.getByRole('button', { name: 'Settle up' }).click()
  const settle = page.getByRole('dialog', { name: 'Settle up' })
  await expect(settle.getByLabel('Amount paid (£)')).toHaveValue('5.49')
  await shoot('settle-sheet')
  await settle.getByRole('button', { name: 'Record payment' }).click()
  await expect(settle).toBeHidden()
  await expect(page.getByText('All settled up.')).toBeVisible()
  await expect(page.getByText('Sam paid you £5.49')).toBeVisible()
})

test('adds a manual bill', async () => {
  await page.getByRole('button', { name: 'Add bill' }).click()
  const sheet = page.getByRole('dialog', { name: 'Add a bill' })
  await sheet.getByLabel('Name').fill('Rent')
  await sheet.getByLabel('Amount (£)').fill('1450')
  await sheet.getByLabel('Next due').fill('2030-01-01')
  await sheet.getByRole('button', { name: 'Add bill' }).click()
  await expect(sheet).toBeHidden()
  const row = page.getByRole('table', { name: 'Bills' }).getByRole('row', { name: /Rent/ })
  await expect(row).toContainText('£1,450.00')
  await expect(row).toContainText('Manual')
})
