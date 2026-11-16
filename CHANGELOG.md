# Changelog

All notable changes to Ordo are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- App shell with a native-feeling window: frosted sidebar on macOS, Mica on Windows 11.
- Home screen with links to Mail, Unclutter and Finance.
- Unclutter preview using sample data: inbox makeup, category filters and a sender list where people can never be selected.
- `mail-core` package: sender grouping and `List-Unsubscribe` parsing (RFC 2369 and RFC 8058).
- Unit tests (Vitest), end-to-end tests (Playwright), CI on macOS, Windows and Linux, and a tag-driven release workflow.
