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

The e2e tests don't pull you away from what you're doing. On macOS Ordo runs as a hidden background
app: the window is never shown, there's no Dock icon and Ordo never becomes the active app. On
Windows and Linux the window is shown without taking focus. To watch a run instead, set `ORDO_E2E_SHOW=1`:

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

The test server accepts `test@ordo.test` with the password `abcd-efgh-ijkl-mnop`, and a second
account, `work@work.ordo.test` with `qrst-uvwx-yzab-cdef`, which the integration tests lay out like
Gmail to test several accounts at once.
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

Google tests use `test/fake-google.ts`, a fake of Google's OAuth and Calendar API endpoints on
127.0.0.1. To run the unpackaged app against it (or another fake), set
`ORDO_GOOGLE_BASE_URL=http://127.0.0.1:<port>`, and `ORDO_TEST_GOOGLE_AUTO_CONSENT=1` to follow the
fake's consent page without opening a browser. Packaged builds ignore both and only talk to Google's
own hosts. See [docs/google.md](docs/google.md#testing-against-a-fake-google).

- Keep pull requests small and focused.
- Add tests for new logic. Domain logic belongs in `packages/*`, which must not import Electron.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages, for example `feat(mail-core): parse List-Id`.
- Add a line to `CHANGELOG.md` under "Unreleased" for anything user-facing.

## Releasing

From a clean, up-to-date `main`:

```bash
pnpm release 0.2.0 --dry-run   # see what it would do
pnpm release 0.2.0             # or patch, minor, major
```

It moves the "Unreleased" changelog entries under the new version, bumps `apps/desktop/package.json`,
commits, tags `v0.2.0` and pushes `main` and the tag. The Release workflow then builds installers for
macOS, Windows and Linux into a draft release with that version's changelog as its notes. Check it,
then publish: installed copies of Ordo only see published releases. Details in
[docs/updates.md](docs/updates.md#cutting-a-release).
