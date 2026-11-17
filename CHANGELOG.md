# Changelog

All notable changes to Ordo are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
- Connect an iCloud account with an app-specific password. It's checked before saving and stored encrypted with the system keychain (Electron `safeStorage`).
- Scan your inbox: headers only, cached in a local SQLite database so later scans only fetch new mail. You can stop a scan and resume it.
- Unclutter shows your real senders, sorted by rules into Promotions, Newsletters, Notifications, Receipts, People and Other. Anyone you've written to counts as a person and can't be selected for clean-up.
- IMAP integration tests and an end-to-end connect-and-scan test against a local GreenMail server, in CI.
- App shell with a native-feeling window: frosted sidebar on macOS, Mica on Windows 11.
- Home screen with links to Mail, Unclutter and Finance.
- Unclutter preview using sample data: inbox makeup, category filters and a sender list where people can never be selected.
- `mail-core` package: sender grouping and `List-Unsubscribe` parsing (RFC 2369 and RFC 8058).
- Unit tests (Vitest), end-to-end tests (Playwright), CI on macOS, Windows and Linux, and a tag-driven release workflow.
