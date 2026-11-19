import { randomUUID } from 'node:crypto';
import { chmod, type FileHandle, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isNat, isRecord, isString } from '../core/check.ts';
import { classify } from '../core/classify.ts';
import type { Store } from '../core/types.ts';
import { openInRoots } from '../files/roots.ts';
import type { Download, Transport } from './fetch.ts';
import { authorizes, fileKey, parseFileRecord, sha256 } from './inbound.ts';

export type Fetched = { kind: 'ok'; id: string; path: string; bytes: number; cached: boolean };
export type FetchRefused = { kind: 'refused'; code: 'forbidden' | 'too-large' | 'server' | 'outside-roots' | 'shape' | 'token'; reason: string };

export const FETCH_LIMITS = { cloud: { bytes: 20_000_000, ms: 120_000 }, local: { bytes: 2_000_000_000, ms: 600_000 } };
const LOCK_SLACK = 30_000;
const STAGING = '.tmp-';
const STAGING_NAME = /^\.tmp-(\d+)-/;

const refused = (code: FetchRefused['code'], reason: string): FetchRefused => ({ kind: 'refused', code, reason });
const codeOf = (error: unknown) => (error instanceof Error && 'code' in error ? error.code : undefined);
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

class TransferFailed extends Error {
	constructor(readonly refusal: FetchRefused) {
		super(refusal.reason);
	}
}

export function cacheName(name: string | undefined): string {
	const reduced = (name ?? '').replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '').slice(0, 100);
	return reduced === '' ? 'file' : reduced;
}

async function completed(dir: string): Promise<{ path: string; bytes: number } | 'none' | 'broken'> {
	let found;
	try {
		found = await lstat(dir);
	} catch (error) {
		if (codeOf(error) === 'ENOENT') return 'none';
		throw error;
	}
	if (!found.isDirectory()) return 'broken';
	const names = await readdir(dir);
	const [name] = names;
	if (names.length !== 1 || name === undefined) return 'broken';
	const file = await lstat(join(dir, name));
	return file.isFile() ? { path: join(dir, name), bytes: file.size } : 'broken';
}

function pidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return codeOf(error) === 'EPERM';
	}
}

async function prepareCache(cache: string): Promise<FetchRefused | undefined> {
	await mkdir(cache, { recursive: true, mode: 0o700 });
	const found = await lstat(cache);
	if (!found.isDirectory()) return refused('shape', 'the cache of fetched files is no directory');
	await chmod(cache, 0o700);
	for (const name of await readdir(cache)) {
		const staging = STAGING_NAME.exec(name);
		if (staging && !pidExists(Number(staging[1]))) await rm(join(cache, name), { recursive: true, force: true });
	}
	return undefined;
}

async function writeCapped(path: string, chunks: AsyncIterable<Uint8Array>, cap: number, deadline: number, now: () => number): Promise<number> {
	const handle = await open(path, 'wx', 0o600);
	const inTime = () => {
		if (now() > deadline) throw new TransferFailed(refused('server', 'the transfer passed its deadline'));
	};
	let bytes = 0;
	try {
		for await (const chunk of chunks) {
			if (bytes + chunk.byteLength > cap) throw new TransferFailed(refused('too-large', `the file has more than ${cap} bytes`));
			for (let written = 0; written < chunk.byteLength; ) {
				inTime();
				const { bytesWritten } = await handle.write(chunk, written, chunk.byteLength - written);
				if (bytesWritten <= 0) throw new TransferFailed(refused('server', 'the cache took no bytes of the transfer'));
				written += bytesWritten;
			}
			bytes += chunk.byteLength;
		}
		await handle.sync();
		const { size } = await handle.stat();
		if (size !== bytes) throw new TransferFailed(refused('server', `the cache holds ${size} of the ${bytes} bytes received`));
		inTime();
	} finally {
		await handle.close();
	}
	return bytes;
}

async function* bodyOf(response: Response): AsyncIterable<Uint8Array> {
	if (!response.body) return;
	const reader = response.body.getReader();
	try {
		for (;;) {
			let read;
			try {
				read = await reader.read();
			} catch {
				throw new TransferFailed(refused('server', 'the transfer was cut off'));
			}
			if (read.done) return;
			yield read.value;
		}
	} finally {
		reader.releaseLock();
	}
}

async function* handleChunks(handle: FileHandle, size: number): AsyncIterable<Uint8Array> {
	let offset = 0;
	while (offset < size) {
		const buffer = new Uint8Array(Math.min(64 * 1024, size - offset));
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
		if (bytesRead === 0) return;
		offset += bytesRead;
		yield bytesRead === buffer.length ? buffer : buffer.slice(0, bytesRead);
	}
}

export type FileSource = { download: Download } | { localFiles: string };

async function transfer(filePath: string, from: FileSource, target: string, now: () => number): Promise<number> {
	const local = 'localFiles' in from;
	const limits = local ? FETCH_LIMITS.local : FETCH_LIMITS.cloud;
	const deadline = now() + limits.ms;
	if (!local) {
		if (filePath.startsWith('/')) throw new TransferFailed(refused('shape', 'getFile named an absolute path, and the Bot API is the cloud one: a local server needs localFiles'));
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), limits.ms);
		try {
			let response: Response;
			try {
				response = await from.download(filePath, controller.signal);
			} catch (error) {
				throw new TransferFailed(refused('server', describe(error)));
			}
			if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) throw new TransferFailed(refused('server', `the server answered the download with a redirect, HTTP ${response.status}, which is not followed`));
			if (!response.ok) throw new TransferFailed(refused('server', `the server answered the download with HTTP ${response.status}`));
			const length = Number(response.headers.get('content-length') ?? Number.NaN);
			if (Number.isSafeInteger(length) && length > limits.bytes) throw new TransferFailed(refused('too-large', `the file has ${length} bytes, more than ${limits.bytes}`));
			const bytes = await writeCapped(target, bodyOf(response), limits.bytes, deadline, now);
			if (Number.isSafeInteger(length) && bytes !== length) throw new TransferFailed(refused('server', `the transfer was cut off after ${bytes} of ${length} bytes`));
			return bytes;
		} finally {
			clearTimeout(timer);
		}
	}
	if (!filePath.startsWith('/')) throw new TransferFailed(refused('shape', 'getFile named a relative path, and localFiles expects the absolute paths of a local server'));
	const opened = await openInRoots(filePath, { roots: [from.localFiles], cwd: '/', home: homedir(), secrets: false });
	if (opened.kind === 'refused') throw new TransferFailed(refused(opened.code === 'outside-roots' ? 'outside-roots' : 'shape', opened.code === 'outside-roots' ? 'getFile named a file outside localFiles' : opened.reason));
	try {
		if (opened.size > limits.bytes) throw new TransferFailed(refused('too-large', `the file has ${opened.size} bytes, more than ${limits.bytes}`));
		const bytes = await writeCapped(target, handleChunks(opened.handle, opened.size), limits.bytes, deadline, now);
		if ((await opened.confirm()) !== undefined) throw new TransferFailed(refused('outside-roots', 'the file in localFiles changed while it was copied'));
		return bytes;
	} finally {
		await opened.handle.close();
	}
}

export async function fetchFile(options: { id: string; store: Store; call: Transport; cache: string; chat: number; allow: readonly number[]; from: FileSource; scrub?: (text: string) => string; now?: () => number }): Promise<Fetched | FetchRefused> {
	const { id, store, call, cache, chat, allow, from } = options;
	const now = options.now ?? Date.now;
	const scrub = options.scrub ?? ((text: string) => text);
	if (!isString(id) || id === '') return refused('shape', 'the file id is no non-empty string');
	const record = parseFileRecord(await store.get(await fileKey(id)));
	if (!record || record.id !== id || !authorizes(record, chat, allow)) return refused('forbidden', 'no message of a user in allow in this chat carried this file id');
	const dir = join(cache, await sha256(record.unique));
	const cached = (found: { path: string; bytes: number }): Fetched => ({ kind: 'ok', id, path: found.path, bytes: found.bytes, cached: true });
	const unprepared = await prepareCache(cache);
	if (unprepared) return unprepared;
	const early = await completed(dir);
	if (typeof early !== 'string') return cached(early);
	const limits = 'localFiles' in from ? FETCH_LIMITS.local : FETCH_LIMITS.cloud;
	return store.lock(
		`media:${record.unique}`,
		async (): Promise<Fetched | FetchRefused> => {
			const found = await completed(dir);
			if (typeof found !== 'string') return cached(found);
			if (found === 'broken') await rm(dir, { recursive: true, force: true });
			const answer = classify('getFile', await call({ method: 'getFile', payload: { file_id: id } }));
			if (answer.kind === 'refused') return refused(answer.code === 'token' ? 'token' : 'server', `getFile was refused: ${scrub(answer.reason)}`);
			if (answer.kind !== 'ok') return refused('server', answer.kind === 'retry' ? 'getFile asked to wait: fetch again later' : 'getFile got no answer: fetch again');
			const file = answer.result;
			if (!isRecord(file) || !isString(file.file_path) || file.file_path === '') return refused('server', 'getFile named no path: Telegram cannot serve this file');
			if (isNat(file.file_size) && file.file_size > limits.bytes) return refused('too-large', `the file has ${file.file_size} bytes, more than ${limits.bytes}`);
			const staging = join(cache, `${STAGING}${process.pid}-${randomUUID()}`);
			await mkdir(staging, { mode: 0o700 });
			try {
				const name = cacheName(record.occurrences.find((occurrence) => occurrence.name !== undefined)?.name);
				const bytes = await transfer(file.file_path, from, join(staging, name), now);
				try {
					await rename(staging, dir);
				} catch (error) {
					const other = await completed(dir);
					if (typeof other !== 'string') return cached(other);
					throw error;
				}
				return { kind: 'ok', id, path: join(dir, name), bytes, cached: false };
			} catch (error) {
				if (error instanceof TransferFailed) return { ...error.refusal, reason: scrub(error.refusal.reason) };
				throw error;
			} finally {
				await rm(staging, { recursive: true, force: true });
			}
		},
		{ wait: limits.ms + LOCK_SLACK },
	);
}
