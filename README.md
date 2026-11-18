# telegram-agent-ui

A coding agent asks its human on Telegram, the human taps or replies on a phone, and the agent gets a typed answer.

Nothing is published yet. `facts/` holds the records the design rests on.

## Core

The entry `telegram-agent-ui` is the pure core: builders, `render`, `renderEdit`, `reduce`, `locate`, `classify` and `parseQuestion`. It makes no request and imports no Node API. A consumer runs the returned calls with its own transport and keeps the question in its own store, under a lock per question.

```ts
import { choice, reduce, render, renderEdit } from 'telegram-agent-ui';

const spec = choice({ markdown: 'Merge `fix/lock` now?' }, [{ label: 'Merge', style: 'primary' }, { label: 'Wait' }]);
const at = { chat: 111, ref: 'merge1' };

// The calls that send it: the body with its buttons, then any files.
const { steps, warnings } = render(spec, at);

// The question's state, event by event.
let { question } = reduce(undefined, { type: 'ask', spec, ...at, allow: [111] }, { now: Date.now() });
({ question } = reduce(question, { type: 'sent', sent: { chat: 111, message: 632, files: [], ref: 'merge1' } }, { now: Date.now() }));

// A tap from getUpdates: `calls` holds the toast, `handled` the answer.
const { question: answered, calls, handled } = reduce(question, { type: 'input', update }, { now: Date.now() });

// The edit that shows the mark on the picked button.
if (answered && answered.shown.want > answered.shown.done) await call(renderEdit(answered));
```

Labels in another language go through `mergeLabels({ yes: 'Ja', no: 'Nein' })`, which checks each label once.

`createChat` is that loop over a transport and a store. It keeps nothing in memory that a restart needs: every method that touches a question takes the store's lock of `q:<ref>`, stores the new state and only then calls Telegram. `flush` repairs every message that does not show its question's state and delivers every answer that `onAnswer` has not received. Sends and edits of one chat start at least 1 s apart within a process. A non-photo attachment may have 50,000,000 bytes, the cloud Bot API's limit; `fileLimit: 2_000_000_000` raises it for a local server.

```ts
import { createChat, yesNo } from 'telegram-agent-ui';
import { fileStore } from 'telegram-agent-ui/store/file';

const chat = createChat({ call, store: fileStore(dir), chat: 111, onAnswer: async (answer) => console.log(answer.delivery, answer.answer) });

const outcome = await chat.send(yesNo({ markdown: 'Deploy `main` now?' }), { meta: { session: 's1' } });
// { kind: 'ok', ref: 'k7q2m4xa', status: 'pending', sent: { chat: 111, message: 632, files: [], ref: 'k7q2m4xa' }, warnings: [] }

// In the one process that polls getUpdates, which stops on TokenRefused:
await chat.flush({ restart: true }); // at start: repairs, and renews spent delivery attempts
await chat.handle(update); // a tap: the toast, the stored answer, the mark on the button
await chat.flush(); // onAnswer gets { ref, seq, answer, by, meta, delivery: 'k7q2m4xa:1' }

// In any other process on the same store:
await chat.wait('k7q2m4xa', { seconds: 10 }); // { status: 'answered', answer: { kind: 'choice', index: 0, label: 'Yes', value: 'yes' }, ... }
```

Bun imports the TypeScript sources. Node 20 and newer import the JavaScript and declarations in `dist/`, which `bun run build` writes; `bun run test:node` builds them, imports all 10 entries with `node` and runs the bin and its MCP server.

## CLI

`init` pairs a bot from @BotFather with your private chat. It reads the token from `TELEGRAM_BOT_TOKEN` or stdin, prints a link that opens the bot with `/start <code>`, and writes `$XDG_CONFIG_HOME/telegram-agent-ui/config.json` and the token in `.env` beside it, mode 0600.

```sh
telegram-agent-ui init
# Open https://t.me/my_agent_bot?start=k2m4xa7qp3re on your phone and tap Start.
# {"bot":{"id":222,"username":"my_agent_bot"},"chat":111,"users":[111],...}
```

`init` refuses with `conflict` while a listener of the bot runs, and keeps an `apiUrl` of an earlier config.

`listen` is the one process that polls Telegram. It holds a lease on the store, so a second `listen` exits 5. `--on-answer` runs a shell command with each answer as JSON on stdin, until it exits 0 within 30 s; `--on-message` gets each message that answers nothing, such as a reply to a choice question, with the question's `ref`. Both get each item at least once: an item whose command fails 5 times waits, and `info` lists it until the next `listen` starts. A supervisor process ends a command at its deadline and when the listener dies.

```sh
telegram-agent-ui listen --on-answer 'my-router' --meta-key session
```

`ask` sends a question and returns at once. `wait` returns the answer, or `pending` after 10 s.

```sh
telegram-agent-ui ask -o Merge -o Wait --meta '{"session":"s1"}' question.md
# {"ref":"k7q2m4xa","status":"pending","next":"push"}
telegram-agent-ui wait k7q2m4xa --seconds 50
# {"status":"answered","answer":{"kind":"choice","index":0,"label":"Merge"},"by":{"id":111,"name":"Dana"},"listener":{"alive":true}}
```

A body comes from a file or from `-` for stdin. A file must lie below the working directory or a directory of `publishRoots` in the config; a file outside them, a link that leaves them, a secret such as `.env`, and a working directory that is `/` or the home directory are refused before anything is sent.

Every command prints one JSON object on stdout and exits 0, or prints `{ error, code?, message, ref? }` and exits 1 (refused), 2 (usage), 3 (no listener), 4 (uncertain), 5 (listener stopped), 6 (no config or a rejected token) or 7 (no view host). `send`, `edit`, `close` and `info --json` complete the set. `TELEGRAM_AGENT_UI_API_URL` points every command at another Bot API server, and `TELEGRAM_AGENT_UI_FAKE=<dir>` records every call in `<dir>/calls.jsonl` instead of sending it. `telegram-agent-ui/commands` holds the command table, and `telegram-agent-ui/telegram` holds `fetchCall` and `listen` for a program of its own. A bot on grammY uses `telegram-agent-ui/grammy` instead: `grammyCall(bot.api)` as the transport and `bot.use(grammyHandler(chat))` in its own loop.

`telegram-agent-ui/store/memory` holds `memoryStore`, a store in memory with a lock per key. `telegram-agent-ui/store/file` holds `fileStore(dir)`, one JSON file per key in a directory of mode 0700, for Node and Bun on macOS and Linux, with a lock that several processes share. `telegram-agent-ui/testing` holds `fakeCall`, a transport that records calls and answers from a script, and `faultyStore`, a store that fails one chosen call before or after it runs.

## Views

A view is content a message cannot show, opened from the message as a Telegram Mini App: Markdown, a diff, or a page of your own HTML. It lives on a view host in your own Cloudflare account, which holds no bot token and calls nobody. `view deploy` deploys it with your `wrangler login`:

```sh
telegram-agent-ui view deploy
# {"origin":"https://telegram-agent-ui-222.you.workers.dev","worker":"telegram-agent-ui-222","kv":"9f2c...","theme":false,"rotated":false}
```

It deploys the Worker of the installed package as `telegram-agent-ui-<bot id>` with wrangler 4.164.0 through npx, creates its KV namespace once, and sets the bot id, the allowed users and the view labels of the config. The upload key and the media key are made once and kept in the config's `.env`; `--rotate-keys` replaces both, and every media URL signed before ends. `TELEGRAM_AGENT_UI_UPLOAD_KEY` and `TELEGRAM_AGENT_UI_MEDIA_KEY` in the environment win over `.env`: such keys are deployed as they are, rotated in the environment, and refused by `--rotate-keys`. `--route views.example.com/*` serves it on a whole host of your own domain, `--account <id>` or `CLOUDFLARE_ACCOUNT_ID` picks one of several accounts, and `--theme <file>` takes a shadcn `cssVars` theme as JSON; `--no-theme` drops it. The origin, account, route and theme go into the config, and a later `view deploy` reuses them, so a sent button keeps its address.

A view opens only for launch data that Telegram signed for an allowed user within the last 600 s. A page shows in a frame with an empty `sandbox`: it runs no script and loads nothing from another host. `telegram-agent-ui/view/handler` holds `createViewHandler`, the host as a function from a `Request` to a `Response` over a storage of `get`, `put` and `delete`, for any runtime with the Fetch API; `telegram-agent-ui/worker` is that function on Cloudflare KV.

## MCP

`telegram-agent-ui mcp` serves the tools `get_status`, `send_message`, `edit_message`, `ask_question`, `get_answer` and `close_question` over stdio, one per command above. A tool takes its command's input and returns the command's JSON as text and as `structuredContent`, with `isError` on a failure. `ask_question` refuses without a live listener, and `get_answer` waits 10 s by default, at most 50 s. A body file is an absolute path in `bodyFile`, below a root the client reports or a directory of `publishRoots`.

`mcp init --client <claude|cursor|vscode|codex|opencode>` writes the entry `npx telegram-agent-ui@latest mcp` into the client's user config and installs nothing. A config that cannot take the entry with every other setting kept is refused with `client-config` and left as it was. A second run changes nothing.

```sh
telegram-agent-ui mcp init --client claude
# {"client":"claude","path":"/Users/you/.claude.json","entry":{"type":"stdio","command":"npx","args":["telegram-agent-ui@latest","mcp"]},"changed":true}
```

| Client | File |
| --- | --- |
| `claude` | `~/.claude.json`, or `.claude.json` in `$CLAUDE_CONFIG_DIR` |
| `cursor` | `~/.cursor/mcp.json` |
| `vscode` | `mcp-config.json` in `$COPILOT_HOME`, default `~/.copilot` |
| `codex` | `config.toml` in `$CODEX_HOME`, default `~/.codex` |
| `opencode` | `opencode/opencode.json` in `$XDG_CONFIG_HOME`, default `~/.config` |
