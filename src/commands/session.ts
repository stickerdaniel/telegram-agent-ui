import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Chat, createChat, type Delivered } from '../chat/create.ts';
import { writeListener } from '../chat/listener.ts';
import { isNat, isRecord, isString } from '../core/check.ts';
import { LIMITS } from '../core/shape.ts';
import type { Call, CallResponse, Readable, Store, Update, ViewClient } from '../core/types.ts';
import { openPublishable, readTextInRoots } from '../files/roots.ts';
import { fileStore } from '../store/file.ts';
import { type Download, fetchCall, fileDownload, scrubber, type Transport } from '../telegram/fetch.ts';
import { isUpdate } from '../telegram/listen.ts';
import { viewClient } from '../view/client.ts';
import { createViewHandler, type ViewStorage } from '../view/handler.ts';
import { apiUrlOf, type Config, type Env, FILE_LIMITS, findSecret, findToken, KEY_NAMES, originOf, paths, readConfig } from './config.ts';
import { Failed, type Failure } from './result.ts';

export type Context = {
	env: Env;
	roots: readonly string[];
	cwd?: string;
	log: (line: string) => void;
	signal: AbortSignal;
	readLine?: () => Promise<string | undefined>;
	stdin?: () => Promise<string>;
	command?: string;
};

export type Session = {
	config: Config;
	where: { config: string; store: string };
	store: Store;
	call: Transport;
	origin: string;
	download?: Download;
	scrub: (text: string) => string;
	chat: Chat;
	views?: ViewClient;
	roots: string[];
	fake?: { answer(ref: string): Promise<void> };
};

export const FAKE_SCENARIOS = ['no-listener', 'no-view-host', 'uncertain', 'refused', 'token'] as const;
type Scenario = (typeof FAKE_SCENARIOS)[number];
const isScenario = (value: string): value is Scenario => FAKE_SCENARIOS.some((scenario) => scenario === value);

export const FAKE_VIEW_ORIGIN = 'https://views.fake.invalid';
const FAKE_API = 'https://api.fake.invalid';
const FAKE_KEYS = { upload: 'fake-upload-key-0123456789', media: 'fake-media-key-0123456789' } as const;
const FAKE_CONFIG: Config = { v: 1, bot: { id: 1, username: 'fake_bot' }, chat: 111, users: [111], labels: {}, publishRoots: [], views: { origin: FAKE_VIEW_ORIGIN } };
const CHANGES = new Set(['sendRichMessage', 'sendPhoto', 'sendVideo', 'sendDocument', 'sendMediaGroup', 'editMessageText']);
const SENDS = new Set(['sendRichMessage', 'sendPhoto', 'sendVideo', 'sendDocument']);

const IDS_KEY = 'fake-ids';

function reserve(store: Store, count: number): Promise<number> {
	return store.lock(IDS_KEY, async () => {
		const value = await store.get(IDS_KEY);
		const next = isRecord(value) && isNat(value.next) && value.next > 1000 ? value.next : 1001;
		await store.set(IDS_KEY, { v: 1, next: next + count });
		return next;
	});
}

function recorder(log: string, store: Store, scenario: Scenario | undefined, command: string | undefined): Transport {
	const answer = async ({ method, payload }: Call): Promise<CallResponse> => {
		if (scenario === 'token') return { ok: false, status: 401, description: 'Unauthorized' };
		if (CHANGES.has(method) && scenario === 'refused') return { ok: false, status: 400, description: 'Bad Request: chat not found' };
		if (CHANGES.has(method) && scenario === 'uncertain') return { noAnswer: true };
		const message = (id: number) => ({ message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: payload.chat_id, type: 'private' } });
		if (method === 'getMe') return { ok: true, result: { id: FAKE_CONFIG.bot.id, is_bot: true, first_name: 'Fake', username: FAKE_CONFIG.bot.username } };
		if (SENDS.has(method)) return { ok: true, result: message(await reserve(store, 1)) };
		if (method === 'sendMediaGroup' && Array.isArray(payload.media)) {
			const first = await reserve(store, payload.media.length);
			return { ok: true, result: payload.media.map((_, index) => message(first + index)) };
		}
		return method === 'editMessageText' ? { ok: true, result: message(Number(payload.message_id)) } : { ok: true, result: true };
	};
	return async (call) => {
		const { method, payload, files } = call;
		const response = await answer(call);
		await appendFile(log, `${JSON.stringify({ at: Date.now(), method, payload, ...(files ? { files: files.map((file) => file.path) } : {}), response, ...(command !== undefined ? { command } : {}) })}\n`);
		return response;
	};
}

function storeStorage(store: Store): ViewStorage {
	return {
		async get(key) {
			const stored = await store.get(key);
			if (!isRecord(stored) || !isString(stored.value)) return undefined;
			return { value: Uint8Array.from(Buffer.from(stored.value, 'base64')), ...(isString(stored.type) ? { type: stored.type } : {}) };
		},
		put: (key, value, { expiresAt, type }) => store.set(key, { value: Buffer.from(value).toString('base64'), expiresAt, ...(type !== undefined ? { type } : {}) }),
		delete: (key) => store.delete(key),
		list: (prefix) => store.list(prefix),
	};
}

function fakeViews(dir: string, log: string, command: string | undefined): ViewClient {
	const handle = createViewHandler({ storage: storeStorage(fileStore(dir)), botId: String(FAKE_CONFIG.bot.id), allowedUsers: FAKE_CONFIG.users, uploadKey: FAKE_KEYS.upload, mediaKey: FAKE_KEYS.media });
	const recorded = async (request: Request): Promise<Response> => {
		const bytes = new Uint8Array(await request.clone().arrayBuffer());
		const type = request.headers.get('Content-Type') ?? undefined;
		let body: unknown;
		if (type === 'application/json') {
			try {
				body = JSON.parse(new TextDecoder().decode(bytes));
			} catch {
				body = undefined;
			}
		}
		const response = await handle(request);
		const url = new URL(request.url);
		const line = { at: Date.now(), method: request.method, path: url.pathname, status: response.status, ...(body !== undefined ? { body } : type !== undefined ? { type, bytes: bytes.length } : {}), ...(command !== undefined ? { command } : {}) };
		await appendFile(log, `${JSON.stringify(line)}\n`);
		return response;
	};
	return viewClient({ origin: FAKE_VIEW_ORIGIN, uploadKey: FAKE_KEYS.upload, fetch: recorded, lateWindow: 0 });
}

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

function fileReader(roots: readonly string[], context: Pick<Context, 'env' | 'cwd'>): (paths: string[]) => Promise<Readable> {
	return (paths) => openPublishable(paths, { roots, cwd: context.cwd ?? '/', home: context.env.HOME || homedir() });
}

async function fakeSession(context: Context, dir: string, onAnswer: ((answer: Delivered) => Promise<void>) | undefined): Promise<Session> {
	const name = context.env.TELEGRAM_AGENT_UI_FAKE_SCENARIO;
	if (name !== undefined && name !== '' && !isScenario(name)) {
		throw new Failed({ error: 'usage', message: `TELEGRAM_AGENT_UI_FAKE_SCENARIO "${name}" is none of ${FAKE_SCENARIOS.join(', ')}` });
	}
	const scenario = name !== undefined && isScenario(name) ? name : undefined;
	await mkdir(dir, { recursive: true });
	const store = fileStore(join(dir, 'store'));
	await writeListener(store, { heartbeat: Date.now(), ...(scenario === 'no-listener' ? { stopped: 'fake mode: no-listener' } : {}) });
	const call = recorder(join(dir, 'calls.jsonl'), store, scenario, context.command);
	const views = scenario === 'no-view-host' ? undefined : fakeViews(join(dir, 'views'), join(dir, 'views.jsonl'), context.command);
	const config: Config = views ? FAKE_CONFIG : { ...FAKE_CONFIG, views: {} };
	const roots = await rootsOf(context);
	const chat = createChat({ call, store, chat: config.chat, allow: config.users, files: fileReader(roots, context), ...(views ? { viewOrigin: FAKE_VIEW_ORIGIN, views } : {}), ...(onAnswer ? { onAnswer } : {}) });
	return {
		config,
		where: { config: 'built in: fake mode', store: join(dir, 'store') },
		store,
		call,
		origin: FAKE_API,
		scrub: (text) => text,
		chat,
		...(views ? { views } : {}),
		roots,
		fake: {
			async answer(ref) {
				const question = await chat.get(ref);
				if (question?.status !== 'open') return;
				const view = question.spec.view;
				if (view !== undefined && question.spec.answer.type === 'choice' && question.spec.answer.in === 'view') {
					const id = `fake${ref}`.padEnd(22, '0').slice(0, 22);
					await chat.choose({ key: `a:${view}:${ref}:${id}`, view, ref, id, index: 0, user: { id: FAKE_CONFIG.chat, name: 'Fake' }, at: Date.now() });
					return;
				}
				const answer = question.spec.answer.type === 'choice' ? { kind: 'choice' as const } : { kind: 'text' as const, reply: await reserve(store, 1) };
				await chat.handle(personAnswer(ref, question.sent.message, answer));
			},
		},
	};
}

export async function rootsOf(context: Pick<Context, 'env' | 'roots'>): Promise<string[]> {
	if (context.env.TELEGRAM_AGENT_UI_FAKE) return [...context.roots];
	return [...context.roots, ...(await readConfig(context.env)).publishRoots];
}

const BODY_BYTES = LIMITS.body * 4;

export async function readBodyFile(path: string, options: { roots: readonly string[]; cwd: string; env: Env }): Promise<{ ok: true; text: string } | { ok: false; failure: Failure }> {
	const { roots, cwd, env } = options;
	const read = await readTextInRoots(path, { roots, cwd, home: env.HOME || homedir(), limit: BODY_BYTES });
	return read.kind === 'ok' ? { ok: true, text: read.text } : { ok: false, failure: { error: 'refused', code: read.code, message: read.reason } };
}

export async function openSession(context: Context, options: { onAnswer?: (answer: Delivered) => Promise<void> } = {}): Promise<Session> {
	const { env } = context;
	if (env.TELEGRAM_AGENT_UI_FAKE) return fakeSession(context, env.TELEGRAM_AGENT_UI_FAKE, options.onAnswer);
	const config = await readConfig(env);
	const token = await findToken(env);
	if (!token) throw new Failed({ error: 'no-config', message: `no bot token: set TELEGRAM_BOT_TOKEN or run telegram-agent-ui init, which writes ${paths(env).envFile}` });
	const apiUrl = apiUrlOf(env, config);
	const call = fetchCall({ token, ...(apiUrl !== undefined ? { apiUrl } : {}) });
	const download = fileDownload({ token, ...(apiUrl !== undefined ? { apiUrl } : {}) });
	const where = { config: paths(env).configFile, store: paths(env).store(config.bot.id) };
	const store = fileStore(where.store);
	const { origin } = config.views;
	const uploadKey = origin !== undefined ? await findSecret(env, KEY_NAMES.upload) : undefined;
	const views = origin !== undefined && uploadKey !== undefined ? viewClient({ origin, uploadKey }) : undefined;
	const roots = [...context.roots, ...config.publishRoots];
	const chat = createChat({
		call,
		store,
		chat: config.chat,
		allow: config.users,
		labels: config.labels,
		...(origin !== undefined ? { viewOrigin: origin } : {}),
		...(views ? { views } : {}),
		files: fileReader(roots, context),
		fileLimit: apiUrl !== undefined ? FILE_LIMITS.local : FILE_LIMITS.cloud,
		...(options.onAnswer ? { onAnswer: options.onAnswer } : {}),
	});
	return { config, where, store, call, origin: originOf(env, config), download, scrub: scrubber(token), chat, ...(views ? { views } : {}), roots };
}
