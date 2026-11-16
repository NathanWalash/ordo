# Security policy

Ordo handles email credentials and message data, so security reports are taken seriously.

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub's security advisories](https://github.com/NathanWalash/ordo/security/advisories/new),
not as a public issue. You should get a reply within a week.

## How Ordo protects your data

- Passwords are stored with Electron `safeStorage` (macOS Keychain, Windows DPAPI), never in files or the repo.
- The renderer runs sandboxed with context isolation and no Node.js access; it talks to the main process only through a typed preload API.
- Email bodies are never sent to a language model. Only sender names, addresses and subject lines are used for sorting, and model output can only be a category label.
- Nothing is permanently deleted: clean-up moves mail to Trash.
