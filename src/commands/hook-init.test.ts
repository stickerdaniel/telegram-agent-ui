import { afterEach, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookInit } from './hook-init.ts';
import type { Context } from './session.ts';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function home(version = '2.1.327') {
	const root = mkdtempSync(join(tmpdir(), 'tau-hook-init-'));
	roots.push(root);
	const bin = join(root, 'bin');
	mkdirSync(bin);
	writeFileSync(join(bin, 'claude'), `#!/bin/sh\necho "${version} (Claude Code)"\n`);
	chmodSync(join(bin, 'claude'), 0o755);
	const log: string[] = [];
	const context: Context = { env: { HOME: root, PATH: `${bin}:/usr/bin:/bin` }, roots: [], log: (line) => log.push(line), signal: new AbortController().signal };
	return { root, context, log };
}

const write = (path: string, value: unknown) => {
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};
const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

const BIN = realpathSync(join(import.meta.dir, '..', 'cli', 'bin.ts'));
const pinned = (rest: string) => `'${process.execPath}' '${BIN}' hook ${rest}`;
const PERMISSION = pinned('permission-request --client claude --seconds 570');
const NOTIFICATION = pinned('notification --client claude');

test('hook init --client claude writes both hooks into settings.json and keeps every other key and handler', async () => {
	const { root, context, log } = home();
	const settings = join(root, '.claude', 'settings.json');
	const own = { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/audit.sh' }] };
	const notice = { matcher: 'idle_prompt', hooks: [{ type: 'command', command: 'say idle' }] };
	write(settings, { model: 'opus', permissions: { allow: ['Bash(git status)'], deny: ['Bash(rm *)'] }, hooks: { PreToolUse: [own], Notification: [notice] }, statusLine: { type: 'command', command: 'status.sh' } });
	const seen: boolean[] = [];
	const watched: Context = {
		...context,
		log(line) {
			log.push(line);
			if (line.startsWith('warning tool-input')) seen.push(readFileSync(settings, 'utf8').includes(PERMISSION));
		},
	};

	const first = await hookInit('claude', watched);
	expect(first).toMatchObject({ ok: true, output: { client: 'claude', path: settings, changed: true } });
	expect(seen).toEqual([false]);
	expect(log.join('\n')).toContain('goes to Telegram');
	expect(read(settings)).toEqual({
		model: 'opus',
		permissions: { allow: ['Bash(git status)'], deny: ['Bash(rm *)'] },
		statusLine: { type: 'command', command: 'status.sh' },
		hooks: {
			PreToolUse: [own],
			PermissionRequest: [{ matcher: '^(?!(?:AskUserQuestion|ExitPlanMode)$).*', hooks: [{ type: 'command', command: PERMISSION, timeout: 600, onFailure: 'block' }] }],
			Notification: [notice, { matcher: 'agent_needs_input|permission_prompt', hooks: [{ type: 'command', command: NOTIFICATION }] }],
		},
	});
	const text = readFileSync(settings, 'utf8');
	expect(await hookInit('claude', context)).toMatchObject({ ok: true, output: { changed: false } });
	expect(readFileSync(settings, 'utf8')).toBe(text);
});

test('the Claude Code matcher, a JavaScript regular expression tested unanchored, leaves out AskUserQuestion and ExitPlanMode alone', async () => {
	const { root, context } = home();
	await hookInit('claude', context);
	const settings = read(join(root, '.claude', 'settings.json'));
	const matcher = JSON.stringify(settings).match(/"matcher":"(\^[^"]+)"/)?.[1] ?? '';
	const runs = (tool: string) => new RegExp(matcher).test(tool);
	expect(['Bash', 'Write', 'Edit', 'WebFetch', 'mcp__github__create_issue', 'AskUserQuestions'].every(runs)).toBe(true);
	expect(runs('AskUserQuestion')).toBe(false);
	expect(runs('ExitPlanMode')).toBe(false);
});

test('a handler of this package from an earlier init is replaced in its place, and its neighbours stay', async () => {
	const { root, context } = home();
	const settings = join(root, '.claude', 'settings.json');
	const before = { matcher: 'idle_prompt', hooks: [{ type: 'command', command: 'say idle' }] };
	const after = { matcher: 'auth_success', hooks: [{ type: 'command', command: 'say signed in' }] };
	write(settings, {
		hooks: {
			PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'npx telegram-agent-ui@latest hook permission-request --client claude --seconds 570', timeout: 120 }] }],
			Notification: [before, { matcher: 'permission_prompt', hooks: [{ type: 'command', command: 'npx telegram-agent-ui@latest hook notification --client claude' }] }, after],
		},
	});
	expect(await hookInit('claude', context)).toMatchObject({ ok: true, output: { changed: true } });
	const hooks = read(settings);
	expect(hooks).toMatchObject({ hooks: { PermissionRequest: [{ hooks: [{ command: PERMISSION, timeout: 600 }] }], Notification: [before, { matcher: 'agent_needs_input|permission_prompt' }, after] } });
	expect(JSON.stringify(hooks).match(/hook permission-request/g)).toHaveLength(1);
});

test('hook init refuses a file with another PermissionRequest handler, for either client, and writes nothing', async () => {
	const { root, context } = home();
	const settings = join(root, '.claude', 'settings.json');
	const claude = { hooks: { PermissionRequest: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'approve-all.sh' }] }] } };
	write(settings, claude);
	expect(await hookInit('claude', context)).toMatchObject({ ok: false, failure: { error: 'refused', code: 'other-hook', message: expect.stringContaining('approve-all.sh') } });
	expect(read(settings)).toEqual(claude);
	const file = join(root, 'codex', 'hooks.json');
	const codex = { hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'audit.sh', timeout: 5 }] }] } };
	write(file, codex);
	expect(await hookInit('codex', { ...context, env: { ...context.env, CODEX_HOME: join(root, 'codex') } })).toMatchObject({ ok: false, failure: { code: 'other-hook' } });
	expect(read(file)).toEqual(codex);
});

test('hook init refuses a Claude Code older than 2.1.295 and one it cannot run, and writes nothing', async () => {
	const old = home('2.1.294');
	expect(await hookInit('claude', old.context)).toMatchObject({ ok: false, failure: { error: 'refused', code: 'client-version', message: expect.stringContaining('2.1.295 or later') } });
	expect(existsSync(join(old.root, '.claude', 'settings.json'))).toBe(false);
	expect(old.log).toEqual([]);
	const missing = home();
	const settings = join(missing.root, '.claude', 'settings.json');
	write(settings, { model: 'opus' });
	expect(await hookInit('claude', { ...missing.context, env: { ...missing.context.env, PATH: '/nowhere' } })).toMatchObject({ ok: false, failure: { code: 'client-version' } });
	expect(read(settings)).toEqual({ model: 'opus' });
	expect(await hookInit('claude', home('2.1.295').context)).toMatchObject({ ok: true });
});

test('hook init --client codex writes the permission hook into hooks.json of CODEX_HOME and keeps the rest', async () => {
	const { root, context } = home('0.0.0');
	const codexHome = join(root, 'codex');
	const env = { ...context.env, CODEX_HOME: codexHome };
	const file = join(codexHome, 'hooks.json');
	const stop = { hooks: [{ type: 'command', command: 'notify.sh', timeout: 5 }] };
	write(file, { description: 'my hooks', hooks: { Stop: [stop] } });
	const first = await hookInit('codex', { ...context, env });
	expect(first).toMatchObject({ ok: true, output: { client: 'codex', path: file, changed: true, next: expect.stringContaining('/hooks') } });
	expect(read(file)).toEqual({
		description: 'my hooks',
		hooks: { Stop: [stop], PermissionRequest: [{ hooks: [{ type: 'command', command: pinned('permission-request --client codex --seconds 570'), timeout: 600 }] }] },
	});
	const text = readFileSync(file, 'utf8');
	expect(await hookInit('codex', { ...context, env })).toMatchObject({ ok: true, output: { changed: false } });
	expect(readFileSync(file, 'utf8')).toBe(text);
});

test('another PermissionRequest handler in a layer the harness loads for the working directory refuses, and the written file stays', async () => {
	const { root, context } = home();
	const repo = join(root, 'repo');
	const cwd = join(repo, 'sub');
	mkdirSync(join(repo, '.git'), { recursive: true });
	mkdirSync(cwd);
	const inRepo: Context = { ...context, cwd };
	const settings = join(root, '.claude', 'settings.json');
	const layers = [join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json'), join(repo, '.claude', 'settings.local.json')];
	expect(await hookInit('claude', inRepo)).toMatchObject({ ok: true, output: { checked: [settings, ...layers] } });
	const written = readFileSync(settings, 'utf8');
	write(join(repo, '.claude', 'settings.local.json'), { hooks: { PermissionRequest: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'approve.sh' }] }] } });
	expect(await hookInit('claude', inRepo)).toMatchObject({ ok: false, failure: { code: 'other-hook', message: expect.stringContaining(join(repo, '.claude', 'settings.local.json')) } });
	expect(readFileSync(settings, 'utf8')).toBe(written);

	const codexHome = join(root, 'codex');
	const codex: Context = { ...inRepo, env: { ...context.env, CODEX_HOME: codexHome } };
	const projectConfig = join(repo, '.codex', 'config.toml');
	mkdirSync(join(repo, '.codex'));
	writeFileSync(projectConfig, '[[hooks.PermissionRequest]]\nmatcher = "Bash"\n\n[[hooks.PermissionRequest.hooks]]\ntype = "command"\ncommand = "approve.sh"\n');
	expect(await hookInit('codex', codex)).toMatchObject({ ok: false, failure: { code: 'other-hook', message: expect.stringContaining(projectConfig) } });
	expect(existsSync(join(codexHome, 'hooks.json'))).toBe(false);
	writeFileSync(projectConfig, 'model = "gpt-5.5"\n');
	const checked = [join(codexHome, 'hooks.json'), join(codexHome, 'config.toml'), join(repo, '.codex', 'hooks.json'), projectConfig, join(cwd, '.codex', 'hooks.json'), join(cwd, '.codex', 'config.toml')];
	expect(await hookInit('codex', codex)).toMatchObject({ ok: true, output: { checked } });
});

test("this package's own handler in another layer refuses too, the earlier npx one and the pinned one alike, since hook init changes only its own file", async () => {
	const { root, context } = home();
	const cwd = join(root, 'project');
	mkdirSync(join(cwd, '.git'), { recursive: true });
	const codexHome = join(root, 'codex');
	const codex: Context = { ...context, cwd, env: { ...context.env, CODEX_HOME: codexHome } };
	const layer = join(cwd, '.codex', 'hooks.json');
	for (const command of ['npx telegram-agent-ui@latest hook permission-request --client codex --seconds 570', pinned('permission-request --client codex --seconds 570')]) {
		write(layer, { hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command, timeout: 600 }] }] } });
		expect(await hookInit('codex', codex)).toMatchObject({ ok: false, failure: { code: 'other-hook', message: expect.stringContaining(layer) } });
		expect(existsSync(join(codexHome, 'hooks.json'))).toBe(false);
	}
});

test('a pinned-looking command of another runtime and bin is another handler: kept for Notification, refused for PermissionRequest', async () => {
	const { root, context } = home();
	const other = (rest: string) => `'/opt/other/node' '/opt/other/cli/bin.js' hook ${rest}`;
	const settings = join(root, '.claude', 'settings.json');
	const notice = { matcher: 'permission_prompt', hooks: [{ type: 'command', command: other('notification --client claude') }] };
	write(settings, { hooks: { Notification: [notice] } });
	expect(await hookInit('claude', context)).toMatchObject({ ok: true });
	expect(read(settings)).toMatchObject({ hooks: { Notification: [notice, { hooks: [{ command: NOTIFICATION }] }] } });
	const permission = { matcher: 'Bash', hooks: [{ type: 'command', command: other('permission-request --client claude --seconds 570') }] };
	write(settings, { hooks: { PermissionRequest: [permission] } });
	expect(await hookInit('claude', context)).toMatchObject({ ok: false, failure: { code: 'other-hook' } });
	expect(read(settings)).toEqual({ hooks: { PermissionRequest: [permission] } });
});

test('a command that names this package in a comment is another handler: kept, and for PermissionRequest refused', async () => {
	const { root, context } = home();
	const audit = { type: 'command', command: 'audit.sh # telegram-agent-ui hook permission-request --client codex', timeout: 5 };
	const file = join(root, 'codex', 'hooks.json');
	write(file, { hooks: { PermissionRequest: [{ hooks: [audit] }] } });
	expect(await hookInit('codex', { ...context, env: { ...context.env, CODEX_HOME: join(root, 'codex') } })).toMatchObject({ ok: false, failure: { code: 'other-hook' } });
	expect(read(file)).toEqual({ hooks: { PermissionRequest: [{ hooks: [audit] }] } });
	const settings = join(root, '.claude', 'settings.json');
	const notice = { matcher: 'permission_prompt', hooks: [{ type: 'command', command: 'audit.sh # telegram-agent-ui hook notification --client claude' }] };
	write(settings, { hooks: { Notification: [notice] } });
	expect(await hookInit('claude', context)).toMatchObject({ ok: true });
	expect(read(settings)).toMatchObject({ hooks: { Notification: [notice, { hooks: [{ command: NOTIFICATION }] }] } });
});

test('the written command runs this installation by absolute paths, with no npm on its PATH', async () => {
	const { root, context } = home();
	await hookInit('codex', { ...context, env: { ...context.env, CODEX_HOME: join(root, 'codex') } });
	const command = JSON.stringify(read(join(root, 'codex', 'hooks.json'))).match(/"command":"([^"]+)"/)?.[1] ?? '';
	expect(command).toBe(pinned('permission-request --client codex --seconds 570'));
	const project = join(root, 'project');
	mkdirSync(project);
	const out = execFileSync('/bin/sh', ['-c', command], { cwd: project, env: { HOME: root, PATH: '/nowhere' }, input: 'not json', encoding: 'utf8' });
	expect(JSON.parse(out)).toMatchObject({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } } });
});

test('hook init run from an npx cache refuses and asks for an install', () => {
	const { root } = home();
	const pkg = join(root, 'npm-cache', '_npx', '3f2a', 'node_modules', 'telegram-agent-ui');
	mkdirSync(pkg, { recursive: true });
	cpSync(join(import.meta.dir, '..'), join(pkg, 'src'), { recursive: true });
	symlinkSync(join(import.meta.dir, '..', '..', 'node_modules'), join(pkg, 'node_modules'));
	const codexHome = join(root, 'codex');
	const ran = spawnSync(process.execPath, [join(pkg, 'src', 'cli', 'bin.ts'), 'hook', 'init', '--client', 'codex'], { env: { HOME: root, PATH: '/usr/bin:/bin', CODEX_HOME: codexHome }, encoding: 'utf8' });
	expect(ran.status).toBe(1);
	expect(JSON.parse(ran.stdout)).toMatchObject({ error: 'refused', code: 'npx-cache', message: expect.stringContaining('npm i -g telegram-agent-ui') });
	expect(existsSync(join(codexHome, 'hooks.json'))).toBe(false);
});

test('a settings file whose hooks are no object is refused and left as it was', async () => {
	const { root, context } = home();
	const settings = join(root, '.claude', 'settings.json');
	write(settings, { hooks: [] });
	expect(await hookInit('claude', context)).toMatchObject({ ok: false, failure: { error: 'refused', code: 'client-config' } });
	expect(read(settings)).toEqual({ hooks: [] });
});
