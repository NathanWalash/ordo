# Backup and restore

Ordo keeps everything on your computer. To get a copy off it without running a server, Ordo
writes **one encrypted file** into a folder you choose. Pick a folder that iCloud Drive, Google
Drive or Dropbox already syncs and the cloud keeps a copy, but it only ever sees ciphertext.

Settings → Backup:

| Row                    | What it does                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| Backup folder          | Choose… opens a folder picker. A folder inside Ordo's own data folder is refused.                  |
| Passphrase             | Set, or Change… (needs the current one). Optionally remembered in the keychain; Forget removes it. |
| Back up automatically  | Once a day while Ordo is open, and on quit if the last backup is more than a day old.              |
| Keep                   | The last 3, 7 (default), 14 or 30. Older backups Ordo made go to the Trash.                        |
| Last backup            | When, how big, or why it failed. **Back Up Now**.                                                  |
| Restore from a backup… | The restore sheet (below).                                                                         |

## What's in a backup

| Included                                                    | Left out                                                    |
| ----------------------------------------------------------- | ----------------------------------------------------------- |
| `mail.sqlite`: downloaded headers, bodies, clean-up history | `account.json`: the iCloud app password (see below)         |
| `calendar.sqlite`                                           | `backup.json`: this computer's backup settings              |
| `money.sqlite` (including what Ordo has learned)            | Electron's own folders (caches, the window's local storage) |
| `boards.sqlite`                                             | `ordo-write.lock`, `before-restore-*` folders               |
| `settings.json`, `assistant.json`                           |                                                             |

**Passwords are never backed up.** The iCloud app-specific password is encrypted with this
computer's keychain (Electron `safeStorage`) and couldn't be decrypted on another computer anyway.
Re-encrypting it under the backup passphrase would put a working credential in the cloud, so Ordo
doesn't. After restoring on another computer, connect iCloud again. Restoring on the same
computer, for the same account, keeps you connected. The manifest records the account's email
address (inside the encryption) so Ordo can tell.

Databases are copied with SQLite's `VACUUM INTO`, while the app runs, holding Ordo's write lock
(so no scan, sync, import or clean-up is half way through). It reads one consistent snapshot, so
changes still in the write-ahead log are included, and it doesn't checkpoint or change the live
database. The snapshots go in a temporary folder inside Ordo's data folder and are removed
afterwards; only the encrypted file leaves it.

## The file

`Ordo-backup-YYYY-MM-DD-HHmm.ordobackup` (local time; `-2`, `-3`… if that minute is taken). It's
written as `….ordobackup.partial` and renamed when complete, so a sync client never uploads half
a backup under the real name.

```
header      64 bytes   "ORDOBKUP", u16 format version (1), KDF id (1 = scrypt), logN, r, p,
                       16-byte salt, 12-byte IV, 16-byte passphrase verifier
ciphertext             AES-256-GCM of gzip(payload); the whole header is the additional data
tag         16 bytes   GCM authentication tag
end         8 bytes    "ORDOEND1"
```

The payload is a big-endian u32 manifest length, the manifest (JSON), then each file's bytes in
manifest order. The manifest has the format version, Ordo's version, when it was made, the
account email, and each file's name, size and SHA-256.

- **Key:** scrypt with N = 2^17, r = 8, p = 1 (OWASP's recommendation; about 128 MiB and a third of
  a second) and a fresh random salt for every backup, giving 64 bytes. The first 32 are the AES key.
  The passphrase is NFC-normalised first.
- **Verifier:** an HMAC-SHA-256 of the header under the other 32 bytes, so a wrong passphrase is
  reported as that, before anything is decrypted, rather than as a damaged file.
- **Integrity:** GCM authenticates the ciphertext and every header byte (version, scrypt settings,
  salt, IV), and each restored file must match its SHA-256 in the manifest. Any changed byte fails.
- **Limits:** a header asking for scrypt settings above 1 GiB, or a payload that decompresses past
  64 GiB, is refused, so a crafted file can't exhaust the computer.

What you see when a backup can't be opened:

| Problem                                 | Message                                                        |
| --------------------------------------- | -------------------------------------------------------------- |
| Wrong passphrase                        | That passphrase doesn't open this backup.                      |
| Any byte changed, or cut short inside   | This backup is damaged or has been changed since Ordo made it. |
| End missing (still syncing, cut off)    | This backup file is incomplete… it may still be downloading.   |
| A newer format, or a newer Ordo version | Update Ordo, then try again.                                   |
| Not an Ordo backup                      | That file isn't an Ordo backup.                                |

## The passphrase

Ordo never stores the passphrase in plain text. It keeps a salted scrypt hash in `backup.json`, to
check the passphrase you type is the one you set (a typo can't make a backup nobody can open).
**Remember on this computer** also keeps the passphrase encrypted with the keychain, so automatic
backups carry on after a restart; without it, Ordo asks once each time it opens (Back Up Now asks
for it) and keeps it in memory until it quits.

Changing the passphrase needs the current one. Backups you already have still open with the
passphrase they were made with. If you've forgotten it, those backups can't be opened by anyone;
to start again with a new passphrase, quit Ordo and delete `backup.json` from Ordo's data folder.

## Pruning

After each successful backup Ordo keeps the newest N files **named exactly like its own backups**
(`Ordo-backup-YYYY-MM-DD-HHmm[-n].ordobackup`) and that **start with Ordo's header**, and moves
the rest to the Trash. Anything else in the folder (your files, a renamed or copied backup, other
apps' files) is never touched. A `.partial` left by a crash is moved to the Trash once it's a day
old.

## Restoring

1. **Choose Backup…** opens a file picker. If the file is in a cloud folder, let it finish
   downloading first.
2. Enter its passphrase and **Open Backup**. Ordo decrypts and checks the whole file into a
   staging folder inside its data folder. Nothing in your data changes yet.
3. The sheet shows the date, the Ordo version that made it, what's inside with sizes, whether
   you'll stay connected to iCloud, and the folder your current data will move to. A backup made by
   a newer Ordo is refused: update first.
4. Type `restore` to enable **Restore and Restart** (and press it: the preload only passes a
   restore on after a click or key press in the window).

Then Ordo refuses if anything (this window, a headless command or an agent) holds the write lock,
takes it, stops the assistant and Ask Ordo, closes every database and the IMAP connection, moves
the current files (with their `-wal` and `-shm` files, so no stale log sits beside a restored
database) into `before-restore-YYYY-MM-DD-HHmmss` in its data folder, moves the restored files in
and relaunches. All the file moves happen in one synchronous step, and if any fails every move is
undone. **The `before-restore` folder is never deleted**; to go back, quit Ordo and move its files
back.

A module that isn't in the backup (say Boards, if you hadn't used it then) is moved aside too, so
you get exactly the backup. Your account stays only if the backup's mail is for the same email;
otherwise `account.json` is moved aside as well and you connect again. This computer's backup
settings (`backup.json`) always stay.

Quit any headless Ordo or MCP server before restoring: the write lock stops one that's writing,
but one that's only reading could keep using the old files until it restarts.

## Headless and MCP

Backup isn't available in headless mode or MCP. The passphrase can't be put on a command line or
in a tool call (it would end up in shell history, process lists and agent transcripts), so a
headless backup could only use a remembered passphrase. Adding it means touching every headless
file (arguments, commands, tools, formatting, fakes); it's left for later. Restoring is the
window's alone.

## Where it lives

| File                                                          | What                                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------- |
| `apps/desktop/src/main/backup/format.ts`                      | The file format, scrypt, AES-GCM, manifest (pure Node)           |
| `apps/desktop/src/main/backup/policy.ts`                      | Names, pruning, when a backup is due, version compare (pure)     |
| `apps/desktop/src/main/backup/snapshot.ts`                    | `VACUUM INTO` snapshots and the restore file swap (pure Node)    |
| `apps/desktop/src/main/backup/index.ts`                       | Electron: settings, dialogs, keychain, schedule, Trash, relaunch |
| `packages/shared/src/backup.ts`                               | IPC channels, zod schemas and types                              |
| `apps/desktop/src/preload/backup.ts`                          | `window.ordo.backup`, with the user-activation checks            |
| `apps/desktop/src/renderer/src/components/BackupSettings.tsx` | Settings → Backup and the restore sheet                          |
