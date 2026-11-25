import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
const { createViewHandler, verifyLaunchData } = await import('telegram-agent-ui/view/handler');
const { readPublishable } = await import('telegram-agent-ui/files');
const { prepareView, viewClient } = await import('telegram-agent-ui/view');
const { default: worker } = await import('telegram-agent-ui/worker');
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

const root = mkdtempSync(join(tmpdir(), 'tau-node-'));
const files = fileStore(join(root, 'store'));
const chat = core.createChat({ call: fakeCall().call, store: files, chat: 111 });
const sent = await chat.send(spec, { ref: 'node2' });
assert.equal(sent.kind, 'ok');
assert.equal((await files.get('q:node2')).status, 'open');
const tap = (ref, message) => ({ update_id: 1, callback_query: { id: `cq-${ref}`, from: { id: 111, is_bot: false, first_name: 'Node' }, chat_instance: '1', data: `q:${ref}:0`, message: { message_id: message, date: 0, chat: { id: 111, type: 'private' } } } });
assert.equal((await chat.handle(tap('node2', sent.sent.message))).kind, 'answered');
assert.equal((await chat.get('node2')).status, 'answered');

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

const call = fetchCall({ token: '222:node', apiUrl });
const bytes = new Uint8Array(1_000_000).fill(7);
const document = { path: '/work/report.pdf', type: 'application/pdf', size: bytes.length, stream: () => new Blob([bytes]).stream(), bytes: async () => bytes, close: async () => {} };
assert.equal((await call({ method: 'sendDocument', payload: { chat_id: 111 }, files: [{ field: 'document', path: document.path }] }, { document })).ok, true);
const upload = received.at(-1).form.get('document');
assert.equal(upload.name, 'report.pdf');
assert.equal(upload.size, 1_000_000);
const listener = core.createChat({ call, store: memoryStore(), chat: 111 });
const stopped = await listen({ chat: listener, target: 111, origin: apiUrl, allow: [111], call, store: memoryStore(), signal: AbortSignal.timeout(30_000) });
assert.equal(stopped.reason, 'conflict');

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

const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex');
const authDate = Math.floor(Date.now() / 1000);
const user = '{"id":111,"first_name":"Node"}';
const signature = Buffer.from(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(`222:WebAppData\nauth_date=${authDate}\nuser=${user}`))).toString('base64url');
const initData = `user=${encodeURIComponent(user)}&auth_date=${authDate}&signature=${signature}`;
assert.deepEqual(await verifyLaunchData(initData, { botId: '222', publicKey, allowedUsers: [111], now: Date.now() }), { ok: true, user: { id: 111, name: 'Node' } });
const entries = new Map();
const storage = {
	get: async (key) => entries.get(key),
	put: async (key, value, { type }) => void entries.set(key, { value, ...(type ? { type } : {}) }),
	delete: async (key) => void entries.delete(key),
	list: async (prefix) => [...entries.keys()].filter((key) => key.startsWith(prefix)),
};
const viewHost = createViewHandler({ storage, botId: '222', allowedUsers: [111], uploadKey: 'upload-key-0123456789', mediaKey: 'media-key-0123456789', publicKey });
const viewId = 'Zr8kQ2vT0mN4xW6yB1cD3e';
const published = { generation: 'g1', expiresAt: Date.now() + 60_000, media: [], view: { v: 1, tabs: [{ label: 'A', content: { markdown: '# A' } }] } };
const stored = await viewHost(new Request(`https://views.example.com/api/view/${viewId}`, { method: 'PUT', headers: { Authorization: 'Bearer upload-key-0123456789' }, body: JSON.stringify(published) }));
assert.equal(stored.status, 200);
const opened = await viewHost(new Request(`https://views.example.com/api/view?v=${viewId}`, { headers: { Authorization: `tma ${initData}` } }));
assert.deepEqual((await opened.json()).view, published.view);
assert.match((await viewHost(new Request('https://views.example.com/'))).headers.get('content-security-policy'), /script-src 'sha256-[A-Za-z0-9+/]{43}=' 'sha256-[A-Za-z0-9+/]{43}=' https:\/\/telegram\.org/);

const project = join(realpathSync(root), 'project');
mkdirSync(join(project, 'shots'), { recursive: true });
writeFileSync(join(project, 'notes.md'), '# Notes\n\n![shot](shots/a.png)');
writeFileSync(join(project, 'shots', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]));
const read = await readPublishable([join(project, 'notes.md')], { roots: [project] });
assert.equal(read.kind, 'ok');
assert.equal(await new Response(read.files[0].stream()).text(), '# Notes\n\n![shot](shots/a.png)');
await read.files[0].close();
assert.equal((await readPublishable(['/etc/hosts'], { roots: [project] })).code, 'outside-roots');

const ready = await prepareView({ tabs: [{ label: 'Notes', content: { file: join(project, 'notes.md') } }] }, { roots: [project] });
assert.equal(ready.kind, 'ok');
assert.deepEqual(ready.prepared.view.tabs[0].content, { markdown: '# Notes\n\n![shot](shots/a.png)', media: { 'shots/a.png': 0 } });
const hostServer = createServer(async (request, response) => {
	const body = ['GET', 'HEAD'].includes(request.method) ? undefined : Readable.toWeb(request);
	const answer = await viewHost(new Request(`https://views.example.com${request.url}`, { method: request.method, headers: request.headers, ...(body ? { body, duplex: 'half' } : {}) }));
	response.writeHead(answer.status, Object.fromEntries(answer.headers)).end(Buffer.from(await answer.arrayBuffer()));
});
await new Promise((resolve) => hostServer.listen(0, '127.0.0.1', resolve));
const views = viewClient({ origin: `http://127.0.0.1:${hostServer.address().port}`, uploadKey: 'upload-key-0123456789' });
const put = await views.put(ready.prepared);
assert.equal(put.kind, 'ok');
assert.deepEqual(await views.has(put.id), { kind: 'present', tabs: ['Notes'], expiresAt: put.expiresAt });
assert.deepEqual(await views.version(), { kind: 'ok', formats: ['1', 'answers'] });
assert.deepEqual(await views.choices(), { kind: 'ok', choices: [] });
assert.deepEqual(await views.context(put.id, 'node4', { markdown: 'Ship it?' }), { kind: 'ok' });
const shown = await viewHost(new Request(`https://views.example.com/api/view?v=${put.id}&q=node4`, { headers: { Authorization: `tma ${initData}` } }));
assert.deepEqual((await shown.json()).context, { markdown: 'Ship it?' });
hostServer.close();

const kv = { getWithMetadata: async () => ({ value: null, metadata: null }), put: async () => {}, delete: async () => {}, list: async () => ({ keys: [], list_complete: true }) };
const version = await worker.fetch(new Request('https://views.example.com/api/version'), { VIEWS: kv, BOT_ID: '222', ALLOWED_USERS: '[111]', UPLOAD_KEY: 'upload-key-0123456789', MEDIA_KEY: 'media-key-0123456789' });
assert.deepEqual((await version.json()).formats, [1, 'answers']);

assert.deepEqual(
	commands.map((command) => command.name),
	['init', 'info', 'send', 'edit', 'ask', 'wait', 'close', 'view put', 'view delete', 'view context', 'view status', 'view deploy', 'listen', 'fetch', 'topic create', 'topic icons', 'topic icon', 'hook permission-request', 'hook notification', 'hook init', 'mcp init'],
);
assert.deepEqual(Object.values(EXIT), [1, 2, 3, 4, 5, 6, 7]);
const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli', 'bin.js');
const env = { PATH: process.env.PATH, HOME: root, TELEGRAM_AGENT_UI_FAKE: join(root, 'fake') };
const run = (args, input) => JSON.parse(execFileSync(process.execPath, [bin, ...args], { env, input, encoding: 'utf8' }));
const { ref } = run(['ask', '--yes-no', '-'], 'Deploy now?');
assert.deepEqual(run(['wait', ref]).answer, { kind: 'choice', index: 0, label: 'Yes', value: 'yes' });
assert.equal(run(['mcp', 'init', '--client', 'codex']).changed, true);
const hooked = spawnSync(process.execPath, [bin, 'hook', 'permission-request', '--client', 'claude'], { env, input: 'not json', encoding: 'utf8' });
assert.equal(hooked.status, 0);
assert.equal(JSON.parse(hooked.stdout).hookSpecificOutput.decision.behavior, 'deny');
const claudeBin = join(root, 'claude-bin');
mkdirSync(claudeBin);
writeFileSync(join(claudeBin, 'claude'), '#!/bin/sh\necho "2.1.327 (Claude Code)"\n', { mode: 0o755 });
const hookEnv = { ...env, PATH: `${claudeBin}:${process.env.PATH}` };
assert.equal(JSON.parse(execFileSync(process.execPath, [bin, 'hook', 'init', '--client', 'claude'], { env: hookEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).changed, true);
const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
assert.equal(settings.hooks.PermissionRequest[0].hooks[0].command, `'${process.execPath}' '${realpathSync(bin)}' hook permission-request --client claude --seconds 570`);
const outside = spawnSync(process.execPath, [bin, 'send', '/etc/hosts'], { env, encoding: 'utf8' });
assert.equal(outside.status, 1);
assert.equal(JSON.parse(outside.stdout).code, 'outside-roots');
const supervisor = join(dirname(bin), '..', 'commands', 'supervise.js');
const supervised = spawnSync(process.execPath, [supervisor, '5000', String(process.pid), 'cat > /dev/null; exit 3'], { input: '{}\n', encoding: 'utf8' });
assert.deepEqual(JSON.parse(supervised.stdout.trim()), { ended: 'exit', code: 3 });
const startedFile = join(root, 'started');
const deadline = 30_000 + (process.pid % 1_000);
const shell = pathToFileURL(join(dirname(bin), '..', 'commands', 'shell.js')).href;
const owner = spawnSync(process.execPath, ['--input-type=module', '-e', `import { runShell } from ${JSON.stringify(shell)}; void runShell(${JSON.stringify(`echo started > ${startedFile}; sleep 59`)}, {}, ${deadline}); process.kill(process.pid, 'SIGKILL');`]);
assert.equal(owner.signal, 'SIGKILL');
const alive = () => spawnSync('pgrep', ['-f', `supervise.js ${deadline}`]).status === 0;
for (const until = Date.now() + 60_000; alive() && !existsSync(startedFile) && Date.now() < until; ) await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(alive(), false);
assert.equal(existsSync(startedFile), false);

const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await mcp.createServer({ env }).connect(serverSide);
const memory = new Client({ name: 'node', version: '1.0.0' });
await memory.connect(clientSide);
assert.deepEqual(
	(await memory.listTools()).tools.map((tool) => tool.name),
	['get_status', 'send_message', 'edit_message', 'ask_question', 'get_answer', 'close_question', 'publish_view', 'fetch_file'],
);
await memory.close();
const stdio = new Client({ name: 'node', version: '1.0.0' });
await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [bin, 'mcp'], env, cwd: root, stderr: 'pipe' }));
const shipIt = await stdio.callTool({ name: 'ask_question', arguments: { answer: 'yesNo', body: 'Ship it?' } });
assert.deepEqual(JSON.parse(shipIt.content[0].text), shipIt.structuredContent);
const waited = await stdio.callTool({ name: 'get_answer', arguments: { ref: shipIt.structuredContent.ref } });
assert.equal(waited.structuredContent.status, 'answered');
assert.equal((await stdio.callTool({ name: 'fetch_file', arguments: { id: 'BQACAgIAAxkBAAI' } })).structuredContent.code, 'forbidden');
await stdio.close();
rmSync(root, { recursive: true, force: true });

console.log(`node ${process.version}: 12 entries import and run, and so do the bin, its supervisor and its MCP server`);
