import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchApp } from './launch'

// Made-up statements from two banks: Gabe's rent share passed on to Patrick, a resold ticket,
// Halloween paid back through Splitwise, an Italy trip and Ryanair flights shared with Amelie.
const MONZO = resolve('e2e/fixtures/memory-monzo.csv')
const HSBC = resolve('e2e/fixtures/memory-hsbc.csv')
const shots = process.env['ORDO_SCREENSHOTS'] === '1'

// Stand-in for LM Studio. Ask Ordo's tool loop: look up Italy, then Luca, then answer with
// placeholders and suggest remembering Luca's payback. It never does a sum itself.
let lmStudio: Server
const prompts: string[] = []

/** The JSON inside `<result id="rN" …>` blocks, in order. */
const results = (prompt: string) =>
  [...prompt.matchAll(/<result id="r\d+" tool="[a-z_]+">\n(.*)\n<\/result>/g)].map(
    (m) => JSON.parse(m[1]!) as Record<string, unknown>,
  )

function reply(content: unknown) {
  return JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }] })
}

function askScript(prompt: string): unknown {
  const r = results(prompt)
  if (r.length === 0) return { type: 'call', tool: 'event_cost', args: { name: 'Italy' } }
  if (r.length === 1) return { type: 'call', tool: 'find_transactions', args: { text: 'Luca' } }
  const event = r[0]!
  const luca = (r[1]!['items'] as { id: string }[])[0]!
  return {
    type: 'answer',
    text: 'Italy cost you {{r1.netPence}} so far. Luca paid you {{r2.items.0.amountPence}} on {{r2.items.0.date}}.',
    proposals: [
      {
        label: 'Luca paid you back for Italy',
        fact: { kind: 'payback', inId: luca.id, eventId: event['id'], person: 'Luca B' },
      },
    ],
  }
}

function startFakeLmStudio(): Promise<string> {
  lmStudio = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'openai/gpt-oss-20b' }] }))
      if (req.url === '/v1/chat/completions') {
        const prompt: string = JSON.parse(body).messages.at(-1).content
        prompts.push(prompt)
        return res.end(reply(askScript(prompt)))
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  return new Promise((resolve) =>
    lmStudio.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(lmStudio.address() as AddressInfo).port}`),
    ),
  )
}

test.describe.configure({ mode: 'serial' })

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const userData = mkdtempSync(join(tmpdir(), 'ordo-e2e-memory-'))
  writeFileSync(
    join(userData, 'settings.json'),
    JSON.stringify({
      theme: 'light',
      ai: {
        provider: 'lmstudio',
        model: 'openai/gpt-oss-20b',
        sortSenders: false,
        money: false,
        cloudConsent: null,
      },
    }),
  )
  app = await launchApp({ ORDO_USER_DATA: userData, ORDO_LMSTUDIO_URL: await startFakeLmStudio() })
  page = await app.firstWindow()
})

test.afterAll(async () => {
  await app?.close()
  lmStudio?.close()
})

const nav = (name: string) => page.getByRole('navigation').getByRole('button', { name, exact: true })
const questions = () => page.getByRole('list', { name: 'Questions for you' })
const looseEnds = () => page.getByRole('list', { name: 'Loose ends' })
const knows = () => page.getByRole('list', { name: 'What Ordo knows' })

async function importAs(path: string, account: string) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [file],
    })) as typeof dialog.showOpenDialog
  }, path)
  await page.getByRole('button', { name: 'Import statement' }).click()
  const sheet = page.getByRole('dialog', { name: 'Import statement' })
  await sheet.getByLabel('Account name').fill(account)
  await sheet.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(sheet).toBeHidden()
}

async function shoot(name: string) {
  if (!shots) return
  await page.screenshot({ path: `test-results/money-memory-${name}-light.png` })
  await page.evaluate(() => window.ordo.settings.set({ theme: 'dark' }))
  await page.waitForTimeout(300)
  await page.screenshot({ path: `test-results/money-memory-${name}-dark.png` })
  await page.evaluate(() => window.ordo.settings.set({ theme: 'light' }))
  await page.waitForTimeout(300)
}

test('Ask Ordo asks for a statement first', async () => {
  await nav('Ask Ordo').click()
  await expect(page.getByRole('heading', { name: 'Ask about your money' })).toBeVisible()
  await page.getByRole('button', { name: 'Import a statement' }).click()
  await expect(page.getByRole('button', { name: 'Import statement' })).toBeVisible()
})

test('imports two banks, then Ordo asks about Gabe’s regular money', async () => {
  await importAs(MONZO, 'Monzo')
  await importAs(HSBC, 'HSBC')
  await nav('Ask Ordo').click()
  const gabe = questions().getByRole('listitem', { name: /Gabe S pays you about £298\.50 a month/ })
  await expect(gabe).toContainText(
    "you pay Patrick O about £597.00 a month. Is Gabe S's money for Patrick O?",
  )
  await expect(questions().getByRole('listitem', { name: /H Bennie's £50\.00 on 5 Oct/ })).toBeVisible()
  // Ryanair didn't split evenly and nothing says it's a payback, so Amelie's "about half" is only
  // one to check.
  await expect(
    questions()
      .getByRole('listitem', { name: /Amelie R's £148\.80/ })
      .getByText('To check'),
  ).toBeVisible()
  // How each bank dates payments.
  await expect(page.getByText('HSBC shows the day a payment cleared', { exact: false }).first()).toBeVisible()
  await shoot('questions')
  // Listing never asks the model.
  expect(prompts).toHaveLength(0)

  await gabe.getByRole('button', { name: 'Yes, I pass it on' }).click()
  await expect(gabe).toBeHidden()
  await expect(looseEnds()).toContainText('Holding for Patrick O£298.50')
  await expect(looseEnds()).toContainText('From Gabe S, last paid in on 1 Nov · not passed on yet')
  await expect(knows()).toContainText('Money from Gabe S is held for Patrick O, not your income.')
})

test('pass-throughs and paybacks become facts with one tap', async () => {
  await questions()
    .getByRole('listitem', { name: /H Bennie's £50\.00/ })
    .getByRole('button', { name: 'Yes, passing through' })
    .click()
  await expect(knows()).toContainText(
    'H Bennie £50.00 on 5 Oct passed straight through to Sam Seller £50.00 on 5 Oct.',
  )
  const genest = questions().getByRole('listitem', { name: /Genest J's £30\.00/ })
  await expect(genest).toContainText('half of 2 payments totalling £60.00')
  await genest.getByRole('button', { name: 'Yes, a payback' }).click()
  await expect(knows()).toContainText('Genest J £30.00 on 2 Nov paid you back for')
  await questions()
    .getByRole('listitem', { name: /Amelie R's £148\.80/ })
    .getByRole('button', { name: 'No' })
    .click()
  await expect(questions().getByRole('listitem', { name: /Amelie R/ })).toBeHidden()
})

test('an event across both banks: Italy, leaving out Ryanair', async () => {
  await page.getByRole('button', { name: 'Add event' }).click()
  const sheet = page.getByRole('dialog', { name: 'Add an event or trip' })
  await sheet.getByLabel('Name').fill('Italy')
  await sheet.getByLabel('From').fill('2026-08-28')
  await sheet.getByLabel('To').fill('2026-09-04')
  await sheet.getByLabel('Leave out').fill('Ryanair')
  await sheet.getByRole('button', { name: 'Add event' }).click()
  await expect(sheet).toBeHidden()
  const italy = page.getByRole('list', { name: 'Events and trips' }).getByRole('button', { name: /^Italy/ })
  // Trenitalia, Ristorante Roma, Gelateria Blu (Monzo) and Hotel Firenze (HSBC); not rent or Ryanair.
  await expect(italy).toContainText('£423.99 out')
  await italy.click()
  await expect(page.getByText('By account')).toBeVisible()
})

test('Ask Ordo answers with Ordo’s own numbers and suggests what to remember', async () => {
  const box = page.getByRole('textbox', { name: 'Ask about your money' })
  await box.fill('How much did Italy cost me?')
  await box.press('Enter')
  const answers = page.getByRole('list', { name: 'Answers' })
  await expect(answers).toContainText('Italy cost you £423.99 so far. Luca paid you £5.00 on 5 Sept.')
  await expect(answers).toContainText('Looked at: Worked out an event · Searched transactions')
  const suggestion = answers.getByRole('group', {
    name: /Suggestion: Luca B £5\.00 on 5 Sept paid you back for Italy\./,
  })
  await expect(suggestion).toBeVisible()
  // Three requests: two tool calls, then the answer. Results went back to the model as data blocks.
  expect(prompts).toHaveLength(3)
  expect(prompts[2]).toContain('<result id="r1" tool="event_cost">')
  expect(prompts[0]).toContain('<question>"How much did Italy cost me?"</question>')
  await shoot('ask')

  await suggestion.getByRole('button', { name: 'Save' }).click()
  await expect(suggestion).toContainText('Saved')
  const italy = page.getByRole('list', { name: 'Events and trips' }).getByRole('button', { name: /^Italy/ })
  await expect(italy).toContainText('£5.00 back')
  await expect(italy).toContainText('£418.99')
})

test('the held rent proposes a shared bill with a split, saved when you confirm it', async () => {
  await nav('Bills & Subscriptions').click()
  const row = page
    .getByRole('list', { name: 'Detected bills' })
    .getByRole('listitem')
    .filter({ hasText: 'Patrick O' })
  await expect(row).toContainText('Split: you £298.50 · Gabe S £298.50')
  await shoot('bills')
  await page.getByRole('button', { name: 'Confirm Patrick O' }).click()
  const bill = page.getByRole('table', { name: 'Bills' }).getByRole('row', { name: /Patrick O/ })
  await expect(bill).toContainText('Split with Gabe S · your share £298.50')
  // Gabe's November payment is already with you for Patrick: Bills doesn't say he still owes it.
  await expect(page.getByText('All settled up.')).toBeVisible()
  await nav('Ask Ordo').click()
  await expect(looseEnds()).toContainText('Holding for Patrick O£298.50')
  await expect(looseEnds()).not.toContainText('Gabe S owes you')
})

test('Teach Ordo walks through accounts and keeps a note; anything can be forgotten', async () => {
  await nav('Ask Ordo').click()
  await page.getByRole('button', { name: 'Teach Ordo' }).click()
  const sheet = page.getByRole('dialog', { name: 'Teach Ordo about your money' })
  await expect(sheet).toContainText('Step 1 of 5: Your accounts')
  await sheet.getByRole('combobox', { name: 'How HSBC dates payments' }).selectOption('transaction')
  await expect(sheet).toContainText('HSBC shows the day you actually paid.')
  await shoot('teach')
  for (let i = 0; i < 4; i++) await sheet.getByRole('button', { name: 'Next' }).click()
  await expect(sheet).toContainText('Step 5 of 5: Anything else')
  await sheet.getByLabel('Note for Ordo').fill('HSBC is my bills account.')
  await sheet.getByRole('button', { name: 'Done' }).click()
  await expect(sheet).toBeHidden()
  await expect(knows()).toContainText('HSBC is my bills account.')
  await expect(knows()).toContainText('HSBC shows the day you paid.')
  await shoot('page')

  await knows().getByRole('button', { name: 'Forget: HSBC is my bills account.' }).click()
  await expect(knows()).not.toContainText('HSBC is my bills account.')
})

test('forgetting an event asks first, and keeps the paybacks for it', async () => {
  const events = page.getByRole('list', { name: 'Events and trips' })
  const italy = events.getByRole('button', { name: /^Italy/ })
  if ((await italy.getAttribute('aria-expanded')) !== 'true') await italy.click()
  await events.getByRole('button', { name: 'Forget Italy' }).click()
  const confirm = events.getByRole('group', { name: 'Forget Italy?' })
  await expect(confirm).toContainText('Paybacks and money owed for it are kept')
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(italy).toBeVisible()

  await events.getByRole('button', { name: 'Forget Italy' }).click()
  await events.getByRole('group', { name: 'Forget Italy?' }).getByRole('button', { name: 'Forget' }).click()
  await expect(
    page.getByText('Forgot Italy. 1 payback for it is kept, now linked to its payments.'),
  ).toBeVisible()
  await expect(italy).toBeHidden()
  await expect(knows()).toContainText('Luca B £5.00 on 5 Sept paid you back for Trenitalia')
})

test('Settings → AI has the Ask Ordo choices, and a local model needs no extra consent', async () => {
  await nav('Settings').click()
  await expect(page.getByRole('radiogroup', { name: 'Ask Ordo answers' })).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Let Ask Ordo ask me back' })).toBeChecked()
  await expect(page.getByRole('switch', { name: /Send amounts, dates and names/ })).toHaveCount(0)
})
