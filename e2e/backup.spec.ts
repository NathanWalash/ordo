import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'

// Backs up a throwaway profile into a temp folder standing in for a cloud folder, then opens the
// backup in the restore sheet and cancels (a confirmed restore relaunches the app, which the test
// can't follow). Synthetic data only; the restore itself is covered by the unit tests.
const folder = mkdtempSync(join(tmpdir(), 'ordo-e2e-backups-'))
const PASS = 'synthetic e2e passphrase'

let app: ElectronApplication
let page: Page

/** Stand in for the native open dialog (it can't be driven from a test): answer with `path`. */
async function nextDialog(path: string) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [p],
    })) as typeof dialog.showOpenDialog
  }, path)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  app = await launchApp()
  page = await app.firstWindow()
  await page.getByRole('navigation').getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { level: 2, name: 'Backup' })).toBeVisible()
  // Saves settings.json, so the backup has something of ours in it.
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Dark' }).click()
})

test.afterAll(async () => {
  await app.close()
})

const section = () => page.getByRole('region', { name: 'Backup' })

test('sets up a folder and a passphrase', async () => {
  await expect(section().getByText('Passwords aren’t backed up')).toBeVisible()
  await expect(section().getByRole('button', { name: 'Back Up Now' })).toBeDisabled()

  await nextDialog(folder)
  await section().getByRole('button', { name: 'Choose…' }).click()
  await expect(section().getByText(folder)).toBeVisible()

  await section().getByRole('button', { name: 'Set passphrase…' }).click()
  const sheet = page.getByRole('dialog', { name: 'Set a backup passphrase' })
  await sheet.getByLabel('Passphrase', { exact: true }).fill(PASS)
  await sheet.getByLabel('Type it again').fill('something else entirely')
  await sheet.getByRole('button', { name: 'Save' }).click()
  await expect(sheet.getByRole('alert')).toHaveText('The two passphrases don’t match.')
  await sheet.getByLabel('Type it again').fill(PASS)
  await sheet.getByRole('button', { name: 'Save' }).click()
  await expect(sheet).toBeHidden()
  await expect(section().getByText('Set, and remembered in this computer’s keychain.')).toBeVisible()
})

test('Back Up Now writes one encrypted file into the folder', async () => {
  await section().getByRole('button', { name: 'Back Up Now' }).click()
  await expect(
    section()
      .getByRole('status')
      .filter({ hasText: /KB|MB|bytes/ }),
  ).toBeVisible({ timeout: 30_000 })
  const files = readdirSync(folder)
  expect(files).toHaveLength(1)
  expect(files[0]).toMatch(/^Ordo-backup-\d{4}-\d{2}-\d{2}-\d{4}\.ordobackup$/)
  expect(readFileSync(join(folder, files[0]!)).subarray(0, 8).toString()).toBe('ORDOBKUP')
})

test('changing the passphrase asks for the current one', async () => {
  await section().getByRole('button', { name: 'Change…' }).nth(1).click()
  const sheet = page.getByRole('dialog', { name: 'Change backup passphrase' })
  await sheet.getByLabel('Current passphrase').fill('not the current one')
  await sheet.getByLabel('New passphrase').fill('another synthetic passphrase')
  await sheet.getByLabel('Type it again').fill('another synthetic passphrase')
  await sheet.getByRole('button', { name: 'Save' }).click()
  await expect(sheet.getByRole('alert')).toHaveText('That isn’t your current passphrase.')
  await sheet.getByRole('button', { name: 'Cancel' }).click()
  await expect(sheet).toBeHidden()
})

test('the restore sheet opens the backup and previews it, changing nothing', async () => {
  const file = join(folder, readdirSync(folder)[0]!)
  await nextDialog(file)
  await section().getByRole('button', { name: 'Restore…' }).click()
  const sheet = page.getByRole('dialog', { name: 'Restore from a backup' })
  await sheet.getByRole('button', { name: 'Choose Backup…' }).click()

  await sheet.getByLabel('Backup passphrase').fill('wrong passphrase')
  await sheet.getByRole('button', { name: 'Open Backup' }).click()
  await expect(sheet.getByRole('alert')).toContainText('doesn’t open this backup')

  await sheet.getByLabel('Backup passphrase').fill(PASS)
  await sheet.getByRole('button', { name: 'Open Backup' }).click()
  await expect(sheet.getByText(/^Backup from /)).toBeVisible({ timeout: 30_000 })
  await expect(sheet.getByText('Settings: appearance and AI')).toBeVisible()
  await expect(sheet.getByText(/replaces all of Ordo’s data/)).toBeVisible()

  const restore = sheet.getByRole('button', { name: 'Restore and Restart' })
  await expect(restore).toBeDisabled()
  await sheet.getByLabel('Type “restore” to confirm').fill('restore')
  await expect(restore).toBeEnabled()

  await sheet.getByRole('button', { name: 'Cancel' }).click()
  await expect(sheet).toBeHidden()
})
