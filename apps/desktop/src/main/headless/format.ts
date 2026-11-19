import { printable } from '@ordo/mail-core'
import type { CommandName } from './args'
import type { CommandResult } from './commands'

/**
 * Human-readable output for the headless CLI. Names, subjects, URLs, merchants and event titles
 * come from other people's emails, statements and calendars, so every string is stripped of
 * control characters before it reaches a terminal (no escape sequences, no fake lines).
 */

// C0 and C1 control characters, DEL, bidi overrides/isolates and marks, zero-width characters,
// line and paragraph separators, and the byte order mark.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g

/** Like `UNSAFE`, but keeping tabs and line breaks: for multi-line text such as an answer. */
export const UNSAFE_KEEP_LINES =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g

export function clean(value: unknown, max = 80): string {
  const s = String(value ?? '').replace(UNSAFE, ' ')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

export function pounds(pence: number | null | undefined): string {
  if (pence === null || pence === undefined) return '?'
  const sign = pence < 0 ? '-' : ''
  return `${sign}£${(Math.abs(pence) / 100).toFixed(2)}`
}

/** The first eight characters of an id: enough to name a card in `boards move-card`. */
const shortId = (id: unknown) => clean(id, 40).slice(0, 8)

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const when = (iso: unknown) => (typeof iso === 'string' ? iso.replace('T', ' ').slice(0, 16) : 'never')
const pad = (n: number) => String(n).padStart(2, '0')
/** An instant as this computer's clock shows it, `YYYY-MM-DD HH:MM`, for event times. */
function localTime(iso: unknown): string {
  const d = typeof iso === 'string' ? new Date(iso) : null
  if (!d || Number.isNaN(d.getTime())) return when(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function table(rows: string[][]): string {
  if (!rows.length) return ''
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)))
  return rows
    .map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  '))
    .join('\n')
}

const more = (d: { total: number; offset: number; shown: number }, what: string) =>
  d.total > d.offset + d.shown
    ? `\n…and ${d.total - d.offset - d.shown} more ${what}. Use --limit to see more.`
    : ''

/** "2026-11-20 09:00 – 10:00 Europe/London, weekly" for a changed event. */
function describe(e: {
  allDay: boolean
  start: string
  end: string
  timeZone: string | null
  repeat: { frequency: string } | null
}): string {
  const span = e.allDay
    ? e.start === e.end
      ? `${e.start}, all day`
      : `${e.start} to ${e.end}, all day`
    : `${e.start.replace('T', ' ')} – ${e.end.slice(0, 10) === e.start.slice(0, 10) ? e.end.slice(11) : e.end.replace('T', ' ')}${e.timeZone ? ` ${clean(e.timeZone, 40)}` : ''}`
  return e.repeat ? `${span}, ${e.repeat.frequency}` : span
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the data shapes come from commands.ts */
const person = (a: any) => (a.name ? `${clean(a.name, 40)} <${clean(a.address, 60)}>` : clean(a.address, 60))

/** A message's text for a terminal: line breaks kept, every control and bidi character gone. */
const body = (text: string) => printable(text).replace(/[\t\v\f]/g, ' ')

function messageTable(messages: any[], withMailbox = false): string {
  return table([
    ['UID', 'DATE', '', 'FROM', 'SUBJECT'],
    ...messages.map((m: any) => [
      String(m.uid),
      when(m.date),
      (m.unread ? '●' : ' ') + (m.flagged ? '⚑' : ' '),
      clean(m.from.name ?? m.from.address, 30),
      clean(m.subject || '(no subject)', 70) + (withMailbox ? `  [${clean(m.mailbox, 30)}]` : ''),
    ]),
  ])
}

const FORMATTERS: { [K in CommandName]: (d: any) => string } = {
  status: (d) =>
    [
      `Ordo ${d.version}`,
      d.account.connected
        ? `Mail:      ${clean(d.account.email)} · ${plural(d.account.messages, 'email')} cached · last scan ${when(d.account.lastScan)}`
        : 'Mail:      not connected (connect an account in the Ordo app)',
      d.calendar.calendars !== undefined
        ? `Calendar:  ${plural(d.calendar.calendars, 'calendar')} · last sync ${when(d.calendar.lastSync)}`
        : 'Calendar:  not connected',
      `AI:        ${d.ai.provider === 'none' ? 'off' : `${d.ai.provider}${d.ai.model ? ` (${clean(d.ai.model)})` : ''}${d.ai.sortSenders ? ', sorting senders' : ''}${d.ai.money ? ', Money' : ''}`}`,
      `Senders:   ${d.counts.senders}  ·  Clean-ups: ${d.counts.cleanups}`,
      `Money:     ${plural(d.counts.transactions, 'transaction')} in ${plural(d.counts.accounts, 'account')} · ${plural(d.counts.bills, 'bill')}`,
      d.writeLock
        ? `Busy:      ${clean(d.writeLock.owner)} is ${clean(d.writeLock.task)} since ${when(d.writeLock.since)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n'),

  scan: (d) =>
    d.stopped
      ? `Scan stopped. ${plural(d.added, 'new email')}, ${d.total} cached.`
      : `Scanned the inbox: ${plural(d.added, 'new email')}, ${d.total} cached.`,

  senders: (d) =>
    d.total === 0
      ? d.category
        ? `No senders in ${d.category === 'uncategorised' ? 'Other' : d.category}.`
        : 'No senders. Run `scan` first.'
      : table([
          ['EMAILS', 'CATEGORY', 'UNSUBSCRIBE', 'SENDER'],
          ...d.senders.map((s: any) => [
            String(s.emails),
            s.category + (s.sortedBy === 'ai' ? '*' : ''),
            s.unsubscribe,
            `${clean(s.name ?? '', 40)} <${clean(s.address, 60)}>${s.protected ? '  (person: never cleared)' : ''}`,
          ]),
        ]) + more(d, 'senders'),

  'cleanup plan': (d) => {
    const lines = [
      d.senders.length
        ? `Dry run. Nothing has changed. Ordo would clear ${plural(d.summary.senders, 'sender')}: move ${plural(d.summary.emailsToTrash, 'email')} to Trash and unsubscribe from ${d.summary.unsubscribes}.`
        : 'Dry run. Nothing would change.',
    ]
    for (const s of d.senders) {
      lines.push(`  ${clean(s.name ?? s.address, 40)} <${clean(s.address, 60)}>`)
      if (s.trash) lines.push(`    move ${plural(s.emails, 'email')} to Trash`)
      const u = s.unsubscribe
      if (u?.kind === 'one-click') lines.push(`    unsubscribe with one click (POST ${clean(u.url, 100)})`)
      if (u?.kind === 'link') lines.push(`    open ${clean(u.url, 100)} in your browser to unsubscribe`)
      if (u?.kind === 'mailto')
        lines.push(`    send “${clean(u.subject, 60)}” to ${clean(u.to, 60)} to unsubscribe`)
    }
    for (const r of d.rejected) lines.push(`  Refused ${clean(r.address, 60)}: ${clean(r.reason, 120)}`)
    return lines.join('\n')
  },

  'cleanup run': (d) =>
    [
      `Clean-up ${d.cleanup.id} done. Moved ${plural(d.cleanup.moved, 'email')} to Trash.`,
      ...d.cleanup.senders.map(
        (s: any) =>
          `  ${clean(s.name ?? s.address, 40)} <${clean(s.address, 60)}>: moved ${s.moved}` +
          (s.unsubscribe ? `, unsubscribe ${s.unsubscribe.status}` : ''),
      ),
      ...d.rejected.map((r: any) => `  Refused ${clean(r.address, 60)}: ${clean(r.reason, 120)}`),
      d.cleanup.error ? `Stopped early: ${clean(d.cleanup.error, 200)}` : '',
      d.cleanup.canUndo ? `Undo with: undo ${d.cleanup.id} --allow-changes --confirm` : '',
    ]
      .filter(Boolean)
      .join('\n'),

  history: (d) =>
    d.total === 0
      ? 'No clean-ups yet.'
      : d.cleanups
          .map(
            (c: any) =>
              `#${c.id}  ${when(c.at)}  moved ${c.moved}` +
              (c.undoneAt ? `, undone (${c.restored ?? 0} restored)` : c.canUndo ? ', can undo' : '') +
              '\n' +
              c.senders
                .map((s: any) => `    ${clean(s.name ?? s.address, 40)} <${clean(s.address, 60)}>`)
                .join('\n'),
          )
          .join('\n') + more(d, 'clean-ups'),

  undo: (d) =>
    d.reason
      ? `Nothing restored (${d.reason}).`
      : `Moved ${plural(d.restored, 'email')} back to the inbox.` +
        (d.missing ? ` ${d.missing} couldn't be restored.` : ''),

  'mail mailboxes': (d) =>
    d.mailboxes.length === 0
      ? 'No mailboxes yet. Run `mail sync` first.'
      : table([
          ['UNREAD', 'MESSAGES', 'MAILBOX'],
          ...d.mailboxes.map((m: any) => [
            String(m.unread),
            String(m.messages),
            clean(m.path, 80) + (m.role && m.role !== 'inbox' ? `  (${m.role})` : ''),
          ]),
        ]),

  'mail sync': (d) =>
    `Checked ${clean(d.mailbox, 60)}: ${plural(d.added, 'new message')}` +
    (d.removed ? `, ${d.removed} gone` : '') +
    (d.changed ? `, ${d.changed} changed` : '') +
    '.',

  'mail list': (d) =>
    d.total === 0
      ? `No messages in ${clean(d.mailbox, 60)}. Run \`mail sync --mailbox ${clean(d.mailbox, 60)}\` to check.`
      : messageTable(d.messages) + more(d, 'messages'),

  'mail search': (d) =>
    d.messages.length === 0
      ? d.where === 'cache'
        ? 'Nothing found in downloaded mail. Add --server to search the server.'
        : 'Nothing found.'
      : messageTable(d.messages, d.where === 'cache' && !d.mailbox),

  'mail read': (d) =>
    [
      `From:    ${d.from ? person(d.from) : ''}`,
      `To:      ${d.to.map(person).join(', ')}`,
      d.cc.length ? `Cc:      ${d.cc.map(person).join(', ')}` : '',
      `Date:    ${when(d.date)}`,
      `Subject: ${clean(d.subject, 200)}`,
      d.attachments.length
        ? `Files:   ${d.attachments.map((a: any) => clean(a.filename, 60)).join(', ')}`
        : '',
      '',
      body(d.text),
      d.truncated ? '\n[The message is longer than this.]' : '',
    ]
      .filter((l, i) => l !== '' || i === 6)
      .join('\n'),

  'calendar sync': (d) =>
    `Synced ${plural(d.calendars, 'calendar')} (${d.fetched} fetched, ${d.skipped} unchanged): ${plural(d.events, 'event')}.` +
    (d.failed?.length
      ? ` Couldn't update ${d.failed.map((f: { name: string }) => clean(f.name, 40)).join(', ')}.`
      : ''),

  'calendar events': (d) =>
    d.total === 0
      ? `No events from ${d.from} to ${d.to}.`
      : table(
          d.events.map((e: any) => [
            e.allDay ? `${String(e.start).slice(0, 10)} all day` : localTime(e.start),
            clean(e.title, 60),
            e.calendar ? `(${clean(e.calendar, 30)})` : '',
          ]),
        ) + more(d, 'events'),

  'calendar list': (d) =>
    d.calendars.length === 0
      ? 'No calendars yet. Run `calendar sync` first.'
      : table(
          d.calendars.map((c: any) => [
            clean(c.name, 40),
            c.source === 'icloud' ? 'iCloud' : c.source === 'link' ? 'link' : 'file',
            c.readOnly ? 'read-only' : 'writable',
            c.visible ? '' : 'hidden',
          ]),
        ),

  'calendar add': (d) =>
    `Added “${clean(d.event.title, 60)}” to ${clean(d.calendar, 40)} (${describe(d.event)}).`,

  'calendar edit': (d) =>
    `Changed “${clean(d.event.title, 60)}”${d.scope === 'this' ? ' (this event only)' : ''}: ${describe(d.event)}.`,

  'calendar delete': (d) =>
    d.scope === 'this'
      ? `Deleted one occurrence of “${clean(d.title, 60)}”.`
      : `Deleted “${clean(d.title, 60)}”.`,

  'money bills': (d) =>
    d.bills.length === 0 && d.toReview.length === 0
      ? 'No bills yet. Import a statement first.'
      : [
          d.bills.length ? `Bills: ${pounds(d.monthlyTotalPence)} a month` : 'No confirmed bills yet.',
          table(
            d.bills.map((b: any) => [
              clean(b.name, 40),
              pounds(b.amountPence),
              b.cadence,
              b.status === 'active' ? `next ${b.nextDue}` : b.status,
            ]),
          ),
          d.toReview.length
            ? `Found ${plural(d.toReview.length, 'possible bill')}, to confirm in the app:\n` +
              table(
                d.toReview.map((b: any) => [
                  `  ${clean(b.name, 40)}`,
                  pounds(b.amountPence),
                  b.cadence,
                  b.nextDue ? `next ${b.nextDue}` : '',
                ]),
              )
            : '',
        ]
          .filter(Boolean)
          .join('\n'),

  'money transactions': (d) =>
    d.total === 0
      ? 'No transactions.'
      : [
          `In ${pounds(d.summary.moneyInPence)} · out ${pounds(d.summary.moneyOutPence)}`,
          table(
            d.transactions.map((t: any) => [
              t.date,
              pounds(t.amountPence),
              clean(t.merchant ?? t.description, 50),
              clean(t.category ?? '', 30) + (t.categorisedBy === 'ai' ? '*' : ''),
              clean(t.account, 30),
            ]),
          ),
          d.transactions.some((t: any) => t.categorisedBy === 'ai') ? '* categorised by AI' : '',
        ]
          .filter(Boolean)
          .join('\n') + more(d, 'transactions'),

  'money balances': (d) =>
    d.debts.length === 0
      ? 'Everyone is square.'
      : d.debts
          .map((x: any) => `${clean(x.from, 40)} owes ${clean(x.to, 40)} ${pounds(x.amountPence)}`)
          .join('\n'),

  'money import': (d) =>
    `Imported ${plural(d.added, 'transaction')} into ${clean(d.account, 60)}` +
    (d.duplicates ? ` (${d.duplicates} already there).` : '.'),

  'money sort': (d) =>
    (d.merchants === 0
      ? 'Nothing was left in Other.'
      : `Checked ${plural(d.checked, 'merchant')} of ${d.merchants} in Other: ${d.changed} categorised, ${d.cached} from earlier answers, ${d.failed} failed.`) +
    (d.billPairs ? ` Matched ${plural(d.billsMatched, 'bill')} to email, to confirm in the app.` : '') +
    (d.errors.length ? `\n${d.errors.map((e: string) => clean(e, 200)).join('\n')}` : ''),

  'money knows': (d) =>
    [
      d.facts.length
        ? table(d.facts.map((f: any) => [clean(f.id, 40), clean(f.kind, 14), clean(f.summary, 120)]))
        : 'Ordo hasn’t learned anything yet. Answer `money questions` or teach it in the app.',
      ...d.accounts.map((a: any) => clean(a.note, 160)),
    ]
      .filter(Boolean)
      .join('\n'),

  'money questions': (d) =>
    d.questions.length
      ? d.questions
          .map(
            (q: any) =>
              `${clean(q.text, 240)}\n  id: ${clean(q.id, 200)}\n  answers: ${q.answers
                .map((a: any) => `${clean(a.id, 40)} (${clean(a.label, 40)})`)
                .join(', ')}`,
          )
          .join('\n\n')
      : 'No questions right now.',

  'money loose-ends': (d) =>
    [
      ...d.held.map(
        (h: any) =>
          `Holding ${pounds(h.holdingPence)} of ${clean(h.from, 40)}'s money for ${clean(h.for, 40)}` +
          (h.holdingPence > 0 ? ' (not passed on yet)' : ''),
      ),
      ...d.owed
        .filter((o: any) => o.outstandingPence > 0)
        .map(
          (o: any) =>
            `${clean(o.person, 40)} owes you ${pounds(o.outstandingPence)}${o.note ? ` for ${clean(o.note, 60)}` : ''}`,
        ),
    ].join('\n') || 'No loose ends.',

  'money events': (d) =>
    d.events.length
      ? table([
          ['EVENT', 'PAID OUT', 'PAID BACK', 'NET'],
          ...d.events.map((e: any) => [
            clean(e.name, 40),
            pounds(e.paidOutPence),
            pounds(e.paidBackPence),
            pounds(e.netPence),
          ]),
        ])
      : 'No events yet. Add one in the app.',

  'money compare': (d) =>
    [
      `${d.category ? `${clean(d.category, 40)}: ` : ''}${pounds(d.thisMonth.netPence)} from ${d.thisMonth.from} to ${d.thisMonth.to}, ` +
        `against ${pounds(d.lastMonth.netPence)} from ${d.lastMonth.from} to ${d.lastMonth.to} ` +
        `(${d.differencePence > 0 ? `${pounds(d.differencePence)} more` : d.differencePence < 0 ? `${pounds(-d.differencePence)} less` : 'the same'}).`,
      ...d.caveats.map((c: string) => clean(c, 200)),
    ].join('\n'),

  'money answer': (d) => `Answered. Ordo saved ${plural(d.saved, 'fact')}.`,

  'money forget': () => 'Forgotten.',

  'ai status': (d) =>
    [
      `Using: ${d.settings.provider === 'none' ? 'nothing (AI is off)' : `${d.settings.provider}${d.settings.model ? ` (${clean(d.settings.model)})` : ''}`}`,
      table(
        d.providers.map((p: any) => [
          p.label,
          p.kind,
          p.available ? 'available' : 'not available',
          clean(p.detail, 60),
        ]),
      ),
    ].join('\n'),

  'ai sort': (d) =>
    `Checked ${plural(d.checked, 'sender')}: ${d.changed} sorted, ${d.cached} from earlier answers, ${d.failed} failed.` +
    (d.errors.length ? `\n${d.errors.map((e: string) => clean(e, 200)).join('\n')}` : ''),

  'boards list': (d) =>
    d.boards.length === 0
      ? 'No boards yet. Make one in the app, under Boards.'
      : table([
          ['CARDS', 'OVERDUE', 'ID', 'BOARD'],
          ...d.boards.map((b: any) => [String(b.cards), String(b.overdue), shortId(b.id), clean(b.name, 60)]),
        ]),

  'boards cards': (d) =>
    d.total === 0
      ? 'No cards.'
      : table([
          ['ID', 'COLUMN', 'DUE', 'CARD'],
          ...d.cards.map((c: any) => [
            shortId(c.id),
            clean(d.board ? c.column : `${c.board} › ${c.column}`, 40),
            c.due ? (c.start ? `${c.start}…${c.due}` : c.due) : '',
            clean(c.title, 60) +
              (c.labels.length ? `  [${c.labels.map((l: string) => clean(l, 20)).join(', ')}]` : '') +
              (c.checklist.total ? `  ${c.checklist.done}/${c.checklist.total}` : ''),
          ]),
        ]) + more(d, 'cards'),

  'boards add-card': (d) =>
    `Added “${clean(d.card.title, 60)}” to ${clean(d.card.board, 40)} › ${clean(d.card.column, 40)} (${shortId(d.card.id)}).`,

  'boards move-card': (d) =>
    `Moved “${clean(d.card.title, 60)}” to ${clean(d.card.board, 40)} › ${clean(d.card.column, 40)}.`,
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The text to print for a result: on stdout when it worked, on stderr when it didn't. */
export function formatHuman(name: CommandName, result: CommandResult): string {
  if (!result.ok) return `Error: ${clean(result.message, 500)}`
  return FORMATTERS[name](result.data)
}

/** The JSON document to print: the data, or `{ "error": { "code", "message" } }`. */
export function formatJson(result: CommandResult): string {
  return escapeForTerminal(
    JSON.stringify(
      result.ok ? result.data : { error: { code: result.code, message: result.message } },
      null,
      2,
    ),
  )
}

/** C1 controls, bidi marks, overrides and isolates, and the line and paragraph separators. */
const TERMINAL_UNSAFE = /[\u0080-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g

/**
 * JSON.stringify already escapes C0 controls; this escapes the rest of what a terminal would act
 * on (C1 controls like CSI, and bidi tricks) as \u sequences. Still the same JSON.
 */
export function escapeForTerminal(json: string): string {
  return json.replace(TERMINAL_UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

export const HELP = `Ordo, headless. Runs without a window, for scripts and AI agents.

Usage:
  ordo --headless <command> [options]
  ordo --headless --mcp [--allow-changes]      MCP server on stdio

Mail:
  status                                        Account, AI and counts (never the password)
  scan                                          Fetch new inbox headers (progress on stderr)
  senders [--category <c>] [--limit <n>]        Senders by email count. Categories: promotions,
                                                newsletters, notifications, receipts, people, other
  cleanup plan --sender <address>...            Dry run: exactly what a clean-up would do
          [--no-unsubscribe] [--no-trash]
  cleanup run --sender <address>... --confirm   Unsubscribe and move emails to Trash *
  history [--limit <n>]                         Past clean-ups
  undo <id> --confirm                           Move a clean-up's emails back from Trash *
  mail mailboxes                                Folders with message and unread counts
  mail sync [--mailbox <path>]                  Fetch new mail in a folder (default INBOX)
  mail list [--mailbox <path>] [--unread] [--limit <n>]
                                                Messages, newest first, with their uid
  mail search <words> [--mailbox <path>] [--server] [--limit <n>]
                                                Search downloaded mail, or the server
  mail read <uid> [--mailbox <path>]            A message as plain text. Doesn't mark it read
                                                Headless mode never sends or changes mail.

Calendar:
  calendar sync                                 Fetch changed calendars
  calendar events --from YYYY-MM-DD --to YYYY-MM-DD [--limit <n>]
  calendar list                                 Calendars, and which can be changed
  calendar add --calendar <name> --title <t> --start <when> [--end <when>] --confirm *
          [--time-zone <zone>] [--location <l>] [--notes <n>] [--alert <minutes>]
          [--repeat daily|weekly|monthly|yearly [--until YYYY-MM-DD | --count <n>]]
  calendar edit --uid <uid> [--occurrence <id> | --all] <fields to change> --confirm *
  calendar delete --uid <uid> [--occurrence <id> | --all] --confirm *
                                                <when> is a day (2026-11-20, all day) or a
                                                time (2026-11-20T09:30). Uids and occurrence
                                                ids are in calendar events --json.

Money:
  money bills                                   Bills and subscriptions
  money transactions [--month YYYY-MM] [--account <name>] [--limit <n>]
  money balances                                Who owes whom
  money import <file.csv> [--account <name>] --confirm   Import a bank statement *
  money sort --confirm                          Categorise merchants in Other and match bills
                                                to email with the saved model (AI for Money) *
  money knows                                   What you've taught Ordo, and how banks date payments
  money questions                               Ordo's questions, with answer ids
  money loose-ends                              Money you hold for others, and who owes you
  money events                                  Events and trips: paid out, paid back, net
  money compare [--category <c>] [--account <name>]   This month so far against last month
  money answer <question-id> --answer <id> --confirm  Answer a question; saves its facts *
  money forget <fact-id> --confirm              Forget a fact *

Boards:
  boards list                                   Boards, with card and overdue counts
  boards cards [--board <name>] [--column <name>] [--label <name>]... [--archived] [--limit <n>]
  boards add-card --board <name> --title <text> [--column <name>] [--due YYYY-MM-DD]
          [--start YYYY-MM-DD] [--notes <text>] [--label <name>]... --confirm   Add a card *
  boards move-card <card> [--column <name>] [--position <n>] [--board <name>] --confirm
                                                Move a card (id, first 8 of its id, or title) *

AI:
  ai status                                     Providers and the saved choice
  ai sort --confirm                             Sort senders in Other with the saved model *

Options:
  --json             One JSON document on stdout; errors as {"error":{"code","message"}}
  --allow-changes    Needed, with --confirm, for the commands marked *
  -h, --help         This help

People you've written to are never cleared. Connecting an account is done in the app.
Exit codes: 0 done, 1 failed, 2 bad arguments, 3 change not allowed or not confirmed,
4 another Ordo window or agent is busy.`
