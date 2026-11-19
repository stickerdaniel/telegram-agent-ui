import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { type Config, findSecret, paths, readConfig, writeConfig } from './config.ts';
import { KEY_NAMES } from './deploy.ts';
import type { Result } from './result.ts';
import { commands } from './table.ts';

setDefaultTimeout(120_000);

const STANDIN = join(import.meta.dir, 'wrangler-standin.ts');
const CONFIG: Config = { v: 1, bot: { id: 222, username: 'probe_bot' }, chat: 111, users: [111, 112], labels: { choose: 'Wähle' }, publishRoots: [], views: {} };
const ACCOUNT = '0123456789abcdef0123456789abcdef';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Call = { args: string[]; account: string | null; botToken: boolean; config?: string; secrets?: Record<string, unknown> };

async function machine(scenario?: string) {
	const root = mkdtempSync(join(tmpdir(), 'tau-deploy-test-'));
	roots.push(root);
	const work = join(root, 'work');
	const standin = join(root, 'standin');
	mkdirSync(work);
	mkdirSync(standin);
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? '/usr/bin:/bin',
		HOME: root,
		XDG_CONFIG_HOME: join(root, 'config'),
		TELEGRAM_BOT_TOKEN: '222:secret',
		TELEGRAM_AGENT_UI_WRANGLER: STANDIN,
		WRANGLER_STANDIN_DIR: standin,
		...(scenario ? { WRANGLER_STANDIN_FAIL: scenario } : {}),
	};
	await writeConfig(env, CONFIG, '222:secret');
	const command = commands.find((entry) => entry.name === 'view deploy');
	if (!command) throw new Error('view deploy is in the table');
	const log: string[] = [];
	const deploy = (input: Record<string, unknown> = {}, overrides: Record<string, string> = {}): Promise<Result> =>
		command.invoke(input, { env: { ...env, ...overrides }, roots: [work], log: (line) => void log.push(line), signal: new AbortController().signal });
	const calls = (): Call[] => {
		const file = join(standin, 'calls.jsonl');
		return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Call) : [];
	};
	return { root, work, env, deploy, calls, log };
}

const steps = (calls: Call[]) => calls.map((call) => call.args.slice(0, call.args[0] === 'deploy' ? 1 : 3).join(' '));
const output = (result: Result) => {
	if (!result.ok) throw new Error(JSON.stringify(result.failure));
	return result.output;
};

test('a first deploy creates the namespace, fills the template and keeps both secrets in .env', async () => {
	const at = await machine();
	const result = output(await at.deploy());
	expect(result).toEqual({ origin: 'https://telegram-agent-ui-222.dana.workers.dev', worker: 'telegram-agent-ui-222', kv: '00000000000000000000000000000001', theme: false, rotated: false });
	const calls = at.calls();
	expect(steps(calls)).toEqual(['kv namespace list', 'kv namespace create', 'kv namespace list', 'deploy']);
	expect(calls[1]?.args).toEqual(['kv', 'namespace', 'create', 'telegram-agent-ui-222']);
	expect(calls.every((call) => !call.botToken && call.account === null)).toBe(true);

	const deployed = calls[3];
	expect(deployed?.config).not.toContain('{{');
	const toml = parse(deployed?.config ?? '');
	expect(toml).toMatchObject({ name: 'telegram-agent-ui-222', workers_dev: true, kv_namespaces: [{ binding: 'VIEWS', id: '00000000000000000000000000000001' }] });
	expect(toml.vars).toEqual({ BOT_ID: '222', ALLOWED_USERS: '[111,112]', LABELS: '{"choose":"Wähle"}', THEME: '' });
	expect(String(toml.main)).toBe(join(import.meta.dir, '..', 'worker', 'index.ts'));
	expect(existsSync(String(toml.main))).toBe(true);

	const upload = await findSecret(at.env, KEY_NAMES.upload);
	const media = await findSecret(at.env, KEY_NAMES.media);
	expect(upload).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(media).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(deployed?.secrets).toEqual({ UPLOAD_KEY: upload, MEDIA_KEY: media });
	const envFile = paths(at.env).envFile;
	expect(statSync(envFile).mode & 0o777).toBe(0o600);
	expect(readFileSync(envFile, 'utf8')).toContain('TELEGRAM_BOT_TOKEN=222:secret\n');
	expect((await readConfig(at.env)).views).toEqual({ origin: 'https://telegram-agent-ui-222.dana.workers.dev' });
	expect(JSON.stringify(result)).not.toContain(upload ?? 'no key');
});

test('a second deploy finds the namespace and keeps the keys, and --rotate-keys makes new ones', async () => {
	const at = await machine();
	output(await at.deploy());
	const before = { upload: await findSecret(at.env, KEY_NAMES.upload), media: await findSecret(at.env, KEY_NAMES.media) };
	output(await at.deploy());
	expect(steps(at.calls()).slice(4)).toEqual(['kv namespace list', 'deploy']);
	expect(at.calls()[5]?.secrets).toEqual({ UPLOAD_KEY: before.upload, MEDIA_KEY: before.media });

	expect(output(await at.deploy({ rotateKeys: true })).rotated).toBe(true);
	const after = { upload: await findSecret(at.env, KEY_NAMES.upload), media: await findSecret(at.env, KEY_NAMES.media) };
	expect(after.upload).not.toBe(before.upload);
	expect(after.media).not.toBe(before.media);
	expect(at.calls().at(-1)?.secrets).toEqual({ UPLOAD_KEY: after.upload, MEDIA_KEY: after.media });
	output(await at.deploy());
	expect(at.calls().at(-1)?.secrets).toEqual({ UPLOAD_KEY: after.upload, MEDIA_KEY: after.media });
});

test('keys from the environment are deployed as they are, and --rotate-keys refuses them before anything changes', async () => {
	const at = await machine();
	const managed = { [KEY_NAMES.upload]: 'upload-from-the-environment', [KEY_NAMES.media]: 'media-from-the-environment' };
	output(await at.deploy({}, managed));
	expect(at.calls().at(-1)?.secrets).toEqual({ UPLOAD_KEY: 'upload-from-the-environment', MEDIA_KEY: 'media-from-the-environment' });
	const envFile = readFileSync(paths(at.env).envFile, 'utf8');
	const calls = at.calls().length;
	for (const env of [managed, { [KEY_NAMES.upload]: 'upload-from-the-environment' }, { [KEY_NAMES.media]: 'media-from-the-environment' }]) {
		const refused = await at.deploy({ rotateKeys: true }, env);
		expect(refused.ok ? undefined : refused.failure, JSON.stringify(env)).toMatchObject({ error: 'usage' });
	}
	expect(at.calls().length).toBe(calls);
	expect(readFileSync(paths(at.env).envFile, 'utf8')).toBe(envFile);
	output(await at.deploy({}, { [KEY_NAMES.upload]: 'upload-rotated', [KEY_NAMES.media]: 'media-rotated' }));
	expect(at.calls().at(-1)?.secrets).toEqual({ UPLOAD_KEY: 'upload-rotated', MEDIA_KEY: 'media-rotated' });
});

test('an account from CLOUDFLARE_ACCOUNT_ID is stored, and a later deploy keeps it when the environment changes', async () => {
	const at = await machine();
	const first = 'a'.repeat(32);
	expect(output(await at.deploy({}, { CLOUDFLARE_ACCOUNT_ID: first })).account).toBe(first);
	expect((await readConfig(at.env)).views.account).toBe(first);
	output(await at.deploy({}, { CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32) }));
	const deployed = at.calls().at(-1);
	expect(deployed?.account).toBe(first);
	expect(parse(deployed?.config ?? '')).toMatchObject({ account_id: first });
	expect((await readConfig(at.env)).views.account).toBe(first);
});

test('route, account and theme go into the deploy and the config, and a later deploy keeps them', async () => {
	const at = await machine();
	const theme = { theme: { radius: '0.5rem' }, dark: { background: 'oklch(0.2 0 0)' } };
	writeFileSync(join(at.work, 'theme.json'), JSON.stringify(theme));
	const result = output(await at.deploy({ route: 'views.example.com/*', account: ACCOUNT, theme: join(at.work, 'theme.json') }));
	expect(result).toMatchObject({ origin: 'https://views.example.com', route: 'views.example.com/*', account: ACCOUNT, theme: true });
	const deployed = at.calls().at(-1);
	expect(deployed?.account).toBe(ACCOUNT);
	expect(parse(deployed?.config ?? '')).toMatchObject({ account_id: ACCOUNT, workers_dev: false, routes: ['views.example.com/*'], vars: { THEME: JSON.stringify(theme) } });
	expect((await readConfig(at.env)).views).toEqual({ origin: 'https://views.example.com', account: ACCOUNT, route: 'views.example.com/*', theme });

	output(await at.deploy());
	expect(parse(at.calls().at(-1)?.config ?? '')).toMatchObject({ account_id: ACCOUNT, routes: ['views.example.com/*'], vars: { THEME: JSON.stringify(theme) } });
	output(await at.deploy({ noTheme: true }));
	expect(parse(at.calls().at(-1)?.config ?? '')).toMatchObject({ vars: { THEME: '' } });
	expect((await readConfig(at.env)).views.theme).toBeUndefined();
});

test('a theme outside the roots or of a wrong shape, a route that is no whole host and a bad account are refused before wrangler runs', async () => {
	const at = await machine();
	const outside = join(at.root, 'theme.json');
	writeFileSync(outside, JSON.stringify({ light: { background: '#fff' } }));
	writeFileSync(join(at.work, 'bad.json'), JSON.stringify({ light: { background: 'red; } body {' } }));
	const refused: [Record<string, unknown>, Record<string, string>][] = [
		[{ theme: outside }, { error: 'refused', code: 'outside-roots' }],
		[{ theme: join(at.work, 'bad.json') }, { error: 'refused', code: 'shape' }],
		[{ theme: join(at.work, 'bad.json'), noTheme: true }, { error: 'usage' }],
		[{ route: '*.example.com/*' }, { error: 'usage' }],
		[{ route: 'views.example.com/subpath/*' }, { error: 'usage' }],
		[{ route: 'views.example.com/' }, { error: 'usage' }],
		[{ account: 'acme' }, { error: 'usage' }],
	];
	for (const [input, failure] of refused) {
		const result = await at.deploy(input);
		expect(result.ok ? undefined : result.failure, JSON.stringify(input)).toMatchObject(failure);
	}
	expect(at.calls()).toEqual([]);
	expect((await readConfig(at.env)).views).toEqual({});
});

test('a failed namespace step deploys nothing, and a failed deploy is uncertain and leaves the config', async () => {
	const listing = await machine('list');
	const refused = await listing.deploy();
	expect(refused.ok ? undefined : refused.failure).toMatchObject({ error: 'refused', code: 'wrangler' });
	expect(steps(listing.calls())).toEqual(['kv namespace list']);

	const deploying = await machine('deploy');
	const uncertain = await deploying.deploy();
	expect(uncertain.ok ? undefined : uncertain.failure).toMatchObject({ error: 'uncertain' });
	expect(uncertain.ok ? '' : uncertain.failure.message).toContain('The Worker may be live');
	expect((await readConfig(deploying.env)).views).toEqual({});
	const sent = deploying.calls().at(-1)?.secrets;
	expect(sent?.UPLOAD_KEY).toBe(await findSecret(deploying.env, KEY_NAMES.upload));
});

test('fake mode refuses to deploy', async () => {
	const at = await machine();
	const result = await at.deploy({}, { TELEGRAM_AGENT_UI_FAKE: join(at.root, 'fake') });
	expect(result.ok ? undefined : result.failure.error).toBe('usage');
	expect(at.calls()).toEqual([]);
});
