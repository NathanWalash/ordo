# Security policy

Ordo handles email credentials and message data, so security reports are taken seriously.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub's security advisories](https://github.com/NathanWalash/ordo/security/advisories/new),
not as a public issue. You should get a reply within a week.

## How Ordo protects your data

- Passwords (one per mail account) are stored encrypted with Electron `safeStorage` (macOS Keychain, Windows DPAPI), never in plain text or the repo.
- Mail servers are only ever reached over TLS, or STARTTLS that must succeed before Ordo signs in or sends; it never falls back to plain text, for any account or server you add.
- Google sign-in uses OAuth with PKCE in your own browser, and your own OAuth client. The refresh token and client secret are stored with `safeStorage`; Google requests can only go to Google's own hosts. Signing out revokes Ordo's access. See [docs/google.md](docs/google.md).
- The renderer runs sandboxed with context isolation and no Node.js access; it talks to the main process only through a typed preload API.
- Email bodies are never sent to a language model. Only sender names, addresses and subject lines are used for sorting, and model output can only be a category label.
- Nothing is permanently deleted: clean-up moves mail to Trash.
