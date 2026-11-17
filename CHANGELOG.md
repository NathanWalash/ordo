# Changelog

All notable changes to Ordo are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
