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

- Keep pull requests small and focused.
- Add tests for new logic. Domain logic belongs in `packages/*`, which must not import Electron.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages, for example `feat(mail-core): parse List-Id`.
- Add a line to `CHANGELOG.md` under "Unreleased" for anything user-facing.

## Releasing

1. Move the "Unreleased" changelog entries under a new version heading.
2. Bump `version` in `apps/desktop/package.json`.
3. Commit, then tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
4. The Release workflow builds installers for macOS, Windows and Linux and attaches them to a draft release. Check it, then publish.
