import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LockTimeout } from '../core/types.ts';
import { fileStore, LockLost } from './file.ts';

// Each test's directory sits in a root of its own, removed once the file is done.
const roots: string[] = [];
const temp = () => {
	const root = mkdtempSync(join(tmpdir(), 'tau-store-'));
	roots.push(root);
	return join(root, 'store');
};
afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const lockDir = (dir: string, key: string) => join(dir, '.locks', encodeURIComponent(key));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Tests that start processes get room for a machine 10 times slower than an idle one.
const SPAWNING = 30_000;

/** Starts lock-child.ts in another process, with `env` in place of this one's. */
function child(dir: string, key: string, mode: 'hold' | 'kill' | 'gate' | 'for', options: { gate?: string; ms?: number; env?: Record<string, string | undefined> } = {}) {
	const arg = options.gate ?? (options.ms !== undefined ? String(options.ms) : undefined);
	const args = [process.execPath, join(import.meta.dir, 'lock-child.ts'), dir, key, mode, ...(arg !== undefined ? [arg] : [])];
	return Bun.spawn(args, { stdout: 'pipe', stderr: 'inherit', env: options.env ?? process.env });
}

/** The first line a child prints. */
async function firstLine(process: { stdout: ReadableStream<Uint8Array> }): Promise<string> {
	const { value } = await process.stdout.getReader().read();
	return new TextDecoder().decode(value).split('\n')[0] ?? '';
}

/** The start time of `pid` as the store reads it. */
function startOf(pid: number): string {
	return Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C' } })
		.stdout.toString()
		.trim();
}

test('one JSON file per key, named by encodeURIComponent, in a directory of mode 0700', async () => {
	const dir = temp();
	const store = fileStore(dir);
	await store.set('q:merge1', { v: 1, list: [1, 'two'] });
	await store.set('m:111:632', 'merge1');
	expect(await store.get('q:merge1')).toEqual({ v: 1, list: [1, 'two'] });
	expect(readdirSync(dir).sort()).toEqual(['.locks', 'm%3A111%3A632', 'q%3Amerge1']);
	expect(statSync(dir).mode & 0o777).toBe(0o700);
	expect(await store.list('q:')).toEqual(['q:merge1']);
	await store.delete('q:merge1');
	expect(await store.get('q:merge1')).toBeUndefined();
	expect(await store.list('')).toEqual(['m:111:632']);
	// A second store on the directory reads the same values.
	expect(await fileStore(dir).get('m:111:632')).toBe('merge1');
	await expect(store.set('.locks', 1)).rejects.toThrow('cannot name a file');
	await expect(store.set('q:x', undefined)).rejects.toThrow('not JSON');
});

test('lock serializes two tasks of one process on one key', async () => {
	const store = fileStore(temp());
	const trace: string[] = [];
	const task = (name: string) => async () => {
		trace.push(`${name} in`);
		const count = Number((await store.get('n')) ?? 0);
		await pause(20);
		await store.set('n', count + 1);
		trace.push(`${name} out`);
	};
	await Promise.all([store.lock('q:a', task('first')), store.lock('q:a', task('second'))]);
	// Either task may go first; neither starts before the other is out.
	expect([
		['first in', 'first out', 'second in', 'second out'],
		['second in', 'second out', 'first in', 'first out'],
	]).toContainEqual(trace);
	expect(await store.get('n')).toBe(2);
});

test('a holder killed inside the lock passes it on', async () => {
	const dir = temp();
	const killed = child(dir, 'q:a', 'kill');
	await killed.exited;
	expect(killed.signalCode).toBe('SIGKILL');
	const store = fileStore(dir);
	expect(await store.lock('q:a', async () => 'taken')).toBe('taken');
	expect(readdirSync(lockDir(dir, 'q:a')).sort()).toEqual(['2.json', '2.released']);
}, SPAWNING);

test('a process that cannot read its own start time takes no lock, so a live holder is never displaced', async () => {
	const dir = temp();
	const gate = `${dir}-gate`;
	// Without ps, the first process cannot name its start time. It would hold the lock until the gate exists.
	const blind = child(dir, 'q:a', 'gate', { gate, env: { ...process.env, PATH: '/nonexistent' } });
	try {
		const said = await firstLine(blind);
		// A process with ps reads the first one's real start time. It must not enter while the first is inside.
		const enteredBesideHolder = await fileStore(dir, { lockWait: 2_000 })
			.lock('q:a', async () => said === 'locked' && !existsSync(gate))
			.catch((error: unknown) => error);
		expect(said).toBe('error IdentityUnknown');
		expect(enteredBesideHolder).toBe(false);
	} finally {
		writeFileSync(gate, '');
		await blind.exited;
	}
	expect(blind.exitCode).toBe(2);
}, SPAWNING);

test('a waiter whose look stalls on a slow ps does not give up on a holder that released meanwhile', async () => {
	const dir = temp();
	// A ps that takes 1.5 s, as one did under CPU contention for a process at background priority.
	const shim = `${dir}-bin`;
	mkdirSync(shim, { recursive: true });
	writeFileSync(join(shim, 'ps'), '#!/bin/sh\nsleep 1.5\nexec /bin/ps "$@"\n', { mode: 0o755 });
	const holder = child(dir, 'q:a', 'for', { ms: 300 });
	const path = process.env.PATH;
	try {
		expect(await firstLine(holder)).toBe('locked');
		process.env.PATH = `${shim}:${path}`;
		// The first look finds the lock held and stalls 1.5 s on ps; the holder lets go 300 ms in.
		// A wait of 500 ms counted from the request would expire during that stalled look.
		expect(await fileStore(dir, { lockWait: 500 }).lock('q:a', async () => 'taken')).toBe('taken');
	} finally {
		process.env.PATH = path;
		holder.kill('SIGKILL');
		await holder.exited;
	}
}, SPAWNING);

test('a live holder is never taken over by age, and a waiter gives up with LockTimeout', async () => {
	const dir = temp();
	const holder = child(dir, 'q:a', 'hold');
	try {
		await firstLine(holder);
		// The generation file looks a year old: age changes nothing.
		const old = new Date(Date.now() - 365 * 86_400_000);
		utimesSync(join(lockDir(dir, 'q:a'), '1.json'), old, old);
		const store = fileStore(dir, { lockWait: 300 });
		let ran = false;
		await expect(
			store.lock('q:a', async () => {
				ran = true;
			}),
		).rejects.toBeInstanceOf(LockTimeout);
		expect(ran).toBe(false);
	} finally {
		holder.kill('SIGKILL');
		await holder.exited;
	}
	expect(await fileStore(dir).lock('q:a', async () => 'after the holder died')).toBe('after the holder died');
}, SPAWNING);

test('the wait of one lock call replaces lockWait for that call alone', async () => {
	const dir = temp();
	const store = fileStore(dir, { lockWait: 200 });
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered = () => {};
	const inside = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const holder = store.lock('media:a', async () => {
		entered();
		await held;
	});
	await inside;
	const patient = store.lock('media:a', async () => 'turn', { wait: 20_000 });
	await expect(store.lock('media:a', async () => 'turn')).rejects.toBeInstanceOf(LockTimeout);
	release();
	await holder;
	expect(await patient).toBe('turn');
}, SPAWNING);

test('a pid that another process reused does not keep a lock, and the holder with its true start time does', async () => {
	const dir = temp();
	const other = Bun.spawn(['sleep', '30']);
	try {
		const owner = (start: string) => JSON.stringify({ pid: other.pid, start, token: 'reused', generation: 1 });
		const generation = join(lockDir(dir, 'q:a'), '1.json');
		// The live process `other` has the owner's start time: it is the holder.
		mkdirSync(lockDir(dir, 'q:a'), { recursive: true });
		writeFileSync(generation, owner(startOf(other.pid)));
		await expect(fileStore(dir, { lockWait: 300 }).lock('q:a', async () => {})).rejects.toBeInstanceOf(LockTimeout);
		// The same pid with another start time is a process that reused the pid of a holder that is gone.
		writeFileSync(generation, owner('Thu Jan  1 00:00:00 1970'));
		expect(await fileStore(dir).lock('q:a', async () => 'taken')).toBe('taken');
	} finally {
		other.kill('SIGKILL');
		await other.exited;
	}
}, SPAWNING);

test('a write by a holder that lost its lock is refused, and its release leaves the successor alone', async () => {
	const dir = temp();
	const store = fileStore(dir);
	await store.set('q:a', 'before');
	await store.lock('q:a', async () => {
		// As if this holder had been judged gone while paused, and another process took the lock.
		writeFileSync(join(lockDir(dir, 'q:a'), '2.json'), JSON.stringify({ pid: process.pid, start: 'another', token: 'successor', generation: 2 }));
		await expect(store.set('q:a', 'late write')).rejects.toBeInstanceOf(LockLost);
		await expect(store.delete('q:a')).rejects.toBeInstanceOf(LockLost);
	});
	expect(await store.get('q:a')).toBe('before');
	expect(readdirSync(lockDir(dir, 'q:a')).sort()).toEqual(['1.json', '2.json']);
});

test('writes under nested locks of two keys and outside any lock go through', async () => {
	const dir = temp();
	const store = fileStore(dir);
	await store.lock('q:a', async () => {
		await store.lock('q:b', async () => store.set('q:b', 1));
		await store.set('q:a', 1);
	});
	await store.set('free', 1);
	expect(await store.list('')).toEqual(['free', 'q:a', 'q:b']);
});
