# Google Calendar and Gmail in Ordo

Ordo can sign in to a Google account (a personal Gmail account or a Google Workspace work account)
to show its calendars, and to read and send its mail in Mail without an app password ("Sign in with
Google"; see [Gmail with Sign in with Google](#gmail-with-sign-in-with-google)). Both use the same
OAuth client, set up once.

For Calendar, Ordo shows the account's calendars next to iCloud's and the ones added by link. Unlike
a calendar added by its
secret iCal link (or Google added to Apple Calendar as a subscription), this connection is:

- **Near live.** Ordo asks Google for changes every few minutes while it's open, and straight away
  when you come back to the window, when your Mac wakes and after you change something. A
  subscription link is refreshed by Google only every few hours.
- **Two-way.** You can add, change and delete events on calendars your account can edit (owner or
  "make changes to events"), from the Calendar page, the ⌘K assistant and the MCP tools, with the
  same confirmations as iCloud.

Ordo has no Google Cloud project of its own, so it signs in with an OAuth client that **you** create in
your own project. That takes about ten minutes, once. This page walks through it, then explains how
syncing works and what to do if something goes wrong.

## 1. Choose where to create the OAuth client

Google's "Google Auth Platform" (the old "OAuth consent screen") offers three kinds of app, called the
_audience_ or user type. Which one you can use decides how long a sign-in lasts.

| Audience     | Who can use it                                              | Sign-in lasts                      | Notes                                                                                                                                        |
| ------------ | ----------------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Internal** | Accounts in the same Google Workspace organisation          | Until revoked                      | Best for a work calendar, if your work account can create Cloud projects. No verification, no warning screen.                                |
| **Personal** | Only the one Google account that created the project        | Until revoked                      | Newer option. Create the project _with the account whose calendar you want_. Can't be changed to another type later.                         |
| **External** | Anyone you allow; while **Testing**, only listed test users | **7 days** while in Testing status | Works from a personal Gmail project for any account, including a work one (if its admin allows it). You'll have to sign in again every week. |

Facts behind that table, from Google's documentation:

- An External app whose publishing status is **Testing** gets refresh tokens that expire after seven
  days: "a publishing status of "Testing" is issued a refresh token expiring in 7 days"
  ([Using OAuth 2.0](https://developers.google.com/identity/protocols/oauth2)). The only exception is
  an app asking for nothing but name, email and profile, and Ordo also asks for calendar access, so the
  exception doesn't apply. Testing allows up to 100 test users
  ([Manage app audience](https://support.google.com/cloud/answer/15549945)).
- Publishing status "is not applicable to Internal or Personal projects", so the seven-day limit
  doesn't apply to them ([Manage app audience](https://support.google.com/cloud/answer/15549945)).
  Internal apps are "not subject to the unverified app screen or the 100-user cap"
  ([Unverified apps](https://support.google.com/cloud/answer/13464323)). Internal is only offered for
  projects that belong to a Google Cloud organisation (in practice, a Workspace domain).
- **Personal** limits sign-in to the account that created the project; any other account gets a
  `client_user_mismatch` error, and the choice is permanent
  ([Manage app audience](https://support.google.com/cloud/answer/15549945)). It has no publishing
  status, so no seven-day limit and no verification. Google's onboarding for it is at
  `console.cloud.google.com/auth/overview/personal`, which creates the project and a client in one go.
- If you set an External app to **In production** without verifying it, Google shows an "unverified
  app" warning screen when you sign in (choose _Advanced_ and continue), and the project is capped at
  100 new users for its lifetime ([Unverified apps](https://support.google.com/cloud/answer/7454865)).
  Personal use with fewer than 100 users is one of Google's listed reasons verification isn't needed,
  but the warning screen and the cap still apply
  ([Unverified apps](https://support.google.com/cloud/answer/13464323)). Google documents the
  seven-day expiry only for Testing, so a production app's sign-ins shouldn't expire weekly; Google
  doesn't state that in so many words.

**Which should I pick?** For a work calendar, try **Internal** first (create the project while signed
in to the work account, in the work organisation). If you can't create projects there, try
**Personal** with the work account. Failing both, use **External** in Testing from any account and add
the work address as a test user, accepting a weekly sign-in, or publish it unverified and accept the
warning screen.

### Google Workspace admins can block this

A Workspace administrator can restrict which third-party apps may use work accounts. Their settings
are under **Admin console › Security › Access and data control › API controls › Manage App Access**
([Control which apps access Google Workspace data](https://support.google.com/a/answer/7281227)).
"Settings for unconfigured apps" can allow any app (the default), allow only apps that ask for basic
sign-in information, or block all third-party apps. If yours does, Google refuses the sign-in with
`admin_policy_enforced` ([OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)),
and Ordo says your administrator doesn't allow the app.

To allow Ordo, the admin chooses **Configured apps › Configure new app**, enters your OAuth client ID,
and sets its access to **Trusted** (or "Specific Google data" covering Calendar). An **Internal** app
created inside the organisation can be trusted with the "Trust internal apps" checkbox. Ask your IT
team before connecting a work account: they may have a policy about it.

## 2. Create the project and turn on the Calendar API

1. Open the [Google Cloud console](https://console.cloud.google.com/) while signed in to the account
   that should own the project (see the table above). Create a project, for example "Ordo".
2. Go to **APIs & Services › Library**, search for **Google Calendar API** and click **Enable**.
   Without it, Ordo's sync fails with "The Google Calendar API isn't turned on in your Google Cloud
   project".

(Google's own walk-through of these steps is in the
[Calendar API Node.js quickstart](https://developers.google.com/workspace/calendar/api/quickstart/nodejs).)

## 3. Configure the Google Auth Platform (consent screen)

1. Go to **Menu › Google Auth platform › Branding**. If it says "Google Auth platform not configured
   yet", click **Get started**.
2. **App information:** an app name ("Ordo") and your email as the user support email.
3. **Audience:** Internal, External or Personal (see above).
4. **Contact information:** your email. Agree to the Google API Services User Data Policy and click
   **Create**.
5. External only: open **Audience** and add the Google account(s) you'll connect under **Test users**.
   (Leave the app in Testing, or click **Publish app** to move it to In production; see the table.)
6. Optional: under **Data Access** you can add the two scopes Ordo asks for (below). The console then
   shows which of your scopes Google treats as sensitive or restricted.

The console's left-hand menu is Overview, Branding, Audience, Clients, Data Access and Verification
Center ([Google Auth Platform](https://support.google.com/cloud/answer/15544987)).

## 4. Create a Desktop app client

1. Open **Clients › Create client**.
2. Application type: **Desktop app**. Name: "Ordo". Click **Create**.
3. Copy the **Client ID** (it ends in `.apps.googleusercontent.com`) and the **Client secret**. In
   Personal mode the secret is shown only once, so copy it before closing the dialog.

Google issues desktop apps a secret too, though "the client secret is obviously not treated as a
secret" for installed apps ([Using OAuth 2.0](https://developers.google.com/identity/protocols/oauth2)).
Ordo stores it in your keychain anyway.

## 5. Connect in Ordo

1. In Ordo, open **Settings › Google**, paste the client ID and secret, and click **Save client**.
2. Click **Connect Google account**. Your browser opens Google's sign-in page (never a window inside
   Ordo). Choose the account, then allow both permissions. If you untick one, Ordo can't work and saves
   nothing.
3. The browser says you're signed in; go back to Ordo. Your calendars appear under the account's
   email in Settings and on the Calendar page within a few seconds.

In **Settings › Google** you can then choose which calendars to show and their colours, see when each
last synced (or why it didn't), sign in again, and sign out. If you'd added the same calendar by its
Google iCal link, Ordo offers to replace that link with the live connection.

### What Ordo asks for

| Scope                                                            | Why                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| `openid`, `email`                                                | To know which account signed in, and show its email.                |
| `https://www.googleapis.com/auth/calendar.calendarlist.readonly` | To list your calendars (names, colours, whether you can edit them). |
| `https://www.googleapis.com/auth/calendar.events`                | To read events and add, change and delete them.                     |

That's the least that works: `calendar.events` alone can't list calendars (`calendarList.list` takes
only `calendar`, `calendar.readonly`, `calendar.calendarlist` or `calendar.calendarlist.readonly`;
[calendarList.list](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list)),
and the full `calendar` scope would also let Ordo change calendars themselves and who they're shared
with ([Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth)). Calendar
scopes are _sensitive_; Gmail's `https://mail.google.com/` is _restricted_ (see below). Ordo asks
for the mail scope only when you add a Gmail account with Sign in with Google, and the Calendar ones
only when you connect Calendar.

## Gmail with Sign in with Google

In **Settings → Accounts → Add account… → Gmail**, **Sign in with Google** (the default) adds a
Gmail account without an app password. It works for accounts that can't have app passwords, such as
most work and school accounts, if their admin allows it (see below).

1. Set up your OAuth client first (steps 1 to 4 above; you don't need the Calendar API for Mail).
   Without one, the sheet says so and takes you to **Settings → Google**.
2. Choose the Google account: one already connected for Calendar, or **Another Google account**.
3. Your browser opens Google's consent page. Allow Ordo to "read, compose, send and permanently
   delete all your email from Gmail": that's Google's one scope for IMAP and SMTP, there's no
   narrower one. Ordo then signs in to Gmail with the new token and saves the account only if that
   works. Its address comes from Google.

What it asks for:

| You start from                      | Google's consent asks for                                                                                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A new sign-in                       | `openid`, `email` and `https://mail.google.com/` only. Calendar stays off until you choose **Add Calendar** in Settings → Google.                                                   |
| An account connected for Calendar   | Everything it already allows, plus `https://mail.google.com/`, for that account: Google doesn't do incremental authorization for desktop apps, so the whole set is asked for again. |
| An account that already allows mail | Nothing: Ordo uses it straight away.                                                                                                                                                |

Gmail is reached at `imap.gmail.com:993` and `smtp.gmail.com:465`, both TLS from the start, as Google
lists them ([IMAP, POP and SMTP](https://developers.google.com/workspace/gmail/imap/imap-smtp));
`smtp.gmail.com:587` with STARTTLS is the alternative. A Google token is only ever sent to those two
servers: an account that signs in with Google always uses Gmail's preset, whatever `accounts.json`
says. Folders work as with an app password: special folders by their SPECIAL-USE flags, and your
labels as folders (see [mail.md](mail.md#gmail)).

### When Google stops accepting the sign-in

Ordo asks Google for a fresh access token (they last about an hour) whenever it connects. If Gmail
refuses one anyway, Ordo refreshes it and tries once more, never more than that, and never with
anything else (there's no password to fall back to). If Google itself refuses (you removed Ordo
from [Third-party connections](https://myaccount.google.com/connections), changed your password,
a week passed with an External app in Testing, or the account never gave mail access), the account
says why in Settings → Accounts and Mail, checks less often (as with a wrong password), and offers
**Sign in again**. That opens Google's consent for the same account (with its address filled in);
signing in as a different account is refused.

### Removing the account, and signing out of Google

- **Removing the mail account** (Settings → Accounts → Remove…) clears its downloaded mail as for any
  account, but leaves the Google sign-in in Settings → Google, because Calendar may use it. The mail
  permission stays granted until you sign out there (or remove Ordo in your Google account); adding
  the account again then needs no new consent.
- **Signing out of Google** (Settings → Google → Sign out) revokes Ordo's access, which ends the
  sign-in for Mail too. So when mail accounts use it, Ordo asks first, listing them, and removes them
  as Remove… does (downloaded mail cleared, nothing changed in Gmail). Without that confirmation the
  main process refuses to sign out.

### Restricted scope: what it means for your OAuth client

`https://mail.google.com/` is a **restricted** scope
([Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)). With your own
client (as Ordo needs), this is what each audience means:

- **Internal** or **Personal**: no verification, no warning screen, no seven-day limit. Best if you
  can use one.
- **External, Testing**: works for the test users you list (up to 100), after a warning screen.
  Refresh tokens expire after seven days, so Gmail asks you to **Sign in again** every week
  ([Using OAuth 2.0](https://developers.google.com/identity/protocols/oauth2)). Google also expires
  tokens with Gmail scopes when you change your password, and after six months unused.
- **External, In production, unverified**: the "Google hasn't verified this app" screen (choose
  _Advanced_ and continue) and a lifetime cap of 100 users
  ([Unverified apps](https://support.google.com/cloud/answer/7454865)). Restricted-scope verification
  (and its security assessment) is for apps offered to the public; personal use (you, or a few people
  you know) is exempt
  ([Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)).

**The Gmail API doesn't need turning on for this, as far as Google documents.** Ordo doesn't call the
Gmail API: it uses IMAP and SMTP with the XOAUTH2 mechanism. Google's pages on that
([IMAP, POP and SMTP](https://developers.google.com/workspace/gmail/imap/imap-smtp) and
[XOAUTH2](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol)) only say the scope
needed is `https://mail.google.com/`, and don't mention enabling any API. We couldn't find Google
saying either way, so if Gmail refuses a fresh token with no other explanation, enabling the Gmail API
in **APIs & Services › Library** is a harmless thing to try.

You can add `https://mail.google.com/` under **Data Access** in the Google Auth Platform to see it
listed as restricted; it isn't required for signing in.

### Google Workspace: what admins can block

On top of the app access controls described in step 1, a Workspace admin can:

- **Turn IMAP off** for users: **Admin console › Apps › Google Workspace › Gmail › End User Access ›
  POP and IMAP access**, "Enable IMAP access for all users" (per organisational unit). Then Gmail
  refuses Ordo's sign-in even with a valid token, and Ordo says your admin may have turned IMAP off.
- **Allow only some mail apps:** in the same setting, "Restrict which mail clients users can use
  (OAuth mail clients only)" with a list of OAuth client IDs. Ask your admin to add **your** client ID
  (Ordo has none of its own).
  ([Turn POP and IMAP on and off for users](https://support.google.com/a/answer/105694))
- **Restrict Gmail for third-party apps:** under **Security › Access and data control › API controls ›
  Manage Google Services**, Gmail can be set to Restricted; `https://mail.google.com/` is one of its
  high-risk scopes, and untrusted apps then can't use it. Trusting your client ID (as for Calendar)
  allows it ([Control which apps access Google Workspace data](https://support.google.com/a/answer/7281227)).

Personal Gmail accounts have IMAP on all the time: Google removed the setting in January 2025
([Gmail IMAP settings](https://support.google.com/mail/answer/7126229)).

## How syncing works

- **Incremental sync.** The first sync of each calendar fetches all its events (2,500 per page). Google
  then gives a sync token, and each later sync fetches only what changed since, deletions included. If
  Google says the token is too old (`410 Gone`), Ordo does a full sync again
  ([Synchronize resources efficiently](https://developers.google.com/workspace/calendar/api/guides/sync)).
- **Near live, by polling.** While Ordo is open it syncs Google every three minutes (give or take 15%,
  so it doesn't hit Google in lockstep), when the window comes back into focus or the computer wakes
  (not more than once every 30 seconds), soon after you show a hidden calendar, and a moment after you
  change an event. After an error it backs off (6, 12, 24, then every 30 minutes) and never tries
  before the `Retry-After` time Google asks for when it's limiting requests
  ([Calendar API errors](https://developers.google.com/workspace/calendar/api/guides/errors)).
- **Why not push notifications?** Google's push notifications (`events.watch`) post to a public
  HTTPS address with a valid certificate ([Push notifications](https://developers.google.com/workspace/calendar/api/guides/push)).
  A desktop app doesn't have one, so Ordo polls instead.
- Hidden calendars aren't fetched until you show them. The manual sync button and `ordo calendar sync`
  sync Google with everything else.

### What's shown

Repeating events are expanded from their rule (with changed and cancelled occurrences) exactly as for
iCloud, one month back and a year ahead. All-day events stay on their dates in any time zone. Events
you've declined are hidden, as in Google Calendar, and so are working-location banners ("Home",
"Office"). HTML descriptions are shown as plain text. An event that uses your calendar's default
reminders shows no alert in Ordo's editor (the reminder still happens in Google).

### Changing events

- Ordo sends only the fields you changed, and only if the event is still the version it last saw
  (`If-Match` with the event's ETag). If it changed in Google Calendar meanwhile, Google answers
  `412 Precondition Failed`: nothing is overwritten, Ordo fetches the latest version and tells you
  ([Version resources](https://developers.google.com/workspace/calendar/api/guides/version-resources)).
- **This event only** changes or deletes that occurrence's own event, as Google Calendar does. Ordo
  first checks the series itself hasn't changed. **All events** changes the series; when the series
  moves, Google decides which changed occurrences to keep, and the next sync shows them.
- Guests aren't emailed about changes Ordo makes (`sendUpdates=none`). Their calendars still update.
- Ordo won't change someone else's invitation (change it in Google Calendar, so the organiser hears
  about it), events on calendars shared with you read-only, out-of-office, focus-time, birthday and
  Gmail events, or alerts after an event starts (Google can't do those).

## Privacy and security

- Your refresh token and client secret are encrypted with the OS keychain (Electron `safeStorage`)
  in `google.json` in Ordo's profile folder. Access tokens stay in memory and last about an hour.
- For sign-in and Calendar, Ordo only talks to `oauth2.googleapis.com` and `www.googleapis.com` (and
  opens `accounts.google.com` in your browser). Every request goes through an allow-list that refuses
  any other host, plain http and redirects. Mail goes to `imap.gmail.com` and `smtp.gmail.com` only,
  over TLS; the access token never goes anywhere else, and never to the window.
- A Gmail account that signs in with Google keeps no secret in `accounts.json`: just which Google
  account it uses (Google's account id). The tokens stay in `google.json`. The browser comes back to a one-time listener on
  `127.0.0.1` that checks a random `state` value and uses PKCE, as Google recommends for desktop apps
  ([OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)).
- **Sign out** revokes Ordo's access at Google and deletes the account and its cached events (and,
  once you confirm, the mail accounts that use it). You can
  also remove Ordo at any time from your Google account's
  [Third-party connections](https://myaccount.google.com/connections) page; Ordo then asks you to sign
  in again.

## Troubleshooting

| What you see                                                   | What to do                                                                                                                                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Google needs you to sign in to … again" every week            | Your client is External in Testing: refresh tokens last seven days. Click **Sign in again**, or switch to Internal/Personal, or publish the app (see step 1).                |
| "Your Google Workspace administrator doesn't allow this app"   | `admin_policy_enforced` (or `org_internal` for someone else's Internal app). Ask your admin to trust your client ID, or create the client inside your Workspace as Internal. |
| "The Google Calendar API isn't turned on…"                     | Enable the Google Calendar API in your project (step 2), wait a minute, sync again.                                                                                          |
| Google says access is blocked because the app is being tested  | An External app in Testing, signed in with an account that isn’t a test user. Add it under **Audience › Test users**.                                                        |
| "Google didn't recognise the OAuth client ID or secret"        | Copy them again from **Clients**; make sure the client type is **Desktop app**. Changing the client ID signs every account out.                                              |
| "Ordo needs every permission on Google's screen…"              | You unticked a permission. Connect again and leave both ticked.                                                                                                              |
| A calendar shows a warning icon                                | Hover it for the reason. Busy or limited: Ordo retries on its own.                                                                                                           |
| A Gmail account says "Google stopped accepting Ordo's sign-in" | Choose **Sign in again** on its row in Settings → Accounts. Every week: your client is External in Testing (see step 1).                                                     |
| "Gmail didn't accept Ordo's Google sign-in"                    | Google gave a fresh token and Gmail still refused it: for a work account, IMAP may be off or limited to some mail apps (see Workspace above). Otherwise sign in again.       |
| "… hasn't given Ordo permission to read and send mail"         | The account's grant doesn't include mail (you unticked it, or it was connected for Calendar only). Choose **Sign in again** and leave every box ticked.                      |

## For developers

### Tokens for other features (Calendar and Gmail)

The Google module lives in `apps/desktop/src/main/google/`:

- `oauth.ts`: PKCE, the consent URL, the loopback listener, the token, refresh and revoke calls
  (no Electron).
- `auth.ts`: `GoogleAuth`, the account store (secrets through a `SecretBox`), automatic refresh,
  `invalid_grant` → needs sign-in again, sign-out (no Electron).
- `fetch.ts`: the allow-list (`googleFetch`, `checkEndpoints`, `isConsentUrl`).
- `index.ts`: the Electron glue, and the two functions other features call:

```ts
// An access token covering `scopes` for a connected account, refreshed when needed.
// Throws GoogleScopeError (with .missing) if the account never granted a scope, and
// GoogleReauthError if the user must sign in again.
getGoogleAccessToken(accountId: string, scopes: readonly string[], options?: { refresh?: boolean }): Promise<string>

// Ask a connected account for more scopes (e.g. SCOPES.mail). Google doesn't support
// incremental authorization for installed apps ("Incremental authorization is not supported
// for installed apps or devices": https://developers.google.com/identity/protocols/oauth2/native-app),
// so this shows consent for everything the account already granted plus `extra`, with
// login_hint set to the account, and the new refresh token replaces the old one.
requestGoogleScopes(accountId: string, extra: readonly string[]): Promise<GoogleAccountInfo>
```

### How Gmail uses it

Gmail over IMAP and SMTP needs `https://mail.google.com/` ("The scope for IMAP, POP, and SMTP access
is `https://mail.google.com/`") and the SASL XOAUTH2 mechanism: send
`base64("user=" + email + "\x01auth=Bearer " + accessToken + "\x01\x01")` with
`AUTHENTICATE XOAUTH2` (IMAP) or `AUTH XOAUTH2` (SMTP). On failure the server sends a base64 JSON
challenge and the client must answer with an empty line
([XOAUTH2 protocol](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol)).

- `AccountAuth` has `{ kind: 'oauth'; provider: 'google'; googleAccountId }` (Google's `sub`).
  `accounts.json` stores no secret for it, and always gives it Gmail's preset servers.
- `main/auth.ts`: `AUTH.oauth` calls `getGoogleAccessToken(googleAccountId, [SCOPES.mail], { refresh })`
  and returns `{ user: email, accessToken }`. `GoogleReauthError`, `GoogleScopeError` and an account
  that's no longer connected become `SignInAgainError` (a `MailAuthError`, so the existing auth error
  state and back-off apply). `withCredentials` runs a connection and, for a Google sign-in only, retries
  once with `{ refresh: true }` when the server refuses the token (`AUTHENTICATIONFAILED`, SMTP 535 /
  `EAUTH`). Every connection goes through it: `connectImap`, `testAccountLogin` and `withSmtp` in
  `main/mail.ts`.
- `imapflow` gets `auth: { user, accessToken }`; `nodemailer` gets
  `auth: { type: 'OAuth2', user, accessToken, provisionCallback }`, where `provisionCallback` refuses
  to renew, because nodemailer would otherwise answer a refused token by sending the same token again.
- `imapflow` prefers `AUTH=OAUTHBEARER` (RFC 7628) over `AUTH=XOAUTH2` when a server advertises both.
  Gmail's capability list includes both as far as we know, so against real Gmail the IMAP sign-in is
  probably OAUTHBEARER, with the same token and scope. Not verified here (no real Gmail in tests).
- `main/google-mail.ts`: adding an account (`MAIL_SCOPES` for a new sign-in, `requestGoogleScopes`
  for a connected account without mail) and Sign in again. A Google sign-in made just for an add that
  then fails is signed out again, so nothing is left behind.
- `signOutGoogle(id, { removeMail })` in `main/calendar.ts` refuses while mail accounts use the sign-in
  unless every one is listed, then removes them before revoking.
- Calendar only syncs Google accounts that granted the Calendar scopes (`hasCalendarScopes`), so a
  Mail-only sign-in is never polled. `connect({ accountId, addCalendar: true })` adds Calendar to it.

### Testing against a fake Google

Unit tests never reach Google: `test/network-guard.ts` blocks anything but loopback, and
`test/fake-google.ts` is an in-process Google on `127.0.0.1` (consent, token, revoke, calendarList,
events with sync and page tokens, instances, ETags and injected 401/410/412/429 failures). The
calendar provider takes an `apiBase`, and the OAuth module takes its endpoints.

GreenMail doesn't speak XOAUTH2, so `test/fake-xoauth2.ts` is a small IMAP and SMTP server on
`127.0.0.1` that signs in only with XOAUTH2 exactly as Google documents it (the payload format, the
base64 JSON challenge, the empty answer, then `NO [AUTHENTICATIONFAILED]` or `535`). Unit tests and
`e2e/mail-google.spec.ts` run the real imapflow and nodemailer against it, with the fake Google's
tokens.

An unpackaged build can be pointed at a fake with `ORDO_GOOGLE_BASE_URL=http://127.0.0.1:<port>`;
`ORDO_TEST_GOOGLE_AUTO_CONSENT=1` follows the fake's consent redirect in the main process instead of
opening a browser. Packaged builds ignore both and refuse any endpoint that isn't Google's own; a
development build refuses any that isn't loopback.

### References

- OAuth 2.0 for installed apps (loopback, PKCE, endpoints): https://developers.google.com/identity/protocols/oauth2/native-app
- Using OAuth 2.0 (Testing refresh-token expiry, desktop client secret): https://developers.google.com/identity/protocols/oauth2
- Manage app audience (Internal, External, Personal; Testing; test users): https://support.google.com/cloud/answer/15549945
- Unverified apps (warning screen, 100-user cap, exceptions): https://support.google.com/cloud/answer/7454865 and https://support.google.com/cloud/answer/13464323
- Google Auth Platform console: https://support.google.com/cloud/answer/15544987
- Sensitive scope verification: https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification
- Restricted scope verification: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- Workspace admin app access control: https://support.google.com/a/answer/7281227
- Calendar API scopes: https://developers.google.com/workspace/calendar/api/auth
- Incremental sync: https://developers.google.com/workspace/calendar/api/guides/sync
- events.list: https://developers.google.com/workspace/calendar/api/v3/reference/events/list
- events.instances: https://developers.google.com/workspace/calendar/api/v3/reference/events/instances
- Calendar API errors and back-off: https://developers.google.com/workspace/calendar/api/guides/errors
- ETags and conditional changes: https://developers.google.com/workspace/calendar/api/guides/version-resources
- Push notifications (why Ordo polls): https://developers.google.com/workspace/calendar/api/guides/push
- Gmail XOAUTH2: https://developers.google.com/workspace/gmail/imap/xoauth2-protocol
- Gmail API scopes: https://developers.google.com/workspace/gmail/api/auth/scopes
- Gmail IMAP, POP and SMTP (servers, ports, OAuth): https://developers.google.com/workspace/gmail/imap/imap-smtp
- Workspace: turn POP and IMAP on and off, OAuth-only mail clients: https://support.google.com/a/answer/105694
- Gmail IMAP always on for personal accounts (January 2025): https://support.google.com/mail/answer/7126229
