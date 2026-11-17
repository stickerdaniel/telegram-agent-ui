// The configuration of 5.1, on disk. The token comes from TELEGRAM_BOT_TOKEN, else from
// `$XDG_CONFIG_HOME/telegram-agent-ui/.env`, written with mode 0600. `config.json` beside it holds
// the bot, the chat and its users. The store of a bot is `$XDG_DATA_HOME/telegram-agent-ui/<bot id>/`.
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { arrayOf, isInt, isRecord, isString } from '../core/check.ts';
import { labelIssue } from '../core/labels.ts';
import { isOrigin } from '../core/shape.ts';
import { defaultLabels, type Labels } from '../core/types.ts';
import { Failed } from './result.ts';

export type Env = Readonly<Record<string, string | undefined>>;

/** `config.json`. `views.origin` is set once a view host is deployed. */
export type Config = {
	v: 1;
	bot: { id: number; username: string };
	chat: number;
	users: number[];
	labels: Partial<Labels>;
	publishRoots: string[];
	apiUrl?: string;
	views: { origin?: string };
};

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

/** A consumer's labels: known keys only, merged with the defaults without a refusal. */
function parseLabels(value: unknown): Partial<Labels> | undefined {
	if (!isRecord(value) || Object.keys(value).some((key) => !(key in defaultLabels))) return undefined;
	if (labelIssue({ ...defaultLabels, ...value }) !== undefined) return undefined;
	const labels: Partial<Labels> = {};
	for (const key of Object.keys(defaultLabels) as (keyof Labels)[]) {
		const label = value[key];
		if (key === 'hintWords') {
			if (arrayOf(isString)(label)) labels.hintWords = [...label];
		} else if (isString(label)) labels[key] = label;
	}
	return labels;
}

/** The stored value of `config.json`, or undefined when any field breaks its type. */
export function parseConfig(value: unknown): Config | undefined {
	if (!isRecord(value) || value.v !== 1) return undefined;
	const { bot, chat, users, publishRoots, apiUrl, views } = value;
	if (!isRecord(bot) || !isInt(bot.id) || !isString(bot.username) || !isInt(chat) || !arrayOf(isInt)(users) || !arrayOf(isString)(publishRoots)) return undefined;
	if (apiUrl !== undefined && !isHttpUrl(apiUrl)) return undefined;
	if (!isRecord(views) || (views.origin !== undefined && !(isString(views.origin) && isOrigin(views.origin)))) return undefined;
	const labels = parseLabels(value.labels);
	if (!labels) return undefined;
	return {
		v: 1,
		bot: { id: bot.id, username: bot.username },
		chat,
		users: [...users],
		labels,
		publishRoots: [...publishRoots],
		...(apiUrl !== undefined ? { apiUrl } : {}),
		views: views.origin !== undefined ? { origin: views.origin } : {},
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

/** `TELEGRAM_BOT_TOKEN=<token>` of a .env file, with or without `export` and quotes. */
function tokenIn(text: string): string | undefined {
	for (const line of text.split('\n')) {
		const match = /^\s*(?:export\s+)?TELEGRAM_BOT_TOKEN\s*=\s*(.*?)\s*$/.exec(line);
		const token = match?.[1]?.replace(/^(['"])(.*)\1$/, '$2');
		if (token) return token;
	}
	return undefined;
}

/** The token from the environment, then from the config's `.env`, or undefined. */
export async function findToken(env: Env): Promise<string | undefined> {
	if (env.TELEGRAM_BOT_TOKEN) return env.TELEGRAM_BOT_TOKEN;
	const text = await readText(paths(env).envFile);
	return text === undefined ? undefined : tokenIn(text);
}

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

/** Writes the token to `.env` with mode 0600 and the config to `config.json`, in a directory of mode 0700. */
export async function writeConfig(env: Env, config: Config, token: string): Promise<void> {
	const where = paths(env);
	await mkdir(where.config, { recursive: true, mode: 0o700 });
	await chmod(where.config, 0o700);
	await writeAtomic(where.envFile, `TELEGRAM_BOT_TOKEN=${token}\n`, 0o600);
	await writeAtomic(where.configFile, `${JSON.stringify(config, null, '\t')}\n`, 0o600);
}
