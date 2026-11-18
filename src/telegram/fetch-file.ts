// Files the human sent, see 5.2: `fetchFile` downloads one by Telegram's file id into a cache on
// this machine, for Node and Bun on macOS and Linux. It first checks the authorization record
// that the listener wrote for that exact file id, so a file id from anywhere else reads nothing.
//
// The cache holds one object per `file_unique_id`, a file in the directory
// `<cache>/<sha256 of file_unique_id>/`, directories of mode 0700 and files of mode 0600. A
// transfer streams into a staging directory of its own with a hard cap, and the staging
// directory is renamed into place: a rename onto an existing directory fails, so the first
// completed transfer fixes the object and its name, and no later one replaces it. A transfer
// that was cut off leaves no object, so the next fetch runs it again. Concurrent fetches of one
// file, also from two processes, coalesce on the store's fenced lock of `media:<file_unique_id>`.
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

/** A fetched file: the id it was asked for, the path of the cached object, its size, and whether the cache held it already. */
export type Fetched = { kind: 'ok'; id: string; path: string; bytes: number; cached: boolean };
/**
 * Why a fetch got no file. `forbidden`: no allowed message of the chat carried this file id, and
 * nothing was read. `too-large`: the file passes the cap. `server`: getFile or the transfer
 * failed, and a later fetch tries again. `outside-roots`: a local server named a path outside
 * its directory. `shape`: an id or path of the wrong form. `token`: the server refused the token.
 */
export type FetchRefused = { kind: 'refused'; code: 'forbidden' | 'too-large' | 'server' | 'outside-roots' | 'shape' | 'token'; reason: string };

/**
 * The caps of one transfer, in bytes and ms: the cloud Bot API serves files up to 20 MB, and a
 * local server's file is copied up to 2,000 MB. The tests of this package shorten the times.
 */
export const FETCH_LIMITS = { cloud: { bytes: 20_000_000, ms: 120_000 }, local: { bytes: 2_000_000_000, ms: 600_000 } };
/** How much longer than one transfer a second fetch of the same file waits for the lock. */
const LOCK_SLACK = 30_000;
const STAGING = '.tmp-';
const STAGING_NAME = /^\.tmp-(\d+)-/;

const refused = (code: FetchRefused['code'], reason: string): FetchRefused => ({ kind: 'refused', code, reason });
const codeOf = (error: unknown) => (error instanceof Error && 'code' in error ? error.code : undefined);
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** A failed transfer, with the refusal it ends in. */
class TransferFailed extends Error {
	constructor(readonly refusal: FetchRefused) {
		super(refusal.reason);
	}
}

/**
 * The name of the cached object: Telegram's name reduced to `[A-Za-z0-9._-]`, without leading
 * dots, at most 100 characters, else `file`. A name of the human's message never leaves the
 * object's directory.
 */
export function cacheName(name: string | undefined): string {
	const reduced = (name ?? '').replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '').slice(0, 100);
	return reduced === '' ? 'file' : reduced;
}

/**
 * The completed object in `dir`: one regular file and nothing else. `none` when `dir` does not
 * exist, `broken` for anything else, such as a link in place of the directory or its file.
 */
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

/** Whether process `pid` exists. */
function pidExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return codeOf(error) === 'EPERM';
	}
}

/** Creates the cache directory with mode 0700, or refuses one that is a link or no directory. */
async function prepareCache(cache: string): Promise<FetchRefused | undefined> {
	await mkdir(cache, { recursive: true, mode: 0o700 });
	const found = await lstat(cache);
	if (!found.isDirectory()) return refused('shape', 'the cache of fetched files is no directory');
	await chmod(cache, 0o700);
	// A staging directory of a process that is gone holds a transfer that never completed.
	for (const name of await readdir(cache)) {
		const staging = STAGING_NAME.exec(name);
		if (staging && !pidExists(Number(staging[1]))) await rm(join(cache, name), { recursive: true, force: true });
	}
	return undefined;
}

/**
 * Writes `chunks` to the new file `path`, mode 0600, and stops with `too-large` past `cap` bytes
 * or with `server` past `deadline` on the clock `now`. A write may take part of a chunk: the rest
 * is written again until the chunk is in, and a write that takes nothing fails. No write starts
 * past the deadline, and a file written by then counts only when its size equals the bytes
 * received and the deadline still holds.
 */
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

/** The chunks of a response body, failing with `server` when the connection ends early. */
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

/** The chunks of an opened file from byte 0 up to `size`. */
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

/** Where a file comes from: the cloud, through `download`, or a local server's directory. */
export type FileSource = { download: Download } | { localFiles: string };

/**
 * Copies the file of `filePath` into `target`: from the cloud by its relative path, or from a
 * local server by its absolute path below `localFiles` alone, opened once and checked on its
 * handle, without the secret-name rules of publishing. The deadline runs on the clock `now`.
 * Throws TransferFailed.
 */
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

/**
 * Fetches the file of Telegram's file id `id` into the cache `cache`. It looks up the file
 * record `fa:<sha256 of id>` first: unless one occurrence lies in `chat` and has a sender in
 * `allow` now, it refuses with `forbidden`, reads no cache and calls no Bot API. Then it returns
 * the cached object of the file's `file_unique_id` when one exists. Else, under the store's lock
 * of `media:<file_unique_id>`, taken with a wait of the transfer cap plus 30 s, it looks once
 * more, calls getFile and copies the file: on the cloud by `download` of its relative path, at
 * most 20,000,000 bytes and 120 s; with `localFiles` from the local server's directory, at most
 * 2,000,000,000 bytes and 600 s, leaving the server's copy. The object keeps the name of its
 * first completed fetch, and the result names that path. Errors carry no URL; `scrub` cleans a
 * server's description of the token. `now`, Date.now by default, is the clock of the transfer's
 * deadline.
 *
 *   const file = await fetchFile({ id, store, call, cache: join(dataDir, 'media'), chat: 111, allow: [111], from: { download: fileDownload({ token }) } });
 *   // { kind: 'ok', id, path: '<cache>/<hash>/report.pdf', bytes: 48213, cached: false }
 */
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
			// Nothing of this package leaves a directory half made: whatever lies there is no object of it.
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
					// Another transfer completed first: its object stays, and this one is dropped.
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
