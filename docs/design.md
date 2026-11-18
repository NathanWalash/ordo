# Ordo design

Ordo is a personal management desktop app for macOS and Windows. It is a
shell with a home screen and a sidebar of modules. **Mail** is the first
module: a full email client with **Unclutter** (bulk unsubscribe and clean-up)
built in. **Finance** and other modules come later.

## Why

- Clear years of automated email out of an iCloud inbox and keep it clear.
- Have one calm, native-feeling place for personal admin, starting with email.
- Learn desktop app development properly (Electron, IPC, IMAP, packaging).

## Goals

- Feels at home on macOS (frosted sidebar, traffic lights, system font, accent
  colour, native menus) and on Windows 11 (Mica, standard window controls).
- Mail data, credentials and AI classification stay on the user's machine.
- Nothing destructive happens without an explicit review step; "delete" means
  move to Trash.
- Modules are independent: each has its own core package and UI routes.

## Non-goals (for now)

- Hosted web version (the core/UI split keeps a local web mode cheap later).
- Gmail (the `MailProvider` interface leaves room; IMAP + app password first).
- Auto-creating iCloud rules.
- Signed / notarised builds.

## Anti-goals

- Ever touching mail from real people in a bulk action.
- Sending email content (bodies) to any cloud model.
- Storing secrets in plain text or in the repo.

## Stack

| Layer      | Choice                                                                   |
| ---------- | ------------------------------------------------------------------------ |
| Shell      | Electron, built with electron-vite, packaged with electron-builder       |
| Language   | TypeScript everywhere                                                    |
| UI         | React, Tailwind CSS v4, Radix/shadcn-style components, TanStack Table    |
| Mail       | `imapflow` (IMAP), `nodemailer` (SMTP, later)                            |
| Storage    | `better-sqlite3` (cache, FTS5 search, audit log)                         |
| Secrets    | Electron `safeStorage` (Keychain / DPAPI)                                |
| Validation | `zod` for IPC payloads and model output                                  |
| Tests      | Vitest; GreenMail (Docker) for IMAP integration; Playwright for Electron |
| Repo       | pnpm workspaces                                                          |

### Approaches considered

- **Electron (chosen):** one TypeScript codebase for Mac and Windows; the UI is
  web tech; native vibrancy/Mica are supported.
- **Tauri:** much smaller binaries but a Rust backend — too much new ground at once.
- **SwiftUI:** truly native, but Mac-only.

## Repository layout

```
apps/desktop          Electron app: main, preload, renderer (React)
packages/shared       Module registry types, IPC contract (zod schemas)
packages/mail-core    Mail domain logic: provider interface, sender grouping,
                      classification rules, unsubscribe planning (no Electron)
packages/calendar-core Calendar domain logic: provider interface, CalDAV (tsdav),
                      iCalendar parsing and recurrence (ical.js), SQLite cache,
                      month/week layout helpers (no Electron)
docs/                 This document
```

Rule: `packages/*` never import Electron. The renderer only talks to the main
process through the typed `window.ordo` API exposed by the preload script
(`contextIsolation`, `sandbox`, no Node in the renderer).

## Calendar module

- One iCloud account powers Mail and Calendar: Calendar signs in to CalDAV
  (`caldav.icloud.com`) with the same Apple ID email and app-specific password.
- `CalendarProvider` (connect, list calendars, fetch events in a range) leaves room
  for Google and Outlook later.
- Recurring events are expanded locally (RRULE, RDATE, EXDATE, RECURRENCE-ID) and
  stored as one row per occurrence in `calendar.sqlite`, covering one month back to
  twelve ahead. Calendars whose CTag hasn't changed are skipped on re-sync.
- Times with a TZID are converted with the runtime's IANA database, falling back to
  the event's VTIMEZONE; all-day events stay on their date whatever the time zone.
- Read-only in the first version. Other modules can show items on the calendar
  (bill due dates, renewals, trial ends) through `OVERLAY_SOURCES` in the renderer.

## Mail module

### Phases

1. **Shell + Unclutter** — account setup (Apple ID + app-specific password),
   header-only scan into SQLite, sender grouping, rule + AI classification,
   review plan, RFC 8058 one-click unsubscribe, move to Trash, audit log.
   Built: the review sheet, one-click / link / mailto unsubscribe, move to
   Trash with the UIDPLUS UID map, and a History view with Undo move (see
   "Clean-up" below).
2. **Reading** — built: folders, message list, safe HTML reader (DOMPurify +
   sandboxed frame + CSP, remote images blocked by default and fetched by
   the main process on request), archive/bin/junk with undo, flags, local
   search over cached headers and opened bodies (SQLite `LIKE`) plus IMAP
   SEARCH. Still to come: conversation threading, IMAP IDLE (Ordo polls
   every five minutes), FTS5.
3. **Writing** — built: compose, reply, reply all, forward, drafts (IMAP
   `APPEND`, replacing the old version with UID EXPUNGE), attachments, SMTP
   via `smtp.mail.me.com:587`. Plain text only for now. See
   [mail.md](mail.md).

### Mail client

- Headers live in `messages` (one table for every folder; Unclutter reads
  INBOX). The inbox is filled by the Unclutter scan so it stays complete;
  other folders start with their newest 500 and grow. Each refresh also
  forgets messages that have gone and updates flags for the newest 1000.
- Bodies of opened messages go in `bodies` (with a text version for search)
  and are dropped by a trigger when their message row is deleted.
- Parts are decoded from BODYSTRUCTURE (transfer encoding, charset,
  format=flowed) rather than from a second `BODY[n.MIME]` fetch, which some
  servers answer wrongly for nested parts.
- Reading opens the mailbox read-only and fetches with `BODY.PEEK`; the
  window marks a message read separately.
- One IMAP connection stays open while you read (closed after a minute
  idle); syncs use their own connection, like the scan.
- Moves keep the server's COPYUID map in memory for Undo.

### Classification

Rules first (`List-Unsubscribe`, `List-Id`, `Precedence`, `Auto-Submitted`,
no-reply addresses, people you have replied to → People). The rest goes to an
`LlmProvider` in batches, returning strict JSON validated with zod:

- `OpenAICompatProvider` — LM Studio (`localhost:1234`) / Ollama; default
  model `gpt-oss-20b` (reasoning low), comparison `gemma-4-26b-a4b-qat`.
- `ClaudeCliProvider` — `claude -p --output-format json`.
- `CodexCliProvider` — `codex exec`.

Only sender name, address, domain and a few subject lines are sent. Model
output can only be a label; it can never trigger an action.

### Clean-up

- The renderer only sends choices (address, unsubscribe, trash). The main
  process re-runs the sender analysis and builds the plan itself, refusing
  anyone categorised as people or found in Sent.
- One-click: `POST List-Unsubscribe=One-Click`, no cookies, `User-Agent: Ordo`,
  10 s timeout, at most three redirects, https only. IP-literal and
  single-label hosts are refused, and an undici `Agent` with a guarded
  `lookup` refuses private, loopback, link-local, CGNAT and similar addresses
  at connect time (no DNS-rebinding gap).
- Links open with `shell.openExternal`; plain http only after the sheet
  shows the URL and the user turns it on.
- mailto: one recipient from the URL path (any `to`/`cc`/`bcc` refuses it),
  sent with nodemailer over `smtp.mail.me.com:587` (STARTTLS). A recipient on
  another registrable domain than the From or List-Id needs a tick. Subject
  and body come from the header only when short plain text; otherwise
  "unsubscribe". At most 50 per clean-up.
- Move: `UID MOVE` to the `\Trash` mailbox in batches of 250 (imapflow falls
  back to COPY + `\Deleted` + EXPUNGE without MOVE). The COPYUID map and
  Trash UIDVALIDITY go in the `cleanups` table with per-sender results. Undo
  moves the mapped UIDs that still exist back to INBOX; if Trash's UIDVALIDITY
  changed nothing is restored. Without UIDPLUS, Undo isn't offered.

## Look and feel

- macOS: `titleBarStyle: 'hiddenInset'`, `vibrancy: 'sidebar'`, transparent
  sidebar, solid content pane, `-apple-system` font, system accent colour.
- Windows 11: `backgroundMaterial: 'mica'`, `titleBarOverlay` controls.
- Light and dark follow the OS.

## Left to the builder

Exact component library choices beyond the above, SQLite schema details,
and visual polish, following Apple's HIG (sidebars, tables, toolbars, materials).
