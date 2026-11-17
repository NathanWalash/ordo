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
