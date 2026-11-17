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

Bun imports the TypeScript sources. Node 20 and newer import the JavaScript and declarations in `dist/`, which `bun run build` writes; `bun run test:node` builds them and imports all 4 entries with `node`.

`telegram-agent-ui/store/memory` holds `memoryStore`, a store in memory with a lock per key. `telegram-agent-ui/store/file` holds `fileStore(dir)`, one JSON file per key in a directory of mode 0700, for Node and Bun on macOS and Linux, with a lock that several processes share. `telegram-agent-ui/testing` holds `fakeCall`, a transport that records calls and answers from a script, and `faultyStore`, a store that fails one chosen call before or after it runs.
