// A Store in one process's memory, for tests and for consumers that keep nothing across a
// restart. Values are copied in and out, so a caller never mutates a stored value.
import { LockTimeout, type Store } from '../core/types.ts';

/**
 * A Store over a Map. Its lock serializes the tasks of one process per key, in arrival order.
 * `lockWait` is how long a task waits for a held lock before it rejects with LockTimeout,
 * 10 s by default.
 *
 *   const store = memoryStore();
 *   await store.lock('q:merge1', async () => store.set('q:merge1', question));
 */
export function memoryStore(options: { lockWait?: number } = {}): Store {
	const lockWait = options.lockWait ?? 10_000;
	const values = new Map<string, unknown>();
	// The promise each key's next task waits for: it settles when the task before it releases.
	const tails = new Map<string, Promise<void>>();

	return {
		get: async (key) => structuredClone(values.get(key)),
		set: async (key, value) => {
			values.set(key, structuredClone(value));
		},
		delete: async (key) => {
			values.delete(key);
		},
		list: async (prefix) => [...values.keys()].filter((key) => key.startsWith(prefix)).sort(),
		async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
			const before = tails.get(key) ?? Promise.resolve();
			let release = () => {};
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			tails.set(key, released);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timedOut = new Promise<'timeout'>((resolve) => {
				timer = setTimeout(() => resolve('timeout'), lockWait);
			});
			const turn = await Promise.race([before.then(() => 'turn' as const), timedOut]);
			clearTimeout(timer);
			if (turn === 'timeout') {
				// The tasks behind this one still wait for the one before it.
				void before.then(release);
				throw new LockTimeout(`the lock of ${key} stayed held for ${lockWait} ms`);
			}
			try {
				return await fn();
			} finally {
				release();
				if (tails.get(key) === released) tails.delete(key);
			}
		},
	};
}
