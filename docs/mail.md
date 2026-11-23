# Mail

Mail (in the sidebar) is a mail client for every account you add: your personal iCloud, a work
Gmail, another Gmail, Yahoo, Fastmail or any IMAP server, side by side. It has a unified inbox,
each account's folders, a message list, a reading pane, search, and writing mail. Unclutter uses
the same accounts, and Calendar uses your iCloud account's app-specific password.

## Accounts

**Settings → Accounts** lists every account with its name, colour, address and provider, and says
when its last check failed (a wrong password, a server that's down). From there you can:

- **Add account…**: pick a provider, enter the address and an app password, and optionally a name
  ("Work", "Personal"). **Test connection** signs in and out without saving anything; **Add
  account** signs in first, so nothing is saved that doesn't work. **Connect iCloud** (shown until
  you have an account, and on Mail, Unclutter and Calendar) is the same for iCloud.
- **Edit…**: rename it, change its colour, enter a new password (Ordo signs in with it before
  saving it) or test it. When an account's password stops working, its button says **Enter
  password…**.
- **Remove…**: a sheet says exactly what goes: the account's password, the mail Ordo downloaded for
  it (headers, folders and the text of messages you opened) and its clean-up history; for the
  iCloud account Calendar uses, its iCloud calendars too (calendars added by link stay). Nothing
  changes on the server: your mail stays where it is, and you can add the account again.

Passwords are encrypted with the system keychain (`safeStorage`) and kept in `accounts.json` in
Ordo's profile, readable only by you. The window never sees a password: it gets each account's
name, colour, address, provider and servers. Ordo always uses an encrypted connection: TLS from the
start, or STARTTLS that must succeed before signing in or sending (Ordo refuses to fall back to
plain text).

### Providers

| Provider    | Servers                                                         | Password                                            |
| ----------- | --------------------------------------------------------------- | --------------------------------------------------- |
| iCloud      | `imap.mail.me.com:993` (TLS), `smtp.mail.me.com:587` (STARTTLS) | App-specific password from account.apple.com        |
| Gmail       | `imap.gmail.com:993` (TLS), `smtp.gmail.com:465` (TLS)          | App password from myaccount.google.com/apppasswords |
| Yahoo Mail  | `imap.mail.yahoo.com:993`, `smtp.mail.yahoo.com:465`            | App password from Yahoo Account Security            |
| Fastmail    | `imap.fastmail.com:993`, `smtp.fastmail.com:465`                | App password with IMAP and SMTP access              |
| Outlook.com | Not supported yet                                               | Microsoft turned off password sign-in for IMAP      |
| Other       | The IMAP and SMTP servers, ports and security you type          | Your password, or an app password if offered        |

Outlook.com, Hotmail and Live are listed but can't be added yet: Microsoft has turned off password
sign-in for IMAP, so Ordo needs Microsoft sign-in, which is coming later.

### Gmail

- **App passwords need 2-Step Verification** on your Google Account. Your Google password won't
  work.
- **Work and school accounts** (Google Workspace) may not allow app passwords or IMAP at all: that's
  your admin's choice. Sign in with Google is coming, and will work for those too.
- **Folders are labels.** Ordo finds Gmail's special folders by their SPECIAL-USE flags, never by
  name, so `[Gmail]/Sent Mail`, `[Gmail]/Bin` (`[Gmail]/Trash` in American English),
  `[Gmail]/Spam` and `[Gmail]/All Mail` work like iCloud's Sent Messages, Deleted Messages and Junk.
  Your labels show as folders.
- **Archive** moves a message to All Mail (Gmail has no Archive folder), which takes it out of the
  Inbox and keeps its other labels. **Move to Bin** moves it to Gmail's Bin, as Gmail's own Delete
  does; Gmail empties it after 30 days.
- Because a message can have several labels, the same message can show in Inbox and in a label
  folder. Ordo only downloads a folder's headers when you open it.

### The unified inbox

With more than one account, Mail opens on **All Inboxes**: every account's inbox together, newest
first, each message with its account's colour and name. Below it, each account has its own folders,
which you can fold away. Search looks through every account's downloaded mail; **Search all of …**
asks each account's server (or, in one account's folder, that account's).

Each account is checked on its own connection, at the same time as the others. When one can't be
reached, the list says which account and why, its name in the sidebar gets a warning sign, and the
others carry on. An account that keeps failing is tried less often by itself (after one minute, then
two, four and so on, at most every half hour; a wrong password waits the half hour at once, since
servers lock out accounts that keep failing to sign in). Pressing refresh, or opening a folder,
always tries every account, and entering the password again starts afresh.

### Which account mail goes from

- A **reply** (and Reply all) always goes from the account the message arrived in. The compose sheet
  says which, and the main process refuses a reply from any other account.
- A **draft** you finish goes from the account it was saved in.
- A **new message** or a **forward** has a **From** picker. It starts on the account you're looking
  at (the first account in All Inboxes; the message's own account for a forward).
- Reply all leaves out every one of your accounts' addresses, so you never copy in your other
  accounts.

### Moving from one account

An install from before several accounts kept one iCloud account in `account.json`. The first time
the new version starts, Ordo moves it into the list as account #1, named iCloud, copying the
encrypted password as it is, then removes the old file. The mail cache (`mail.sqlite`) gains an
account column, and every cached message, folder, body, sync state, "people you've written to" entry
and clean-up is given to account #1, in one transaction. Nothing is fetched again and nothing is
lost. Both steps are safe to run twice (the cache keeps a schema version, `PRAGMA user_version`, and
checks it inside the transaction, so the app and a headless Ordo starting together migrate it once),
and a failure part way leaves the old file exactly as it was.

## Folders and the message list

The list on the left shows Inbox, Drafts, Sent, Archive (All Mail on Gmail), Junk and Bin (the
account's Trash), then your own folders: for each account, with All Inboxes first when you have
more than one. In a window narrower than about 1100 points it becomes a rail of icons, with your own
folders in a menu. Ordo caches message headers in its local database:

- **The folder list** comes first, so Drafts, Sent and the rest work while a big first inbox scan
  is still running.
- **Inbox** uses the same scan as Unclutter, so it holds every message once it has been checked
  (every account's inbox, each scanned on its own).
  The first time takes a while on a big inbox; Ordo shows how far it has got.
- **Other folders** start with their newest 500 messages, then pick up new mail. Older mail is
  found with **Search all of … on iCloud**.

The list loads 200 messages at a time as you scroll. Each check notices mail that has gone (moved or
deleted elsewhere) and updated read, flagged and replied states: the newest 1000 messages every
time, and the next 1000 older ones in turn, so over a few checks every cached message is covered.
A check never undoes a flag you changed in Ordo while it was running. Ordo checks when you open a
folder, when you press the refresh button and every five minutes while Mail is open. If it can't
reach an account's server it says which account, when it last tried, and keeps showing the mail it
has.

Headers cached by Unclutter before the mail client existed have no recipients or attachment
markers until those messages are fetched again; opening a message always shows everything.

The text of a message is fetched when you open it and kept in the cache, so search can find it
later. Opening a message marks it read. Reading from headless mode or MCP never does.

Removing an account stops any check of it that is running and waits for it before clearing that
account's part of the cache, so nothing from it is left behind. Other accounts carry on.

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
- Mail goes through the From account's own SMTP server (iCloud: `smtp.mail.me.com:587`, STARTTLS
  required; Gmail: `smtp.gmail.com:465`) with its password. A copy with your Bcc list is kept in that
  account's Sent; the copy that is sent leaves Bcc out. If the server refuses some recipients, Ordo
  says which; if it refuses them all, nothing is sent and Ordo says so.
- Replies are threaded (`In-Reply-To` and `References`) and the original is marked as replied. Reply
  all leaves out all your addresses: every account's, iCloud's other spellings (@icloud.com, @me.com
  and @mac.com) and Gmail's (@gmail.com and @googlemail.com, with or without dots); anything in Sent
  counts as yours.
- Forward includes the original's attachments; remove any you don't want.
- **Attach files…** uses the open dialog. The window only sees names and sizes, never paths.
  iCloud can't send much more than 20 MB, so Ordo stops at about 14 MB and 20 files.
- **Save draft** saves to the From account's Drafts, replacing the version saved before, attachments and all. Closing
  with unsaved changes asks whether to keep a draft. Open a draft and choose **Edit draft** to carry
  on; a reply saved as a draft stays in its thread. Sending a draft removes it from Drafts.
- Compose fits a small window: the fields scroll and the buttons stay in view.

## Moving mail

Archive, Move to Bin, Move to Junk and Move to Inbox move the selected message on its own account's
server. Nothing is deleted: Bin is the account's Trash folder (on Gmail, a MOVE to its `\Trash`
folder, as Gmail's Delete does), and Archive on Gmail is All Mail. **Undo move** (or ⌘Z) puts it back for a little while
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
text of messages you've opened, across every folder of every account. Every word must match.
**Search all of … on iCloud** (or Gmail, or every account's server in All Inboxes; Return does the
same) asks the server to search the open folder too, for older mail and the text of messages you
haven't opened.

## The assistant, headless mode and MCP

`mail mailboxes`, `mail sync`, `mail list`, `mail search` and `mail read`, and the matching MCP
tools, are read-only. Every mail command and tool takes an optional account (`--account Work`, by
name, address or id); results name each message's account (`account`, `accountId`), because a uid
is only unique within one account's folder. Without one, `mail list` and `mail sync` cover every
account's inbox and `mail search` every account; the rest use the first account. With `--allow-changes` and a confirm on each call, `mail move`, `mail flag`,
`mail mark` and `mail undo` (and the MCP tools `ordo_mail_move`, `ordo_mail_flag`,
`ordo_mail_mark`, `ordo_mail_undo` and `ordo_mail_draft`) change at most 20 messages at a time,
only ones already in Ordo's cache. They go through the same functions as the window, so they take
the write lock, folders are checked against the server's list, and moves can be undone while that
Ordo is running. Moving into Drafts is refused. Headless mode and MCP can never send. JSON output
escapes control and bidi characters, so it's safe to print. See [headless.md](headless.md).

The in-app assistant (⌘K) can do the same, save drafts, and send a new email, a reply or a forward
after you press Send on a card that shows all of it, including which account it goes from. A reply
or forward goes from the account the message is in. After it changes mail, the Mail page reloads in
place, keeping the folder you're in. See [assistant.md](assistant.md#email).

## For tests

Unpackaged builds can point IMAP and SMTP at a local server with `ORDO_IMAP_HOST`,
`ORDO_IMAP_PORT`, `ORDO_SMTP_HOST` and `ORDO_SMTP_PORT` (with `ORDO_SMTP_SECURE=1` or
`ORDO_SMTP_REQUIRE_TLS=1` if needed), for every account at once: each still signs in with its own
user and password. `ORDO_TEST_ALLOW_LOOPBACK_HTTP=1` lets Load images reach an
http server on 127.0.0.1. Packaged builds ignore all of these.
