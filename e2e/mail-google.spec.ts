import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { startFakeGoogle, type FakeGoogle } from '../test/fake-google'
import { startFakeXoauth2Mail, type FakeXoauth2Mail } from '../test/fake-xoauth2'
import { launchApp } from './launch'

// Gmail with Sign in with Google, end to end: a fake Google on 127.0.0.1 (the unpackaged app
// follows its consent page itself, so no browser opens) and a fake Gmail that signs in only with
// SASL XOAUTH2. No real Google account, no real Gmail, no iCloud.

let google: FakeGoogle
let gmail: FakeXoauth2Mail
let app: ElectronApplication
let page: Page

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  google = await startFakeGoogle()
  gmail = await startFakeXoauth2Mail((user, token) => {
    const t = google.accessTokens.get(token)
    return !!t && t.scope.split(' ').includes('https://mail.google.com/') && t.account.email === user
  })
  app = await launchApp({
    ORDO_GOOGLE_BASE_URL: google.base,
    ORDO_TEST_GOOGLE_AUTO_CONSENT: '1',
    ORDO_IMAP_HOST: '127.0.0.1',
    ORDO_IMAP_PORT: String(gmail.imapPort),
    ORDO_SMTP_HOST: '127.0.0.1',
    ORDO_SMTP_PORT: String(gmail.smtpPort),
  })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app.close()
  await gmail.stop()
  await google.stop()
})

const accounts = () => page.getByRole('region', { name: 'Accounts' })
const googleSection = () => page.getByRole('region', { name: 'Google' })
const sheet = () => page.getByRole('dialog', { name: 'Add a mail account' })

test('Gmail offers Sign in with Google, and says to set up the OAuth client first', async () => {
  await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click()
  await accounts().getByRole('button', { name: 'Add account…' }).click()
  await expect(sheet().getByRole('radio', { name: /Sign in with Google/ })).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(sheet().getByRole('button', { name: 'Sign in with Google' })).toBeDisabled()
  await sheet().getByRole('button', { name: 'Set up in Settings → Google' }).click()
  await expect(sheet()).toBeHidden()
  await googleSection().getByLabel('Client ID').fill(google.clientId)
  await googleSection().getByLabel('Client secret').fill(google.clientSecret)
  await googleSection().getByRole('button', { name: 'Save client' }).click()
  await expect(googleSection().getByText(google.clientId)).toBeVisible()
})

test('adds the Gmail account with a Google sign-in, signing in to Gmail with XOAUTH2', async () => {
  await accounts().getByRole('button', { name: 'Add account…' }).click()
  await expect(sheet().getByRole('radio', { name: /Choose in your browser/ })).toBeVisible()
  await sheet().getByLabel('Name (optional)').fill('Work')
  await sheet().getByRole('button', { name: 'Sign in with Google' }).click()
  await expect(sheet()).toBeHidden()
  const list = accounts().getByRole('list', { name: 'Mail accounts' })
  await expect(list.getByText('Work', { exact: true })).toBeVisible()
  await expect(list.getByText(`${google.account.email} · Gmail (Google sign-in)`)).toBeVisible()
  expect(gmail.attempts.some((a) => a.protocol === 'imap' && a.ok && a.user === google.account.email)).toBe(
    true,
  )
  // Settings → Google shows the sign-in as Mail's, with Calendar not connected.
  await expect(googleSection().getByText('Calendar isn’t connected. Mail: Work.')).toBeVisible()
  await expect(googleSection().getByRole('button', { name: 'Add Calendar' })).toBeVisible()
})

test('offers Sign in again when Google stops accepting the sign-in', async () => {
  // Revoked at Google: refresh tokens and access tokens stop working.
  google.refreshTokens.clear()
  google.expireAccessTokens()
  await page.getByRole('navigation').getByRole('button', { name: 'Mail' }).click()
  await page.getByRole('button', { name: 'Check for new mail' }).click()
  await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click()
  const again = accounts().getByRole('button', { name: 'Sign in to Work again' })
  await expect(again).toBeVisible()
  await expect(accounts().getByText(/Google stopped accepting Ordo’s sign-in/)).toBeVisible()
  await again.click()
  await expect(again).toBeHidden()
  await expect(accounts().getByText(/Google stopped accepting/)).toBeHidden()
})

test('signing out of Google asks first, then removes the mail account too', async () => {
  await googleSection().getByRole('button', { name: 'Sign out' }).click()
  const confirm = page.getByRole('dialog', { name: `Sign out of ${google.account.email}?` })
  await expect(confirm.getByText(`Work (${google.account.email})`)).toBeVisible()
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(accounts().getByText('Work', { exact: true })).toBeVisible()
  await googleSection().getByRole('button', { name: 'Sign out' }).click()
  await confirm.getByRole('button', { name: 'Sign out and remove it' }).click()
  await expect(googleSection().getByText(google.account.email)).toBeHidden()
  await expect(page.getByRole('list', { name: 'Mail accounts' })).toBeHidden()
  expect(google.revoked.length).toBe(1)
})
