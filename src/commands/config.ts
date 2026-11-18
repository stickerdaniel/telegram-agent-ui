// The configuration of 5.1, on disk. The token comes from TELEGRAM_BOT_TOKEN, else from
// `$XDG_CONFIG_HOME/telegram-agent-ui/.env`, written with mode 0600; the keys of the view host
// that `view deploy` makes sit in the same file. `config.json` beside it holds the bot, the chat,
// its users and the view host. The store of a bot is `$XDG_DATA_HOME/telegram-agent-ui/<bot id>/`.
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { arrayOf, isInt, isRecord, isString } from '../core/check.ts';
import { parseLabels } from '../core/labels.ts';
import { isOrigin } from '../core/shape.ts';
import type { Labels } from '../core/types.ts';
import { type CssVars, parseTheme } from '../view/theme.ts';
import { Failed } from './result.ts';

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * `config.json`. `view deploy` writes `views`: the origin of the host, the Cloudflare account
 * and the route it was deployed with, and the theme it carries, so a later deploy keeps them.
 */
export type Config = {
	v: 1;
	bot: { id: number; username: string };
	chat: number;
	users: number[];
	labels: Partial<Labels>;
	publishRoots: string[];
	apiUrl?: string;
	views: Views;
};
export type Views = { origin?: string; account?: string; route?: string; theme?: CssVars };

/** A Cloudflare account id: 32 hex digits. */
export const isAccount = (value: string) => /^[0-9a-f]{32}$/.test(value);

/**
 * The origin a Worker route serves, `https://<host>`, or undefined for any other route. A route
 * is `<host>/*`, such as `views.example.com/*`: one host without a wildcard, all of its paths,
 * since the shell, the API and the media URLs sit at the root of the host.
 */
export function routeOrigin(route: string): string | undefined {
	const match = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/\*$/i.exec(route);
	const host = match?.[1]?.toLowerCase();
	return host === undefined ? undefined : `https://${host}`;
}

/** The `views` of a config, or undefined when a field breaks its type. */
function parseViews(value: unknown): Views | undefined {
	if (!isRecord(value)) return undefined;
	const { origin, account, route, theme } = value;
	if (origin !== undefined && !(isString(origin) && isOrigin(origin))) return undefined;
	if (account !== undefined && !(isString(account) && isAccount(account))) return undefined;
	if (route !== undefined && !(isString(route) && routeOrigin(route) !== undefined)) return undefined;
	const parsedTheme = theme === undefined ? undefined : parseTheme(theme);
	if (theme !== undefined && parsedTheme === undefined) return undefined;
	return {
		...(isString(origin) ? { origin } : {}),
		...(isString(account) ? { account } : {}),
		...(isString(route) ? { route } : {}),
		...(parsedTheme ? { theme: parsedTheme } : {}),
	};
}

/** A file a non-photo upload may have: the cloud Bot API's limit and a local server's. */
export const FILE_LIMITS = { cloud: 50_000_000, local: 2_000_000_000 } as const;

/** The directories of 5.1, from the XDG variables with their defaults under HOME. */
export function paths(env: Env) {
	const home = env.HOME || homedir();
	const config = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'telegram-agent-ui');
	const data = join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'telegram-agent-ui');
	return { config, configFile: join(config, 'config.json'), envFile: join(config, '.env'), store: (bot: number) => join(data, String(bot)) };
}

const isHttpUrl = (value: unknown): value is string => isString(value) && URL.canParse(value) && /^https?:$/.test(new URL(value).protocol);

/** The stored value of `config.json`, or undefined when any field breaks its type. */
export function parseConfig(value: unknown): Config | undefined {
	if (!isRecord(value) || value.v !== 1) return undefined;
	const { bot, chat, users, publishRoots, apiUrl, views } = value;
	if (!isRecord(bot) || !isInt(bot.id) || !isString(bot.username) || !isInt(chat) || !arrayOf(isInt)(users) || !arrayOf(isString)(publishRoots)) return undefined;
	if (apiUrl !== undefined && !isHttpUrl(apiUrl)) return undefined;
	const parsedViews = parseViews(views);
	const labels = parseLabels(value.labels);
	if (!labels || !parsedViews) return undefined;
	return {
		v: 1,
		bot: { id: bot.id, username: bot.username },
		chat,
		users: [...users],
		labels,
		publishRoots: [...publishRoots],
		...(apiUrl !== undefined ? { apiUrl } : {}),
		views: parsedViews,
	};
}

/** The text of a file, or undefined when it does not exist. */
async function readText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, 'utf8');
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
		throw error;
	}
}

/** The config, or a thrown `no-config` failure that says what is missing. */
export async function readConfig(env: Env): Promise<Config> {
	const { configFile } = paths(env);
	const text = await readText(configFile);
	if (text === undefined) throw new Failed({ error: 'no-config', message: `no config at ${configFile}: run telegram-agent-ui init` });
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		value = undefined;
	}
	const config = parseConfig(value);
	if (!config) throw new Failed({ error: 'no-config', message: `the config at ${configFile} breaks its format: run telegram-agent-ui init` });
	return config;
}

/** The line of a .env file that sets `name`, with or without `export`. */
const lineOf = (name: string) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*?)\\s*$`);

/** `<name>=<value>` of a .env file, with or without `export` and quotes. */
function valueIn(text: string, name: string): string | undefined {
	for (const line of text.split('\n')) {
		const value = lineOf(name).exec(line)?.[1]?.replace(/^(['"])(.*)\1$/, '$2');
		if (value) return value;
	}
	return undefined;
}

/** The value of `name` from the environment, then from the config's `.env`, or undefined. */
export async function findSecret(env: Env, name: string): Promise<string | undefined> {
	if (env[name]) return env[name];
	const text = await readText(paths(env).envFile);
	return text === undefined ? undefined : valueIn(text, name);
}

/** The token from the environment, then from the config's `.env`, or undefined. */
export const findToken = (env: Env) => findSecret(env, 'TELEGRAM_BOT_TOKEN');

/** The Bot API root of every call: TELEGRAM_AGENT_UI_API_URL, then the config's `apiUrl`. Throws `no-config` for one that is no http or https URL. */
export function apiUrlOf(env: Env, config?: Pick<Config, 'apiUrl'>): string | undefined {
	const url = env.TELEGRAM_AGENT_UI_API_URL || config?.apiUrl;
	if (url !== undefined && !isHttpUrl(url)) throw new Failed({ error: 'no-config', message: `the Bot API URL "${url}" is no http or https URL` });
	return url;
}

/** Writes `text` to `path` with `mode` through a temp file in the same directory, so a reader never sees a part. */
async function writeAtomic(path: string, text: string, mode: number): Promise<void> {
	const temp = `${path}.${process.pid}.tmp`;
	try {
		await writeFile(temp, text, { mode });
		await chmod(temp, mode);
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

/**
 * Sets each `name=value` line of `.env`, mode 0600, in a directory of mode 0700. Every other
 * line stays, so `init` keeps the keys of `view deploy` and `view deploy` keeps the token.
 */
export async function writeSecrets(env: Env, values: Record<string, string>): Promise<void> {
	const where = paths(env);
	await mkdir(where.config, { recursive: true, mode: 0o700 });
	await chmod(where.config, 0o700);
	const kept = ((await readText(where.envFile)) ?? '').split('\n').filter((line) => line.trim() !== '' && !Object.keys(values).some((name) => lineOf(name).test(line)));
	await writeAtomic(where.envFile, [...kept, ...Object.entries(values).map(([name, value]) => `${name}=${value}`)].map((line) => `${line}\n`).join(''), 0o600);
}

/** Writes the config to `config.json`, mode 0600, in a directory of mode 0700. */
export async function writeConfigFile(env: Env, config: Config): Promise<void> {
	const where = paths(env);
	await mkdir(where.config, { recursive: true, mode: 0o700 });
	await chmod(where.config, 0o700);
	await writeAtomic(where.configFile, `${JSON.stringify(config, null, '\t')}\n`, 0o600);
}

/** Writes the token to `.env` and the config to `config.json`, both mode 0600, in a directory of mode 0700. */
export async function writeConfig(env: Env, config: Config, token: string): Promise<void> {
	await writeSecrets(env, { TELEGRAM_BOT_TOKEN: token });
	await writeConfigFile(env, config);
}
