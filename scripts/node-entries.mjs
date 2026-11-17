// Imports the 3 package entries by name with plain Node, as a Node 20 consumer would, and runs
// one small call through each. Run after the build: `bun run test:node`.
import assert from 'node:assert/strict';

const core = await import('telegram-agent-ui');
const { memoryStore } = await import('telegram-agent-ui/store/memory');
const { fakeCall, faultyStore } = await import('telegram-agent-ui/testing');

const spec = core.choice({ markdown: 'Merge now?' }, [{ label: 'Merge' }, { label: 'Wait' }]);
const { steps } = core.render(spec, { chat: 111, ref: 'node1' });
assert.equal(steps[0].call.method, 'sendRichMessage');
const { question } = core.reduce(undefined, { type: 'ask', spec, ref: 'node1', chat: 111, allow: [111] }, { now: 1 });
assert.deepEqual(core.parseQuestion(JSON.parse(JSON.stringify(question))), question);
assert.throws(() => core.mergeLabels({ yes: '' }), core.ShapeError);

const store = faultyStore(memoryStore());
await store.lock('q:node1', () => store.set('q:node1', question));
assert.deepEqual(await store.get('q:node1'), question);
const telegram = fakeCall();
assert.equal((await telegram.call(steps[0].call)).ok, true);

console.log(`node ${process.version}: 3 entries import and run`);
