import { expect, test } from 'bun:test';
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
	// Queued behind the waiter that gave up: it runs once the holder releases, 50 ms later.
	await Promise.all([holder, store.lock('q:a', async () => trace.push('third'))]);
	expect(trace).toEqual(['holder', 'third']);
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
