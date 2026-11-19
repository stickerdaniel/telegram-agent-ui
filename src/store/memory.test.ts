import { expect, jest, test } from 'bun:test';
import { LockTimeout } from '../core/types.ts';
import { memoryStore } from './memory.ts';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('lock serializes two tasks on one key', async () => {
	const store = memoryStore();
	const trace: string[] = [];
	const task = (name: string) => async () => {
		trace.push(`${name} in`);
		const count = Number((await store.get('n')) ?? 0);
		await pause(5);
		await store.set('n', count + 1);
		trace.push(`${name} out`);
	};
	await Promise.all([store.lock('q:a', task('first')), store.lock('q:a', task('second'))]);
	expect(trace).toEqual(['first in', 'first out', 'second in', 'second out']);
	expect(await store.get('n')).toBe(2);
});

test('locks of different keys do not wait for each other', async () => {
	const store = memoryStore();
	const trace: string[] = [];
	await Promise.all([
		store.lock('q:a', async () => {
			trace.push('a in');
			await pause(10);
			trace.push('a out');
		}),
		store.lock('q:b', async () => {
			trace.push('b in');
		}),
	]);
	expect(trace).toEqual(['a in', 'b in', 'a out']);
});

test('a task that throws releases the lock', async () => {
	const store = memoryStore();
	await expect(store.lock('q:a', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
	expect(await store.lock('q:a', async () => 'next')).toBe('next');
});

test('a waiter rejects with LockTimeout after lockWait, and the tasks behind it keep their order', async () => {
	const store = memoryStore({ lockWait: 100 });
	const trace: string[] = [];
	const holder = store.lock('q:a', async () => {
		await pause(150);
		trace.push('holder');
	});
	const waiter = store.lock('q:a', async () => trace.push('waiter'));
	await expect(waiter).rejects.toBeInstanceOf(LockTimeout);
	await Promise.all([holder, store.lock('q:a', async () => trace.push('third'))]);
	expect(trace).toEqual(['holder', 'third']);
});

test('the wait of one lock call replaces lockWait for that call alone', async () => {
	const store = memoryStore({ lockWait: 100 });
	const holder = store.lock('media:a', () => pause(300));
	const patient = store.lock('media:a', async () => 'turn', { wait: 2_000 });
	const hasty = store.lock('media:a', async () => 'turn');
	await expect(hasty).rejects.toBeInstanceOf(LockTimeout);
	expect(await patient).toBe('turn');
	await holder;
});

async function behindHolders(holders: number, holdMs: number): Promise<unknown> {
	jest.useFakeTimers();
	try {
		const store = memoryStore();
		const held = Array.from({ length: holders }, () => store.lock('q:a', () => new Promise<void>((resolve) => setTimeout(resolve, holdMs))));
		const waiter = store.lock('q:a', async () => 'turn').catch((error: unknown) => error);
		for (let elapsed = 0; elapsed <= holders * holdMs + 1_000; elapsed += 100) {
			jest.advanceTimersByTime(100);
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();
		}
		await Promise.allSettled(held);
		return await waiter;
	} finally {
		jest.useRealTimers();
	}
}

test('the wait counts per holder: three holders of 4 s each do not time out a waiter with a 10 s wait', async () => {
	expect(await behindHolders(3, 4_000)).toBe('turn');
});

test('one holder that keeps the key for 11 s times out a waiter with a 10 s wait', async () => {
	expect(await behindHolders(1, 11_000)).toBeInstanceOf(LockTimeout);
});

test('values are copied in and out', async () => {
	const store = memoryStore();
	const value = { list: [1] };
	await store.set('k', value);
	value.list.push(2);
	expect(await store.get('k')).toEqual({ list: [1] });
	const read = (await store.get('k')) as { list: number[] };
	read.list.push(3);
	expect(await store.get('k')).toEqual({ list: [1] });
	await store.set('q:b', 1);
	await store.set('q:a', 1);
	await store.set('m:1', 1);
	expect(await store.list('q:')).toEqual(['q:a', 'q:b']);
	await store.delete('q:a');
	expect(await store.get('q:a')).toBeUndefined();
});
