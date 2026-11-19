import type { Call, CallResponse, Store } from '../core/types.ts';

export type Scripted = CallResponse | ((call: Call) => CallResponse);

const DATE = 1794908513;
const SENDS = new Set(['sendRichMessage', 'sendPhoto', 'sendVideo', 'sendDocument']);

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
		async call(call: Call, files?: Readonly<Record<string, unknown>>): Promise<CallResponse> {
			calls.push(files ? { call, files } : { call });
			const scripted = queue.shift();
			if (scripted === undefined) return success(call);
			return typeof scripted === 'function' ? scripted(call) : scripted;
		},
	};
}

export class StoreFault extends Error {
	override name = 'StoreFault';
}

type Method = keyof Store;

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
		lock: (key, fn, options) => run('lock', key, () => inner.lock(key, fn, options)),
	};
	return {
		...store,
		ops,
		fail(method: Method, when: 'before' | 'after', nth = 1) {
			armed = { method, when, left: nth };
		},
	};
}
