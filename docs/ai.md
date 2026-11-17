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

## Safety

Subject lines and sender names come from strangers, so Ordo treats them as untrusted:

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
- Unpackaged builds take `ORDO_LMSTUDIO_URL`, `ORDO_OLLAMA_URL` and `ORDO_AI_CLI_PATH` for tests.
- `AI_LIVE=lmstudio pnpm vitest run ai.live` sorts made-up senders with a real local model (also
  `ollama` or `claude`). It's skipped by default.
