// Imports the 8 package entries by name with plain Node, as a Node 20 consumer would, runs one
// small call through each, and runs the bin. Run after the build: `bun run test:node`.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const core = await import('telegram-agent-ui');
const { memoryStore } = await import('telegram-agent-ui/store/memory');
const { fileStore } = await import('telegram-agent-ui/store/file');
const { fakeCall, faultyStore } = await import('telegram-agent-ui/testing');
const { fetchCall, listen } = await import('telegram-agent-ui/telegram');
const { grammyCall, grammyHandler } = await import('telegram-agent-ui/grammy');
const { commands, EXIT } = await import('telegram-agent-ui/commands');
const mcp = await import('telegram-agent-ui/mcp');
const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');
const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
const { Bot } = await import('grammy');

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
const tap = (ref, message) => ({ update_id: 1, callback_query: { id: `cq-${ref}`, from: { id: 111, is_bot: false, first_name: 'Node' }, chat_instance: '1', data: `q:${ref}:0`, message: { message_id: message, date: 0, chat: { id: 111, type: 'private' } } } });
assert.equal((await chat.handle(tap('node2', sent.sent.message))).kind, 'answered');
assert.equal((await chat.get('node2')).status, 'answered');

// A Bot API server on node:http: sends get message 1001, a long poll ends with 409, and every
// multipart upload is read back with the Fetch API's form parser.
const received = [];
const server = createServer(async (request, response) => {
	const method = request.url.split('/').pop();
	const body = new Request('http://local', { method: 'POST', headers: request.headers, body: Readable.toWeb(request), duplex: 'half' });
	const form = request.headers['content-type']?.startsWith('multipart/') ? await body.formData() : undefined;
	received.push({ method, form, json: form ? undefined : await body.text() });
	const answer = (status, value) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
	if (method === 'getUpdates') return answer(409, { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' });
	if (method === 'getWebhookInfo') return answer(200, { ok: true, result: { url: '' } });
	if (method.startsWith('send')) return answer(200, { ok: true, result: { message_id: 1001, date: 0, chat: { id: 111, type: 'private' } } });
	return answer(200, { ok: true, result: true });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const apiUrl = `http://127.0.0.1:${server.address().port}`;

// ./telegram: a streamed upload, and a listener that stops on the 409.
const call = fetchCall({ token: '222:node', apiUrl });
const bytes = new Uint8Array(1_000_000).fill(7);
const document = { path: '/work/report.pdf', type: 'application/pdf', size: bytes.length, stream: () => new Blob([bytes]).stream(), bytes: async () => bytes, close: async () => {} };
assert.equal((await call({ method: 'sendDocument', payload: { chat_id: 111 }, files: [{ field: 'document', path: document.path }] }, { document })).ok, true);
const upload = received.at(-1).form.get('document');
assert.equal(upload.name, 'report.pdf');
assert.equal(upload.size, 1_000_000);
const listener = core.createChat({ call, store: memoryStore(), chat: 111 });
const stopped = await listen({ chat: listener, call, store: memoryStore(), signal: AbortSignal.timeout(30_000) });
assert.equal(stopped.reason, 'conflict');

// ./grammy: the bot's Api is the transport, and its middleware answers a tap.
const bot = new Bot('222:node', {
	client: { apiRoot: apiUrl },
	botInfo: { id: 222, is_bot: true, first_name: 'Probe', username: 'probe_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false },
});
const hosted = core.createChat({ call: grammyCall(bot.api), store: memoryStore(), chat: 111 });
const asked = await hosted.send(spec, { ref: 'node3' });
assert.equal(asked.kind, 'ok');
bot.use(grammyHandler(hosted));
await bot.handleUpdate(tap('node3', asked.sent.message));
assert.equal((await hosted.get('node3')).status, 'answered');
server.close();

// ./commands and the bin, in fake mode.
assert.deepEqual(
	commands.map((command) => command.name),
	['init', 'info', 'send', 'edit', 'ask', 'wait', 'close', 'listen', 'mcp init'],
);
assert.deepEqual(Object.values(EXIT), [1, 2, 3, 4, 5, 6, 7]);
const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli', 'bin.js');
const env = { PATH: process.env.PATH, HOME: root, TELEGRAM_AGENT_UI_FAKE: join(root, 'fake') };
const run = (args, input) => JSON.parse(execFileSync(process.execPath, [bin, ...args], { env, input, encoding: 'utf8' }));
const { ref } = run(['ask', '--yes-no', '-'], 'Deploy now?');
assert.deepEqual(run(['wait', ref]).answer, { kind: 'choice', index: 0, label: 'Yes', value: 'yes' });
// mcp init parses Codex's TOML under Node too.
assert.equal(run(['mcp', 'init', '--client', 'codex']).changed, true);
// A body file outside the roots is refused before anything is sent.
const outside = spawnSync(process.execPath, [bin, 'send', '/etc/hosts'], { env, encoding: 'utf8' });
assert.equal(outside.status, 1);
assert.equal(JSON.parse(outside.stdout).code, 'outside-roots');
// The supervisor of an answer command runs under Node and reports the command's exit.
const supervisor = join(dirname(bin), '..', 'commands', 'supervise.js');
const supervised = spawnSync(process.execPath, [supervisor, '5000', String(process.pid), 'cat > /dev/null; exit 3'], { input: '{}\n', encoding: 'utf8' });
assert.deepEqual(JSON.parse(supervised.stdout.trim()), { ended: 'exit', code: 3 });
// An owner that dies right after it started the supervisor leaves no command running: the
// supervisor sees another parent than the owner it was told, and starts nothing.
const startedFile = join(root, 'started');
const deadline = 30_000 + (process.pid % 1_000);
const shell = pathToFileURL(join(dirname(bin), '..', 'commands', 'shell.js')).href;
const owner = spawnSync(process.execPath, ['--input-type=module', '-e', `import { runShell } from ${JSON.stringify(shell)}; void runShell(${JSON.stringify(`echo started > ${startedFile}; sleep 59`)}, {}, ${deadline}); process.kill(process.pid, 'SIGKILL');`]);
assert.equal(owner.signal, 'SIGKILL');
const alive = () => spawnSync('pgrep', ['-f', `supervise.js ${deadline}`]).status === 0;
for (const until = Date.now() + 60_000; alive() && !existsSync(startedFile) && Date.now() < until; ) await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(alive(), false);
assert.equal(existsSync(startedFile), false);

// ./mcp: a client in memory lists the tools, and one over stdio asks and waits through the bin.
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await mcp.createServer({ env }).connect(serverSide);
const memory = new Client({ name: 'node', version: '1.0.0' });
await memory.connect(clientSide);
assert.deepEqual(
	(await memory.listTools()).tools.map((tool) => tool.name),
	['get_status', 'send_message', 'edit_message', 'ask_question', 'get_answer', 'close_question'],
);
await memory.close();
const stdio = new Client({ name: 'node', version: '1.0.0' });
await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [bin, 'mcp'], env, cwd: root, stderr: 'pipe' }));
const shipIt = await stdio.callTool({ name: 'ask_question', arguments: { answer: 'yesNo', body: 'Ship it?' } });
assert.deepEqual(JSON.parse(shipIt.content[0].text), shipIt.structuredContent);
const waited = await stdio.callTool({ name: 'get_answer', arguments: { ref: shipIt.structuredContent.ref } });
assert.equal(waited.structuredContent.status, 'answered');
await stdio.close();
rmSync(root, { recursive: true, force: true });

console.log(`node ${process.version}: 8 entries import and run, and so do the bin, its supervisor and its MCP server`);
