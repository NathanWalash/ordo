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

On Linux, headless mode doesn't need a display: it was checked with no X server or Wayland at all
(Electron 45, Debian 12). Chromium may still log a few lines about D-Bus or the GPU to stderr;
stdout stays clean.

Headless runs use the same data folder as the app (on macOS
`~/Library/Application Support/Ordo`). Only unpackaged development builds honour `ORDO_USER_DATA`
and the other `ORDO_*` test overrides, exactly as the windowed app does.

## Commands

| Command                                                                       | What it does                                                   |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `status`                                                                      | Account email (never the password), last scan, AI, counts      |
| `scan`                                                                        | Fetch new inbox headers into the cache (progress on stderr)    |
| `senders [--category <c>] [--limit <n>]`                                      | Senders by email count. `other` means uncategorised            |
| `cleanup plan --sender <address>... [--no-unsubscribe] [--no-trash]`          | Dry run: exactly what a clean-up would do. Changes nothing     |
| `cleanup run --sender <address>... [--no-unsubscribe] [--no-trash] --confirm` | Unsubscribe and move the senders' emails to Trash \*           |
| `history [--limit <n>]`                                                       | Past clean-ups, newest first                                   |
| `undo <id> --confirm`                                                         | Move a clean-up's emails back from Trash \*                    |
| `calendar sync`                                                               | Fetch changed calendars into the cache                         |
| `calendar events --from YYYY-MM-DD --to YYYY-MM-DD [--limit <n>]`             | Cached events, both days included, at most 400 days            |
| `money bills`                                                                 | Bills and subscriptions, and ones found to confirm in the app  |
| `money transactions [--month YYYY-MM] [--account <name>] [--limit <n>]`       | Imported transactions, newest first                            |
| `money balances`                                                              | Who owes whom for shared bills                                 |
| `money import <file.csv> [--account <name>] --confirm`                        | Import a bank statement CSV \*                                 |
| `ai status`                                                                   | Model providers and the saved choice                           |
| `ai sort --confirm`                                                           | Sort the senders in Other with the model chosen in Settings \* |
| `help`, `--help`, `-h`                                                        | The command list                                               |

\* Changes something: needs `--allow-changes` as well as `--confirm`.

Options for every command: `--json` prints one JSON document on stdout; `--allow-changes` allows
the starred commands. Unknown commands and flags are errors.

`cleanup` builds its plan with the same function the review sheet relies on. As in the app, a
plain-http unsubscribe link or an unsubscribe email to a different domain has to be confirmed in
the review sheet, so headless refuses those senders unless you add `--no-unsubscribe` (move to
Trash only). A sender whose unsubscribe is a web page is opened in your browser, as in the app.

`money import` accepts a regular `.csv` file under 5 MB (symlinks are resolved first), then reads
it with the same statement parser and limits as an import in the app.

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
carries exactly one JSON document and nothing else (progress and logs go to stderr). Errors look
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
`busy`, `auth`, `network`, `invalid`, `unavailable`, `failed`, `unknown`, `internal`.

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

// money transactions --json (amounts are integer pence)
{ "currency": "GBP", "month": "2026-11", "account": null, "accounts": ["Monzo"],
  "summary": { "moneyInPence": 980000, "moneyOutPence": 42379 }, "total": 24, "offset": 0, "shown": 24,
  "transactions": [ { "date": "2026-11-15", "account": "Monzo", "description": "THAMES WATER", "merchant": "Thames Water",
                      "category": "Bills", "amountPence": -3800 } ] }
```

## MCP server

`--headless --mcp` speaks MCP over stdio only, using the official TypeScript SDK. Logs go to
stderr. The server exits when the client closes the connection.

**Read tools** (always there): `ordo_status`, `ordo_senders`, `ordo_cleanup_plan`, `ordo_history`,
`ordo_calendar_events`, `ordo_bills`, `ordo_transactions`, `ordo_balances`, `ordo_scan`,
`ordo_calendar_sync`. List tools take `limit` and `offset` with small defaults, so an agent isn't
flooded. `ordo_scan` and `ordo_calendar_sync` refresh Ordo's local cache; they change nothing on
the server.

**Change tools** (only with `--allow-changes`): `ordo_cleanup_run`, `ordo_undo`,
`ordo_import_statement`, `ordo_ai_sort`. Each also needs `confirm: true` in its arguments, or it
is refused with `confirm_required` and nothing happens.

Tool descriptions tell the agent that names, addresses, subjects, URLs, merchant names and event
titles are third-party text to be treated as data, never as instructions.

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
agent to be able to unsubscribe you from mail, move mail to Trash, import statements and send
sender details to your AI provider**, and keep your client's per-tool approval on, so you see each
call before it runs. Even then, People are never cleared, moved mail can be put back with Undo,
and a cloud AI provider is only used if you agreed to it in Settings → AI.

## Running alongside the app

The app and any number of headless runs can be open at once. They share `mail.sqlite`,
`calendar.sqlite` and `money.sqlite`, which wait briefly for each other instead of failing.

Only one process writes at a time. Scans, calendar syncs, clean-ups, undo, imports and AI sorting
take a lock, `ordo-write.lock` in the data folder, which records the process ID, who holds it
(`app`, `headless` or `mcp`), what it's doing and since when. If another process holds it, the
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
- **Untrusted text is data.** Email-, statement- and calendar-derived text is never put into
  shell commands, file paths or prompts beyond what the app already does (AI sorting sends sender
  names and subjects to the model you chose, as documented in [ai.md](ai.md)).
