// A Store in one process's memory, for tests and for consumers that keep nothing across a
// restart. Values are copied in and out, so a caller never mutates a stored value.
import { LockTimeout, type Store } from '../core/types.ts';

/**
 * A Store over a Map. Its lock serializes the tasks of one process per key, in arrival order.
 * `lockWait` is how long one holder may keep a key while a task waits for it before that task
 * rejects with LockTimeout, 10 s by default. A key that is free or changes hands restarts the
 * count, so a task behind several short holders waits as long as they take. The `wait` of one
 * `lock` call replaces `lockWait` for that call.
 *
 *   const store = memoryStore();
 *   await store.lock('q:merge1', async () => store.set('q:merge1', question));
 */
export function memoryStore(options: { lockWait?: number } = {}): Store {
	const lockWait = options.lockWait ?? 10_000;
	const values = new Map<string, unknown>();
	// The promise each key's next task waits for: it settles when the task before it releases.
	const tails = new Map<string, Promise<void>>();
	// The task that holds each key, and when it took it.
	const holders = new Map<string, { since: number }>();

	/** Settles with 'turn' once `before` settles, or 'timeout' once one holder of `key` kept it for `lockWait` of this wait. */
	function awaitTurn(key: string, before: Promise<void>, lockWait: number): Promise<'turn' | 'timeout'> {
		const waiting = Date.now();
		return new Promise((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			// Looks at the holder each time its time could have run out: the count runs from when this
			// wait began or the holder took the key, whichever is later, so a new holder restarts it.
			const check = () => {
				const holder = holders.get(key);
				const left = holder ? Math.max(holder.since, waiting) + lockWait - Date.now() : lockWait;
				if (left <= 0) resolve('timeout');
				else timer = setTimeout(check, left);
			};
			void before.then(() => {
				clearTimeout(timer);
				resolve('turn');
			});
			check();
		});
	}

	return {
		get: async (key) => structuredClone(values.get(key)),
		set: async (key, value) => {
			values.set(key, structuredClone(value));
		},
		delete: async (key) => {
			values.delete(key);
		},
		list: async (prefix) => [...values.keys()].filter((key) => key.startsWith(prefix)).sort(),
		async lock<T>(key: string, fn: () => Promise<T>, options: { wait?: number } = {}): Promise<T> {
			const wait = options.wait ?? lockWait;
			const before = tails.get(key) ?? Promise.resolve();
			let release = () => {};
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			tails.set(key, released);
			if ((await awaitTurn(key, before, wait)) === 'timeout') {
				// The tasks behind this one still wait for the one before it.
				void before.then(release);
				throw new LockTimeout(`the lock of ${key} stayed held by one holder for ${wait} ms`);
			}
			const held = { since: Date.now() };
			holders.set(key, held);
			try {
				return await fn();
			} finally {
				if (holders.get(key) === held) holders.delete(key);
				release();
				if (tails.get(key) === released) tails.delete(key);
			}
		},
	};
}
