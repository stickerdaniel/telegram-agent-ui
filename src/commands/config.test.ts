// The stored values of this stage read back after a JSON round trip, and a value that breaks
// its type reads as none: config.json, the token in .env, and the `listener` key.
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseListener } from '../chat/listener.ts';
import { type Config, findSecret, findToken, parseConfig, paths, readConfig, writeConfig, writeSecrets } from './config.ts';
import { Failed } from './result.ts';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function home() {
	const root = mkdtempSync(join(tmpdir(), 'tau-config-'));
	roots.push(root);
	return { HOME: root };
}

const CONFIG: Config = {
	v: 1,
	bot: { id: 222, username: 'probe_bot' },
	chat: 111,
	users: [111],
	labels: { yes: 'Ja', hintWords: ['tippe'] },
	publishRoots: ['/work/docs'],
	apiUrl: 'http://127.0.0.1:8081',
	views: { origin: 'https://views.example.com', account: '0123456789abcdef0123456789abcdef', route: 'views.example.com/*', theme: { dark: { background: 'oklch(0.2 0 0)' } } },
};

test('a written config reads back equal, under the XDG defaults of HOME', async () => {
	const env = home();
	await writeConfig(env, CONFIG, '222:secret');
	expect(paths(env).configFile).toBe(join(env.HOME, '.config', 'telegram-agent-ui', 'config.json'));
	expect(paths(env).store(222)).toBe(join(env.HOME, '.local', 'share', 'telegram-agent-ui', '222'));
	expect(await readConfig(env)).toEqual(CONFIG);
	expect(await findToken(env)).toBe('222:secret');
	expect(await findToken({ ...env, TELEGRAM_BOT_TOKEN: '222:from-env' })).toBe('222:from-env');
});

test('a config that breaks any field reads as none, and readConfig says so', async () => {
	const broken: unknown[] = [
		{ ...CONFIG, v: 2 },
		{ ...CONFIG, chat: '111' },
		{ ...CONFIG, users: [1.5] },
		{ ...CONFIG, apiUrl: 'ftp://example.com' },
		{ ...CONFIG, views: { origin: 'http://views.example.com' } },
		{ ...CONFIG, views: { account: 'acme' } },
		{ ...CONFIG, views: { route: '*.example.com/*' } },
		{ ...CONFIG, views: { theme: { light: { background: 'red; }' } } } },
		{ ...CONFIG, labels: { yess: 'Ja' } },
		{ ...CONFIG, labels: { yes: '' } },
		{ ...CONFIG, publishRoots: '/work' },
	];
	for (const value of broken) expect(parseConfig(JSON.parse(JSON.stringify(value))), JSON.stringify(value)).toBeUndefined();
	const env = home();
	await expect(readConfig(env)).rejects.toThrow(Failed);
	await writeConfig(env, CONFIG, '222:secret');
	writeFileSync(paths(env).configFile, '{"v":1');
	await expect(readConfig(env)).rejects.toMatchObject({ failure: { error: 'no-config' } });
});

test('the token is read from a .env line with export and quotes', async () => {
	const env = home();
	await writeConfig(env, CONFIG, 'x');
	writeFileSync(paths(env).envFile, 'OTHER=1\nexport TELEGRAM_BOT_TOKEN="222:quoted"\n');
	expect(await findToken(env)).toBe('222:quoted');
});

test('writing the token keeps the other lines of .env, and writing a secret keeps the token', async () => {
	const env = home();
	await writeConfig(env, CONFIG, '222:first');
	await writeSecrets(env, { TELEGRAM_AGENT_UI_UPLOAD_KEY: 'upload' });
	await writeConfig(env, CONFIG, '222:second');
	expect(await findToken(env)).toBe('222:second');
	expect(await findSecret(env, 'TELEGRAM_AGENT_UI_UPLOAD_KEY')).toBe('upload');
	expect(readFileSync(paths(env).envFile, 'utf8')).toBe('TELEGRAM_AGENT_UI_UPLOAD_KEY=upload\nTELEGRAM_BOT_TOKEN=222:second\n');
});

test('the listener record reads back after a JSON round trip, and a broken one reads as none', () => {
	const record = { v: 1 as const, heartbeat: 1_000, polled: 900, push: { metaKeys: ['session'] }, stopped: 'conflict' };
	expect(parseListener(JSON.parse(JSON.stringify(record)))).toEqual(record);
	expect(parseListener({ v: 1, heartbeat: 1_000 })).toEqual({ v: 1, heartbeat: 1_000 });
	for (const broken of [{ ...record, polled: -1 }, { ...record, push: { metaKeys: 'session' } }, { ...record, heartbeat: '1000' }]) expect(parseListener(broken)).toBeUndefined();
});
