// What a command runs on: the config, the token, the store and a chat over them. Fake mode,
// `TELEGRAM_AGENT_UI_FAKE=<dir>`, replaces the Bot API with a recorder that appends every call
// to `<dir>/calls.jsonl`, and the config with a built-in one. Its store lives in `<dir>/store`,
// it reports a live listener without an answer command, and the first `wait` on a question
// answers it. `TELEGRAM_AGENT_UI_FAKE_SCENARIO` picks a failure script for tests.
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type Chat, createChat, type Delivered } from '../chat/create.ts';
import { writeListener } from '../chat/listener.ts';
import { isNat, isRecord } from '../core/check.ts';
import type { CallResponse, Store, Update } from '../core/types.ts';
import { fileStore } from '../store/file.ts';
import { fetchCall, type Transport } from '../telegram/fetch.ts';
import { isUpdate } from '../telegram/listen.ts';
import { apiUrlOf, type Config, type Env, FILE_LIMITS, findToken, paths, readConfig } from './config.ts';
import { Failed } from './result.ts';

/** What a command gets from its caller: the CLI's process, or an MCP server's. */
export type Context = {
	env: Env;
	/** The working directory: the first root of every file read. */
	cwd: string;
	/** Progress and warnings, one line each. */
	log: (line: string) => void;
	/** Ends a command that runs until stopped: `listen`, and `init` while it waits. */
	signal: AbortSignal;
	/** One line a person types, such as a token. Undefined when nobody can type. */
	readLine?: () => Promise<string | undefined>;
};

export type Session = {
	config: Config;
	/** Where the config and the store are, for `info`. */
	where: { config: string; store: string };
	store: Store;
	call: Transport;
	chat: Chat;
	/** The directories files may be read from: the working directory and `publishRoots`. */
	roots: string[];
	/** Fake mode only: answers a pending question as a person would, on the first wait. */
	fake?: { answer(ref: string): Promise<void> };
};

/** The failure scripts of fake mode. `no-listener` has no live listener, the others answer every send and edit so. */
export const FAKE_SCENARIOS = ['no-listener', 'uncertain', 'refused', 'token'] as const;
type Scenario = (typeof FAKE_SCENARIOS)[number];
const isScenario = (value: string): value is Scenario => FAKE_SCENARIOS.some((scenario) => scenario === value);

const FAKE_CONFIG: Config = { v: 1, bot: { id: 1, username: 'fake_bot' }, chat: 111, users: [111], labels: {}, publishRoots: [], views: {} };
const CHANGES = new Set(['sendRichMessage', 'sendPhoto', 'sendVideo', 'sendDocument', 'sendMediaGroup', 'editMessageText']);
const SENDS = new Set(['sendRichMessage', 'sendPhoto', 'sendVideo', 'sendDocument']);

// The next free message id of fake mode, `{ v: 1, next }`, taken under the store's lock of this key.
const IDS_KEY = 'fake-ids';

/**
 * Reserves `count` message ids under the store's lock, so processes that share one fake
 * directory never hand out one id twice. Returns the first.
 */
function reserve(store: Store, count: number): Promise<number> {
	return store.lock(IDS_KEY, async () => {
		const value = await store.get(IDS_KEY);
		const next = isRecord(value) && isNat(value.next) && value.next > 1000 ? value.next : 1001;
		await store.set(IDS_KEY, { v: 1, next: next + count });
		return next;
	});
}

/**
 * The recorder of fake mode: every call becomes one line of `log`, `{ at, method, payload,
 * files? }`. It answers like the cloud Bot API on success, with message ids from `reserve`, one
 * per message an album returns, or as `scenario` says.
 */
function recorder(log: string, store: Store, scenario: Scenario | undefined): Transport {
	return async ({ method, payload, files }) => {
		await appendFile(log, `${JSON.stringify({ at: Date.now(), method, payload, ...(files ? { files: files.map((file) => file.path) } : {}) })}\n`);
		if (scenario === 'token') return { ok: false, status: 401, description: 'Unauthorized' };
		if (CHANGES.has(method) && scenario === 'refused') return { ok: false, status: 400, description: 'Bad Request: chat not found' };
		if (CHANGES.has(method) && scenario === 'uncertain') return { noAnswer: true };
		const message = (id: number) => ({ message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: payload.chat_id, type: 'private' } });
		if (SENDS.has(method)) return { ok: true, result: message(await reserve(store, 1)) };
		if (method === 'sendMediaGroup' && Array.isArray(payload.media)) {
			const first = await reserve(store, payload.media.length);
			return { ok: true, result: payload.media.map((_, index) => message(first + index)) };
		}
		const answer: CallResponse = method === 'editMessageText' ? { ok: true, result: message(Number(payload.message_id)) } : { ok: true, result: true };
		return answer;
	};
}

/** A tap on the first button, or a reply with message id `reply` to the message, by the fake chat's user, as JSON from Telegram. */
function personAnswer(ref: string, message: number, answer: { kind: 'choice' } | { kind: 'text'; reply: number }): Update {
	const person = { id: FAKE_CONFIG.chat, is_bot: false, first_name: 'Fake' };
	const chat = { id: FAKE_CONFIG.chat, type: 'private', first_name: 'Fake' };
	const update: unknown =
		answer.kind === 'choice'
			? { update_id: 1, callback_query: { id: `fake-${ref}`, from: person, chat_instance: 'fake', data: `q:${ref}:0`, message: { message_id: message, date: 0, chat } } }
			: { update_id: 1, message: { message_id: answer.reply, date: 0, chat, from: person, text: 'fake answer', reply_to_message: { message_id: message, date: 0, chat } } };
	if (!isUpdate(update)) throw new Error('unreachable: the update has an id');
	return update;
}

/** The session of fake mode in `dir`. */
async function fakeSession(context: Context, dir: string, onAnswer: ((answer: Delivered) => Promise<void>) | undefined): Promise<Session> {
	const name = context.env.TELEGRAM_AGENT_UI_FAKE_SCENARIO;
	if (name !== undefined && name !== '' && !isScenario(name)) {
		throw new Failed({ error: 'usage', message: `TELEGRAM_AGENT_UI_FAKE_SCENARIO "${name}" is none of ${FAKE_SCENARIOS.join(', ')}` });
	}
	const scenario = name !== undefined && isScenario(name) ? name : undefined;
	await mkdir(dir, { recursive: true });
	const store = fileStore(join(dir, 'store'));
	// The fake listener beats with every command, and stops for the `no-listener` scenario. The stored baselines stay.
	await writeListener(store, { heartbeat: Date.now(), ...(scenario === 'no-listener' ? { stopped: 'fake mode: no-listener' } : {}) });
	const call = recorder(join(dir, 'calls.jsonl'), store, scenario);
	const chat = createChat({ call, store, chat: FAKE_CONFIG.chat, allow: FAKE_CONFIG.users, ...(onAnswer ? { onAnswer } : {}) });
	return {
		config: FAKE_CONFIG,
		where: { config: 'built in: fake mode', store: join(dir, 'store') },
		store,
		call,
		chat,
		roots: await rootsOf(context),
		fake: {
			async answer(ref) {
				const question = await chat.get(ref);
				if (question?.status !== 'open') return;
				const answer = question.spec.answer.type === 'choice' ? { kind: 'choice' as const } : { kind: 'text' as const, reply: await reserve(store, 1) };
				await chat.handle(personAnswer(ref, question.sent.message, answer));
			},
		},
	};
}

/**
 * The directories files may be read from: the working directory, plus `publishRoots` of the
 * config. Fake mode has the working directory alone. Throws `no-config` without a config.
 */
export async function rootsOf(context: Pick<Context, 'env' | 'cwd'>): Promise<string[]> {
	if (context.env.TELEGRAM_AGENT_UI_FAKE) return [context.cwd];
	return [context.cwd, ...(await readConfig(context.env)).publishRoots];
}

/**
 * The session of a command: fake mode when TELEGRAM_AGENT_UI_FAKE names a directory, else the
 * config, the token and the store of 5.1. Throws a `no-config` failure without a config or a
 * token. `onAnswer` goes to the chat, for the listener.
 */
export async function openSession(context: Context, options: { onAnswer?: (answer: Delivered) => Promise<void> } = {}): Promise<Session> {
	const { env, cwd } = context;
	if (env.TELEGRAM_AGENT_UI_FAKE) return fakeSession(context, env.TELEGRAM_AGENT_UI_FAKE, options.onAnswer);
	const config = await readConfig(env);
	const token = await findToken(env);
	if (!token) throw new Failed({ error: 'no-config', message: `no bot token: set TELEGRAM_BOT_TOKEN or run telegram-agent-ui init, which writes ${paths(env).envFile}` });
	const apiUrl = apiUrlOf(env, config);
	const call = fetchCall({ token, ...(apiUrl !== undefined ? { apiUrl } : {}) });
	const where = { config: paths(env).configFile, store: paths(env).store(config.bot.id) };
	const store = fileStore(where.store);
	const chat = createChat({
		call,
		store,
		chat: config.chat,
		allow: config.users,
		labels: config.labels,
		...(config.views.origin !== undefined ? { viewOrigin: config.views.origin } : {}),
		fileLimit: apiUrl !== undefined ? FILE_LIMITS.local : FILE_LIMITS.cloud,
		...(options.onAnswer ? { onAnswer: options.onAnswer } : {}),
	});
	return { config, where, store, call, chat, roots: [cwd, ...config.publishRoots] };
}
