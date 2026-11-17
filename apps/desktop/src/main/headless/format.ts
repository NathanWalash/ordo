import type { CommandName } from './args'
import type { CommandResult } from './commands'

/**
 * Human-readable output for the headless CLI. Names, subjects, URLs, merchants and event titles
 * come from other people's emails, statements and calendars, so every string is stripped of
 * control characters before it reaches a terminal (no escape sequences, no fake lines).
 */

// C0 and C1 control characters, DEL, and bidi overrides/isolates.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g

export function clean(value: unknown, max = 80): string {
  const s = String(value ?? '').replace(UNSAFE, ' ')
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

export function pounds(pence: number | null | undefined): string {
  if (pence === null || pence === undefined) return '?'
  const sign = pence < 0 ? '-' : ''
  return `${sign}£${(Math.abs(pence) / 100).toFixed(2)}`
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const when = (iso: unknown) => (typeof iso === 'string' ? iso.replace('T', ' ').slice(0, 16) : 'never')

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

/* eslint-disable @typescript-eslint/no-explicit-any -- the data shapes come from commands.ts */
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
      ? 'No senders. Run `scan` first.'
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
            e.allDay ? `${String(e.start).slice(0, 10)} all day` : when(e.start),
            clean(e.title, 60),
            e.calendar ? `(${clean(e.calendar, 30)})` : '',
          ]),
        ) + more(d, 'events'),

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
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The text to print for a result: on stdout when it worked, on stderr when it didn't. */
export function formatHuman(name: CommandName, result: CommandResult): string {
  if (!result.ok) return `Error: ${clean(result.message, 500)}`
  return FORMATTERS[name](result.data)
}

/** The JSON document to print: the data, or `{ "error": { "code", "message" } }`. */
export function formatJson(result: CommandResult): string {
  return JSON.stringify(
    result.ok ? result.data : { error: { code: result.code, message: result.message } },
    null,
    2,
  )
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

Calendar:
  calendar sync                                 Fetch changed calendars
  calendar events --from YYYY-MM-DD --to YYYY-MM-DD [--limit <n>]

Money:
  money bills                                   Bills and subscriptions
  money transactions [--month YYYY-MM] [--account <name>] [--limit <n>]
  money balances                                Who owes whom
  money import <file.csv> [--account <name>] --confirm   Import a bank statement *
  money sort --confirm                          Categorise merchants in Other and match bills
                                                to email with the saved model (AI for Money) *

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
