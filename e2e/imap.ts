import { ImapFlow } from 'imapflow'

export const imapPort = process.env['IMAP_TEST_PORT']
export const TEST_ACCOUNT = { email: 'test@ordo.test', password: 'abcd-efgh-ijkl-mnop' }

const msg = (from: string, to: string, subject: string, extra = '') =>
  `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: Mon, 16 Nov 2026 10:00:00 +0000\r\n${extra}\r\nHi\r\n`

/** Put a newsletter, a person and a reply to that person into the test mailbox. */
export async function seedMailbox() {
  const c = new ImapFlow({
    host: '127.0.0.1',
    port: Number(imapPort),
    secure: false,
    auth: { user: TEST_ACCOUNT.email, pass: TEST_ACCOUNT.password },
    logger: false,
  })
  await c.connect()
  if (!(await c.list()).some((b) => b.path === 'Sent')) await c.mailboxCreate('Sent')
  await c.append(
    'INBOX',
    msg(
      'Daily Digest <digest@news.example>',
      TEST_ACCOUNT.email,
      'Issue 1',
      'List-Id: <digest.news.example>\r\nList-Unsubscribe: <https://news.example/u>\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n',
    ),
  )
  await c.append('INBOX', msg('Sam <sam@friend.example>', TEST_ACCOUNT.email, 'Dinner?'))
  await c.append('Sent', msg(`Me <${TEST_ACCOUNT.email}>`, 'sam@friend.example', 'Re: Dinner?'))
  await c.logout()
}
