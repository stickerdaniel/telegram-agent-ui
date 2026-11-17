// One side of the two-process race test: `bun race-child.ts <dir> <log> <op> <id> <run>`. It
// builds a chat on `fileStore(dir)`, writes `<log>.ready-<id>`, waits up to 300 s for `<log>.go`
// (else exits 3), runs `op` on question `probe001` and prints the result as JSON. Both sides
// append every call to `<log>`, one JSON line each, so the file holds the calls in the order they
// were made. Each side also writes `<log>.trace-<id>`: its store operations, lock phases and calls
// with wall-clock times, which the test prints when a run fails.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { choice } from '../core/builders.ts';
import type { Call, CallResponse, Store } from '../core/types.ts';
import { CHAT, REF, tap } from '../fixtures.ts';
import { fileStore } from '../store/file.ts';
import { type Chat, createChat } from './create.ts';

export const BODY = 1001;
export const SPEC = choice({ markdown: 'Deploy now?' }, [{ label: 'Deploy' }, { label: 'Wait' }]);
export const OPS = ['send', 'tap0', 'tap1', 'close', 'edit'] as const;
export type Op = (typeof OPS)[number];

/** A transport that appends each call to `log` and answers as the Bot API does on success, with message 1001 for a send. */
export function logged(log: string) {
	return async (call: Call): Promise<CallResponse> => {
		appendFileSync(log, `${JSON.stringify({ method: call.method, payload: call.payload })}\n`);
		if (call.method === 'sendRichMessage') return { ok: true, result: { message_id: BODY, date: 0, chat: { id: CHAT, type: 'private' } } };
		if (call.method === 'editMessageText') return { ok: true, result: { message_id: call.payload.message_id, date: 0, chat: { id: CHAT, type: 'private' } } };
		return { ok: true, result: true };
	};
}

export function act(chat: Chat, op: Op, id: string) {
	switch (op) {
		case 'send':
			return chat.send(SPEC, { ref: REF });
		case 'tap0':
		case 'tap1':
			return chat.handle(tap({ button: op === 'tap0' ? 0 : 1, id: `cq-${id}`, message: BODY }));
		case 'close':
			return chat.close(REF, { markdown: 'Closed from the terminal.' });
		case 'edit':
			return chat.edit({ chat: CHAT, message: BODY, files: [], ref: REF }, { markdown: 'Deploy at 18:00?' });
	}
}

/** A store that notes each operation, and each phase of a lock, with the wall-clock time in `trace`. */
export function traced(store: Store, note: (what: string) => void): Store {
	const timed =
		<A extends unknown[], R>(name: string, op: (...args: A) => Promise<R>) =>
		async (...args: A): Promise<R> => {
			note(`${name} ${String(args[0])}`);
			try {
				return await op(...args);
			} finally {
				note(`${name} ${String(args[0])} done`);
			}
		};
	return {
		get: timed('get', store.get),
		set: timed('set', store.set),
		delete: timed('delete', store.delete),
		list: timed('list', store.list),
		async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
			note(`lock ${key} wanted`);
			try {
				return await store.lock(key, async () => {
					note(`lock ${key} held`);
					try {
						return await fn();
					} finally {
						note(`lock ${key} fn done`);
					}
				});
			} finally {
				note(`lock ${key} released or failed`);
			}
		},
	};
}

if (import.meta.main) {
	const [dir, log, op, id, run] = process.argv.slice(2);
	const known = OPS.find((name) => name === op);
	if (!dir || !log || !known || !id) throw new Error('usage: race-child.ts <dir> <log> <op> <id> <run>');
	// Appended at once, so a child that is killed or hangs still leaves its trace.
	const note = (what: string) => appendFileSync(`${log}.trace-${id}`, `${Date.now()} pid ${process.pid} run ${run} ${op}: ${what}\n`);
	const transport = logged(log);
	const call = async (request: Call) => {
		note(`call ${request.method}`);
		const response = await transport(request);
		note(`call ${request.method} done`);
		return response;
	};
	// This test checks consistency, not timeouts: LockTimeout has its own tests in the store.
	// A starved holder kept the lock 172 s at load average 30, so the wait per holder is 30 min.
	const chat = createChat({ call, store: traced(fileStore(dir, { lockWait: 1_800_000 }), note), chat: CHAT });
	writeFileSync(`${log}.ready-${id}`, '');
	// A parent that died never writes the go file: give up after 300 s instead of waiting for good.
	const deadline = Date.now() + 300_000;
	while (!existsSync(`${log}.go`)) {
		if (Date.now() > deadline) process.exit(3);
		await Bun.sleep(1);
	}
	note('go');
	try {
		const result = await act(chat, known, id);
		note('acted');
		console.log(JSON.stringify(result));
	} catch (error) {
		note(`failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
		throw error;
	}
}
