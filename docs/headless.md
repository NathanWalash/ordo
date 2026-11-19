# Headless mode

Ordo can run without a window, for scripts, tests and AI agents. It is the same app: the same
data folder, the same saved account, and the same main-process functions the window uses, so
every check the window makes (People are never cleared, the unsubscribe network guard, the limits
on unsubscribe emails, cloud-AI consent) applies here too. There are two ways in:

- **CLI:** `Ordo --headless <command> [options]` runs one command and exits.
- **MCP server:** `Ordo --headless --mcp` serves the Model Context Protocol on stdin and stdout
  for an agent such as Claude Code or Claude Desktop. There is no network port.

Headless mode is **read-only unless you say otherwise**. Anything that changes your mailbox or
data needs `--allow-changes` on the command line _and_ an explicit confirm on each call.

Connecting an account stays in the app, so a password never appears on a command line. Connect
once in the window; headless runs then use the saved account.

## Running it

From a checkout (build first; `pnpm ordo` runs the built app and doesn't rebuild):

```bash
pnpm build
pnpm ordo -- status
pnpm ordo -- senders --category promotions --limit 10
pnpm ordo -- senders --json
```

From an installed app:

| OS      | Command                                                                            |
| ------- | ---------------------------------------------------------------------------------- |
| macOS   | `/Applications/Ordo.app/Contents/MacOS/Ordo --headless status`                     |
| Windows | `"%LOCALAPPDATA%\Programs\Ordo\Ordo.exe" --headless status`                        |
| Linux   | `ordo --headless status` (AppImage: `./Ordo-<version>.AppImage --headless status`) |

On Windows, Ordo.exe is a windowed program, so a plain Command Prompt may not show its output.
Pipe or redirect it (`Ordo.exe --headless status | more`, or `> out.txt`); MCP clients always use
pipes, so the MCP server is unaffected.

On Windows, Electron replaces the main process's `process.stdin` with an empty stream that has
already ended, which made the MCP server (`--headless --mcp`) close as soon as a client connected.
Ordo now reads standard input itself there (file descriptor 0: the pipe an MCP client gives it,
or a file with `< requests.jsonl`). The MCP end-to-end tests run on Windows in CI again.

On Linux, headless mode doesn't need a display: it was checked with no X server or Wayland at all
(Electron 45, Debian 12). Chromium may still log a few lines about D-Bus or the GPU to stderr;
stdout stays clean. Running the unpackaged app (`pnpm ordo`) on a distribution that blocks
unprivileged user namespaces, such as Ubuntu 24.04, needs `--no-sandbox` before `apps/desktop`,
as the end-to-end tests do; packaged builds ship Chromium's sandbox helper and don't.

Headless runs use the same data folder as the app (on macOS
`~/Library/Application Support/Ordo`). Only unpackaged development builds honour `ORDO_USER_DATA`
and the other `ORDO_*` test overrides, exactly as the windowed app does.

## Commands

| Command                                                                       | What it does                                                     |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `status`                                                                      | Account email (never the password), last scan, AI, counts        |
| `scan`                                                                        | Fetch new inbox headers into the cache (progress on stderr)      |
| `senders [--category <c>] [--limit <n>]`                                      | Senders by email count. `other` means uncategorised              |
| `cleanup plan --sender <address>... [--no-unsubscribe] [--no-trash]`          | Dry run: exactly what a clean-up would do. Changes nothing       |
| `cleanup run --sender <address>... [--no-unsubscribe] [--no-trash] --confirm` | Unsubscribe and move the senders' emails to Trash \*             |
| `history [--limit <n>]`                                                       | Past clean-ups, newest first                                     |
| `undo <id> --confirm`                                                         | Move a clean-up's emails back from Trash \*                      |
| `mail mailboxes`                                                              | Folders with message and unread counts                           |
| `mail sync [--mailbox <path>]`                                                | Fetch new mail in one folder into the cache (default INBOX)      |
| `mail list [--mailbox <path>] [--unread] [--limit <n>]`                       | Cached messages, newest first, with the uid to read              |
| `mail search <words> [--mailbox <path>] [--server] [--limit <n>]`             | Search the cache (every folder), or the server (one folder)      |
| `mail read <uid> [--mailbox <path>]`                                          | A message as plain text, headers and attachment names            |
| `mail move <uid>... --to <where> [--mailbox <path>] --confirm`                | Move to archive, bin, junk, inbox or a folder \*                 |
| `mail flag <uid>... [--unflag] [--mailbox <path>] --confirm`                  | Flag or unflag \*                                                |
| `mail mark <uid>... --read\|--unread [--mailbox <path>] --confirm`            | Mark read or unread \*                                           |
| `mail undo [<id>] --confirm`                                                  | Undo a move made in the same process (in practice, MCP) \*       |
| `calendar sync`                                                               | Fetch changed iCloud calendars and calendar links into the cache |
| `calendar events --from YYYY-MM-DD --to YYYY-MM-DD [--limit <n>]`             | Cached events, both days included, at most 400 days              |
| `calendar list`                                                               | Calendars, where each comes from, and which can be changed       |
| `calendar add --calendar <name> --title <t> --start <when> [...] --confirm`   | Add an event to a writable iCloud calendar \*                    |
| `calendar edit --uid <uid> [--occurrence <id> \| --all] <fields> --confirm`   | Change an event, or one occurrence of a repeating one \*         |
| `calendar delete --uid <uid> [--occurrence <id> \| --all] --confirm`          | Delete an event, or one occurrence of a repeating one \*         |
| `money bills`                                                                 | Bills and subscriptions, and ones found to confirm in the app    |
| `money transactions [--month YYYY-MM] [--account <name>] [--limit <n>]`       | Imported transactions, newest first                              |
| `money balances`                                                              | Who owes whom for shared bills                                   |
| `money import <file.csv> [--account <name>] --confirm`                        | Import a bank statement CSV \*                                   |
| `money sort --confirm`                                                        | Categorise merchants in Other and match bills to email (AI) \*   |
| `money knows`                                                                 | What you've taught Ordo, and how each bank dates payments        |
| `money questions`                                                             | Ordo's questions about your money, with answer ids               |
| `money loose-ends`                                                            | Money you hold for others, and who still owes you                |
| `money events`                                                                | Events and trips: paid out, paid back and net                    |
| `money compare [--category <c>] [--account <name>]`                           | This month so far against last month to the same day             |
| `money answer <question-id> --answer <id> --confirm`                          | Answer one of Ordo's questions; saves what it means \*           |
| `money forget <fact-id> --confirm`                                            | Forget something Ordo learned \*                                 |
| `boards list`                                                                 | Boards, with card and overdue counts                             |
| `boards cards [--board <b>] [--column <c>] [--label <l>]...`                  | Cards in column order. Also `--archived` and `--limit <n>`       |
| `boards add-card --board <b> --title <t> [options] --confirm`                 | Add a card; options below \*                                     |
| `boards move-card <card> [--column <c>] [--position <n>] --confirm`           | Move a card; position 1 is the top \*                            |
| `ai status`                                                                   | Model providers and the saved choice                             |
| `ai sort --confirm`                                                           | Sort the senders in Other with the model chosen in Settings \*   |
| `help`, `--help`, `-h`                                                        | The command list                                                 |

\* Changes something: needs `--allow-changes` as well as `--confirm`.

Options for every command: `--json` prints one JSON document on stdout; `--allow-changes` allows
the starred commands. Unknown commands and flags are errors.

`cleanup` builds its plan with the same function the review sheet relies on. As in the app, a
plain-http unsubscribe link or an unsubscribe email to a different domain has to be confirmed in
the review sheet, so headless refuses those senders unless you add `--no-unsubscribe` (move to
Trash only). A sender whose unsubscribe is a web page is opened in your browser, as in the app.

Headless mode and MCP can never send mail, even with `--allow-changes`: sending is the in-app
assistant's alone, after you press Send on a card showing the whole email. `mail read`
fetches the message with `BODY.PEEK` from a mailbox opened read-only, so it stays unread; HTML is
turned into text, with link addresses after their text (`Read more <https://…>`), and printed with
control characters and bidi overrides removed. `mail sync` refreshes the cache like `scan` (it takes
the write lock but changes nothing on the server); for the inbox it is the same scan.

### Changing mail

`mail move`, `mail flag`, `mail mark` and `mail undo` change messages through the same functions as
the window, so they take the write lock and every check applies.

- **Which messages:** uids from `mail list` or `mail search`, all in one `--mailbox` (default
  INBOX), at most 20 at a time. Only messages already in Ordo's cache can be changed (run
  `mail sync` first); any other uid fails with `not_found` and nothing changes.
- **Where to:** `--to archive`, `bin` (or `trash`), `junk` (or `spam`), `inbox`, or one of the
  folders `mail mailboxes` lists, by path or by name. A folder the server didn't list fails with
  `not_found`; Drafts is refused. Nothing is ever deleted.
- **Undo:** undo is kept in memory, so it only works within one MCP session (`ordo_mail_undo` undoes
  the last move that session made). A one-off `mail move` can't be undone by a later command: move
  the messages back with `mail move` instead, as its output says. Nothing is ever deleted.

```bash
pnpm ordo -- mail list --json
pnpm ordo -- mail move 9071 9072 --to archive --allow-changes --confirm
pnpm ordo -- mail flag 9071 --unflag --allow-changes --confirm
pnpm ordo -- mail mark 9071 --read --allow-changes --confirm
```

```jsonc
// mail move --json (flag gives { mailbox, uids, flagged }, mark { mailbox, uids, read },
// undo { undoId, restored })
{ "mailbox": "INBOX", "to": "Archive", "moved": 2, "undoId": 3 }
```

`money import` accepts a regular `.csv` file under 5 MB (symlinks are resolved first), then reads
it with the same statement parser and limits as an import in the app.

### Calendar events

`calendar add`, `edit` and `delete` change events on writable iCloud calendars, through the same
function as the window. Calendars added by link or file, read-only iCloud calendars and other
people's invitations are refused (`read_only`).

- **When:** `--start` and `--end` are a day (`2026-11-20`, an all-day event; `--end` is the last
  day) or a time (`2026-11-20T09:30`), in `--time-zone` (an IANA name like `Europe/London`;
  default: this computer's zone). Without `--end`, a new event lasts an hour (or one day).
- **Other fields:** `--title`, `--location`, `--notes` (`--location=` or `--notes=` clears them),
  `--alert <minutes before>` or `--alert none`, `--repeat daily|weekly|monthly|yearly` with
  `--until YYYY-MM-DD` or `--count <n>` (`--repeat none` stops it repeating).
- **Which event:** `--uid` and, for one occurrence of a repeating event, `--occurrence`; both are
  in `calendar events --json` (`uid`, `occurrence`). A repeating event needs `--occurrence` (that
  occurrence only) or `--all` (every one); without either the command stops with exit code 2.
  `--calendar <name or id>` picks between calendars if the same uid is in more than one.
- **Edits change only the flags given.** Moving the start keeps the event's length. With `--all`
  and `--occurrence` together, the series moves by as much as that occurrence moved.
- **Never overwrites.** If the event changed on another device since Ordo last synced, nothing
  is saved, Ordo refreshes that calendar, and the command fails with `conflict`. Run it again.

```bash
pnpm ordo -- calendar list
pnpm ordo -- calendar add --calendar Home --title "Dentist" --start 2026-11-20T09:00 --alert 30 --allow-changes --confirm
pnpm ordo -- calendar events --from 2026-11-01 --to 2026-11-30 --json
pnpm ordo -- calendar edit --uid 3F2A… --occurrence 2026-11-23T09:00:00.000Z --start 2026-11-23T11:00 --allow-changes --confirm
pnpm ordo -- calendar delete --uid 3F2A… --all --allow-changes --confirm
```

`money sort` is Sort with AI from Finances: it needs a model and **Use AI for Money** in Settings →
AI, and doesn't need a mail account (bill matching is skipped without one). `money transactions
--json` marks categories a model chose with `"categorisedBy": "ai"` and its `confidence`, and ones
you chose with `"categorisedBy": "you"`; the human output adds a `*` to AI categories.

### Boards

`boards add-card` also takes `--column <c>`, `--due YYYY-MM-DD`, `--start YYYY-MM-DD` (a date
range, with `--due`), `--notes <text>` and `--label <l>` (repeatable). `boards move-card` also
takes `--board <b>`.

Boards, columns and labels are named the way you see them (any case), or given by id. A card is
its id, the first 8 characters of its id (as `boards cards` shows them) or its exact title; add
`--board` when two boards have a card with the same title. `add-card` puts the card at the end of
the column (the first column by default); `move-card` moves within the card's board, to the end of
the column unless you give `--position`. Labels must already exist on the board. Boards work
without a mail account. Like the app, every change takes the write lock and is checked by the
same store, so a name that's too long, a date that doesn't exist or an unknown label is refused
and nothing changes.

```jsonc
// boards cards --board Home --json
{ "board": "Home", "column": null, "total": 2, "offset": 0, "shown": 2, "cards": [
  { "id": "c0ffee00-…", "title": "Fix the gate", "board": "Home", "column": "To do", "start": null,
    "due": "2026-12-01", "labels": ["Urgent"], "checklist": { "done": 1, "total": 3 }, "links": 2,
    "fields": { "Priority": "High", "Owner": "Sam" }, "archived": false }
] }

// boards add-card / move-card --json
{ "card": { "id": "…", "title": "Book the MOT", "board": "Home", "column": "Doing", … } }
```

### Exit codes

| Code | Meaning                                                                         |
| ---- | ------------------------------------------------------------------------------- |
| 0    | Done                                                                            |
| 1    | The command ran and failed: not connected, network, refused by Ordo's checks... |
| 2    | Bad arguments                                                                   |
| 3    | A change without `--allow-changes`, or without `--confirm`                      |
| 4    | Another Ordo window or agent is writing; try again when it finishes             |

### Output

Human-readable text by default. Text that came from emails, statements or calendars has control
characters and bidi overrides removed before it reaches your terminal. With `--json`, stdout
carries exactly one JSON document and nothing else (progress and logs go to stderr). Control
characters, C1 controls and bidi characters in it are written as `\u` escapes, so the JSON is safe
to print in a terminal and still parses to the same text; MCP results are escaped the same way.
Errors look
like this, with a non-zero exit code:

```json
{
  "error": {
    "code": "changes_not_allowed",
    "message": "cleanup run changes your data, so Ordo only runs it when started with --allow-changes. Nothing was changed."
  }
}
```

Error codes: `usage`, `changes_not_allowed`, `confirm_required`, `not_connected`, `locked`,
`busy`, `auth`, `network`, `invalid`, `unavailable`, `conflict` (an event changed somewhere else
first), `not_found`, `read_only`, `failed`, `unknown`, `internal`.

Shapes, trimmed:

```jsonc
// status --json
{
  "version": "0.1.0",
  "account": { "connected": true, "email": "you@icloud.com", "lastScan": "2026-11-17T09:12:03.000Z", "messages": 4120 },
  "calendar": { "connected": true, "lastSync": null, "calendars": 3 },
  "ai": { "provider": "lmstudio", "model": "gpt-oss-20b", "sortSenders": true, "cloudConsent": null },
  "counts": { "senders": 312, "cleanups": 2, "transactions": 480, "accounts": 2, "bills": 9 },
  "writeLock": null // or { "owner": "app", "task": "scanning the inbox", "since": "..." }
}

// senders --json
{ "total": 312, "offset": 0, "shown": 50, "senders": [
  { "address": "digest@news.example", "name": "Daily Digest", "category": "newsletters", "emails": 41,
    "unread": 39, "lastSeen": "2026-11-16T10:00:00.000Z", "unsubscribe": "one-click", "protected": false },
  { "address": "sam@friend.example", "name": "Sam", "category": "people", "emails": 3, "unread": 0,
    "lastSeen": "2026-11-16T10:00:00.000Z", "unsubscribe": "none", "protected": true }
] }

// cleanup plan --json (run returns { "cleanup": { "id", "moved", "canUndo", "senders": [...] }, "rejected": [...] })
{ "senders": [ { "address": "digest@news.example", "name": "Daily Digest", "category": "newsletters", "emails": 41,
                 "trash": true, "unsubscribe": { "kind": "one-click", "url": "https://news.example/u" } } ],
  "rejected": [ { "address": "sam@friend.example", "reason": "Someone you’ve written to. Never included in bulk actions." } ],
  "summary": { "senders": 1, "emailsToTrash": 41, "unsubscribes": 1 } }

// mail list --json (mail search adds "query" and "where": "cache" or "server")
{ "mailbox": "INBOX", "total": 4120, "offset": 0, "shown": 25, "messages": [
  { "mailbox": "INBOX", "uid": 9071, "date": "2026-11-16T10:00:00.000Z",
    "from": { "address": "sam@friend.example", "name": "Sam" }, "to": [{ "address": "you@icloud.com", "name": null }],
    "subject": "Lunch?", "unread": true, "flagged": false, "answered": false, "attachments": false }
] }

// mail read 9071 --json
{ "mailbox": "INBOX", "uid": 9071, "date": "2026-11-16T10:00:00.000Z", "from": { "address": "sam@friend.example", "name": "Sam" },
  "to": [...], "cc": [], "replyTo": [], "subject": "Lunch?", "messageId": "<abc@friend.example>",
  "unread": true, "flagged": false, "text": "Are you free on Friday?", "truncated": false,
  "attachments": [{ "filename": "menu.pdf", "contentType": "application/pdf", "size": 51234 }] }

// calendar events --json, and the ordo_calendar_events MCP tool. Timed events give instants (UTC);
// all-day events give dates, YYYY-MM-DD, with an exclusive end as in iCalendar (a one-day event
// on 10 July ends on 11 July). The human output shows times on this computer's clock.
// uid and occurrence name an event (and one occurrence of a repeating one) for calendar edit and delete.
{ "from": "2026-07-01", "to": "2026-07-31", "total": 2, "offset": 0, "shown": 2, "events": [
  { "title": "Holiday", "start": "2026-07-10", "end": "2026-07-11", "allDay": true, "calendar": "Home",
    "location": null, "uid": "9B0E…", "occurrence": null },
  { "title": "Standup", "start": "2026-07-13T08:00:00.000Z", "end": "2026-07-13T08:15:00.000Z", "allDay": false,
    "calendar": "Home", "location": null, "uid": "3F2A…", "occurrence": "2026-07-13T08:00:00.000Z" } ] }

// calendar add --json (edit adds "scope": "this" | "all"; delete returns { uid, scope, title })
{ "uid": "8C1D…", "calendar": "Home", "event": { "title": "Dentist", "allDay": false,
  "start": "2026-11-20T09:00", "end": "2026-11-20T10:00", "timeZone": "Europe/London",
  "location": null, "repeat": null, "alert": 30 } }

// money transactions --json (amounts are integer pence)
{ "currency": "GBP", "month": "2026-11", "account": null, "accounts": ["Monzo"],
  "summary": { "moneyInPence": 980000, "moneyOutPence": 42379 }, "total": 24, "offset": 0, "shown": 24,
  "transactions": [ { "date": "2026-11-15", "account": "Monzo", "description": "THAMES WATER", "merchant": "Thames Water",
                      "category": "Bills", "amountPence": -3800 } ] }
```

## MCP server

`--headless --mcp` speaks MCP over stdio only, using the official TypeScript SDK. Logs go to
stderr. The server exits when the client closes the connection, after finishing any call already
running (waiting at most five minutes), so a clean-up a client cancels or abandons still finishes
and can be undone.

**Read tools** (always there): `ordo_status`, `ordo_senders`, `ordo_cleanup_plan`, `ordo_history`,
`ordo_mailboxes`, `ordo_messages`, `ordo_search_mail`, `ordo_read_message`, `ordo_calendar_events`,
`ordo_calendar_list`, `ordo_bills`, `ordo_transactions`, `ordo_balances`, `ordo_boards`,
`ordo_board_cards`, `ordo_scan`, `ordo_mail_sync`, `ordo_calendar_sync`. List tools take `limit` and
`offset` with small defaults, so an agent isn't flooded. `ordo_scan`, `ordo_mail_sync` and
`ordo_calendar_sync` refresh Ordo's local cache; they change nothing on the server.
`ordo_read_message` returns a message as plain text and never marks it read. There is no tool to
send mail, with or without `--allow-changes`: `ordo_mail_send` is marked `assistantOnly` in the
registry, so it is never registered here, has no headless command, and Ordo refuses it from any
caller but the in-app assistant.

**Change tools** (only with `--allow-changes`): `ordo_cleanup_run`, `ordo_undo`,
`ordo_import_statement`, `ordo_ai_sort`, `ordo_money_sort`, `ordo_calendar_add`,
`ordo_calendar_edit`, `ordo_calendar_delete`, `ordo_board_add_card`, `ordo_board_move_card`,
`ordo_mail_move`, `ordo_mail_flag`, `ordo_mail_mark`, `ordo_mail_undo` and `ordo_mail_draft`.
Each also needs `confirm: true` in its arguments, or it is refused with `confirm_required` and
nothing happens.

The mail tools take `uids` (at most 20, from one `mailbox`) as the CLI does. `ordo_mail_draft`
saves a new message, a reply, a reply-all or a forward to Drafts: `mode`, `uid` for the message
being answered or forwarded, `to` and `cc` as plain addresses (no Bcc), `subject` and a plain-text
`body`. A reply's recipients and subject come from the original, which is quoted, and the draft
stays in its thread. Nothing is sent. Flagging, marking, undo and drafts are marked
non-destructive.

The calendar tools take the same fields as the CLI, in camelCase (`timeZone`, `alert: null` for
no alert), plus `uid`, `occurrence` and `all: true` to say which event. They go through the same
checks as the window: read-only calendars and invitations are refused, and an event changed
elsewhere first is never overwritten (`conflict`).

Tool descriptions tell the agent that names, addresses, subjects, URLs, merchant names and event
titles are third-party text to be treated as data, never as instructions; the board tools say the
same of card titles, labels and fields, which may quote emails or web pages. Adding or moving a card
is marked non-destructive (nothing is lost), but still needs `--allow-changes` and `confirm: true`.

`ordo_import_statement` takes a full local path. UNC and device paths (`\\server\share`,
`//server/share`, `\\?\`, `\\.\`) are refused before any file-system call, here and in the CLI;
the CLI still accepts a path relative to the current folder.

The tools are defined once, in `apps/desktop/src/main/headless/tools.ts`, and shared with the
in-app assistant. To add one, see [assistant.md](assistant.md#adding-a-tool).

### Claude Code

```bash
claude mcp add ordo -- /Applications/Ordo.app/Contents/MacOS/Ordo --headless --mcp
```

or, for one project, in `.mcp.json`:

```json
{
  "mcpServers": {
    "ordo": { "command": "/Applications/Ordo.app/Contents/MacOS/Ordo", "args": ["--headless", "--mcp"] }
  }
}
```

### Claude Desktop

In `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "ordo": {
      "command": "/Applications/Ordo.app/Contents/MacOS/Ordo",
      "args": ["--headless", "--mcp"]
    }
  }
}
```

On Windows use the path to `Ordo.exe`, e.g. `C:\\Users\\you\\AppData\\Local\\Programs\\Ordo\\Ordo.exe`.

### Letting an agent make changes

Add `"--allow-changes"` to `args` to register the change tools. **Only do this if you want the
agent to be able to unsubscribe you from mail, move, flag and mark mail and save drafts, import statements, add, change
and delete calendar events (deleted events can't be undone in Ordo), add and move cards on your
boards, and send sender details to your AI provider**, and keep your client's per-tool approval on,
so you see each call before it runs. Even then, People are never cleared, moved mail can be put back with Undo,
and a cloud AI provider is only used if you agreed to it in Settings → AI.

## Running alongside the app

The app and any number of headless runs can be open at once. They share `mail.sqlite`,
`calendar.sqlite`, `money.sqlite` and `boards.sqlite`, which wait briefly for each other instead of
failing.

Only one process writes at a time. Scans, calendar syncs, event changes, clean-ups, undo, imports,
AI sorting and board changes take a lock, `ordo-write.lock` in the data folder, which records the
process ID, who holds it (`app`, `headless` or `mcp`), what it's doing and since when. If another process holds it, the
command exits with code 4 (`locked`) and the window says, for example, "Ordo is busy in an AI agent
using Ordo (clearing senders). Try again when it finishes." Reading never waits.

A lock left behind by a process that crashed or was killed is noticed (its process ID no longer
exists) and taken over; so is one older than six hours, in case the process ID has been reused.
`status` shows who holds the lock.

## Safety model

- **Read-only by default.** Changes need `--allow-changes` when Ordo starts, and `--confirm`
  (CLI) or `confirm: true` (MCP) on each call.
- **People are never touched.** Anyone categorised as a person, or anyone you've written to, is
  refused by the main process whatever the caller asks, exactly as in the app.
- **The same checks as the window.** Headless calls the same functions: the unsubscribe network
  guard (no private or local addresses), at most 50 unsubscribe emails per clean-up, cloud AI only
  with saved consent, move to Trash rather than delete.
- **No secrets out.** `status` shows the account email only; the password and tokens are never
  printed or returned. Connecting an account is only possible in the window.
- **No network listener.** The MCP server is stdio only.
- **No sending.** Headless mode and MCP can never send mail. With `--allow-changes` and a confirm
  they can move, flag and mark cached messages and save drafts. Sending only happens from a click
  on Send in the window, or on the in-app assistant's send card.
- **Untrusted text is data.** Email-, statement- and calendar-derived text is never put into
  shell commands, file paths or prompts beyond what the app already does (AI sorting sends sender
  names and subjects to the model you chose, as documented in [ai.md](ai.md)).
