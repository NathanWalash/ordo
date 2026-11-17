# Changelog

All notable changes to Ordo are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

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
