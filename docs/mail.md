# Mail

Mail → Inbox is a mail client for the iCloud account you connected: your folders, a message list,
a reading pane, search, and writing mail. It uses the same app-specific password as Unclutter and
Calendar.

## Folders and the message list

The list on the left shows Inbox, Drafts, Sent, Archive, Junk and Bin (iCloud's Trash), then your
own folders. Ordo caches message headers in its local database:

- **Inbox** uses the same scan as Unclutter, so it holds every message once it has been checked.
  The first time takes a while on a big inbox; Ordo shows how far it has got.
- **Other folders** start with their newest 500 messages, then pick up new mail. Older mail is
  found with **Search all of … on iCloud**.

Each check also notices mail that has gone (moved or deleted elsewhere) and updated read, flagged
and replied states. Ordo checks when you open a folder, when you press the refresh button and every
five minutes while Mail is open.

The text of a message is fetched when you open it and kept in the cache, so search can find it
later. Opening a message marks it read. Reading from headless mode or MCP never does.

## Reading HTML mail safely

Email HTML comes from strangers, so Ordo treats it as hostile, in layers:

1. **Sanitised.** DOMPurify removes scripts, event handlers, forms, frames, embedded objects, `<base>`,
   `<meta>` and anything else that can run code or send data. Link addresses that aren't http,
   https or mailto are dropped.
2. **Sandboxed.** The message is shown in an `<iframe sandbox="allow-same-origin">`: no scripts, no
   forms, no pop-ups, no top-level navigation. The main process also cancels any request to load a page into a
   frame, so even a link or redirect Ordo missed can't load in the app.
3. **Strict Content Security Policy.** `default-src 'none'; img-src data:; style-src 'unsafe-inline';
font-src data:; form-action 'none'`, on top of the app's own policy. The message can't connect
   anywhere: no remote images, fonts, stylesheets or requests.
4. **Remote images are blocked** by default, so senders can't tell you opened their email (tracking
   pixels). **Load images** asks the main process to fetch that message's images, once: https only,
   public internet only (the same guard as one-click unsubscribe), no cookies, no referrer, images
   only, at most 3 MB each and 20 MB in all. They come back as `data:` URLs, so the frame itself
   still never connects. Nothing is remembered for next time.
5. Images attached to the message itself (`cid:`) are shown, up to 5 MB.

Plain-text mail is shown as text, with web addresses made into links that go through the same check.

## Links

Clicking a link in a message never opens it in Ordo. A sheet shows the full address first, and:

- warns when the link's text names one site but it goes to another (`www.mybank.co.uk` that really
  goes to `evil.example`), a common scam;
- warns when the link isn't https;
- refuses links that hide their destination behind a user name (`https://bank.example@evil.example`)
  and anything that isn't a web link (`file:`, `javascript:`, app links).

**Open link** opens it in your browser. The main process checks the address again before it does.
A `mailto:` link starts a new message instead, filling in To, Cc, Subject and the text. It never
fills in Bcc, so nobody can be copied in without you seeing it, and nothing is sent until you
click Send.

## Attachments

Attachments are listed under the message. **Save** opens the save dialog, suggesting the file's own
name with any folders, control characters and leading dots removed. Ordo downloads it only then.

## Writing mail

New message, Reply, Reply all and Forward open a compose sheet. Messages are plain text.

- **Sending only ever happens when you click Send.** Return in a field doesn't send. The preload
  script refuses a send that doesn't follow a click or key press in the window, and there is no
  way to send from headless mode or MCP.
- Addresses are checked as you go, and again in the main process. At most 50 people per message.
  Header fields are single lines, so a subject or name can't add hidden headers.
- Mail goes through iCloud's SMTP server (`smtp.mail.me.com:587`, STARTTLS required) with your
  app-specific password. A copy with your Bcc list is kept in Sent; the copy that is sent leaves
  Bcc out.
- Replies are threaded (`In-Reply-To` and `References`) and the original is marked as replied.
- Forward includes the original's attachments; remove any you don't want.
- **Attach files…** uses the open dialog. The window only sees names and sizes, never paths.
  iCloud can't send much more than 20 MB, so Ordo stops at about 14 MB of attachments.
- **Save draft** saves to Drafts, replacing the version saved before. Closing with unsaved changes
  asks whether to keep a draft. Open a draft and choose **Edit draft** to carry on. Sending a draft
  removes it from Drafts.

## Moving mail

Archive, Move to Bin, Move to Junk and Move to Inbox move the selected message on the server.
Nothing is deleted: Bin is iCloud's Trash. **Undo** (or Z) puts it back for a little while after.
Ordo only offers Undo when the server says where the message went.

## Keyboard

| Key              | Does                        |
| ---------------- | --------------------------- |
| ↑ ↓ or K J       | Previous or next message    |
| C or ⌘N          | New message                 |
| R / A / F        | Reply / Reply all / Forward |
| E                | Archive                     |
| Delete or #      | Move to Bin                 |
| U                | Mark read or unread         |
| S                | Flag or unflag              |
| Z                | Undo the last move          |
| / or ⌘F          | Search                      |
| Return in search | Search the server too       |
| Escape in search | Clear the search            |

## Search

Typing in the search field looks through the cache at once: subjects, senders, recipients and the
text of messages you've opened, across every folder. Every word must match. **Search all of … on
iCloud** (or Return) asks the server to search the open folder too, for older mail and the text of
messages you haven't opened.

## Headless and MCP

`mail mailboxes`, `mail sync`, `mail list`, `mail search` and `mail read`, and the matching MCP
tools, are read-only. See [headless.md](headless.md).

## For tests

Unpackaged builds can point IMAP and SMTP at a local server with `ORDO_IMAP_HOST`,
`ORDO_IMAP_PORT`, `ORDO_SMTP_HOST` and `ORDO_SMTP_PORT` (with `ORDO_SMTP_SECURE=1` or
`ORDO_SMTP_REQUIRE_TLS=1` if needed). `ORDO_TEST_ALLOW_LOOPBACK_HTTP=1` lets Load images reach an
http server on 127.0.0.1. Packaged builds ignore all of these.
