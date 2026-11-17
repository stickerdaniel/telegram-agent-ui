// Test doubles for a consumer's loop: a Bot API transport that records every call and answers
// from a script, and a store that fails on demand. Neither makes a request.
import type { Call, CallResponse, Store } from '../core/types.ts';

/** One scripted answer: a fixed response, or one computed from the call. */
export type Scripted = CallResponse | ((call: Call) => CallResponse);

// The date of the recorded sends in facts/records/, in Unix seconds.
const DATE = 1794908513;
const SENDS = new Set(['sendRichMessage', 'sendPhoto', 'sendVideo', 'sendDocument']);

/**
 * A transport that records every call and answers from `script`, in order. Once the script
 * is used up it answers like the cloud Bot API does on success: a send gets a new message,
 * an album one message per file, an edit the edited message, anything else `true`.
 *
 *   const telegram = fakeCall([{ noAnswer: true }]);
 *   await telegram.call(steps[0].call); // { noAnswer: true }
 *   telegram.calls.length; // 1
 */
export function fakeCall(script: Scripted[] = []) {
	const queue = [...script];
	const calls: { call: Call; files?: Readonly<Record<string, unknown>> }[] = [];
	let next = 1000;
	const message = (chat: unknown, id = ++next) => ({ message_id: id, date: DATE, chat: { id: chat, type: 'private' } });

	function success({ method, payload }: Call): CallResponse {
		if (SENDS.has(method)) return { ok: true, result: message(payload.chat_id) };
		if (method === 'sendMediaGroup') return { ok: true, result: (Array.isArray(payload.media) ? payload.media : []).map(() => message(payload.chat_id)) };
		if (method === 'editMessageText' && typeof payload.message_id === 'number') return { ok: true, result: message(payload.chat_id, payload.message_id) };
		return { ok: true, result: true };
	}

	return {
		calls,
		/** The transport: `files` holds what a caller opened for the call's multipart fields. */
		async call(call: Call, files?: Readonly<Record<string, unknown>>): Promise<CallResponse> {
			calls.push(files ? { call, files } : { call });
			const scripted = queue.shift();
			if (scripted === undefined) return success(call);
			return typeof scripted === 'function' ? scripted(call) : scripted;
		},
	};
}

/** The error a faulty store throws. */
export class StoreFault extends Error {
	override name = 'StoreFault';
}

type Method = keyof Store;

/**
 * Wraps a store so that one chosen call fails: `fail('set', 'after', 2)` lets the second
 * `set` from now on write and then throw StoreFault, `'before'` throws without running it.
 * For `lock`, `'after'` runs the task and then throws. `ops` lists every call in order, so a
 * test can count the fault points of a run and then fail each one.
 */
export function faultyStore(inner: Store) {
	let armed: { method: Method; when: 'before' | 'after'; left: number } | undefined;
	const ops: { method: Method; key: string }[] = [];

	async function run<T>(method: Method, key: string, op: () => Promise<T>): Promise<T> {
		ops.push({ method, key });
		const fault = armed?.method === method && --armed.left === 0 ? armed.when : undefined;
		if (fault) armed = undefined;
		if (fault === 'before') throw new StoreFault(`${method} ${key} failed before it ran`);
		const result = await op();
		if (fault === 'after') throw new StoreFault(`${method} ${key} failed after it ran`);
		return result;
	}

	const store: Store = {
		get: (key) => run('get', key, () => inner.get(key)),
		set: (key, value) => run('set', key, () => inner.set(key, value)),
		delete: (key) => run('delete', key, () => inner.delete(key)),
		list: (prefix) => run('list', prefix, () => inner.list(prefix)),
		lock: (key, fn) => run('lock', key, () => inner.lock(key, fn)),
	};
	return {
		...store,
		ops,
		/** Arms one fault on the `nth` call of `method` from now on, 1 by default. */
		fail(method: Method, when: 'before' | 'after', nth = 1) {
			armed = { method, when, left: nth };
		},
	};
}
