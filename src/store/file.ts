// A Store of one JSON file per key, for Node and Bun on macOS and Linux. Several processes may
// share one directory: a write goes to a temp file that is renamed over the key's file, so a
// reader sees the old value or the new one, never a part.
//
// The lock of a key is a directory of generation files, `.locks/<key>/<n>.json`, each holding
// its owner: pid, process start time and a token per acquisition. The highest generation is the
// current one, held until `<n>.released` exists. This is the reply desk's ledger lock:
// - Publication: the owner is written in full to a temp file and hard-linked to `<n>.json`.
//   link() fails when the name exists, so exactly one waiter gets each generation, and a
//   generation file is never seen half-written.
// - Takeover: a waiter that sees generation n released, or owned by a process that is gone,
//   publishes n + 1. A process is gone when its pid does not exist, or when ps reads another
//   start time for it, so a pid that another process reused never keeps a lock. A start time that
//   cannot be read proves nothing: a process that cannot read its own takes no lock. Age never
//   passes a lock on: a held lock never expires while its task runs.
// - Nothing removes the current generation. The new holder deletes the generations below its
//   own; a waiter that published one of those again sees a higher one and withdraws it.
// - Fence: before every `set` and `delete` inside a lock, the store checks that each lock the
//   task holds is still its own, so a holder that was replaced cannot write.
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isInt, isRecord, isString } from '../core/check.ts';
import { LockTimeout, type Store } from '../core/types.ts';

/** A write inside a lock that this process no longer holds. */
export class LockLost extends Error {
	override name = 'LockLost';
}

/** A process that cannot read its own start time, and therefore takes no lock. */
export class IdentityUnknown extends Error {
	override name = 'IdentityUnknown';
}

type Owner = { pid: number; start: string; token: string; generation: number };
type Held = { dir: string; key: string; owner: Owner };

// Names that start with "." are the store's own: the lock directories and temp files. No key
// encodes to one, since `fileStore` refuses such keys.
const LOCKS = '.locks';
const TEMP = '.tmp-';
const TEMP_NAME = /^\.tmp-(\d+)-/;

const codeOf = (error: unknown) => (error instanceof Error && 'code' in error ? error.code : undefined);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The file name of a key. Throws for a key whose name would start with "." or not fit a file name. */
function fileName(key: string): string {
	const name = encodeURIComponent(key);
	if (name === '' || name.startsWith('.') || name.length > 240) throw new Error(`the key "${key}" cannot name a file of the store`);
	return name;
}

/** The start time of process `pid` as ps reports it, or undefined when ps names none. With the pid it identifies one process. */
function startTime(pid: number): string | undefined {
	try {
		const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] });
		return out.trim() || undefined;
	} catch {
		return undefined;
	}
}

function pidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return codeOf(error) === 'EPERM';
	}
}

let ownStart: string | undefined;
/**
 * This process's start time. Throws IdentityUnknown when ps names none: an owner without a
 * comparable start time could be judged gone by a process that reads the real one.
 */
function thisStart(): string {
	ownStart ??= startTime(process.pid);
	if (ownStart === undefined) throw new IdentityUnknown(`the start time of process ${process.pid} cannot be read with ps, so this process takes no lock`);
	return ownStart;
}

/**
 * Whether the owner's process still runs. Only a start time that was read and differs proves a
 * reused pid: a live pid whose start time cannot be read counts as the owner, so the lock fails closed.
 */
function alive(owner: Owner): boolean {
	if (owner.pid === process.pid) return owner.start === thisStart();
	if (!pidExists(owner.pid)) return false;
	const start = startTime(owner.pid);
	return start === undefined || start === owner.start;
}

const isOwner = (value: unknown): value is Owner => isRecord(value) && isInt(value.pid) && isString(value.start) && isString(value.token) && isInt(value.generation);
const generationPath = (dir: string, generation: number) => join(dir, `${generation}.json`);
const releasedPath = (dir: string, generation: number) => join(dir, `${generation}.released`);

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (codeOf(error) === 'ENOENT') return false;
		throw error;
	}
}

async function top(dir: string): Promise<number> {
	const generations = (await readdir(dir)).flatMap((name) => {
		const match = /^(\d+)\.json$/.exec(name);
		return match ? [Number(match[1])] : [];
	});
	return Math.max(0, ...generations);
}

async function readOwner(dir: string, generation: number): Promise<Owner | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(generationPath(dir, generation), 'utf8'));
		return isOwner(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Publishes `owner` as its generation. False when another waiter got that generation first. */
async function publish(dir: string, owner: Owner): Promise<boolean> {
	const temp = join(dir, `${TEMP}${process.pid}-${randomUUID()}`);
	try {
		const handle = await open(temp, 'wx', 0o600);
		try {
			await handle.writeFile(JSON.stringify(owner));
		} finally {
			await handle.close();
		}
		await link(temp, generationPath(dir, owner.generation));
		return true;
	} catch (error) {
		if (codeOf(error) === 'EEXIST') return false;
		throw error;
	} finally {
		await rm(temp, { force: true });
	}
}

/** Removes the generations below `generation` and the temp files of processes that are gone. */
async function sweep(dir: string, generation: number): Promise<void> {
	for (const name of await readdir(dir)) {
		const old = /^(\d+)\.(json|released)$/.exec(name);
		const temp = TEMP_NAME.exec(name);
		const stale = old ? Number(old[1]) < generation : temp ? !pidExists(Number(temp[1])) : false;
		if (stale) await rm(join(dir, name), { force: true });
	}
}

/** Throws LockLost unless `held` is still the current, unreleased generation of its lock, with this owner. */
async function fence(held: Held): Promise<void> {
	const { dir, owner } = held;
	const current = await readOwner(dir, owner.generation);
	if ((await top(dir)) !== owner.generation || (await exists(releasedPath(dir, owner.generation))) || current?.token !== owner.token || current.pid !== owner.pid) {
		throw new LockLost(`the lock of ${held.key} is no longer held by this task`);
	}
}

/**
 * A Store in the directory `dir`, created with mode 0700 when missing: one JSON file per key,
 * named `encodeURIComponent(key)`. Keys whose name would start with "." are refused. `lockWait`
 * is how long one holder may keep a lock, as a waiting `lock` observes it, before the waiter
 * rejects with LockTimeout, 10 s by default. A lock that changes hands restarts the wait.
 * A `set` or `delete` inside `lock` rejects with LockLost once a task no longer holds its lock.
 * `lock` rejects with IdentityUnknown in a process that cannot read its own start time with ps.
 *
 *   const store = fileStore(join(process.env.XDG_DATA_HOME ?? '', 'telegram-agent-ui', '123'));
 *   await store.lock('q:merge1', async () => store.set('q:merge1', question));
 */
export function fileStore(dir: string, options: { lockWait?: number } = {}): Store {
	const lockWait = options.lockWait ?? 10_000;
	// The locks the current task holds, so a write inside them can be fenced.
	const holding = new AsyncLocalStorage<Held[]>();
	let ready: Promise<void> | undefined;

	/** Creates the directory once, with mode 0700, and removes temp files of processes that are gone. */
	function prepare(): Promise<void> {
		ready ??= (async () => {
			await mkdir(join(dir, LOCKS), { recursive: true, mode: 0o700 });
			await chmod(dir, 0o700);
			for (const name of await readdir(dir)) {
				const temp = TEMP_NAME.exec(name);
				if (temp && !pidExists(Number(temp[1]))) await rm(join(dir, name), { force: true });
			}
		})();
		return ready;
	}

	async function fenceHeld(): Promise<void> {
		for (const held of holding.getStore() ?? []) await fence(held);
	}

	async function acquire(key: string): Promise<Held> {
		const start = thisStart();
		const lockDir = join(dir, LOCKS, fileName(key));
		await mkdir(lockDir, { recursive: true, mode: 0o700 });
		// The generation this waiter saw held, and when a look at it had ended. The wait counts only
		// while one generation stays held: a lock that was free or changed hands starts it again.
		// So the time another process spends acquiring, and any time this one is starved, never
		// counts against a holder.
		let seen: { generation: number; token: string | undefined; at: number } | undefined;
		for (let pause = 5; ; pause = Math.min(pause * 2, 100)) {
			// Read before the look, which may stall on a ps spawn: a slow look never makes the holder seem to have held longer.
			const lookedAt = Date.now();
			const current = await top(lockDir);
			const holder = current > 0 ? await readOwner(lockDir, current) : undefined;
			// An unreadable owner counts as live: the lock fails closed.
			const free = current === 0 || (await exists(releasedPath(lockDir, current))) || (holder !== undefined && !alive(holder));
			if (free) {
				seen = undefined;
				const owner: Owner = { pid: process.pid, start, token: randomUUID(), generation: current + 1 };
				if (await publish(lockDir, owner)) {
					if ((await top(lockDir)) === owner.generation) {
						await sweep(lockDir, owner.generation);
						return { dir: lockDir, key, owner };
					}
					await rm(generationPath(lockDir, owner.generation), { force: true });
				}
				continue;
			}
			if (seen?.generation !== current || seen.token !== holder?.token) seen = { generation: current, token: holder?.token, at: Date.now() };
			else if (lookedAt - seen.at >= lockWait) {
				// Two looks, lockWait apart, both found this generation held.
				throw new LockTimeout(holder ? `the lock of ${key} stayed held by pid ${holder.pid} for ${lockWait} ms` : `the lock of ${key} has an unreadable owner`);
			}
			await sleep(pause);
		}
	}

	/** Marks the generation released, unless a successor took it over: then its generation stays untouched. */
	async function release(held: Held): Promise<void> {
		try {
			await fence(held);
		} catch (error) {
			if (error instanceof LockLost) return;
			throw error;
		}
		const handle = await open(releasedPath(held.dir, held.owner.generation), 'wx', 0o600);
		await handle.close();
	}

	return {
		async get(key) {
			await prepare();
			try {
				return JSON.parse(await readFile(join(dir, fileName(key)), 'utf8'));
			} catch (error) {
				if (codeOf(error) === 'ENOENT') return undefined;
				throw error;
			}
		},
		async set(key, value) {
			await prepare();
			const path = join(dir, fileName(key));
			const text = JSON.stringify(value);
			if (text === undefined) throw new Error(`the value of ${key} is not JSON`);
			await fenceHeld();
			const temp = join(dir, `${TEMP}${process.pid}-${randomUUID()}`);
			try {
				const handle = await open(temp, 'wx', 0o600);
				try {
					await handle.writeFile(text);
					await handle.sync();
				} finally {
					await handle.close();
				}
				await rename(temp, path);
			} catch (error) {
				await rm(temp, { force: true });
				throw error;
			}
		},
		async delete(key) {
			await prepare();
			const path = join(dir, fileName(key));
			await fenceHeld();
			await rm(path, { force: true });
		},
		async list(prefix) {
			await prepare();
			const keys = (await readdir(dir)).flatMap((name) => {
				if (name.startsWith('.')) return [];
				try {
					return [decodeURIComponent(name)];
				} catch {
					return [];
				}
			});
			return keys.filter((key) => key.startsWith(prefix)).sort();
		},
		async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
			await prepare();
			const held = await acquire(key);
			try {
				return await holding.run([...(holding.getStore() ?? []), held], fn);
			} finally {
				await release(held);
			}
		},
	};
}
