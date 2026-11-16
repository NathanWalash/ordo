import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  // Launches the built app (run `pnpm build` first; `pnpm test:e2e` does this).
  app = await electron.launch({ args: ['apps/desktop'] })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
})

test('opens on the home screen', async () => {
  await expect(page).toHaveTitle('Ordo')
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Mail/ })).toBeVisible()
})

test('Unclutter lets you pick senders but never people', async () => {
  await page.getByRole('navigation').getByRole('button', { name: 'Unclutter' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Unclutter' })).toBeVisible()
  await expect(page.getByText('Sample data.')).toBeVisible()

  await page.getByRole('checkbox', { name: 'Select Northwind Outlet' }).check()
  await expect(page.getByText(/1 senders, 642 emails/)).toBeVisible()

  await expect(page.getByRole('checkbox', { name: 'Select Sam Patel' })).toBeDisabled()
})

test('category filter narrows the sender list', async () => {
  await page.getByRole('button', { name: /^Newsletters/ }).click()
  await expect(page.getByText('The Morning Brief')).toBeVisible()
  await expect(page.getByText('Northwind Outlet')).toHaveCount(0)
})
