import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  app = await launchApp()
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
})

const title = () => page.getByTestId('calendar-title')
const view = (name: string) =>
  page.getByRole('radiogroup', { name: 'Calendar view' }).getByRole('radio', { name })

test('Calendar opens from the sidebar with a sample preview', async () => {
  await page.getByRole('navigation').getByRole('button', { name: 'Calendar' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Calendar' })).toBeVisible()
  await expect(page.getByText('Sample data. Connect your iCloud account')).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'Show Work' })).toBeChecked()

  // Narrow windows (CI runners' small screens) show the short month, "Nov 2026"; it's in the long one too.
  const thisMonth = new Date().toLocaleDateString(undefined, { month: 'short' })
  await expect(title()).toContainText(thisMonth)
  await expect(view('Month')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByRole('grid', { name: 'Month' })).toBeVisible()
  await expect(page.locator('[aria-current="date"]')).toHaveCount(1)
})

test('switches between Month, Week and Agenda', async () => {
  await view('Week').click()
  await expect(view('Week')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByText('all-day')).toBeVisible()
  await expect(page.getByRole('button', { name: /Design review/ })).toBeVisible()

  await view('Agenda').click()
  await expect(page.getByLabel('Agenda')).toBeVisible()
  await expect(page.getByRole('heading', { level: 3, name: /Today/ })).toBeVisible()

  await view('Month').click()
  await expect(page.getByRole('grid', { name: 'Month' })).toBeVisible()
})

test('previous, next and Today change the visible range', async () => {
  const start = await title().textContent()
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(title()).not.toHaveText(start!)
  const next = await title().textContent()
  await page.getByRole('button', { name: 'Previous' }).click()
  await page.getByRole('button', { name: 'Previous' }).click()
  await expect(title()).not.toHaveText(start!)
  await expect(title()).not.toHaveText(next!)
  await page.getByRole('button', { name: 'Today' }).click()
  await expect(title()).toHaveText(start!)
  await expect(page.locator('[aria-current="date"]')).toHaveCount(1)
})

test('shows event details and hides a calendar when unchecked', async () => {
  await view('Week').click()
  await page.getByRole('button', { name: /Design review/ }).click()
  const popover = page.getByRole('dialog', { name: 'Design review' })
  await expect(popover).toBeVisible()
  await expect(popover.getByText('Room 4')).toBeVisible()
  await expect(popover.getByText('Work', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(popover).toBeHidden()

  await page.getByRole('checkbox', { name: 'Show Work' }).uncheck()
  await expect(page.getByRole('button', { name: /Design review/ })).toHaveCount(0)
  await page.getByRole('checkbox', { name: 'Show Work' }).check()
  await expect(page.getByRole('button', { name: /Design review/ })).toBeVisible()
})

test('Connect iCloud opens the shared connect sheet', async () => {
  await page.getByRole('button', { name: 'Connect iCloud' }).click()
  await expect(page.getByRole('dialog', { name: 'Connect iCloud Mail' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { level: 1, name: 'Calendar' })).toBeVisible()
})
