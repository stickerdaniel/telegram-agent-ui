// The MCP server as an MCP client sees it: the SDK's client over stdio, against the bin in fake
// mode. One test installs the packed tarball into an empty directory and runs it with Node.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

// The tarball test builds, packs and installs; a loaded machine starts a process in seconds.
setDefaultTimeout(240_000);

const REPO = join(import.meta.dir, '..', '..');
const BIN = join(REPO, 'src', 'cli', 'bin.ts');

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A temp directory, removed after the test; its real path, since macOS links /var to /private/var. */
function temp(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/**
 * A connected client of the server that `command` starts. `roots` makes it declare the roots
 * capability and answer with them. `modern` probes for the 2026-07-28 protocol, else the client
 * opens with the 2025 `initialize`.
 */
async function connect(server: { command: string; args: string[]; cwd: string; env: Record<string, string> }, roots?: string[], modern = false): Promise<Client> {
	const client = new Client({ name: 'test', version: '1.0.0' }, { ...(roots ? { capabilities: { roots: {} } } : {}), ...(modern ? { versionNegotiation: { mode: 'auto' } } : {}) });
	if (roots) client.setRequestHandler('roots/list', async () => ({ roots: roots.map((root) => ({ uri: pathToFileURL(root).href })) }));
	await client.connect(new StdioClientTransport({ ...server, stderr: 'pipe' }));
	cleanups.push(() => client.close());
	return client;
}

/** A client of the bin's server in fake mode, started in `cwd`. */
function fake(root: string, cwd: string, options: { roots?: string[]; scenario?: string; modern?: boolean } = {}) {
	const { roots, scenario, modern } = options;
	const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, TELEGRAM_AGENT_UI_FAKE: join(root, 'fake'), ...(scenario ? { TELEGRAM_AGENT_UI_FAKE_SCENARIO: scenario } : {}) };
	return connect({ command: process.execPath, args: [BIN, 'mcp'], cwd, env }, roots, modern);
}

type Called = Awaited<ReturnType<Client['callTool']>>;

/** The JSON of a tool result, after checking that its text and its structured content carry the same object. */
function json(result: Called): Record<string, unknown> {
	const [first] = Array.isArray(result.content) ? result.content : [];
	expect(first?.type).toBe('text');
	const structured = result.structuredContent;
	if (typeof structured !== 'object' || structured === null) throw new Error(`no structuredContent in ${JSON.stringify(result)}`);
	expect(JSON.parse(first?.type === 'text' ? first.text : '')).toEqual(structured);
	return { ...structured };
}

test('the packed tarball, installed into an empty directory, serves the tools, and ask_question and get_answer run in fake mode', async () => {
	const root = temp('tau-pack-');
	const pkg = join(root, 'pkg');
	mkdirSync(pkg);
	// The package as npm packs it: package.json, README, src and a fresh build in dist.
	for (const name of ['package.json', 'README.md', 'src']) cpSync(join(REPO, name), join(pkg, name), { recursive: true });
	execFileSync(process.execPath, ['x', 'tsc', '-p', join(REPO, 'tsconfig.build.json'), '--outDir', join(pkg, 'dist')], { cwd: REPO, stdio: 'pipe' });
	execFileSync('npm', ['pack', '--silent', '--pack-destination', root], { cwd: pkg, stdio: 'pipe' });
	const tarball = readdirSync(root).find((name) => name.endsWith('.tgz'));
	if (!tarball) throw new Error('npm pack wrote no tarball');
	const consumer = join(root, 'consumer');
	mkdirSync(consumer);
	execFileSync('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund', '--silent', join(root, tarball)], { cwd: consumer, stdio: 'pipe' });

	const bin = join(consumer, 'node_modules', 'telegram-agent-ui', 'dist', 'cli', 'bin.js');
	const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, TELEGRAM_AGENT_UI_FAKE: join(root, 'fake') };
	const client = await connect({ command: 'node', args: [bin, 'mcp'], cwd: consumer, env });
	const { tools } = await client.listTools();
	expect(tools.map((tool) => tool.name)).toEqual(['get_status', 'send_message', 'edit_message', 'ask_question', 'get_answer', 'close_question', 'publish_view']);
	const ask = tools.find((tool) => tool.name === 'ask_question');
	// The fake view host ships in the tarball too.
	expect(tools.find((tool) => tool.name === 'publish_view')?.inputSchema.properties).toHaveProperty('tabs.items.required', ['label', 'file']);
	expect(Object.keys(ask?.inputSchema.properties ?? {})).toEqual(['answer', 'options', 'once', 'view', 'answerIn', 'meta', 'ref', 'strict', 'dryRun', 'body', 'bodyFile']);

	const asked = json(await client.callTool({ name: 'ask_question', arguments: { answer: 'choice', options: ['Merge', 'Wait'], body: 'Merge `fix/lock` now?', strict: true } }));
	expect(asked).toMatchObject({ status: 'pending', next: 'wait' });
	const answered = json(await client.callTool({ name: 'get_answer', arguments: { ref: asked.ref } }));
	expect(answered).toMatchObject({ status: 'answered', answer: { kind: 'choice', index: 0, label: 'Merge' }, listener: { alive: true } });
	const methods = readFileSync(join(root, 'fake', 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).method);
	expect(methods).toEqual(['sendRichMessage', 'answerCallbackQuery', 'editMessageText']);
});

test('ask_question without a live listener is an isError result, and nothing is sent', async () => {
	const root = temp('tau-mcp-');
	const client = await fake(root, root, { scenario: 'no-listener' });
	const result = await client.callTool({ name: 'ask_question', arguments: { answer: 'yesNo', body: 'Deploy now?' } });
	expect(result.isError).toBe(true);
	expect(json(result)).toMatchObject({ error: 'no-listener' });
	expect(readdirSync(join(root, 'fake'))).not.toContain('calls.jsonl');
	// A message that asks nothing needs no listener.
	const sent = await client.callTool({ name: 'send_message', arguments: { body: 'Build passed.' } });
	expect(sent.isError).toBeUndefined();
	expect(json(sent)).toMatchObject({ chat: 111, message: 1001 });
});

test.each([
	['2025', false],
	['2026-07-28', true],
])('on the %s protocol a body file comes from the roots the client reports, never from the server directory, and a client without roots reads none', async (_era, modern) => {
	const root = temp('tau-mcp-');
	const project = join(root, 'project');
	const server = join(root, 'server');
	for (const dir of [project, server]) mkdirSync(dir);
	writeFileSync(join(project, 'q.md'), 'Ship `v2` now?');
	writeFileSync(join(server, 'secret.md'), 'a sentinel in the server directory');

	const client = await fake(root, server, { roots: [project], modern });
	expect(client.getProtocolEra()).toBe(modern ? 'modern' : 'legacy');
	const status = json(await client.callTool({ name: 'get_status', arguments: {} }));
	expect(status.roots).toEqual([project]);
	const asked = await client.callTool({ name: 'ask_question', arguments: { answer: 'yesNo', bodyFile: join(project, 'q.md') } });
	expect(asked.isError).toBeUndefined();
	const outside = await client.callTool({ name: 'send_message', arguments: { bodyFile: join(server, 'secret.md') } });
	expect(outside.isError).toBe(true);
	expect(json(outside)).toMatchObject({ error: 'refused', code: 'outside-roots' });
	expect(json(await client.callTool({ name: 'send_message', arguments: { bodyFile: 'q.md' } }))).toMatchObject({ error: 'usage' });
	expect(json(await client.callTool({ name: 'send_message', arguments: { body: 'Hi', bodyFile: join(project, 'q.md') } }))).toMatchObject({ error: 'usage' });
	expect(json(await client.callTool({ name: 'send_message', arguments: {} }))).toMatchObject({ error: 'usage' });

	const rootless = await fake(root, project, { modern });
	expect(json(await rootless.callTool({ name: 'get_status', arguments: {} })).roots).toEqual([]);
	const refused = await rootless.callTool({ name: 'send_message', arguments: { bodyFile: join(project, 'q.md') } });
	expect(json(refused)).toMatchObject({ error: 'refused', code: 'outside-roots' });

	const bodies = readFileSync(join(root, 'fake', 'calls.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).payload.rich_message?.markdown);
	expect(bodies).toEqual(['Ship `v2` now?']);
});

test('publish_view uploads files below the roots to the view host and refuses a path outside them, a .env and a link that leaves them', async () => {
	const root = temp('tau-mcp-');
	const project = join(root, 'project');
	mkdirSync(project);
	writeFileSync(join(project, 'mock.html'), '<h1>Mock</h1>');
	writeFileSync(join(project, '.env'), 'TOKEN=ENV_SENTINEL');
	writeFileSync(join(root, 'outside.md'), 'OUTSIDE_SENTINEL');
	symlinkSync(join(root, 'outside.md'), join(project, 'notes.md'));
	const client = await fake(root, project, { roots: [project] });
	const tool = (await client.listTools()).tools.find((candidate) => candidate.name === 'publish_view');
	expect(tool?.description).toContain('Cloudflare account');
	expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(['title', 'tabs', 'ttl', 'replace', 'dryRun']);

	const publish = async (file: string) => client.callTool({ name: 'publish_view', arguments: { tabs: [{ label: 'Tab', file }] } });
	const published = json(await publish(join(project, 'mock.html')));
	const id = String(published.id);
	expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
	expect(published.files).toEqual([{ path: join(project, 'mock.html'), bytes: 13 }]);
	expect(json(await publish(join(root, 'outside.md')))).toMatchObject({ error: 'refused', code: 'outside-roots' });
	expect(json(await publish(join(project, '.env')))).toMatchObject({ error: 'refused', code: 'secret-file' });
	expect(json(await publish(join(project, 'notes.md')))).toMatchObject({ error: 'refused', code: 'outside-roots' });
	// A relative path would resolve against the server's own directory.
	expect(json(await publish('mock.html'))).toMatchObject({ error: 'usage' });

	const uploads = readFileSync(join(root, 'fake', 'views.jsonl'), 'utf8');
	expect(uploads.trim().split('\n').map((line) => JSON.parse(line).path)).toEqual([`/api/view/${id}`]);
	expect(uploads).not.toContain('SENTINEL');
});

test('a warning reaches the agent as a second text block, and an unknown argument is a usage failure', async () => {
	const root = temp('tau-mcp-');
	const client = await fake(root, root);
	const asked = await client.callTool({ name: 'ask_question', arguments: { answer: 'text', body: 'Reply with the release name' } });
	expect(asked.content).toEqual([expect.objectContaining({ type: 'text' }), { type: 'text', text: expect.stringContaining('warning no-question-mark') }]);
	const unknown = await client.callTool({ name: 'get_answer', arguments: { ref: 'abc', after: 3 } });
	expect(unknown.isError).toBe(true);
	expect(json(unknown)).toMatchObject({ error: 'usage', message: expect.stringContaining('unknown input after') });
});

test('ask_question with answerIn view binds each option to the tab of its label, and get_answer returns the pick made in the view', async () => {
	const root = temp('tau-mcp-');
	const project = join(root, 'project');
	mkdirSync(project);
	for (const name of ['compact', 'wide']) writeFileSync(join(project, `${name}.html`), `<h1>${name}</h1>`);
	const client = await fake(root, project, { roots: [project] });
	const ask = (await client.listTools()).tools.find((candidate) => candidate.name === 'ask_question');
	expect(ask?.inputSchema.properties).toHaveProperty('answerIn.enum', ['chat', 'view']);
	const published = json(await client.callTool({ name: 'publish_view', arguments: { tabs: ['compact', 'wide'].map((name) => ({ label: name, file: join(project, `${name}.html`) })) } }));
	const question = { answer: 'choice', options: ['compact', 'wide'], view: published.id, body: 'Which layout should stay?' };
	expect(json(await client.callTool({ name: 'ask_question', arguments: { ...question, answer: 'text', options: undefined, answerIn: 'view' } }))).toMatchObject({ error: 'refused', code: 'shape' });
	const asked = json(await client.callTool({ name: 'ask_question', arguments: { ...question, answerIn: 'view' } }));
	expect(asked).toMatchObject({ status: 'pending' });
	expect(json(await client.callTool({ name: 'get_answer', arguments: { ref: asked.ref } }))).toMatchObject({ status: 'answered', answer: { kind: 'choice', index: 0, label: 'compact' } });
	const contexts = readFileSync(join(root, 'fake', 'views.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((line) => String(line.path).includes('/context/'));
	expect(contexts.at(-1)?.body).toMatchObject({ choice: { options: [{ index: 0, label: 'compact', tab: 'compact' }, { index: 1, label: 'wide', tab: 'wide' }] } });
});

test('ask_question binds options to tabs of other labels, refuses a tab the view lacks with view-host and a shared tab with shape', async () => {
	const root = temp('tau-mcp-');
	const project = join(root, 'project');
	mkdirSync(project);
	for (const name of ['compact', 'wide']) writeFileSync(join(project, `${name}.html`), `<h1>${name}</h1>`);
	const client = await fake(root, project, { roots: [project] });
	const ask = (await client.listTools()).tools.find((candidate) => candidate.name === 'ask_question');
	expect(ask?.inputSchema.properties).toHaveProperty('options.items.anyOf', [
		{ type: 'string' },
		{ type: 'object', properties: { label: { type: 'string' }, tab: { type: 'string' } }, required: ['label'], additionalProperties: false },
	]);
	const published = json(await client.callTool({ name: 'publish_view', arguments: { tabs: [['Compact', 'compact'], ['Wide', 'wide']].map(([label, name]) => ({ label, file: join(project, `${name}.html`) })) } }));
	const question = (options: unknown[]) => ({ answer: 'choice', answerIn: 'view', view: published.id, body: 'Which layout should stay?', options });
	const asked = json(await client.callTool({ name: 'ask_question', arguments: question([{ label: 'Use compact', tab: 'Compact' }, { label: 'Use wide', tab: 'Wide' }]) }));
	expect(asked).toMatchObject({ status: 'pending' });
	const contexts = readFileSync(join(root, 'fake', 'views.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((line) => String(line.path).endsWith(`/context/${String(asked.ref)}`));
	expect(contexts.at(-1)?.body).toMatchObject({ choice: { options: [{ index: 0, label: 'Use compact', tab: 'Compact' }, { index: 1, label: 'Use wide', tab: 'Wide' }] } });
	expect(json(await client.callTool({ name: 'get_answer', arguments: { ref: asked.ref } }))).toMatchObject({ status: 'answered', answer: { kind: 'choice', index: 0, label: 'Use compact' } });

	expect(json(await client.callTool({ name: 'ask_question', arguments: question([{ label: 'Use compact', tab: 'Compact' }, { label: 'Use grid', tab: 'Grid' }]) }))).toMatchObject({ error: 'no-view-host', message: expect.stringContaining('"Grid"') });
	expect(json(await client.callTool({ name: 'ask_question', arguments: question([{ label: 'Use compact', tab: 'Compact' }, { label: 'Also compact', tab: 'Compact' }]) }))).toMatchObject({ error: 'refused', code: 'shape' });
	expect(json(await client.callTool({ name: 'ask_question', arguments: question([{ label: 'Use compact', tab: 'Compact', style: 'primary' }, 'Wide']) }))).toMatchObject({ error: 'usage' });
});
