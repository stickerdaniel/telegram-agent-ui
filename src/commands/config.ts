import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { arrayOf, isInt, isRecord, isString } from '../core/check.ts';
import { parseLabels } from '../core/labels.ts';
import { isOrigin } from '../core/shape.ts';
import type { Labels } from '../core/types.ts';
import { CLOUD_API } from '../telegram/fetch.ts';
import { type CssVars, parseTheme } from '../view/theme.ts';
import { Failed } from './result.ts';

export type Env = Readonly<Record<string, string | undefined>>;

export type Config = {
	v: 1;
	bot: { id: number; username: string };
	chat: number;
	users: number[];
	labels: Partial<Labels>;
	publishRoots: string[];
	apiUrl?: string;
	localFiles?: string;
	views: Views;
};
export type Views = { origin?: string; account?: string; route?: string; theme?: CssVars };

export const isAccount = (value: string) => /^[0-9a-f]{32}$/.test(value);

export function routeOrigin(route: string): string | undefined {
	const match = /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/\*$/i.exec(route);
	const host = match?.[1]?.toLowerCase();
	return host === undefined ? undefined : `https://${host}`;
}

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

export const KEY_NAMES = { upload: 'TELEGRAM_AGENT_UI_UPLOAD_KEY', media: 'TELEGRAM_AGENT_UI_MEDIA_KEY' } as const;

export const FILE_LIMITS = { cloud: 50_000_000, local: 2_000_000_000 } as const;

export function paths(env: Env) {
	const home = env.HOME || homedir();
	const config = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'telegram-agent-ui');
	const data = join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'telegram-agent-ui');
	return { config, configFile: join(config, 'config.json'), envFile: join(config, '.env'), store: (bot: number) => join(data, String(bot)) };
}

const isHttpUrl = (value: unknown): value is string => isString(value) && URL.canParse(value) && /^https?:$/.test(new URL(value).protocol);

export function parseConfig(value: unknown): Config | undefined {
	if (!isRecord(value) || value.v !== 1) return undefined;
	const { bot, chat, users, publishRoots, apiUrl, localFiles, views } = value;
	if (!isRecord(bot) || !isInt(bot.id) || !isString(bot.username) || !isInt(chat) || !arrayOf(isInt)(users) || !arrayOf(isString)(publishRoots)) return undefined;
	if (apiUrl !== undefined && !isHttpUrl(apiUrl)) return undefined;
	if (localFiles !== undefined && !(isString(localFiles) && isAbsolute(localFiles))) return undefined;
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
		...(isString(localFiles) ? { localFiles } : {}),
		views: parsedViews,
	};
}

async function readText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, 'utf8');
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
		throw error;
	}
}

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

const lineOf = (name: string) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*?)\\s*$`);

function valueIn(text: string, name: string): string | undefined {
	for (const line of text.split('\n')) {
		const value = lineOf(name).exec(line)?.[1]?.replace(/^(['"])(.*)\1$/, '$2');
		if (value) return value;
	}
	return undefined;
}

export async function findSecret(env: Env, name: string): Promise<string | undefined> {
	if (env[name]) return env[name];
	const text = await readText(paths(env).envFile);
	return text === undefined ? undefined : valueIn(text, name);
}

export const findToken = (env: Env) => findSecret(env, 'TELEGRAM_BOT_TOKEN');

export function apiUrlOf(env: Env, config?: Pick<Config, 'apiUrl'>): string | undefined {
	const url = env.TELEGRAM_AGENT_UI_API_URL || config?.apiUrl;
	if (url !== undefined && !isHttpUrl(url)) throw new Failed({ error: 'no-config', message: `the Bot API URL "${url}" is no http or https URL` });
	return url;
}

export const originOf = (env: Env, config?: Pick<Config, 'apiUrl'>) => (apiUrlOf(env, config) ?? CLOUD_API).replace(/\/+$/, '');

export async function localFilesOf(env: Env, config?: Pick<Config, 'apiUrl' | 'localFiles'>): Promise<string | undefined> {
	const dir = env.TELEGRAM_AGENT_UI_LOCAL_FILES || config?.localFiles;
	if (dir === undefined) return undefined;
	if (!isAbsolute(dir)) throw new Failed({ error: 'no-config', message: `localFiles "${dir}" is no absolute path` });
	const found = await stat(dir).catch(() => undefined);
	if (!found?.isDirectory()) throw new Failed({ error: 'no-config', message: `localFiles ${dir} is no existing directory` });
	if (new URL(originOf(env, config)).origin === new URL(CLOUD_API).origin) throw new Failed({ error: 'no-config', message: 'localFiles names the directory of a local Bot API server, and the Bot API URL is the cloud one: set apiUrl too' });
	return dir;
}

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

export async function writeSecrets(env: Env, values: Record<string, string>): Promise<void> {
	const where = paths(env);
	await mkdir(where.config, { recursive: true, mode: 0o700 });
	await chmod(where.config, 0o700);
	const kept = ((await readText(where.envFile)) ?? '').split('\n').filter((line) => line.trim() !== '' && !Object.keys(values).some((name) => lineOf(name).test(line)));
	await writeAtomic(where.envFile, [...kept, ...Object.entries(values).map(([name, value]) => `${name}=${value}`)].map((line) => `${line}\n`).join(''), 0o600);
}

export async function writeConfigFile(env: Env, config: Config): Promise<void> {
	const where = paths(env);
	await mkdir(where.config, { recursive: true, mode: 0o700 });
	await chmod(where.config, 0o700);
	await writeAtomic(where.configFile, `${JSON.stringify(config, null, '\t')}\n`, 0o600);
}

export async function writeConfig(env: Env, config: Config, token: string): Promise<void> {
	await writeSecrets(env, { TELEGRAM_BOT_TOKEN: token });
	await writeConfigFile(env, config);
}
