// Test doubles for createChat: a Telegram model on `fakeCall` that keeps what each message shows
// and fails chosen calls, and a store wrapper that records every stored value that would not
// read back. Not part of the package.
import { NOT_MODIFIED } from '../core/classify.ts';
import { isRecord, sameJson } from '../core/check.ts';
import { parseQuestion } from '../core/parse.ts';
import type { Call, CallResponse, Publishable, Question, Readable, Store, ViewClient } from '../core/types.ts';
import { CHAT, NOW } from '../fixtures.ts';
import { memoryStore } from '../store/memory.ts';
import { fakeCall, faultyStore } from '../testing/index.ts';
import { PACING } from './calls.ts';
import { type ChatIO, createChat } from './create.ts';

// Every chat test of this process sends to chat 111. Pacing it to one call per second would
// serialize hundreds of runs, so it is off here; the pacing test turns it on for itself.
PACING.interval = 0;

/**
 * How a scripted call fails. `lost` and `gateway` reach the server, which applies them, and lose
 * or garble the answer. `refused`, `token` and `busy` are refused before the server applies them.
 * `busy` carries the time from which a retry is allowed.
 */
export type Fault = 'lost' | 'gateway' | 'refused' | 'token' | { busy: number };

/** What a message shows: its body and keyboard, as the last call that reached the server left them. */
export type Shown = { rich_message: unknown; reply_markup?: unknown };

export const shownOf = (payload: Record<string, unknown>): Shown => ({ rich_message: payload.rich_message, ...(payload.reply_markup !== undefined ? { reply_markup: payload.reply_markup } : {}) });
const MEDIA = new Set(['sendPhoto', 'sendVideo', 'sendDocument']);

/**
 * A Telegram model behind `fakeCall`. It numbers messages from 1001, keeps what each shows,
 * answers an edit that changes nothing with 400 "message is not modified", and fails the call
 * with index `n` (0-based, counted over the model's life) as `fail(n, fault)` says.
 */
export function telegram() {
	const shows = new Map<number, Shown>();
	const replies = new Map<number, unknown>();
	const faults = new Map<number, Fault>();
	let index = 0;
	let next = 1000;
	const message = (id: number) => ({ message_id: id, date: 1794908513, chat: { id: CHAT, type: 'private' } });

	function reach(call: Call): CallResponse {
		const { method, payload } = call;
		if (method === 'sendRichMessage') {
			shows.set(++next, shownOf(payload));
			return { ok: true, result: message(next) };
		}
		if (method === 'editMessageText') {
			const id = Number(payload.message_id);
			if (!shows.has(id)) return { ok: false, status: 400, description: 'Bad Request: message to edit not found' };
			const before = JSON.stringify(shows.get(id));
			shows.set(id, shownOf(payload));
			return before === JSON.stringify(shows.get(id)) ? { ok: false, status: 400, description: `Bad Request: ${NOT_MODIFIED}` } : { ok: true, result: message(id) };
		}
		if (MEDIA.has(method) || method === 'sendMediaGroup') {
			const count = method === 'sendMediaGroup' && Array.isArray(payload.media) ? payload.media.length : 1;
			const ids = Array.from({ length: count }, () => ++next);
			for (const id of ids) replies.set(id, isRecord(payload.reply_parameters) ? payload.reply_parameters.message_id : undefined);
			return { ok: true, result: method === 'sendMediaGroup' ? ids.map(message) : message(ids[0] ?? 0) };
		}
		return { ok: true, result: true };
	}

	function answer(call: Call): CallResponse {
		const fault = faults.get(index++);
		if (fault === 'refused') return { ok: false, status: 400, description: 'Bad Request: chat not found' };
		if (fault === 'token') return { ok: false, status: 401, description: 'Unauthorized' };
		if (typeof fault === 'object') return { ok: false, status: 429, description: 'Too Many Requests', retryAfter: fault.busy };
		const response = reach(call);
		if (fault === 'lost') return { noAnswer: true };
		if (fault === 'gateway') return { ok: false, status: 502, description: 'Bad Gateway' };
		return response;
	}

	const fake = fakeCall(Array.from({ length: 500 }, () => answer));
	return {
		/** The transport for createChat. */
		call: (call: Call, files?: Record<string, Publishable>) => fake.call(call, files),
		calls: fake.calls,
		shows,
		/** The message id each files message replied to. */
		replies,
		/** Fails the call with index `n` from the model's start. */
		fail(n: number, fault: Fault) {
			faults.set(n, fault);
		},
		/** How many calls the model has answered. */
		get count() {
			return index;
		},
		/** The id the next message will get. */
		get nextMessage() {
			return next + 1;
		},
	};
}
export type Telegram = ReturnType<typeof telegram>;

/**
 * Wraps a store so that every value written is checked as it would be read back: a question
 * must pass `parseQuestion` after a JSON round trip and equal it, an index entry is a ref, a
 * tombstone `{ v: 1, at }`. Each breach lands in `breaches`; the write goes on, so a test sees
 * the state that the breach produced.
 */
export function checkedStore(inner: Store) {
	const breaches: string[] = [];
	const check = (key: string, value: unknown) => {
		const read: unknown = JSON.parse(JSON.stringify(value));
		if (key.startsWith('q:') && !sameJson(parseQuestion(read), value)) breaches.push(`${key} does not read back as a question`);
		if (key.startsWith('m:') && typeof read !== 'string') breaches.push(`${key} is not a ref`);
		if (key.startsWith('t:') && !(isRecord(read) && read.v === 1 && typeof read.at === 'number')) breaches.push(`${key} is not a tombstone`);
	};
	const store: Store = {
		...inner,
		set: async (key, value) => {
			check(key, value);
			await inner.set(key, value);
		},
	};
	return { store, breaches };
}

/** Every question in a store, as `parseQuestion` reads it, by ref. */
export async function questions(store: Store): Promise<Map<string, Question | undefined>> {
	const found = new Map<string, Question | undefined>();
	for (const key of await store.list('q:')) found.set(key.slice(2), parseQuestion(await store.get(key)));
	return found;
}

/** A Publishable over bytes in memory. `closed` counts its closes. */
export function memoryFile(path: string, bytes = new Uint8Array([1, 2, 3]), type = 'image/png'): Publishable & { closed: number } {
	return {
		path,
		type,
		size: bytes.length,
		closed: 0,
		stream: () => new Blob([bytes]).stream(),
		bytes: async () => bytes,
		async close() {
			this.closed++;
		},
	};
}

/**
 * A chat over a checked, faulty memory store and a Telegram model, at a clock that a test can
 * move. `io` overrides any part of createChat's input.
 */
export function setup(io: Partial<ChatIO> = {}) {
	const server = telegram();
	const checked = checkedStore(memoryStore());
	const store = faultyStore(checked.store);
	const clock = { now: NOW };
	const chat = createChat({ call: server.call, store, chat: CHAT, now: () => clock.now, ...io });
	return { server, store, inner: checked.store, breaches: checked.breaches, clock, chat };
}

/** A view client whose `context` records each write and fails the writes `failing` names by their 0-based index. It holds no view and no choice. */
export function fakeViews(failing: number[] = []) {
	const writes: { id: string; ref: string; body: unknown; choice?: unknown }[] = [];
	const views: ViewClient = {
		put: async () => ({ kind: 'refused', reason: 'not in this stage' }),
		has: async () => ({ kind: 'missing' }),
		delete: async () => ({ kind: 'missing' }),
		version: async () => ({ kind: 'ok', formats: ['1', 'answers'] }),
		choices: async () => ({ kind: 'ok', choices: [] }),
		removeChoice: async () => ({ kind: 'ok' }),
		async context(id, ref, body, choice) {
			const index = writes.length;
			writes.push({ id, ref, body, ...(choice !== undefined ? { choice } : {}) });
			if (failing.includes(index)) throw new Error('the view host did not answer');
			return { kind: 'ok' };
		},
	};
	return { views, writes };
}

/** A file reader over memory: every path opens as a small file, and `opened` keeps each one. */
export function fakeFiles() {
	const opened: ReturnType<typeof memoryFile>[] = [];
	const files = async (paths: string[]): Promise<Readable> => {
		const read = paths.map((path) => memoryFile(path));
		opened.push(...read);
		return { kind: 'ok', files: read };
	};
	return { files, opened };
}
