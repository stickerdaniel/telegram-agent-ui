// `mcp init` writes each client's documented entry into a temp home, keeps what the file held,
// and changes nothing on a second run.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MCP_CLIENTS, type McpClient, mcpInit } from './mcp-init.ts';

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function home() {
	const dir = mkdtempSync(join(tmpdir(), 'tau-mcp-init-'));
	homes.push(dir);
	return { dir, env: { HOME: dir } };
}

const STDIO = { type: 'stdio', command: 'npx', args: ['telegram-agent-ui@latest', 'mcp'] };

/** The path and the file each client documents, in a home `dir`. */
const expected: Record<McpClient, (dir: string) => { path: string; text: string }> = {
	claude: (dir) => ({ path: join(dir, '.claude.json'), text: `${JSON.stringify({ mcpServers: { 'telegram-agent-ui': STDIO } }, null, 2)}\n` }),
	cursor: (dir) => ({ path: join(dir, '.cursor', 'mcp.json'), text: `${JSON.stringify({ mcpServers: { 'telegram-agent-ui': STDIO } }, null, 2)}\n` }),
	vscode: (dir) => ({ path: join(dir, '.copilot', 'mcp-config.json'), text: `${JSON.stringify({ mcpServers: { 'telegram-agent-ui': { ...STDIO, tools: ['*'] } } }, null, 2)}\n` }),
	opencode: (dir) => ({
		path: join(dir, '.config', 'opencode', 'opencode.json'),
		text: `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { 'telegram-agent-ui': { type: 'local', command: ['npx', 'telegram-agent-ui@latest', 'mcp'], enabled: true } } }, null, 2)}\n`,
	}),
	codex: (dir) => ({ path: join(dir, '.codex', 'config.toml'), text: '[mcp_servers.telegram-agent-ui]\ncommand = "npx"\nargs = ["telegram-agent-ui@latest", "mcp"]\n' }),
};

test.each([...MCP_CLIENTS])('%s: a fresh home gets the documented file, and a second run changes nothing', async (client) => {
	const { dir, env } = home();
	const { path, text } = expected[client](dir);
	expect(await mcpInit(client, env)).toEqual({ ok: true, output: expect.objectContaining({ client, path, changed: true }) });
	expect(readFileSync(path, 'utf8')).toBe(text);
	expect(statSync(path).mode & 0o777).toBe(0o600);
	expect(await mcpInit(client, env)).toEqual({ ok: true, output: expect.objectContaining({ changed: false }) });
	expect(readFileSync(path, 'utf8')).toBe(text);
});

test('a JSON config keeps its other keys and servers, and its mode', async () => {
	const { dir, env } = home();
	const path = join(dir, '.claude.json');
	writeFileSync(path, JSON.stringify({ numStartups: 4, mcpServers: { other: { command: 'other' }, 'telegram-agent-ui': { command: 'old' } } }), { mode: 0o644 });
	await mcpInit('claude', env);
	expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ numStartups: 4, mcpServers: { other: { command: 'other' }, 'telegram-agent-ui': STDIO } });
	expect(statSync(path).mode & 0o777).toBe(0o644);
});

test('CLAUDE_CONFIG_DIR, CODEX_HOME, COPILOT_HOME and XDG_CONFIG_HOME move the file', async () => {
	const { dir } = home();
	const env = { HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'c'), CODEX_HOME: join(dir, 'x'), COPILOT_HOME: join(dir, 'p'), XDG_CONFIG_HOME: join(dir, 'xdg') };
	const paths = await Promise.all(MCP_CLIENTS.map(async (client) => {
		const result = await mcpInit(client, env);
		return result.ok ? result.output.path : undefined;
	}));
	expect(paths).toEqual([join(dir, 'c', '.claude.json'), join(dir, '.cursor', 'mcp.json'), join(dir, 'p', 'mcp-config.json'), join(dir, 'x', 'config.toml'), join(dir, 'xdg', 'opencode', 'opencode.json')]);
});

test('a config that is no JSON object is refused and left as it was', async () => {
	const { dir, env } = home();
	const path = join(dir, '.cursor', 'mcp.json');
	mkdirSync(dirname(path));
	for (const text of ['{ "mcpServers": { // a comment\n } }', '[]', '{ "mcpServers": [] }']) {
		writeFileSync(path, text);
		expect(await mcpInit('cursor', env)).toMatchObject({ ok: false, failure: { error: 'refused', code: 'client-config' } });
		expect(readFileSync(path, 'utf8')).toBe(text);
	}
});

test('a Codex config keeps its other tables, and its entry is replaced in place', async () => {
	const { dir, env } = home();
	const path = join(dir, '.codex', 'config.toml');
	mkdirSync(dirname(path));
	const before = 'model = "gpt-6"\n\n[mcp_servers.telegram-agent-ui]\ncommand = "old"\n\n[mcp_servers.other]\ncommand = "other"\n';
	writeFileSync(path, before);
	await mcpInit('codex', env);
	const after = 'model = "gpt-6"\n\n[mcp_servers.telegram-agent-ui]\ncommand = "npx"\nargs = ["telegram-agent-ui@latest", "mcp"]\n\n[mcp_servers.other]\ncommand = "other"\n';
	expect(readFileSync(path, 'utf8')).toBe(after);
	expect(await mcpInit('codex', env)).toMatchObject({ output: { changed: false } });
	writeFileSync(path, 'model = "gpt-6"');
	await mcpInit('codex', env);
	expect(readFileSync(path, 'utf8')).toBe('model = "gpt-6"\n\n[mcp_servers.telegram-agent-ui]\ncommand = "npx"\nargs = ["telegram-agent-ui@latest", "mcp"]\n');
});

/** A Codex config in a fresh home: its path, and the parse of the file with Bun's own TOML parser. */
function codexHome(text: string) {
	const { dir, env } = home();
	const path = join(dir, '.codex', 'config.toml');
	mkdirSync(dirname(path));
	writeFileSync(path, text);
	return { env, path, parsed: () => Bun.TOML.parse(readFileSync(path, 'utf8')) };
}

const CODEX_ENTRY = { command: 'npx', args: ['telegram-agent-ui@latest', 'mcp'] };

test('a Codex config whose string holds a table header keeps the string and every setting, and gets the entry', async () => {
	const text = 'developer_instructions = """\nExample configuration:\n[mcp_servers.telegram-agent-ui]\ncommand = "example"\n"""\nmodel = "gpt-6"\n';
	const codex = codexHome(text);
	expect(await mcpInit('codex', codex.env)).toMatchObject({ ok: true, output: { changed: true } });
	expect(codex.parsed()).toEqual({ developer_instructions: 'Example configuration:\n[mcp_servers.telegram-agent-ui]\ncommand = "example"\n', model: 'gpt-6', mcp_servers: { 'telegram-agent-ui': CODEX_ENTRY } });
	expect(readFileSync(codex.path, 'utf8').startsWith(text)).toBe(true);
	expect(await mcpInit('codex', codex.env)).toMatchObject({ output: { changed: false } });
});

test('a Codex table with a single-quoted name is replaced in place, and the file stays valid', async () => {
	const codex = codexHome("model = \"gpt-6\"\n\n[mcp_servers.'telegram-agent-ui']\ncommand = \"old\"\nenabled = false\n\n[mcp_servers.other]\ncommand = \"other\"\n");
	await mcpInit('codex', codex.env);
	expect(codex.parsed()).toEqual({ model: 'gpt-6', mcp_servers: { 'telegram-agent-ui': CODEX_ENTRY, other: { command: 'other' } } });
});

test('a Codex entry in an inline table, or a config that is no TOML, is refused and left as it was', async () => {
	for (const text of ['mcp_servers = { telegram-agent-ui = { command = "old" } }\n', 'model = "gpt-6\n']) {
		const codex = codexHome(text);
		expect(await mcpInit('codex', codex.env)).toMatchObject({ ok: false, failure: { error: 'refused', code: 'client-config' } });
		expect(readFileSync(codex.path, 'utf8')).toBe(text);
	}
});

test('an OpenCode config with native servers gets the native entry, which wins, and loses a legacy one of the name', async () => {
	const { dir, env } = home();
	const path = join(dir, '.config', 'opencode', 'opencode.json');
	mkdirSync(dirname(path), { recursive: true });
	const other = { type: 'local', command: ['other-server'] };
	writeFileSync(path, JSON.stringify({ mcp: { 'telegram-agent-ui': { type: 'local', command: ['legacy'] }, servers: { 'telegram-agent-ui': { type: 'local', command: ['old-server'], disabled: true }, other } } }));
	expect(await mcpInit('opencode', env)).toMatchObject({ ok: true, output: { changed: true } });
	expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ mcp: { servers: { 'telegram-agent-ui': { type: 'local', command: ['npx', 'telegram-agent-ui@latest', 'mcp'] }, other } } });
	expect(await mcpInit('opencode', env)).toMatchObject({ output: { changed: false } });
});

test('a link to a config that does not exist is refused, and the link stays', async () => {
	const { dir, env } = home();
	const target = join(dir, 'dotfiles', 'cursor.json');
	mkdirSync(join(dir, '.cursor'));
	symlinkSync(target, join(dir, '.cursor', 'mcp.json'));
	expect(await mcpInit('cursor', env)).toMatchObject({ ok: false, failure: { error: 'refused', code: 'client-config', message: expect.stringContaining(`is a link to ${target}, which does not exist. Create the target or remove the link`) } });
	expect(lstatSync(join(dir, '.cursor', 'mcp.json')).isSymbolicLink()).toBe(true);
	expect(existsSync(target)).toBe(false);
});

test('a link whose missing target runs through a linked directory and .. is refused, and the unrelated file of the lexical path keeps its bytes', async () => {
	const { dir, env } = home();
	for (const path of ['.cursor', 'links', join('physical', 'nested')]) mkdirSync(join(dir, path), { recursive: true });
	symlinkSync('../links/jump/../mcp.json', join(dir, '.cursor', 'mcp.json'));
	symlinkSync('../physical/nested', join(dir, 'links', 'jump'));
	const unrelated = join(dir, 'links', 'mcp.json');
	const bytes = '{"mcpServers":{"sentinel":{"command":"unrelated-do-not-change"}},"untouched":true}';
	writeFileSync(unrelated, bytes);
	expect(await mcpInit('cursor', env)).toMatchObject({ ok: false, failure: { code: 'client-config' } });
	expect(readFileSync(unrelated, 'utf8')).toBe(bytes);
	expect(existsSync(join(dir, 'physical', 'mcp.json'))).toBe(false);
});

test('a relative link under a linked directory changes the existing file it leads to, and an unrelated file of the same lexical path keeps its bytes', async () => {
	const { dir, env } = home();
	mkdirSync(join(dir, 'physical', 'cursor'), { recursive: true });
	mkdirSync(join(dir, 'physical', 'shared'));
	mkdirSync(join(dir, 'shared'));
	symlinkSync(join(dir, 'physical', 'cursor'), join(dir, '.cursor'));
	symlinkSync('../shared/mcp.json', join(dir, 'physical', 'cursor', 'mcp.json'));
	const intended = join(dir, 'physical', 'shared', 'mcp.json');
	const unrelated = join(dir, 'shared', 'mcp.json');
	writeFileSync(intended, '{"mcpServers":{"other":{"command":"intended-existing"}}}');
	const bytes = '{"mcpServers":{"sentinel":{"command":"unrelated-do-not-change"}},"untouched":true}';
	writeFileSync(unrelated, bytes);
	expect(await mcpInit('cursor', env)).toMatchObject({ ok: true, output: { changed: true } });
	expect(JSON.parse(readFileSync(intended, 'utf8'))).toEqual({ mcpServers: { other: { command: 'intended-existing' }, 'telegram-agent-ui': STDIO } });
	expect(readFileSync(unrelated, 'utf8')).toBe(bytes);
	expect(lstatSync(join(dir, '.cursor')).isSymbolicLink()).toBe(true);
	expect(lstatSync(join(dir, 'physical', 'cursor', 'mcp.json')).isSymbolicLink()).toBe(true);
	// The same chain to a target that no longer exists is refused, and nothing is written.
	rmSync(intended);
	expect(await mcpInit('cursor', env)).toMatchObject({ ok: false, failure: { code: 'client-config' } });
	expect(existsSync(intended)).toBe(false);
	expect(readFileSync(unrelated, 'utf8')).toBe(bytes);
});

test('the bin runs mcp init --client and refuses a client it does not know', () => {
	const { dir } = home();
	const run = (client: string) =>
		Bun.spawnSync([process.execPath, join(import.meta.dir, '..', 'cli', 'bin.ts'), 'mcp', 'init', '--client', client], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir } });
	const written = run('cursor');
	expect(written.exitCode).toBe(0);
	expect(JSON.parse(written.stdout.toString())).toMatchObject({ client: 'cursor', path: join(dir, '.cursor', 'mcp.json'), changed: true });
	const unknown = run('zed');
	expect(unknown.exitCode).toBe(2);
	expect(JSON.parse(unknown.stdout.toString())).toMatchObject({ error: 'usage', message: expect.stringContaining('claude, cursor, vscode, codex, opencode') });
});

test('a linked config stays a link, and its target gets the entry', async () => {
	const { dir, env } = home();
	const target = join(dir, 'setup', 'config.toml');
	mkdirSync(dirname(target));
	writeFileSync(target, 'model = "gpt-6"\n');
	mkdirSync(join(dir, '.codex'));
	symlinkSync(target, join(dir, '.codex', 'config.toml'));
	await mcpInit('codex', env);
	expect(lstatSync(join(dir, '.codex', 'config.toml')).isSymbolicLink()).toBe(true);
	expect(readFileSync(target, 'utf8')).toContain('[mcp_servers.telegram-agent-ui]');
});
