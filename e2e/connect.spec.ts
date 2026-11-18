import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { imapPort, seedMailbox, TEST_ACCOUNT } from './imap'
import { launchApp } from './launch'

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  if (imapPort) await seedMailbox()
  app = await launchApp(imapPort ? { ORDO_IMAP_HOST: '127.0.0.1', ORDO_IMAP_PORT: imapPort } : {})
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
})

const sheet = () => page.getByRole('dialog', { name: 'Connect iCloud Mail' })

test('the connect sheet checks what you type', async () => {
  await page.getByRole('navigation').getByRole('button', { name: 'Inbox' }).click()
  await page.getByRole('button', { name: 'Connect iCloud' }).click()
  await expect(sheet()).toBeVisible()
  await expect(page.getByLabel('Apple ID email')).toBeFocused()

  await sheet().getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(sheet().getByText('Enter the email address you use for iCloud Mail.')).toBeVisible()
  await expect(sheet().getByText('App-specific passwords look like abcd-efgh-ijkl-mnop.')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(sheet()).toBeHidden()
})

test('connects, scans and lists real senders', async () => {
  test.skip(!imapPort, 'Set IMAP_TEST_PORT and run `pnpm imap:start` to test against a local IMAP server')

  await page.getByRole('button', { name: 'Connect iCloud' }).click()
  await page.getByLabel('Apple ID email').fill(TEST_ACCOUNT.email)
  await page.getByLabel('App-specific password').fill('wron-gpas-swor-dzzz')
  await sheet().getByRole('button', { name: 'Test connection' }).click()
  await expect(sheet().getByRole('status')).toContainText("iCloud didn't accept")

  await page.getByLabel('App-specific password').fill(TEST_ACCOUNT.password)
  await sheet().getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(sheet()).toBeHidden()

  // Connecting takes you to Unclutter, ready to scan.
  await expect(page.getByRole('heading', { level: 1, name: 'Unclutter' })).toBeVisible()
  await page.getByRole('button', { name: 'Scan inbox' }).click()
  await expect(page.getByRole('heading', { name: /emails from \d+ senders/ })).toBeVisible({
    timeout: 15_000,
  })

  await expect(page.getByRole('checkbox', { name: 'Select Daily Digest' })).toBeEnabled()
  await expect(page.getByRole('checkbox', { name: 'Select Sam' })).toBeDisabled()
  await expect(page.getByText("Someone you've written to.").first()).toBeVisible()
})

test('an unreachable mail server says so, with a next step', async () => {
  // Port 9 (discard) has nothing listening: the same as iCloud being unreachable.
  const offline = await launchApp({ ORDO_IMAP_HOST: '127.0.0.1', ORDO_IMAP_PORT: '9' })
  try {
    const win = await offline.firstWindow()
    await win.getByRole('navigation').getByRole('button', { name: 'Inbox' }).click()
    await win.getByRole('button', { name: 'Connect iCloud' }).click()
    await win.getByLabel('Apple ID email').fill('you@icloud.com')
    await win.getByLabel('App-specific password').fill('abcd-efgh-ijkl-mnop')
    const dialog = win.getByRole('dialog', { name: 'Connect iCloud Mail' })
    await dialog.getByRole('button', { name: 'Test connection' }).click()
    await expect(dialog.getByRole('status')).toContainText("Couldn't reach iCloud. Check you're online")
  } finally {
    await offline.close()
  }
})

test('disconnecting forgets the account', async () => {
  test.skip(!imapPort, 'Needs the connected account from the previous test')
  await page.getByRole('navigation').getByRole('button', { name: 'Inbox' }).click()
  await expect(page.getByRole('heading', { name: `Connected as ${TEST_ACCOUNT.email}` })).toBeVisible()
  await page.getByRole('button', { name: 'Disconnect' }).click()
  await expect(page.getByRole('heading', { name: 'Connect your iCloud account' })).toBeVisible()
})
