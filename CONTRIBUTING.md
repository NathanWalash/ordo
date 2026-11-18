# Contributing

Thanks for your interest in Ordo. It's a personal project, but issues and pull
requests are welcome.

## Setup

You need Node 22 or newer (see `.nvmrc`) and pnpm (the version is pinned in
`package.json`, so `corepack enable` will pick it up).

```bash
pnpm install
pnpm dev
```

## Before you open a pull request

```bash
pnpm check      # format check, lint, typecheck, unit tests
pnpm test:e2e   # builds the app and runs the Playwright tests
```

The e2e tests run Ordo as a hidden background app: the window is never shown, and on macOS there's
no Dock icon and Ordo never becomes the active app, so a test run doesn't pull you away from what
you're doing. To watch a run instead, set `ORDO_E2E_SHOW=1`:

```bash
ORDO_E2E_SHOW=1 pnpm test:e2e
```

To run the IMAP tests (and the full connect-and-scan e2e test) you need Docker:

```bash
pnpm imap:start
IMAP_TEST_PORT=3143 pnpm test:integration
IMAP_TEST_PORT=3143 pnpm test:e2e
pnpm imap:stop
```

The test server accepts `test@ordo.test` with the password `abcd-efgh-ijkl-mnop`.
`pnpm imap:start` opens IMAP on port 3143 and SMTP on 3025 (used to test unsubscribe emails).
The clean-up end-to-end test also runs a local http endpoint for one-click unsubscribe; the
unpackaged app accepts `http://127.0.0.1` there only because the test sets
`ORDO_TEST_ALLOW_LOOPBACK_HTTP=1`. Add `ORDO_E2E_SCREENSHOTS=1` to save light and dark
screenshots of the review sheet, result and history under `test-results/screenshots/`.

To run the unpackaged app against other servers, set `ORDO_IMAP_HOST` / `ORDO_IMAP_PORT`
(and `ORDO_SMTP_HOST` / `ORDO_SMTP_PORT`, plus `ORDO_SMTP_REQUIRE_TLS=1` if the server
offers STARTTLS). Packaged builds ignore all of these.

The CalDAV tests run against [Radicale](https://radicale.org) on port 5232. It accepts any
username and password, and each run creates its own calendar:

```bash
pnpm caldav:start
CALDAV_TEST_PORT=5232 pnpm test:integration
pnpm caldav:stop
```

Both servers can run at once; `pnpm test:integration` runs whichever tests have a port set.

Vitest can't reach the real network. `test/network-guard.ts` runs before every test file and
makes `net`, `tls` and `dns` throw for anything but loopback (127.0.0.0/8, `::1`, `localhost`), so
`fetch`, `http` and IMAP and SMTP clients fail too. It also points `ORDO_IMAP_HOST`,
`ORDO_SMTP_HOST` and `ORDO_CALDAV_URL` at a closed port on 127.0.0.1 unless you set them. A test
that needs a server starts one on 127.0.0.1, or gives a made-up name its own `lookup` that answers
with a loopback address.

- Keep pull requests small and focused.
- Add tests for new logic. Domain logic belongs in `packages/*`, which must not import Electron.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages, for example `feat(mail-core): parse List-Id`.
- Add a line to `CHANGELOG.md` under "Unreleased" for anything user-facing.

## Releasing

1. Move the "Unreleased" changelog entries under a new version heading.
2. Bump `version` in `apps/desktop/package.json`.
3. Commit, then tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
4. The Release workflow builds installers for macOS, Windows and Linux and attaches them to a draft release. Check it, then publish.
