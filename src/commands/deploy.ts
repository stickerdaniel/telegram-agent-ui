import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRecord, isString } from '../core/check.ts';
import { type CssVars, parseTheme, themeIssue } from '../view/theme.ts';
import { type Config, type Env, findSecret, isAccount, KEY_NAMES, readConfig, routeOrigin, writeConfigFile, writeSecrets } from './config.ts';
import { done, failed, type Result } from './result.ts';
import { type Context, readBodyFile, rootsOf } from './session.ts';

export const WRANGLER_VERSION = '4.164.0';
export { KEY_NAMES } from './config.ts';

const here = fileURLToPath(import.meta.url);
const WORKER = fileURLToPath(new URL(`../worker/index${extname(here)}`, import.meta.url));
const TEMPLATE = new URL('../../src/worker/wrangler.toml', import.meta.url);

const KV_DEADLINE = 120_000;
const DEPLOY_DEADLINE = 600_000;

type Ran = { code: number | null; stdout: string; stderr: string };
type Wrangler = (args: string[], deadline: number) => Promise<Ran>;

const newKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');

const tomlString = (text: string) => JSON.stringify(text).replaceAll('\u007f', '\\u007f');

const tail = (ran: Ran) => `${ran.stdout}\n${ran.stderr}`.trim().split('\n').slice(-12).join('\n');

function wranglerIn(env: Env, cwd: string, account: string | undefined): Wrangler {
	const command = env.TELEGRAM_AGENT_UI_WRANGLER ? [env.TELEGRAM_AGENT_UI_WRANGLER] : ['npx', '--yes', `wrangler@${WRANGLER_VERSION}`];
	const childEnv: Record<string, string> = {};
	for (const [name, value] of Object.entries(env)) if (value !== undefined && name !== 'TELEGRAM_BOT_TOKEN' && !name.startsWith('TELEGRAM_AGENT_UI_')) childEnv[name] = value;
	if (account !== undefined) childEnv.CLOUDFLARE_ACCOUNT_ID = account;
	const [file = 'npx', ...prefix] = command;
	return (args, deadline) =>
		new Promise((resolve) => {
			const child = spawn(file, [...prefix, ...args], { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
			let stdout = '';
			let stderr = '';
			child.stdout.setEncoding('utf8').on('data', (chunk: string) => void (stdout += chunk));
			child.stderr.setEncoding('utf8').on('data', (chunk: string) => void (stderr += chunk));
			const timer = setTimeout(() => {
				try {
					if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
				} catch {
				}
			}, deadline);
			child.on('error', (error) => {
				clearTimeout(timer);
				resolve({ code: null, stdout, stderr: `${stderr}${error.message}` });
			});
			child.on('close', (code) => {
				clearTimeout(timer);
				resolve({ code, stdout, stderr });
			});
		});
}

function listed(stdout: string): unknown[] | undefined {
	try {
		const value: unknown = JSON.parse(stdout.slice(stdout.indexOf('['), stdout.lastIndexOf(']') + 1));
		return Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

async function namespace(wrangler: Wrangler, title: string): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
	const find = async (): Promise<{ id?: string; failure?: string }> => {
		const ran = await wrangler(['kv', 'namespace', 'list'], KV_DEADLINE);
		const list = ran.code === 0 ? listed(ran.stdout) : undefined;
		if (!list) return { failure: `wrangler kv namespace list ${ran.code === 0 ? 'printed no list' : `exited ${ran.code}`}:\n${tail(ran)}` };
		const entry = list.find((item) => isRecord(item) && item.title === title);
		return isRecord(entry) && isString(entry.id) ? { id: entry.id } : {};
	};
	const first = await find();
	if (first.failure !== undefined) return { ok: false, message: first.failure };
	if (first.id !== undefined) return { ok: true, id: first.id };
	const created = await wrangler(['kv', 'namespace', 'create', title], KV_DEADLINE);
	const second = await find();
	if (second.id !== undefined) return { ok: true, id: second.id };
	return { ok: false, message: `wrangler kv namespace create ${title} exited ${created.code}:\n${tail(created)}` };
}

export function fillTemplate(template: string, values: Record<string, string>): string {
	return template.replace(/\{\{(\w+)\}\}/g, (_whole, field: string) => {
		const value = values[field];
		if (value === undefined) throw new Error(`the wrangler template field ${field} has no value`);
		return value;
	});
}

export async function wranglerConfig(config: Config, deploy: { kv: string; account?: string | undefined; route?: string | undefined; theme?: CssVars | undefined }): Promise<string> {
	const { kv, account, route, theme } = deploy;
	return fillTemplate(await readFile(TEMPLATE, 'utf8'), {
		name: tomlString(`telegram-agent-ui-${config.bot.id}`),
		main: tomlString(WORKER),
		workersDev: route === undefined ? 'true' : 'false',
		account: account === undefined ? '# account_id: the one account of the wrangler login' : `account_id = ${tomlString(account)}`,
		routes: route === undefined ? '# routes: none, the host serves on workers.dev' : `routes = [${tomlString(route)}]`,
		kv: tomlString(kv),
		botId: tomlString(String(config.bot.id)),
		allowedUsers: tomlString(JSON.stringify(config.users)),
		labels: tomlString(JSON.stringify(config.labels)),
		theme: tomlString(theme === undefined ? '' : JSON.stringify(theme)),
	});
}

function workersDev(stdout: string, name: string): string | undefined {
	return new RegExp(`https://${name}\\.[a-z0-9-]+\\.workers\\.dev`).exec(stdout)?.[0];
}

export type DeployInput = { theme?: string; noTheme?: boolean; route?: string; account?: string; rotateKeys?: boolean };

export async function viewDeploy(input: DeployInput, context: Context): Promise<Result> {
	const { env } = context;
	if (env.TELEGRAM_AGENT_UI_FAKE) return failed({ error: 'usage', message: 'fake mode has no view host to deploy' });
	if (input.theme !== undefined && input.noTheme) return failed({ error: 'usage', message: '--theme and --no-theme exclude each other' });
	const config = await readConfig(env);
	const route = input.route ?? config.views.route;
	const account = input.account ?? config.views.account ?? (env.CLOUDFLARE_ACCOUNT_ID || undefined);
	if (route !== undefined && routeOrigin(route) === undefined) {
		return failed({ error: 'usage', message: `the route "${route}" is no <host>/* of one host, such as views.example.com/*: the shell, the API and the media URLs sit at the root of the host` });
	}
	if (account !== undefined && !isAccount(account)) return failed({ error: 'usage', message: `the account "${account}" is no Cloudflare account id of 32 hex digits` });
	const fromEnv = Object.values(KEY_NAMES).filter((name) => env[name]);
	if (input.rotateKeys && fromEnv.length > 0) {
		return failed({ error: 'usage', message: `${fromEnv.join(' and ')} come from the environment, which wins over .env: put new keys there and run view deploy without --rotate-keys` });
	}

	let theme = input.noTheme ? undefined : config.views.theme;
	if (input.theme !== undefined) {
		const read = await readBodyFile(input.theme, { roots: await rootsOf(context), cwd: process.cwd(), env });
		if (!read.ok) return failed(read.failure);
		let value: unknown;
		try {
			value = JSON.parse(read.text);
		} catch {
			return failed({ error: 'refused', code: 'shape', message: `the theme ${input.theme} is no JSON` });
		}
		theme = parseTheme(value);
		if (!theme) return failed({ error: 'refused', code: 'shape', message: `the theme ${input.theme} is refused: ${themeIssue(value)}` });
	}

	const found = { upload: await findSecret(env, KEY_NAMES.upload), media: await findSecret(env, KEY_NAMES.media) };
	const keys = { upload: (!input.rotateKeys && found.upload) || newKey(), media: (!input.rotateKeys && found.media) || newKey() };
	if (keys.upload !== found.upload || keys.media !== found.media) await writeSecrets(env, { [KEY_NAMES.upload]: keys.upload, [KEY_NAMES.media]: keys.media });

	const name = `telegram-agent-ui-${config.bot.id}`;
	const dir = await mkdtemp(join(tmpdir(), 'tau-deploy-'));
	try {
		const wrangler = wranglerIn(env, dir, account);
		context.log(`view deploy: the KV namespace ${name}`);
		const kv = await namespace(wrangler, name);
		if (!kv.ok) return failed({ error: 'refused', code: 'wrangler', message: `${kv.message}\nNothing was deployed: check the wrangler login and run view deploy again` });
		const toml = join(dir, 'wrangler.toml');
		const secrets = join(dir, 'secrets.json');
		await writeFile(toml, await wranglerConfig(config, { kv: kv.id, account, route, theme }));
		await writeFile(secrets, JSON.stringify({ UPLOAD_KEY: keys.upload, MEDIA_KEY: keys.media }), { mode: 0o600 });
		await chmod(secrets, 0o600);
		context.log(`view deploy: deploying ${name} with wrangler ${WRANGLER_VERSION}`);
		const deployed = await wrangler(['deploy', '--config', toml, '--secrets-file', secrets], DEPLOY_DEADLINE);
		const origin = route !== undefined ? routeOrigin(route) : workersDev(deployed.stdout, name);
		if (deployed.code !== 0 || origin === undefined) {
			const end = deployed.code !== 0 ? `exited ${deployed.code}` : 'printed no workers.dev address';
			return failed({ error: 'uncertain', message: `wrangler deploy ${end}:\n${tail(deployed)}\nThe Worker may be live: run view deploy again` });
		}
		if (config.views.origin !== undefined && config.views.origin !== origin) context.log(`warning: the view host moves from ${config.views.origin} to ${origin}; buttons sent before open the old address`);
		await writeConfigFile(env, { ...config, views: { origin, ...(account !== undefined ? { account } : {}), ...(route !== undefined ? { route } : {}), ...(theme ? { theme } : {}) } });
		return done({ origin, worker: name, kv: kv.id, ...(account !== undefined ? { account } : {}), ...(route !== undefined ? { route } : {}), theme: theme !== undefined, rotated: input.rotateKeys === true });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
