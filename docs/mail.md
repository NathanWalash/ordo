# Mail

Mail (in the sidebar) is a mail client for the iCloud account you connected: your folders, a
message list, a reading pane, search, and writing mail. It uses the same app-specific password as
Unclutter and Calendar.

## Folders and the message list

The list on the left shows Inbox, Drafts, Sent, Archive, Junk and Bin (iCloud's Trash), then your
own folders. In a window narrower than about 1100 points it becomes a rail of icons, with your own
folders in a menu. Ordo caches message headers in its local database:

- **The folder list** comes first, so Drafts, Sent and the rest work while a big first inbox scan
  is still running.
- **Inbox** uses the same scan as Unclutter, so it holds every message once it has been checked.
  The first time takes a while on a big inbox; Ordo shows how far it has got.
- **Other folders** start with their newest 500 messages, then pick up new mail. Older mail is
  found with **Search all of … on iCloud**.

The list loads 200 messages at a time as you scroll. Each check notices mail that has gone (moved or
deleted elsewhere) and updated read, flagged and replied states: the newest 1000 messages every
time, and the next 1000 older ones in turn, so over a few checks every cached message is covered.
A check never undoes a flag you changed in Ordo while it was running. Ordo checks when you open a
folder, when you press the refresh button and every five minutes while Mail is open. If it can't
reach iCloud it says when it last tried and keeps showing the mail it has.

Headers cached by Unclutter before the mail client existed have no recipients or attachment
markers until those messages are fetched again; opening a message always shows everything.

The text of a message is fetched when you open it and kept in the cache, so search can find it
later. Opening a message marks it read. Reading from headless mode or MCP never does.

Disconnecting stops any check that is running and waits for it before clearing the cache, so
nothing from the old account is left behind.

## Reading HTML mail safely

Email HTML comes from strangers, so Ordo treats it as hostile, in layers:

1. **Sanitised.** DOMPurify removes scripts, event handlers, forms, frames, embedded objects, `<base>`,
   `<meta>` and anything else that can run code or send data. Link addresses that aren't http,
   https or mailto are dropped.
2. **Sandboxed.** The message is shown in an `<iframe sandbox="allow-same-origin">`: no scripts, no
   forms, no pop-ups, no top-level navigation. The main process also cancels any request to load a
   page into a frame, so even a link or redirect Ordo missed can't load in the app.
3. **Strict Content Security Policy.** `default-src 'none'; img-src data:; style-src 'unsafe-inline';
font-src data:; form-action 'none'`, on top of the app's own policy. The message can't connect
   anywhere: no remote images, fonts, stylesheets or requests.
4. **Remote images are blocked** by default, so senders can't tell you've opened their email
   (tracking pixels). **Load images** asks the main process to fetch that message's images, once:
   https only, public internet only (the same guard as one-click unsubscribe), no cookies, no
   referrer, images only, at most 3 MB each and 20 MB in all. They come back as `data:` URLs, so the
   frame itself still never connects. Nothing is remembered for next time.
5. Images attached to the message itself (`cid:`) are shown, up to 50 of them and 5 MB in all; the
   rest are listed as attachments.

Limits so one email can't tie Ordo up: at most 2 MB of HTML and 2 MB of text are read (Apple Mail's
split HTML parts share that budget), each part in one request; at most 100 attachments are listed;
and turning HTML into text (for search, replies and headless mode) reads at most 256 KB in a single
pass. An attached or returned email (a bounce) is listed as an `.eml` file, never shown as the body.

The frame grows to fit the message, so only the reading pane scrolls. An email that sets no colours
of its own follows the app into dark mode; a designed one keeps the white page it was made for.
Plain-text mail is shown as text, with web addresses made into links that go through the same check.

Names never hide addresses: the reading pane shows every recipient and Reply-To with its address,
and a name that is itself a different address (`"boss@company.example" <attacker@evil.example>`) is
shown as the real address.

## Links

Clicking a link in a message never opens it in Ordo. A sheet shows the full address first, with the
site it really goes to in bold:

- when the link's text names one site but it goes to another (`www.mybank.co.uk` that really goes to
  `evil.example`), the sheet says **This link may be a scam**, and **Don't open** is the default;
- it warns when the link isn't https;
- it refuses links that hide their destination behind a user name
  (`https://bank.example@evil.example`) and anything that isn't a web link (`file:`, `javascript:`,
  app links).

**Open link** opens it in your browser. The main process checks the address again before it does.
A `mailto:` link starts a new message instead, filling in To, Cc, Subject and the text, with bare
addresses only. It never fills in Bcc, so nobody can be copied in without you seeing it, and nothing
is sent until you click Send.

## Attachments

Attachments are listed under the message. **Save** opens the save dialog, suggesting the file's own
name with any folders, control characters and leading dots removed; **Save all…** saves every file
into a folder you choose, never overwriting anything. Ordo downloads them only then, and marks each
saved file as downloaded (the `com.apple.quarantine` flag on macOS, the Mark of the Web on Windows),
so the system checks it before it opens.

## Writing mail

New message, Reply, Reply all and Forward open a compose sheet. Messages are plain text.

- **Sending only ever happens when you click Send or press ⌘Return**, or press **Send** on the
  assistant's card that shows the whole email (see [assistant.md](assistant.md#email)). Return in a
  field doesn't send. The preload script refuses a send that doesn't follow a click or key press in
  the window, and there is no way to send from headless mode or MCP.
- Recipients become tokens that always show the address, so a long name can't push it out of
  view. Addresses are checked as you go, and again in the main process. At most 50 people per
  message. Header fields are single lines, so a subject or name can't add hidden headers. Send with
  a mistake puts the cursor in the field to fix.
- Mail goes through iCloud's SMTP server (`smtp.mail.me.com:587`, STARTTLS required) with your
  app-specific password. A copy with your Bcc list is kept in Sent; the copy that is sent leaves
  Bcc out. If iCloud refuses some recipients, Ordo says which; if it refuses them all, nothing is
  sent and Ordo says so.
- Replies are threaded (`In-Reply-To` and `References`) and the original is marked as replied. Reply
  all leaves out all your iCloud addresses (@icloud.com, @me.com and @mac.com) and treats anything
  in Sent as yours.
- Forward includes the original's attachments; remove any you don't want.
- **Attach files…** uses the open dialog. The window only sees names and sizes, never paths.
  iCloud can't send much more than 20 MB, so Ordo stops at about 14 MB and 20 files.
- **Save draft** saves to Drafts, replacing the version saved before, attachments and all. Closing
  with unsaved changes asks whether to keep a draft. Open a draft and choose **Edit draft** to carry
  on; a reply saved as a draft stays in its thread. Sending a draft removes it from Drafts.
- Compose fits a small window: the fields scroll and the buttons stay in view.

## Moving mail

Archive, Move to Bin, Move to Junk and Move to Inbox move the selected message on the server.
Nothing is deleted: Bin is iCloud's Trash. **Undo move** (or ⌘Z) puts it back for a little while
after. Ordo only offers Undo when the server says where the message went.

## Keyboard

Mail's own shortcuts work anywhere in the window except while you're typing. The single keys only
work while the message list or a message has focus, so they never surprise you while typing
elsewhere or using a screen reader. Press ? in the list for this table.

| Key              | Does                     |
| ---------------- | ------------------------ |
| ↑ ↓ or K J       | Previous or next message |
| ⌘N or C          | New message              |
| ⌘R or R          | Reply                    |
| ⇧⌘R or A         | Reply all                |
| ⇧⌘F or F         | Forward                  |
| ⌃⌘A or E         | Archive                  |
| ⌘⌫, Delete or #  | Move to Bin              |
| ⇧⌘U or U         | Mark read or unread      |
| ⇧⌘L or S         | Flag or unflag           |
| ⌘Z or Z          | Undo the last move       |
| ⌘F or /          | Search                   |
| ⌘Return          | Send, while writing      |
| Return in search | Search the server too    |
| Escape in search | Clear the search         |

## Search

Typing in the search field looks through the cache at once: subjects, senders, recipients and the
text of messages you've opened, across every folder. Every word must match. **Search all of … on
iCloud** (or Return) asks the server to search the open folder too, for older mail and the text of
messages you haven't opened.

## The assistant, headless mode and MCP

`mail mailboxes`, `mail sync`, `mail list`, `mail search` and `mail read`, and the matching MCP
tools, are read-only. With `--allow-changes` and a confirm on each call, `mail move`, `mail flag`,
`mail mark` and `mail undo` (and the MCP tools `ordo_mail_move`, `ordo_mail_flag`,
`ordo_mail_mark`, `ordo_mail_undo` and `ordo_mail_draft`) change at most 20 messages at a time,
only ones already in Ordo's cache. They go through the same functions as the window, so they take
the write lock, folders are checked against the server's list, and moves can be undone while that
Ordo is running. Moving into Drafts is refused. Headless mode and MCP can never send. JSON output
escapes control and bidi characters, so it's safe to print. See [headless.md](headless.md).

The in-app assistant (⌘K) can do the same, save drafts, and send a new email, a reply or a forward
after you press Send on a card that shows all of it. After it changes mail, the Mail page reloads in
place, keeping the folder you're in. See [assistant.md](assistant.md#email).

## For tests

Unpackaged builds can point IMAP and SMTP at a local server with `ORDO_IMAP_HOST`,
`ORDO_IMAP_PORT`, `ORDO_SMTP_HOST` and `ORDO_SMTP_PORT` (with `ORDO_SMTP_SECURE=1` or
`ORDO_SMTP_REQUIRE_TLS=1` if needed). `ORDO_TEST_ALLOW_LOOPBACK_HTTP=1` lets Load images reach an
http server on 127.0.0.1. Packaged builds ignore all of these.
