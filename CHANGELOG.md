# Changelog

All notable changes to Ordo are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Mail client. Mail → Inbox now shows your iCloud folders (Inbox, Drafts, Sent, Archive, Junk, Bin and your own), a message list with unread dots, flags and an All/Unread switch, and a reading pane. Ordo checks for new mail when you open a folder, on request and every five minutes. See [docs/mail.md](docs/mail.md).
- HTML email is shown safely: sanitised with DOMPurify, in a sandboxed frame with no scripts, forms or pop-ups, under a Content-Security-Policy that lets it connect nowhere. Remote images (tracking pixels) are blocked; **Load images** fetches that message's images through Ordo, https only, public internet only, no cookies or referrer. Plain-text mail is shown as text.
- Links in email never open inside Ordo. A sheet shows where a link really goes, warns when its text names a different site or it isn't https, and opens it in your browser. Links that hide their destination behind a user name, and non-web links, are refused. `mailto:` links start a new message (never with a Bcc).
- Attachments are listed under the message and saved with the save dialog. Inline images in a message are shown.
- Mark read or unread, flag, and move to Archive, Bin, Junk or back to the Inbox, with Undo. Keyboard shortcuts: arrows or J/K, C, R, A, F, E, Delete, U, S, Z and /.
- Search as you type across every downloaded folder (subjects, people and the text of messages you've opened), plus **Search all of … on iCloud** for older mail.
- Write, reply, reply all and forward (with the original's attachments), attach files, and save drafts to Drafts. Mail is sent through iCloud SMTP (`smtp.mail.me.com:587`, STARTTLS) with the app-specific password you already saved, only when you click Send; a copy with the Bcc list is kept in Sent and replies are threaded and marked as answered. Addresses are checked as you type and again in the main process, at most 50 recipients per message.
- Headless: read-only `mail mailboxes`, `mail sync`, `mail list`, `mail search` (cache or `--server`) and `mail read` (plain text, never marks a message read), and the matching MCP tools `ordo_mailboxes`, `ordo_mail_sync`, `ordo_messages`, `ordo_search_mail` and `ordo_read_message`. There is no way to send, draft, flag or move mail from headless mode or MCP.
- Settings → Account shows the connected iCloud account, with Connect and Disconnect (Disconnect moved here from the Inbox page).
- `ORDO_SMTP_HOST` and `ORDO_SMTP_PORT` point an unpackaged build's SMTP at a local server for tests, like `ORDO_IMAP_*`. End-to-end tests for the mail client run against GreenMail IMAP and SMTP.

### Changed

- The inbox scan also records flags, recipients and Message-IDs, and a refresh forgets mail that was moved or deleted elsewhere, so Unclutter's counts stay accurate.

- `pnpm dev` on macOS shows the app as Ordo in the menu bar, Dock and Cmd-Tab instead of Electron, by renaming the development copy of Electron before it starts. Packaged builds were already named Ordo.
- Add a calendar by link: paste a calendar's iCal link (Google's **Secret address in iCal format**, Outlook's published ICS link, any `webcal://` or `.ics` link) and Ordo shows it under **Other calendars**, read-only, next to iCloud's. Useful for a Google work calendar that doesn't sync properly into iCloud. Ordo checks the link really is a calendar before saving it, keeps it encrypted with the system keychain, refreshes it with every sync, and says which link stopped working instead of dropping its events. Links must be https, and neither a link nor its redirects may reach this computer or the local network.
- Import an `.ics` file as a calendar of its own, with its recurring events expanded like any other.
- Calendars added by link or file work without an iCloud account, survive disconnecting iCloud, and can be removed from the calendar list. Headless `calendar sync` and `calendar events` include them.
- HSBC statements: the headerless `date,description,amount` export is read without asking, and HSBC's transaction codes are understood. Direct debits and standing orders no rule places count as Bills, foreign card fees as Fees, and the codes and exchange-rate details are dropped from merchant names.
- The Monzo app's search export (`ID, Created, Title, Subtitle, …`), including its `13/11/26, 19:58` dates, Monzo's own categories and the Subtitle shown after the name.
- Transfers between your own accounts: money out of one imported account and the same amount into another within three days, where one side names the other account or both are transfers, is paired and marked "to/from your … account". All accounts totals leave it out, so it isn't counted as both spending and income. A single account still shows it.
- More UK chains in the category rules (One Stop, Wetherspoon, Beryl, First Bus, TK Maxx…), and keywords also match plurals like `SAINSBURYS`.
- Sort with AI for Money: with **Use AI for Money** on in Settings → AI (off by default), Finances gets a Sort with AI button that asks your chosen model to categorise the merchants left in Other, one item per merchant with a cleaned name, a description with every number removed, in or out, and a rough amount band. Never balances, account details, dates or exact amounts. Rows a model categorised show a sparkle with its confidence; answers are cached per merchant and model, and applied without asking again. Same cloud consent and write lock as sorting senders. See [docs/ai.md](docs/ai.md#money).
- AI bill matching: the same run asks the model whether recurring bank payments the rules couldn't link (like `AMZN MKTP`) belong to an email sender (`Amazon`). A match only adds the emails to a detected bill marked **Matched by AI** in Bills; the model never confirms a bill.
- Change a transaction's category from the menu on its row on Finances. Your choice wins over the bank, the rules and AI; **Automatic** undoes it.
- Headless: `money sort --allow-changes --confirm` and the `ordo_money_sort` MCP tool (only with `--allow-changes`, needs `confirm: true`). `money transactions` shows who chose each category.

- New logo and app icon: four stacked cards, black at the front and lighter greys behind, on a white tile.
- Headless mode: `Ordo --headless <command>` runs without a window, for scripts, tests and AI agents. Commands for status, scan, senders, clean-up plan and run, history, undo, calendar sync and events, bills, transactions, balances, statement import and AI sorting. Human-readable by default, `--json` for one JSON document, meaningful exit codes. It calls the same main-process functions as the window, so People are never cleared and every network, mailto and cloud-AI check still applies. Read-only unless started with `--allow-changes`, and each change needs `--confirm`. Connecting an account stays in the app. See [docs/headless.md](docs/headless.md).
- MCP server: `Ordo --headless --mcp` serves Ordo's read tools to Claude Code, Claude Desktop and other MCP clients over stdio (no network port). Change tools only appear with `--allow-changes` and each needs `confirm: true`. Tool descriptions mark text from emails, statements and calendars as untrusted.
- `pnpm ordo -- <command>` runs the built app headless from a checkout.
- The app and headless runs can be open together: the databases wait briefly for each other, and scans, syncs, clean-ups, undo, imports and AI sorting take a shared write lock (`ordo-write.lock`). The window says "Ordo is busy in another window or agent" instead of clashing; a lock left by a crashed process is taken over.
- Sort with AI in Unclutter: asks the model chosen in Settings → AI about the senders in Other, with progress, Stop and a summary. Sorted rows show a sparkle with the model's confidence, and earlier answers are kept without asking again. Without a model set up, the button opens Settings.
- Bill due dates, yearly renewals and trial ends from Money appear on the Calendar, drawn so they never look like events.
- Unclutter clean-up. "Review and clear" opens a review sheet listing the selected senders, with Unsubscribe (one-click, link or email) and Move to Trash for each, a summary and a Clear button. People you've written to are refused again in the main process, whatever the window sends.
- One-click unsubscribe (RFC 8058) is a cookie-less HTTPS POST from the main process with a 10 second timeout and at most three https-only redirects. It never reaches private, local or link-local addresses, checked when connecting, so DNS tricks can't get round it.
- Unsubscribe links open in your browser; plain http links only after the sheet has shown you the URL and you've turned them on.
- Unsubscribe emails (mailto:) go out through iCloud SMTP with your app-specific password: one recipient, a short checked subject and body, at most 50 per clean-up. An address on a different domain from the sender is shown and has to be ticked first.
- Move to Trash moves every cached inbox email from those senders to your Trash in batches. Nothing is deleted.
- Clean-up history (Mail → History) lists past clean-ups with per-sender results. Undo move puts the emails back from Trash using the UIDs the server reported, and says how many couldn't be restored. Unsubscribes can't be undone.
- Settings → AI: choose LM Studio or Ollama on this computer, or your own Claude or ChatGPT login through the Claude Code or Codex CLI. Each shows whether it's running or installed, with a model picker (gpt-oss-20b preselected when you have it), a Test button that shows the reply and how long it took, and a switch to sort senders Ordo isn't sure about. Off by default. A cloud CLI needs an explicit confirm first, because sender names and subject lines then go to Anthropic or OpenAI. See [docs/ai.md](docs/ai.md).
- `@ordo/ai` package: one interface over LM Studio, Ollama and the two CLIs, with structured JSON output, a checked retry, timeouts, cancellation and a concurrency limit. CLIs are found through your login shell's PATH, so they work when Ordo is opened from Finder, and run with their tools off in an empty folder.
- Model-based sender sorting in `mail-core`: only senders the rules left in Other are sent, as names, addresses, list flags and up to five subject lines, never bodies. People are never sent or changed. Answers are cached per sender and model in the mail database.
- Settings page, opened from the gear at the bottom of the sidebar. Appearance lets you choose System, Light or Dark; the choice is saved and applied to the whole window, including the native sidebar material and the Windows title bar buttons.
- Frosted glass on the toolbar, the Unclutter table header and footer, and the connect sheet. Content scrolls under the toolbar. Surfaces turn solid when Reduce transparency is on, or where blur isn't supported.
- Solid sidebar on Windows 10, which has no Mica.
- Calendar: your iCloud calendars in Month, Week and Agenda views, using the same account and app-specific password as Mail (CalDAV). Read-only for now. Recurring events, all-day and multi-day events and time zones are handled; calendars can be shown or hidden, and events open a detail popover.
- Calendar keeps a local cache (one month back, twelve ahead) in its own SQLite database and only refetches calendars that changed. Before you connect, it previews sample data.
- `calendar-core` package with unit tests, and CalDAV integration tests against a local Radicale server, in CI.
- Money module, replacing the Finance placeholder, with **Finances** and **Bills & Subscriptions** pages. Everything is stored in its own local database (`money.sqlite`); nothing is uploaded.
- Import bank statements as CSV from a button or by dropping the file on the window. Monzo, Starling, Revolut, Nationwide and Lloyds-style exports are recognised automatically; other layouts get a column picker. Re-importing a statement skips transactions you already have.
- Finances shows money in and out, spending by category, monthly totals and every transaction, filtered by account and month.
- Bills & Subscriptions finds recurring payments (weekly, monthly or yearly) in your statements and, when Mail is connected, links them to receipts, renewals, trial-ending and price-change emails. Confirm or dismiss what it finds, or add bills yourself. Price rises and trials ending are flagged.
- Split bills with flatmates equally, by amount or by percentage. Balances are worked out in whole pence and simplified to the fewest payments, and you can record settling up.
- `money-core` package: statement parsing, merchant clean-up, recurring detection, email hints, bill linking, split maths, a calendar feed for bills and a seam for a future local-model advisor.
- Connect an iCloud account with an app-specific password. It's checked before saving and stored encrypted with the system keychain (Electron `safeStorage`).
- Scan your inbox: headers only, cached in a local SQLite database so later scans only fetch new mail. You can stop a scan and resume it.
- Unclutter shows your real senders, sorted by rules into Promotions, Newsletters, Notifications, Receipts, People and Other. Anyone you've written to counts as a person and can't be selected for clean-up.
- IMAP integration tests and an end-to-end connect-and-scan test against a local GreenMail server, in CI.
- App shell with a native-feeling window: frosted sidebar on macOS, Mica on Windows 11.
- Home screen with links to Mail, Unclutter and Finance.
- Unclutter preview using sample data: inbox makeup, category filters and a sender list where people can never be selected.
- `mail-core` package: sender grouping and `List-Unsubscribe` parsing (RFC 2369 and RFC 8058).
- Unit tests (Vitest), end-to-end tests (Playwright), CI on macOS, Windows and Linux, and a tag-driven release workflow.
