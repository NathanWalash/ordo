# AI sorting

Ordo's rules sort most senders into Promotions, Newsletters, Notifications, Receipts and People.
The ones they aren't sure about land in Other. A model can take a second look at those.

AI is **off** until you choose a provider in **Settings → AI**. There are no API keys: Ordo uses a
model on your computer, or the login you already have in a CLI.

## Providers

| Provider        | Where it runs                        | Notes                                                |
| --------------- | ------------------------------------ | ---------------------------------------------------- |
| LM Studio       | On this computer                     | Recommended. OpenAI-compatible server on port 1234.  |
| Ollama          | On this computer                     | Native API on port 11434.                            |
| Claude Code CLI | Anthropic, under your Claude account | Needs `claude` installed and signed in.              |
| Codex CLI       | OpenAI, under your ChatGPT account   | Experimental. Needs `codex` installed and signed in. |

**Recommended model: `gpt-oss-20b`.** It sorts senders accurately and runs on a laptop with 16 GB of
memory. Ordo preselects it when LM Studio or Ollama has it. Any chat model works; smaller ones are
faster but make more mistakes.

## What is sent

For each sender in Other, and nothing else:

- the sender's name, address and domain
- whether the mail came through a mailing list, and Ordo's bulk and automated flags
- up to five recent subject lines

Never message bodies, attachments, recipients or your account details. People you've written to are
never sent and never changed by a model.

With LM Studio or Ollama all of this stays on your computer. With a CLI it goes to Anthropic or
OpenAI under your own account and their terms, so Ordo asks you to confirm first.

Answers are cached in Ordo's local mail database by sender and model, so running again only asks
about new or changed senders. Disconnecting your account clears the cache.

## Money

With **Use AI for Money (categories and bill matching)** turned on in Settings → AI (off by
default), **Sort with AI** on Finances does two things with the same provider and model. It uses the
same cloud consent as sorting senders, and the same write lock.

**Categories.** Only transactions the bank and the rules left in Other (or blank) are sent, and only
once per merchant however many payments there are. For each merchant, exactly this:

```json
{
  "merchant": "Zorblax Studio",
  "description": "CARD PAYMENT TO ZORBLAX STUDIO ON",
  "direction": "out",
  "typicalAmount": "£10–£20"
}
```

- `merchant`: Ordo's cleaned-up merchant name.
- `description`: the most common statement description for it, with every number removed (dates,
  times, card numbers, references, phone numbers) and cut to 80 characters.
- `direction`: whether the money went `in` or `out`.
- `typicalAmount`: the median payment rounded into a band (under £5, £5–£10, £10–£20, £20–£50,
  £50–£100, £100–£250, £250–£500, £500–£1,000, £1,000–£2,500, over £2,500).

Never balances, account names or numbers, dates, exact amounts or the list of transactions. The
model must answer one of the existing categories (Groceries, Eating out, Transport, Bills,
Subscriptions, Shopping, Entertainment, Health, Cash, Transfers, Income, Other) with a confidence
from 0 to 1; below 0.5, or "Other", nothing changes. A category a model chose shows a sparkle with
its confidence. Choosing a category yourself from the menu on a transaction always wins over the
bank, the rules and the model, and is never sent; **Automatic** undoes it.

**Bill matching.** When Mail is connected, Ordo also asks about recurring bank payments the rules
couldn't link to a subscription email, paired with email senders whose names look close (same first
letter, and a shared start or an abbreviation, like `AMZN MKTP` and `Amazon`). For each pair:

```json
{
  "pair": "p1",
  "bankMerchant": "Amzn Mktp",
  "bankAmount": "£20–£50",
  "cadence": "monthly",
  "emailSender": "Amazon",
  "emailDomain": "amazon.co.uk",
  "emailKinds": ["renewal"]
}
```

No subject lines, dates or exact amounts. The model answers yes or no with a confidence per pair id;
only pairs that were sent count. A match only adds the emails to a bill in Bills → Detected, marked
**Matched by AI**. The model never confirms a bill: you do.

Answers are cached in `money.sqlite` per merchant (or pair), model and a fingerprint of what was
sent, so running again only asks about new or changed merchants. Listing transactions and bills
applies cached answers without calling the model; with AI for Money off, they aren't applied.

## Ask Ordo

**Ask Ordo** (Money → Ask Ordo) answers questions about your money, like "How much did Italy cost
me?" or "What am I holding for other people?", and learns from what you tell it. It uses the
provider and model chosen in Settings → AI.

**Ordo does the maths.** The model can't see your statements. It answers by calling Ordo's query
functions, one at a time, in a strict JSON loop:

```json
{ "type": "call", "tool": "event_cost", "args": { "name": "Italy" } }
```

Ordo runs the function on your data and sends back the result as data. When the model is ready it
answers, writing every amount as a placeholder for a number a tool returned:

```json
{ "type": "answer", "text": "Italy cost you {{r1.netPence}} after {{r1.paidBackPence}} came back." }
```

Ordo fills the placeholders in itself. An answer with an amount the model wrote (`£30`, `12.50`,
`1250p`, `30 pounds`) or a placeholder that points nowhere is refused and asked again once. At most
six tool calls, then the model must answer.

The tools: `find_transactions`, `spending` (between two days, net of paybacks), `compare_months`,
`events`, `event_cost`, `matches` (paybacks and pass-throughs, with how sure Ordo is), `share_of`
(your share of one outgoing after paybacks), `loose_ends` (money held for others, money owed to you),
`people`, `facts` (what you've told Ordo) and `caveats` (how each bank dates payments). Arguments are
checked with zod; bad ones come back to the model as an error.

**What is sent.** Unlike Sort with AI, Ask Ordo needs real detail: exact amounts, dates, account
names, merchant and people's names from your statements, and the facts you've saved, as sentences.
Only what the model asks a tool for is sent, plus your question and the last few questions and
answers in the conversation. Never your whole statement, files or balances.

- **On this computer (LM Studio, Ollama):** nothing leaves your computer, so nothing more is asked.
- **Claude Code or Codex CLI:** Ask Ordo needs its own consent, **Send amounts, dates and names to
  Anthropic (or OpenAI)** in Settings → AI, on top of the consent for sorting. It is off by
  default, asked for in its own dialog, kept per provider, and cleared when you switch provider.
  Without it, Ask Ordo is off and says why; Ordo's own questions, loose ends and events still work.

**Remembering.** When you tell Ask Ordo something ("Genest's £30 was for Halloween"), it can suggest
up to three facts to remember. Ordo checks each one against its schema, drops any that name payments
or events the tools never showed (or an amount owed that Ordo didn't work out), and shows the rest
as Ordo's own sentence with Save and Not now. Nothing is saved until you press Save. Clarifying
questions ("Which trip do you mean?") come with short options that send your choice as the next
question; turn them off with **Let Ask Ordo ask me back**. **Ask Ordo answers** chooses briefly or
in detail.

**What Ordo knows** is stored in `money.sqlite` as facts: people (flatmate, friend…), events and
trips, paybacks, pass-throughs, money held for someone, money owed to you, payments to ignore,
income sources, how an account dates payments, and notes. Each one is checked again when read; you
can forget any of them on the Ask Ordo page or with `money forget`. Ordo's own questions (who is
this, was this a payback) are worked out without a model, from exact amounts and dates.

## Safety

Subject lines, sender names and statement descriptions come from strangers, so Ordo treats them as
untrusted:

- They're sent inside a delimited data block, and the instructions tell the model it's data.
- Replies must match a strict schema: an address Ordo asked about, one of the five categories (never
  People) and a confidence from 0 to 1. Anything else is dropped; a malformed reply gets one retry.
  Ordo never shows or stores free text from a sorting reply.
- **Claude Code** runs in an empty temporary folder with the prompt on stdin, and no tools to call:

  ```text
  claude -p --output-format json --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}'
    --permission-mode dontAsk --disable-slash-commands --no-session-persistence
    --system-prompt <instructions> [--model <model>] --json-schema <schema>
  ```

- **Codex** runs in an empty temporary folder with the prompt on stdin. It has no single "no tools"
  switch, so Ordo turns off every tool-giving feature and labels it experimental:

  ```text
  codex exec --sandbox read-only --skip-git-repo-check --ephemeral --ignore-user-config
    --disable shell_tool --disable unified_exec --disable apps --disable plugins … (19 features)
    -c web_search="disabled" -C <empty folder> --output-schema <file> -o <file> -
  ```

## Setting up LM Studio

1. Install [LM Studio](https://lmstudio.ai) and download `gpt-oss-20b` (or another chat model).
2. Open the **Developer** tab and turn on **Start server** (port 1234).
3. In Ordo, open **Settings → AI**, choose **LM Studio** and press **Test**.

LM Studio loads the model on the first request, so the first Test can take a minute.

## Setting up Ollama

1. Install [Ollama](https://ollama.com) and run `ollama pull gpt-oss:20b`.
2. Make sure Ollama is running (the menu bar app, or `ollama serve`).
3. In Ordo, choose **Ollama** and press **Test**.

## Using Claude Code or Codex

Install the CLI, run it once in Terminal and sign in (`claude`, or `codex login`). Ordo finds it
through your login shell's PATH, so it works even when Ordo is opened from Finder. If you install it
while Ordo is open, press **Check again**.

## For developers

- `packages/ai` has the `ModelProvider` interface (`.`) and the adapters (`./node`).
- `aiCategorise` in `packages/mail-core` does the sorting; `window.ordo.ai` exposes status, test and
  sorting to the renderer.
- `aiCategoriseTransactions` and `aiMatchBills` in `packages/money-core` do Money's;
  `window.ordo.money.aiSort()` runs both, and `money sort` / `ordo_money_sort` in headless mode.
- `askMoney` and `moneyTools` in `packages/money-core` are Ask Ordo; the engines it calls (ledger,
  `findMatches`, `eventCost`, `heldBalances`, `owedToYou`, `compareMonthToDate`, `proposeQuestions`)
  are pure and need no model. `window.ordo.moneyMemory` exposes them to the renderer.
- Unpackaged builds take `ORDO_LMSTUDIO_URL`, `ORDO_OLLAMA_URL` and `ORDO_AI_CLI_PATH` for tests.
- `AI_LIVE=lmstudio pnpm vitest run ai.live` sorts made-up senders with a real local model (also
  `ollama` or `claude`). It's skipped by default.
