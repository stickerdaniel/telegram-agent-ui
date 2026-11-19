import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, link, mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isInt, isRecord, isString } from '../core/check.ts';
import { LockTimeout, type Store } from '../core/types.ts';

export class LockLost extends Error {
	override name = 'LockLost';
}

export class IdentityUnknown extends Error {
	override name = 'IdentityUnknown';
}

type Owner = { pid: number; start: string; token: string; generation: number };
type Held = { dir: string; key: string; owner: Owner };

const LOCKS = '.locks';
const TEMP = '.tmp-';
const TEMP_NAME = /^\.tmp-(\d+)-/;

const codeOf = (error: unknown) => (error instanceof Error && 'code' in error ? error.code : undefined);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fileName(key: string): string {
	const name = encodeURIComponent(key);
	if (name === '' || name.startsWith('.') || name.length > 240) throw new Error(`the key "${key}" cannot name a file of the store`);
	return name;
}

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
function thisStart(): string {
	ownStart ??= startTime(process.pid);
	if (ownStart === undefined) throw new IdentityUnknown(`the start time of process ${process.pid} cannot be read with ps, so this process takes no lock`);
	return ownStart;
}

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

async function sweep(dir: string, generation: number): Promise<void> {
	for (const name of await readdir(dir)) {
		const old = /^(\d+)\.(json|released)$/.exec(name);
		const temp = TEMP_NAME.exec(name);
		const stale = old ? Number(old[1]) < generation : temp ? !pidExists(Number(temp[1])) : false;
		if (stale) await rm(join(dir, name), { force: true });
	}
}

async function fence(held: Held): Promise<void> {
	const { dir, owner } = held;
	const current = await readOwner(dir, owner.generation);
	if ((await top(dir)) !== owner.generation || (await exists(releasedPath(dir, owner.generation))) || current?.token !== owner.token || current.pid !== owner.pid) {
		throw new LockLost(`the lock of ${held.key} is no longer held by this task`);
	}
}

export function fileStore(dir: string, options: { lockWait?: number } = {}): Store {
	const lockWait = options.lockWait ?? 10_000;
	const holding = new AsyncLocalStorage<Held[]>();
	let ready: Promise<void> | undefined;

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

	async function acquire(key: string, lockWait: number): Promise<Held> {
		const start = thisStart();
		const lockDir = join(dir, LOCKS, fileName(key));
		await mkdir(lockDir, { recursive: true, mode: 0o700 });
		let seen: { generation: number; token: string | undefined; at: number } | undefined;
		for (let pause = 5; ; pause = Math.min(pause * 2, 100)) {
			const lookedAt = Date.now();
			const current = await top(lockDir);
			const holder = current > 0 ? await readOwner(lockDir, current) : undefined;
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
				throw new LockTimeout(holder ? `the lock of ${key} stayed held by pid ${holder.pid} for ${lockWait} ms` : `the lock of ${key} has an unreadable owner`);
			}
			await sleep(pause);
		}
	}

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
		async lock<T>(key: string, fn: () => Promise<T>, options: { wait?: number } = {}): Promise<T> {
			await prepare();
			const held = await acquire(key, options.wait ?? lockWait);
			try {
				return await holding.run([...(holding.getStore() ?? []), held], fn);
			} finally {
				await release(held);
			}
		},
	};
}
