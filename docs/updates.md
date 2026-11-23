# Updates and releases

Ordo isn't code-signed yet (there's no Apple Developer account), so macOS won't let an app
replace itself silently the way signed apps do. Instead there are two ways to stay up to date:

- **Installed from a release:** Ordo tells you when a newer release is out and opens its
  installer in your browser. You install it the usual way.
- **Built from source:** `pnpm install-app` pulls main, builds Ordo for your Mac and swaps it
  into `/Applications`.

Neither touches your data. Ordo keeps it in its profile folder (`~/Library/Application
Support/Ordo` on macOS, `%APPDATA%\Ordo` on Windows), which an update never changes.

## "Ordo X.Y.Z is available"

Installed builds check for a newer version once a day: about 15 seconds after launch, and again
every few hours if Ordo stays open, but never more than once in 24 hours. You can also check
any time in **Settings → Updates → Check for updates**, which works in development builds too.

A check is one unauthenticated request to
`https://api.github.com/repos/NathanWalash/ordo/releases/latest`. It goes through the same
guarded fetch as unsubscribe links (public addresses only), follows no redirects and gives up
after 10 seconds. It sends nothing about you: no version, no identifier, no cookies, only the
`User-Agent: Ordo` header GitHub requires. Nothing is downloaded or run by Ordo.

If the latest release is newer than the version you're running (by
[Semantic Versioning](https://semver.org); drafts and pre-releases never count), a small notice
appears in the bottom corner with the start of the release notes and three choices:

- **Download** opens the installer for your computer in your browser: the Apple silicon or Intel
  DMG on a Mac (an Intel copy running on Apple silicon is offered the Apple silicon one), the
  Windows installer on Windows (Windows on Arm gets the x64 one), the AppImage on Linux. If the
  release has no matching file, it opens the release page. Before anything is opened, the URL
  must be https on `github.com` (this repository's releases) or `objects.githubusercontent.com`,
  with no user name, password or port; anything else from GitHub's answer is ignored.
- **Skip this version** stops the notice for that version. A later version shows it again.
- **×** (Later) hides it until Ordo next starts.

**Settings → Updates** shows the version you have and the last check, has **Check for
updates** (or **Download X.Y.Z** once one is found) and the **Check for updates automatically**
switch. With it off, Ordo never contacts GitHub unless you press the button.

What's remembered lives in `updates.json` in the profile folder: whether automatic checks are
on, when Ordo last checked and the version you skipped.

### How it's built

- `apps/desktop/src/main/updates/logic.ts`: pure decisions, with no Electron or network: semver
  comparison, picking the asset for a platform and arch, the once-a-day throttle, skipped
  versions, URL validation and the release-notes summary. Tested in `logic.test.ts`.
- `updater.ts`: the `Updater` interface (`check()`, `apply()`) and `createGitHubUpdater`, which
  does the request with an injected fetch. Tested with a fake fetch in `updater.test.ts`; unit
  tests can't reach the network anyway (`test/network-guard.ts`).
- `store.ts`: `updates.json`, read forgivingly and written atomically.
- `index.ts`: the Electron side: IPC (`UPDATES_IPC` in `packages/shared/src/updates.ts`, inputs
  checked with zod), the daily timer and `shell.openExternal`.
- Renderer: `components/UpdateNotice.tsx` and `components/UpdateSettings.tsx`.

### Silent updates later

Once builds are signed and notarised, a second `Updater` can wrap
[electron-updater](https://www.electron.build/auto-update): `check()` maps to
`checkForUpdates()`, and `apply()` downloads the update and calls `quitAndInstall()` instead of
opening the browser. Only `getUpdater()` in `main/updates/index.ts` needs to choose it; the IPC,
the notice and Settings stay the same. The Release workflow already uploads the `latest*.yml`
and `.blockmap` files electron-updater reads. macOS updates also need a `zip` target next to
the DMG in `electron-builder.yml`.

## Install from source: `pnpm install-app`

For a Mac you develop on, one command builds and installs the current main:

```bash
pnpm install-app
```

It prints each step:

1. **Checks the checkout.** It must be on `main` with no uncommitted changes. To build something
   else, add `--allow-branch` or `--allow-dirty` (it won't pull then).
2. **Pulls** with `git pull --ff-only`, then runs `pnpm install --frozen-lockfile`.
3. **Builds** the unpacked app for this Mac's processor only (`electron-builder --dir`): no DMG,
   nothing published. It lands in `apps/desktop/release/<version>/mac-arm64/` (or `mac/` on Intel).
4. **Quits Ordo** if it's running, by asking it nicely (the first time, macOS may ask whether your
   terminal may control Ordo). If Ordo doesn't quit, it asks you to quit it. Only the installed
   Ordo is asked; a development copy from `pnpm dev` isn't touched.
5. **Installs.** It copies the build next to `/Applications/Ordo.app` under a temporary name,
   clears the quarantine flag on that copy only, checks its bundle id and version, moves the old
   app to `Ordo.app.previous`, renames the new one into place and then removes the old one. If
   the last rename fails, the old app is put back.
6. **Reopens Ordo** if it was running.

Running it again is always safe: a leftover temporary copy is removed, and if an earlier run
stopped with only `Ordo.app.previous` left, that copy is kept until the new app is in place.

Options:

| Option            | What it does                                                     |
| ----------------- | ---------------------------------------------------------------- |
| `--allow-branch`  | Build a branch other than main (no pull).                        |
| `--allow-dirty`   | Build with uncommitted changes (no pull).                        |
| `--no-pull`       | Don't pull first.                                                |
| `--dest <folder>` | Install into another Applications folder, e.g. `~/Applications`. |
| `--keep-previous` | Keep the old app as `Ordo.app.previous` afterwards.              |
| `--no-open`       | Don't reopen Ordo afterwards.                                    |

It only ever installs into a folder named `Applications`, never under `~/Library`, so it can't
reach your profile. On Windows and Linux it builds the unpacked app and tells you where it is;
run `pnpm package` for a proper installer.

The app is built on your Mac, so Gatekeeper doesn't ask about it. Because it isn't signed,
macOS may ask once after an update whether Ordo may use its saved key in your keychain ("Ordo
Safe Storage"); choose **Always Allow**.

## Cutting a release

You need push access to `main` and a clean checkout of it.

1. Make sure `CHANGELOG.md` has everything under **Unreleased**.
2. Run:

   ```bash
   pnpm release 0.2.0 --dry-run   # check first: nothing is changed
   pnpm release 0.2.0             # or patch, minor, major
   ```

   It checks you're on a clean `main` that's level with `origin/main` and that the tag is new,
   moves the Unreleased entries under `## [0.2.0] - <today>`, sets `version` in
   `apps/desktop/package.json`, commits `chore(release): v0.2.0`, tags `v0.2.0` and pushes `main`
   and the tag together (`git push --atomic`). Before the first release, `pnpm release 0.1.0`
   releases the current version without bumping it. With `--no-push` it stops before pushing.
   If `main` only accepts pull requests the push is refused as a whole; the script says how to
   continue (merge the release commit through a PR, then tag the merged commit and push the tag).

3. The tag starts the [Release workflow](../.github/workflows/release.yml). It checks the tag
   matches the app version, then builds on macOS (arm64 and x64 DMGs), Windows (x64 installer)
   and Linux (AppImage) with read-only access to the repository. A last job, the only one
   allowed to write, creates a **draft** release named "Ordo 0.2.0" with that version's
   changelog section as its notes (plus how to install), and attaches the installers along with
   the `.blockmap` and `latest*.yml` files.
4. Check the draft on GitHub, then **publish** it. Installed copies only see published releases,
   so nobody is told about it until you do.

To rebuild a tag (say a runner failed), run the workflow from the Actions tab with the tag. It
replaces the files on its own draft but refuses to change a release that's already published.
