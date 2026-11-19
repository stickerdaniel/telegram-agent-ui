import { LockTimeout, type Store } from '../core/types.ts';

export function memoryStore(options: { lockWait?: number } = {}): Store {
	const lockWait = options.lockWait ?? 10_000;
	const values = new Map<string, unknown>();
	const tails = new Map<string, Promise<void>>();
	const holders = new Map<string, { since: number }>();

	function awaitTurn(key: string, before: Promise<void>, lockWait: number): Promise<'turn' | 'timeout'> {
		const waiting = Date.now();
		return new Promise((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
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
