// Imports the 4 package entries by name with plain Node, as a Node 20 consumer would, and runs
// one small call through each. Run after the build: `bun run test:node`.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const core = await import('telegram-agent-ui');
const { memoryStore } = await import('telegram-agent-ui/store/memory');
const { fileStore } = await import('telegram-agent-ui/store/file');
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

// createChat on a fileStore: a question is sent, stored as a file and answered by a tap.
const root = mkdtempSync(join(tmpdir(), 'tau-node-'));
const files = fileStore(join(root, 'store'));
const chat = core.createChat({ call: fakeCall().call, store: files, chat: 111 });
const sent = await chat.send(spec, { ref: 'node2' });
assert.equal(sent.kind, 'ok');
assert.equal((await files.get('q:node2')).status, 'open');
const tap = { update_id: 1, callback_query: { id: 'cq1', from: { id: 111, is_bot: false, first_name: 'Node' }, chat_instance: '1', data: 'q:node2:0', message: { message_id: sent.sent.message, date: 0, chat: { id: 111, type: 'private' } } } };
assert.equal((await chat.handle(tap)).kind, 'answered');
assert.equal((await chat.get('node2')).status, 'answered');
rmSync(root, { recursive: true, force: true });

console.log(`node ${process.version}: 4 entries import and run`);
