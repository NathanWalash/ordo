# Google Calendar in Ordo

Ordo can sign in to a Google account (a personal Gmail account or a Google Workspace work account)
and show its calendars next to iCloud's and the ones added by link. Unlike a calendar added by its
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
scopes are _sensitive_; Gmail's `https://mail.google.com/` is _restricted_ (see "For developers").

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
- Ordo only talks to `oauth2.googleapis.com` and `www.googleapis.com` (and opens
  `accounts.google.com` in your browser). Every request goes through an allow-list that refuses any
  other host, plain http and redirects. The browser comes back to a one-time listener on
  `127.0.0.1` that checks a random `state` value and uses PKCE, as Google recommends for desktop apps
  ([OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app)).
- **Sign out** revokes Ordo's access at Google and deletes the account and its cached events. You can
  also remove Ordo at any time from your Google account's
  [Third-party connections](https://myaccount.google.com/connections) page; Ordo then asks you to sign
  in again.

## Troubleshooting

| What you see                                                  | What to do                                                                                                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Google needs you to sign in to … again" every week           | Your client is External in Testing: refresh tokens last seven days. Click **Sign in again**, or switch to Internal/Personal, or publish the app (see step 1).                |
| "Your Google Workspace administrator doesn't allow this app"  | `admin_policy_enforced` (or `org_internal` for someone else's Internal app). Ask your admin to trust your client ID, or create the client inside your Workspace as Internal. |
| "The Google Calendar API isn't turned on…"                    | Enable the Google Calendar API in your project (step 2), wait a minute, sync again.                                                                                          |
| Google says access is blocked because the app is being tested | An External app in Testing, signed in with an account that isn’t a test user. Add it under **Audience › Test users**.                                                        |
| "Google didn't recognise the OAuth client ID or secret"       | Copy them again from **Clients**; make sure the client type is **Desktop app**. Changing the client ID signs every account out.                                              |
| "Ordo needs every permission on Google's screen…"             | You unticked a permission. Connect again and leave both ticked.                                                                                                              |
| A calendar shows a warning icon                               | Hover it for the reason. Busy or limited: Ordo retries on its own.                                                                                                           |

## For developers

### Tokens for other features (Gmail next)

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

Gmail over IMAP and SMTP needs `https://mail.google.com/` ("The scope for IMAP, POP, and SMTP access
is `https://mail.google.com/`") and the SASL XOAUTH2 mechanism: send
`base64("user=" + email + "\x01auth=Bearer " + accessToken + "\x01\x01")` with
`AUTHENTICATE XOAUTH2` (IMAP) or `AUTH XOAUTH2` (SMTP). On failure the server sends a base64 JSON
challenge and the client must answer with an empty line
([XOAUTH2 protocol](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol)). `imapflow`
(`auth: { user, accessToken }`) and `nodemailer` (`auth: { type: 'OAuth2', user, accessToken }`) both accept an access token for this. On a 401/`AUTHENTICATIONFAILED`,
call `getGoogleAccessToken(id, scopes, { refresh: true })` once and retry. The Gmail API itself doesn't
need to be enabled for IMAP/SMTP as far as Google's documentation says (it doesn't mention it); check
when building it.

`https://mail.google.com/` is a **restricted** scope
([Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)). A public app
asking for it needs restricted-scope verification, and a security assessment only if restricted data
is stored on or sent through servers; personal use, internal apps and development are exempt
([Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)).
With each user's own client (Internal, Personal, or External in Testing) none of that applies, but the
Testing seven-day expiry still does.

### Testing against a fake Google

Unit tests never reach Google: `test/network-guard.ts` blocks anything but loopback, and
`test/fake-google.ts` is an in-process Google on `127.0.0.1` (consent, token, revoke, calendarList,
events with sync and page tokens, instances, ETags and injected 401/410/412/429 failures). The
calendar provider takes an `apiBase`, and the OAuth module takes its endpoints.

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
