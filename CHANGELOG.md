# Changelog

All notable changes to Ordo are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Settings page, opened from the gear at the bottom of the sidebar. Appearance lets you choose System, Light or Dark; the choice is saved and applied to the whole window, including the native sidebar material and the Windows title bar buttons.
- Frosted glass on the toolbar, the Unclutter table header and footer, and the connect sheet. Content scrolls under the toolbar. Surfaces turn solid when Reduce transparency is on, or where blur isn't supported.
- Solid sidebar on Windows 10, which has no Mica.
- Connect an iCloud account with an app-specific password. It's checked before saving and stored encrypted with the system keychain (Electron `safeStorage`).
- Scan your inbox: headers only, cached in a local SQLite database so later scans only fetch new mail. You can stop a scan and resume it.
- Unclutter shows your real senders, sorted by rules into Promotions, Newsletters, Notifications, Receipts, People and Other. Anyone you've written to counts as a person and can't be selected for clean-up.
- IMAP integration tests and an end-to-end connect-and-scan test against a local GreenMail server, in CI.
- App shell with a native-feeling window: frosted sidebar on macOS, Mica on Windows 11.
- Home screen with links to Mail, Unclutter and Finance.
- Unclutter preview using sample data: inbox makeup, category filters and a sender list where people can never be selected.
- `mail-core` package: sender grouping and `List-Unsubscribe` parsing (RFC 2369 and RFC 8058).
- Unit tests (Vitest), end-to-end tests (Playwright), CI on macOS, Windows and Linux, and a tag-driven release workflow.
