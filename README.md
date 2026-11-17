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

Bun imports the TypeScript sources. Node 20 and newer import the JavaScript and declarations in `dist/`, which `bun run build` writes; `bun run test:node` builds them and imports all 3 entries with `node`.

`telegram-agent-ui/store/memory` holds `memoryStore`, a store in memory with a lock per key. `telegram-agent-ui/testing` holds `fakeCall`, a transport that records calls and answers from a script, and `faultyStore`, a store that fails one chosen call before or after it runs.
