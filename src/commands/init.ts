import { readFile } from 'node:fs/promises';
import { LISTENER_KEY } from '../chat/listener.ts';
import { isNat, isRecord, isString } from '../core/check.ts';
import { LockTimeout } from '../core/types.ts';
import { fileStore } from '../store/file.ts';
import { fetchCall, type Transport } from '../telegram/fetch.ts';
import { isUpdate } from '../telegram/listen.ts';
import { apiUrlOf, type Config, type Env, findToken, parseConfig, paths, writeConfig } from './config.ts';
import { done, failed, type Result } from './result.ts';
import type { Context } from './session.ts';

export const PAIR_WAIT = 600_000;
const PAUSE = 5_000;
const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

const newCode = () => [...crypto.getRandomValues(new Uint8Array(12))].map((byte) => CODE_ALPHABET.charAt(byte % 32)).join('');

function within<T>(promise: Promise<T>, signal: AbortSignal, ms = Number.POSITIVE_INFINITY): Promise<T | undefined> {
	return new Promise((resolve) => {
		const timer = Number.isFinite(ms) ? setTimeout(() => resolve(undefined), ms) : undefined;
		const stop = () => resolve(undefined);
		signal.addEventListener('abort', stop, { once: true });
		if (signal.aborted) stop();
		promise.then(resolve, () => resolve(undefined)).finally(() => {
			clearTimeout(timer);
			signal.removeEventListener('abort', stop);
		});
	});
}

async function existing(env: Env): Promise<Config | undefined> {
	try {
		return parseConfig(JSON.parse(await readFile(paths(env).configFile, 'utf8')));
	} catch {
		return undefined;
	}
}

async function pair(call: Transport, code: string, username: string, signal: AbortSignal): Promise<{ chat: number; user: number } | Result> {
	const deadline = Date.now() + PAIR_WAIT;
	let offset: number | undefined;
	while (!signal.aborted && Date.now() < deadline) {
		const timeout = Math.max(0, Math.min(50, Math.floor((deadline - Date.now()) / 1000)));
		const response = await within(call({ method: 'getUpdates', payload: { ...(offset !== undefined ? { offset } : {}), timeout, allowed_updates: ['message'] } }), signal);
		if (!response) break;
		if (!('noAnswer' in response) && !response.ok) {
			if (response.status === 401) return failed({ error: 'no-config', message: 'the server rejects the bot token: copy it again from @BotFather' });
			if (response.status === 409) return failed({ error: 'refused', code: 'conflict', message: `another process polls @${username}: stop it and run init again (${response.description})` });
		}
		const updates = 'ok' in response && response.ok && Array.isArray(response.result) ? response.result.filter(isUpdate) : undefined;
		if (!updates) {
			await within(new Promise((resolve) => setTimeout(resolve, PAUSE)), signal);
			continue;
		}
		for (const update of updates) {
			offset = update.update_id + 1;
			const message = update.message;
			if (message?.chat.type === 'private' && message.from && message.text === `/start ${code}`) {
				await within(call({ method: 'getUpdates', payload: { offset, timeout: 0 } }), signal, 10_000);
				return { chat: message.chat.id, user: message.from.id };
			}
		}
	}
	const when = signal.aborted ? 'before init was stopped' : `within ${PAIR_WAIT / 1000} s`;
	return failed({ error: 'refused', code: 'not-paired', message: `no /start ${code} arrived ${when}: run init again` });
}

export async function init(context: Context): Promise<Result> {
	const { env, log, signal } = context;
	if (env.TELEGRAM_AGENT_UI_FAKE) return failed({ error: 'usage', message: 'fake mode has a built-in config: unset TELEGRAM_AGENT_UI_FAKE to pair a bot' });
	let token = await findToken(env);
	if (!token && context.readLine) {
		log('Paste the bot token from @BotFather and press Enter:');
		token = (await context.readLine())?.trim();
	}
	if (!token) return failed({ error: 'no-config', message: 'no bot token: set TELEGRAM_BOT_TOKEN or paste the token on stdin' });
	const before = await existing(env);
	const apiUrl = apiUrlOf(env, before);
	const call = fetchCall({ token, ...(apiUrl !== undefined ? { apiUrl } : {}) });

	const me = await call({ method: 'getMe', payload: {} });
	if (!('noAnswer' in me) && !me.ok && me.status === 401) return failed({ error: 'no-config', message: 'the server rejects the bot token: copy it again from @BotFather' });
	const bot = 'ok' in me && me.ok && isRecord(me.result) ? me.result : undefined;
	if (!bot || !isNat(bot.id) || !isString(bot.username)) return failed({ error: 'uncertain', message: 'getMe got no usable answer: check the network and run init again' });
	const { id, username } = bot;
	const hook = await call({ method: 'getWebhookInfo', payload: {} });
	const url = 'ok' in hook && hook.ok && isRecord(hook.result) ? hook.result.url : undefined;
	if (isString(url) && url !== '') return failed({ error: 'refused', code: 'webhook', message: `@${username} has a webhook, and the listener needs getUpdates: call deleteWebhook or use another bot` });

	const store = fileStore(paths(env).store(id));
	const conflict = failed({ error: 'refused', code: 'conflict', message: `a listener of @${username} runs: stop it and run init again` });
	let paired: { chat: number; user: number } | Result;
	try {
		paired = await store.lock(LISTENER_KEY, () => {
			const code = newCode();
			log(`Open https://t.me/${username}?start=${code} on your phone and tap Start.`);
			return pair(call, code, username, signal);
		});
	} catch (error) {
		if (error instanceof LockTimeout) return conflict;
		throw error;
	}
	if ('ok' in paired) return paired;

	const kept = before?.bot.id === id ? { labels: before.labels, publishRoots: before.publishRoots, views: before.views } : { labels: {}, publishRoots: [], views: {} };
	const config: Config = { v: 1, bot: { id, username }, chat: paired.chat, users: [paired.user], ...kept, ...(apiUrl !== undefined ? { apiUrl } : {}) };
	await writeConfig(env, config, token);
	const where = paths(env);
	return done({ bot: config.bot, chat: config.chat, users: config.users, config: where.configFile, store: where.store(id) });
}
