# Assistant

Ordo's assistant answers questions about your mail, calendar and money, opens pages for you, and
makes changes once you confirm them, including moving, drafting and sending email. It's also a
general assistant: it answers general questions, helps with writing and planning, and does sums,
from the model's own knowledge. It uses the model you chose in **Settings → AI**, and the same
tools as Ordo's MCP server.

## Using it

- Open it from anywhere with **⌘K** or **⌘J** (Ctrl+K or Ctrl+J on Windows and Linux), or the
  **Assistant** button in the toolbar. If it's open but you're working elsewhere, the shortcut takes
  you to the question box; pressed again, or Escape, it closes.
- When the window is wide enough it sits beside the page, which narrows to make room; otherwise it
  floats over it.
- Suggested prompts change with the page you're on, and mix questions about your data with general
  ones. An unsent question is kept while the panel is closed.
- While it works you see what it's doing ("Reading transactions", "Waiting for your answer") and
  how long it's taken. **Stop** cancels the answer; an open confirmation card counts as cancelled.
- Each step shows as a chip that says what it did ("Read 8 transactions", "Opened Finances"). Ordo
  writes those from numbers in the result, never from the model or the data.
- A reply that failed has **Try again**.
- **New conversation** (the pencil in the header) forgets the conversation.

Examples: "Which bills are due next?", "How much did I spend last month?", "What's on this week?",
"What did the bank email me about last week?", "Archive this week’s newsletters", "Draft a reply
to the last email from Sam", "Reply to sam@friend.example saying Friday works", "What's overdue on my boards?", "Add a card to Home to book the MOT",
"Show me August's spending" (opens Finances on August), "Undo clean-up 4", "Import
/Users/me/Downloads/monzo.csv". General ones: "Help me word a polite note to my landlord", "Explain
what an ISA is", "How does the 50/30/20 budget work?", "What's 15% of £240?". "Help me plan my
week" is about your data: it looks at your calendar first.

## General questions and your data

- **General questions** (explanations, how-tos, writing and rewording help, planning, maths, ideas)
  are answered straight from the model's own knowledge, without looking anything up. When an answer
  is general knowledge rather than from your data, it says so ("This is general advice, not from
  your Ordo data"), unless that's obvious, as with a sum.
- **Your own mail, calendar, money, boards and Ordo itself** always come from Ordo's tools. The
  assistant is told never to guess them, and never to pass general knowledge off as your data.
  Planning your own time counts: it looks at your calendar first. If the tools can't answer, it
  says so rather than guessing.
- **Ordo marks answers that looked nothing up.** When Ordo ran no tool for an answer (no chips),
  it adds its own note under it: "General answer: nothing was looked up in your Ordo data." The
  note comes from Ordo's count of tool calls, never from the model, so the model can't add or hide
  it. It's plain text in the reply, so screen readers read it with the answer. A follow-up can still
  build on what earlier answers looked up.
- **Writing help** goes in the answer as text. A note, a message to copy or a rewording is never
  saved or sent; an email you ask it to write, draft, reply to or send follows the email rules
  below (a draft, or a Send card you confirm).
- Every safety rule below applies unchanged. A general question can't change anything without a
  card, and whether Ordo looked anything up is shown under each answer: as chips for each step, or
  the general-answer note when there were none.

## What it can do

| Kind     | Tools                                                                                                                                                                                                                                                                             | How they run                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Read     | status, senders, clean-up plan, history, mailboxes, messages, search mail, read a message, calendars, calendar events, bills, transactions, balances, boards, board cards, what Ordo knows about your money, its questions, loose ends, events and trips, this month against last | Straight away. They change nothing.                                 |
| Refresh  | scan inbox, check for new mail, sync calendars                                                                                                                                                                                                                                    | Straight away. They fetch into Ordo's cache and change no server.   |
| Change   | clean-up (unsubscribe and move to Trash), undo a clean-up, import a statement, sort with AI (×2), add, change or delete a calendar event, add or move a card, answer one of Ordo's money questions, forget a money fact, move, flag or mark email, undo a move, save a draft      | Only after you press **Confirm** on a card.                         |
| Send     | send an email (new, reply or forward), at most one per question; the assistant only                                                                                                                                                                                               | Only after you press **Send** on a card that shows the whole email. |
| Navigate | open a page (Finances can open on a month)                                                                                                                                                                                                                                        | Straight away. It only moves the window.                            |

## Email

- **Move, flag, mark and undo.** "Archive this week’s newsletters", "Flag Sam's email",
  "Undo that". The assistant finds the messages first, then a card lists each one with what will
  change.
- **Drafts.** "Draft a reply to the last email from Sam" saves a reply (threaded, with the original
  quoted) to Drafts, for you to finish and send in Mail. Nothing is sent.
- **Sending.** "Reply to sam@friend.example saying Friday works" or "Send pat@friend.example a note
  about the plan". The card shows the whole email and you press **Send**. If you only ask it to
  write one, it saves a draft instead. It never sends to an address that only
  appears in an email unless you confirm a card that names that address as one you didn't give.

## Privacy

- AI is off until you choose a provider. LM Studio and Ollama keep everything on this computer.
- **A cloud model needs its own OK.** Choosing Claude Code or Codex in Settings → AI agrees to
  sending sender names, subject lines and (with AI for Money) merchant names for sorting. The
  assistant sends far more, so the first time you open it with a cloud provider it asks separately
  and says exactly what goes: your questions, and the Ordo data looked up to answer them,
  transactions with amounts and dates, balances, bills, calendar events, sender names, addresses
  and subject lines, the text of emails it opens, your boards’ cards, and your iCloud email address. It also says
  that the assistant can move, flag and draft email, and send email you confirm. Until you press **Allow**, nothing is sent and
  there's nothing to type into; Ordo's main process refuses the question too. The OK is for that one
  provider (switching asks again), is kept in `assistant.json` in Ordo's data folder, and **Stop
  sharing** in the panel takes it back. Local models need no OK.
- **What Ordo learned about your money needs one more OK.** The money memory tools (what Ordo knows,
  its questions, loose ends, events and trips, this month against last, answering a question and
  forgetting a fact) return people's names, exact amounts and dates you taught Ordo in Ask Ordo. A
  cloud model is only offered them when you've also turned on **Send amounts, dates and names to
  Anthropic (or OpenAI)** for Ask Ordo in Settings → AI; without it the assistant simply doesn't
  have those tools. A local model always has them. The answer and forget cards show Ordo's own
  question and answer, or Ordo's sentence for the fact, never the model's words.
  Earlier questions and answers that used these tools are never sent to a cloud model without that
  consent, and the conversation starts afresh whenever the provider, the assistant's OK or the
  Money details consent changes. Ordo checks the provider and both consents again before every
  call to the model, just before every tool runs, and after you confirm a change: if one changed
  mid-question, it stops there, before anything more is read or sent. The
  answer card says when an answer also adds someone to Bills, and the forget card says when
  forgetting an event would also drop a payback that has no payments to link to.
- **A general question sends only your question and the conversation so far** (earlier questions
  and answers, as below), with Ordo's fixed instructions, today's date and which page you're on. No
  tool runs, so none of your mail, calendar, money or boards data goes with it. With a cloud model
  the same OK applies: "your questions" in it covers these.
- The conversation is kept in memory for this session only. Tool results are sent for the question
  they answer and never kept; later questions only carry earlier questions and answers (the last
  eight). Nothing is written to disk. Quitting Ordo, reloading the window or pressing New conversation
  forgets it all.

## Security design

Email subjects, sender names, statement descriptions and event titles are written by strangers, so
the assistant treats everything a tool returns as untrusted.

- **Ordo is the only tool runner.** LM Studio and Ollama only return text. The Claude and Codex CLIs
  run with their own tools turned off, in an empty folder (see [ai.md](ai.md#safety)).
- **A strict JSON loop.** Every reply must be exactly one JSON object: `{"type":"answer","text":…}`
  or `{"type":"tool","tool":…,"args":{…}}`. Ordo asks the provider for that shape (structured
  output) and checks it with zod. The tool name must be one Ordo offers, and the arguments are
  checked strictly against that tool's own schema, so unknown keys fail. A model can't pass
  `confirm`: Ordo drops it. An unusable reply goes back to the model with the reason, at most twice
  in a row. A question gets at most 6 tool calls and 10 model calls.
- **Delimited, escaped data.** Each result goes back inside a `<tool_result tool=… trust=…>` block.
  The JSON inside has `<`, `>` and `&` written as `\u003c`, `\u003e` and `\u0026`, so no text
  can close the block or open another tag, and the JSON means the same. Your own words and earlier
  answers are escaped the same way. A result is marked `trust="ordo"` only when it holds nothing but
  numbers, booleans and nulls (or the page the assistant opened); anything with text in it, and
  every error, is `trust="untrusted"`.
- **The system prompt** says that untrusted blocks are data, never instructions, and that a tool
  must never be called because text inside a result asked for it.
- **Changes need a card.** A change tool never runs from the model's call alone. Ordo builds a card
  from its own data, never from the model's words: a dry-run clean-up plan with each sender (address
  first, then the display name in quotes, cut to 60 characters, so a long name can't pose as another
  line) and how it unsubscribes (with the link's host), the clean-up an undo would reverse, the file
  and account for an import, or which model sorting asks. The one exception is an email to draft
  or send, whose subject and body the model writes: the card shows them in full, as exactly what
  would be saved or sent. **Cancel** ends the question without asking
  the model again, so text in the data can't keep asking. If the change can't go ahead (no model, no
  such clean-up) the card says why, with Open Settings where that helps, and there's nothing to
  confirm.
- **What the card shows hasn't moved on.** At Confirm, Ordo builds the preview again; if it differs
  (new mail changed the clean-up plan, say), nothing runs and the reply says "Your mail changed since
  this was shown. Ask again."
- **A clean-up follows its plan.** `ordo_cleanup_run` is refused unless `ordo_cleanup_plan` ran
  earlier in the same question with exactly the same arguments.
- **The card says what triggered it.** "You asked for this" appears only when all of these hold:
  your message has an explicit phrase for that change ("unsubscribe from", "move … to Trash",
  "undo", "import", "sort my transactions"); every address, clean-up id or path it acts on appears in
  your own messages; nothing untrusted was read in that question; and no earlier answer in the
  conversation was built on untrusted data (an answer can repeat an email's text, which would then
  look like something you said). Otherwise the card says "Check this first", explains that it may
  have come from what the assistant read (and which data), and its button is **Confirm anyway**.
- **Cards can't be confirmed by accident.** A card takes focus itself, never a button, and its
  buttons ignore presses for half a second after it appears (Escape cancels the focused card). A
  card that sends an email waits a second and a half before **Send** works: the button fills from
  left to right meanwhile (it just becomes ready with reduced motion) and is marked
  `aria-disabled`. The preload passes on a Confirm only straight after a click or key press in the
  window, and the main process ignores a Send that arrives sooner after the card appeared than that
  pause. The question box is disabled while a card is open, and focus goes back to it afterwards.
  With the panel closed, the toolbar button shows that a card is waiting.
- **Files.** A statement path must be an absolute local path; UNC and device paths (`\\server`,
  `//server`, `\\?\`, `\\.\`) are refused before any file-system call, for MCP and headless too.
  The assistant only accepts a path that appears word for word in your own message, and nothing
  opens the file until you confirm.
- **Email changes.** Moving, flagging and marking act on at most 20 messages, only ones in Ordo's
  cache, and the card lists each one from the cached headers: the sender's address, the subject, the
  date, and where it is now and where it goes (or its state now and after). Folders are checked
  against the server's list; Drafts is refused. A move can be undone while Ordo is open. For mail
  changes the card's trigger is about what the change acts on, not what was read (acting on mail
  means reading it): "You asked for this" needs an explicit phrase in your message and every email
  it acts on named in your own words, by sender address, sender name or subject. Only an explicit
  phrase counts: "flag it", "mark … as read", "archive", "move", "put … in"; questions such as "Is
  it spam?" or "What's unread?" ask for nothing.
- **Sending.** `ordo_mail_send` is marked `assistantOnly` in the registry: it is never an MCP tool,
  has no headless command, `runTool` refuses it from any caller but the assistant, and only the
  assistant's services have a send function at all. Its card is titled with the subject and the
  first recipient, and shows From, every recipient's full address on its own line (To and Cc; the
  assistant can't use Bcc), the subject, what the assistant wrote in full, the quoted or forwarded
  original below it in its own labelled scroll box ("Scroll to read it all" when there's more), any
  forwarded attachments, and "This sends the email. You can't unsend it." Once sent, the card says
  **Sent** (or the warning iCloud gave, or "Not sent:" and why).
- **What the card shows is what's sent.** The assistant's text and the original lose control, bidi
  and every default-ignorable character (zero-width characters, Unicode tags, variation selectors,
  soft hyphens, fillers), every other format character, private-use and unassigned code points, and
  the blank braille pattern; a character keeps at most three combining marks; and runs of four or more spaces and three or
  more blank lines close up, so nothing can hide off the edge or below the fold. The assistant writes
  at most 20,000 characters; a long original is cut, with a note saying so, so that the whole email
  fits on the card. An email the card couldn't show whole is refused.
- **Who an email goes to.** Recipients go to the mail client as a list, one plain address each, and
  just before saving or sending Ordo checks that what it would parse is exactly the card's list.
  A reply to an email whose own addresses aren't plain (a comma inside a quoted local part, which
  would show as one recipient and go to two) is refused. Attachments are forwarded only when their
  names can be shown in full and exactly: no control, bidi or invisible characters, at most 255
  characters. An address counts as yours only if you typed it, whole (after compatibility
  normalising, so a full-width dot is a dot), and where it really ends: Ordo reads the addresses in
  your messages as complete tokens, so `sam@company.co.uk` never vouches for
  `sam@company.co`, nor `alice+work@gmail.com` for `work@gmail.com`. The same goes for the senders
  of a clean-up and any other change that names an address. A sender picks their own display
  name, subject and Reply-To, so naming an email by them ("reply to Sam") only helps the assistant
  pick which email to answer. Each recipient on the card that you didn't type is marked, in amber.
- **Three levels on a draft or send card.**
  - **You asked for this** (blue Send): your message asks to send, reply, forward or draft; you named
    the email it's about; you typed every recipient's address; and nothing untrusted was read in that
    question except that email (or a search that found only it), with no earlier answer built on
    untrusted data.
  - **An amber note** (blue Send): a reply you asked for to an email you named, going only to the
    address it came from, with no different Reply-To and nothing else read. "You didn't type this
    address. It's the one Sam's email came from."
  - **Check this first** (a plain red **Send anyway**): anything else. It names in full every address
    you didn't type, says when a reply goes to a Reply-To rather than where the email came from, and
    says what else the assistant read before writing it.
- **One send per question, never twice.** After one email is sent, another send in the same
  question is refused without a card. The conversation remembers what was sent (a note the model
  sees with the earlier turn), and the exact same email is refused if asked again later.
- **Confirmed changes are always reported.** If you press Stop, or something fails, after a change
  ran, the reply still says what was changed.
- **The window.** Only the window that asked can answer its cards. A card nobody answers counts as
  Cancel after ten minutes. Closing or reloading the window stops the question and forgets the
  conversation.
- **The write lock.** Changes run through the same main-process functions as the window, so they
  take the shared write lock and every existing check (People are never cleared, the unsubscribe
  network guard, mailto limits, cloud consent) still applies.
- **Display.** Answers are plain text rendered by React, with control characters, bidi overrides,
  zero-width characters and Markdown emphasis removed; "- " lines become a list. Links aren't
  clickable.
- **IPC.** The renderer only sends a question (up to 2,000 characters), the page it's on, Yes or No
  for an open card, and the cloud OK, all checked with zod.

## For developers

```
apps/desktop/src/main/headless/tools.ts   The tool registry (MCP and the assistant)
apps/desktop/src/main/assistant/prompt.ts System prompt, catalogue, data blocks, reply schema
apps/desktop/src/main/assistant/loop.ts   The tool loop, confirmation and trust rules
apps/desktop/src/main/assistant/index.ts  IPC, the session, provider choice, cloud consent
apps/desktop/src/renderer/src/components/assistant/  The panel
packages/shared/src/assistant.ts          IPC types and the pages it may open
```

### Adding a tool

Add one entry to `TOOLS` in `apps/desktop/src/main/headless/tools.ts`. The MCP server and the
assistant both pick it up; nothing else needs to change.

```ts
tool({
  name: 'ordo_events_today', // ordo_<noun>, unique
  kind: 'read', // 'read' | 'refresh' | 'change'
  label: 'Reading today’s events', // the chip while it runs
  done: (d) => `Read ${num(d, 'total')} events`, // the chip when done: numbers only
  description: 'Events today, from the cache.', // for the model; no front-end specifics
  untrusted: true, // results carry third-party text (adds the MCP warning)
  reads: 'your calendar', // what a card says the assistant read
  input: { limit: z.number().int().min(1).max(50).default(20) },
  run: async (services, args) => ({ ok: true, data: services.calendar.events(/* … */) }),
})
```

- To reuse a headless command, set `command` and `run: viaCommand('calendar events', (a) => ({ input: … }))`;
  the CLI's validation and change gate then apply too.
- A `change` tool also needs `intent` (an explicit phrase in the user's words), `named` (the values
  the user must have written for "You asked for this") and `preview(services, args)`, which says
  exactly what would change, from Ordo's own data, without changing anything. Arguments that are file
  paths go in `localPaths`; a preview must never touch them. `after` names a dry run that must come
  first with the same arguments, and `staleMessage` what to say if the preview moved on.
- A mail change's preview also returns `mail` (the messages it acts on, and an email's recipients),
  which decides "You asked for this" instead of what was read, and an email to show in full returns
  `email`.
- `assistantOnly: true` keeps a tool out of the MCP server and headless mode: `runTool` refuses it
  unless the caller is the assistant (`caller: 'assistant'`, set only after its card). Sending
  mail is the only one.
- Always run tools through `runTool`, which validates arguments, gates changes (`allowChanges` and
  `confirm`) and hides unexpected errors.
- To let the assistant open a new page, add it to `ASSISTANT_PAGES` in
  `packages/shared/src/assistant.ts` (a test checks it is a real route).
- `tools.test.ts` checks every change command is a change tool with a preview and intent;
  `mcp.test.ts` pins every MCP tool's name, description and schema in a snapshot, so a change to the
  MCP surface shows up in review (`vitest -u` updates it).

### Testing

- `prompt.test.ts` checks the system prompt: general questions answered without a tool, the user's
  data only from tools, and every safety rule word for word.
- `loop.test.ts` drives the loop with a scripted fake model: a general question answered with no
  tool call and nothing but the question and history sent, tool choice, bad JSON, schema
  mismatches and retries, both step caps, prompt injection in results and in history, plan-first,
  stale previews, cards, Stop after a change, and trust; and for mail, the send trigger rules
  (asked, from email text, mixed, Reply-To and look-alike senders), one send per question,
  history, and injected emails that ask to send, move or draft.
- `tools.test.ts` covers each mail tool's preview, the change gate and assistant-only send;
  `mail-client.flow.test.ts` runs the tools against an in-memory IMAP server and a fake SMTP send.
- `e2e/assistant-mail.spec.ts` runs the app against GreenMail and a fake LM Studio: archive after
  Confirm and Cancel, a draft reply in Drafts, a threaded reply GreenMail delivers, and an injected
  email whose warning card is cancelled.
- `index.test.ts` covers the session: the busy guard, cards answered twice, from another window or
  never, Stop and Clear mid-question, a closed or reloaded window, history, page checks and cloud
  consent.
- `e2e/assistant.spec.ts` runs the app against a fake LM Studio that reads tool results back out of
  the prompt; "Help me plan my week" reads the calendar, and "Explain what an ISA is" is answered
  with no tool and shows the general-answer note; `e2e/assistant-setup.spec.ts` checks the no-model state and the cloud OK.

## Limits

- General answers come from the model alone: they can be wrong or out of date, and small local
  models know less. Check anything important.
- Small local models sometimes need the retry, or answer without looking things up. gpt-oss-20b
  works well; smaller ones make more mistakes.
- One question at a time, and no streaming: the answer appears when it's ready.
- The trigger check is cautious: after the assistant has read anything untrusted in a conversation,
  later change cards say "Check this first" even when you did ask. Start a new conversation for a
  clean slate. The card is the real safeguard: read it before you confirm.
- Results are cut at 16,000 characters each; the model is told to page with `limit` and `offset`.
- The assistant reads mail as plain text and never marks it read. It changes at most 20 messages at
  a time, only ones Ordo has cached, and undo only covers moves made while Ordo is open.
- It sends at most one email per question, never with Bcc or attachments of its own (a forward
  carries the original's), to at most 20 people. It remembers sent emails for the last eight turns.
- The assistant can't connect accounts or change settings. Those stay in the app.
