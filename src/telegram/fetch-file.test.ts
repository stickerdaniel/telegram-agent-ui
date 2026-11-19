import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { type FileHandle, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from '../core/types.ts';
import { fileStore } from '../store/file.ts';
import { type FakeBotApi, fakeBotApi, TOKEN } from './fake-server.ts';
import { fetchCall, fileDownload } from './fetch.ts';
import { FETCH_LIMITS, type FileSource, fetchFile } from './fetch-file.ts';
import { isUpdate } from './listen.ts';
import { recordFiles, sha256 } from './inbound.ts';

const SPAWNING = 120_000;
const CHILD = join(import.meta.dir, 'fetch-child.ts');

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const BYTES = new TextEncoder().encode('%PDF-1.7 a report of 48 bytes, more or less....');

function setup() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'tau-fetch-')));
	const server = fakeBotApi();
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	cleanups.push(() => server.stop());
	const storeDir = join(root, 'store');
	const store = fileStore(storeDir);
	const cache = join(storeDir, 'media');
	const call = fetchCall({ token: TOKEN, apiUrl: server.url });
	const cloud: FileSource = { download: fileDownload({ token: TOKEN, apiUrl: server.url }) };
	const fetch = (id: string, options: { allow?: number[]; from?: FileSource; store?: Store } = {}) =>
		fetchFile({ id, store: options.store ?? store, call, cache, chat: 111, allow: options.allow ?? [111], from: options.from ?? cloud });
	return { root, server, storeDir, store, cache, fetch };
}

async function sent(store: Store, id: string, options: { unique?: string; name?: string; chat?: number; sender?: number; message?: number } = {}) {
	const update: unknown = {
		update_id: 1,
		message: {
			message_id: options.message ?? 700,
			from: { id: options.sender ?? 111, is_bot: false, first_name: 'Dana' },
			chat: { id: options.chat ?? 111, type: 'private' },
			date: 1,
			document: { file_id: id, file_unique_id: options.unique ?? `u-${id}`, file_name: options.name ?? 'report.pdf', file_size: BYTES.length },
		},
	};
	if (!isUpdate(update)) throw new Error('no update');
	await recordFiles(store, update);
}

const reads = (server: FakeBotApi) => server.received.filter((call) => call.method === 'getFile' || call.method === 'download');

test('fetch makes no Bot API call for an unknown id, another chat or a sender removed from allow, cached or not', async () => {
	const { server, store, fetch } = setup();
	expect(await fetch('nosuch')).toMatchObject({ kind: 'refused', code: 'forbidden' });
	await sent(store, 'elsewhere', { chat: 222 });
	server.file('elsewhere', { unique: 'u-elsewhere', path: 'documents/file_1.pdf', bytes: BYTES });
	expect(await fetch('elsewhere')).toMatchObject({ kind: 'refused', code: 'forbidden' });
	await sent(store, 'theirs', { sender: 333 });
	server.file('theirs', { unique: 'u-theirs', path: 'documents/file_2.pdf', bytes: BYTES });
	expect(await fetch('theirs', { allow: [111, 333] })).toMatchObject({ kind: 'ok', cached: false });
	const before = reads(server).length;
	expect(await fetch('theirs')).toMatchObject({ kind: 'refused', code: 'forbidden' });
	expect(reads(server)).toHaveLength(before);
	expect(reads(server).filter((call) => call.payload.file_id === 'nosuch' || call.payload.file_id === 'elsewhere')).toEqual([]);
});

test('a file id whose one sender left allow is fetched while another occurrence has a sender in allow', async () => {
	const { server, store, fetch } = setup();
	await sent(store, 'shared', { sender: 333, message: 700 });
	await sent(store, 'shared', { sender: 111, message: 701 });
	server.file('shared', { unique: 'u-shared', path: 'documents/file_3.pdf', bytes: BYTES });
	const fetched = await fetch('shared');
	expect(fetched).toMatchObject({ kind: 'ok', id: 'shared', bytes: BYTES.length, cached: false });
	if (fetched.kind !== 'ok') throw new Error('not fetched');
	expect(readFileSync(fetched.path)).toEqual(Buffer.from(BYTES));
	expect(statSync(fetched.path).mode & 0o777).toBe(0o600);
	expect(statSync(join(fetched.path, '..')).mode & 0o777).toBe(0o700);
});

test('the copy is reused after a restart and under a new name, without another getFile', async () => {
	const { server, store, storeDir, cache, fetch } = setup();
	await sent(store, 'first', { unique: 'u-same', name: 'report.pdf' });
	server.file('first', { unique: 'u-same', path: 'documents/file_4.pdf', bytes: BYTES });
	const first = await fetch('first');
	expect(first).toMatchObject({ kind: 'ok', cached: false, path: join(cache, await sha256('u-same'), 'report.pdf') });
	const restarted = fileStore(storeDir);
	await sent(restarted, 'second', { unique: 'u-same', name: 'renamed.pdf', message: 702 });
	expect(await fetch('second', { store: restarted })).toEqual({ kind: 'ok', id: 'second', path: join(cache, await sha256('u-same'), 'report.pdf'), bytes: BYTES.length, cached: true });
	expect(reads(server).map((call) => call.method)).toEqual(['getFile', 'download']);
});

test('a cut-off download leaves no object and runs again on the next fetch', async () => {
	const { server, store, cache, fetch } = setup();
	await sent(store, 'cut');
	server.file('cut', { unique: 'u-cut', path: 'documents/file_5.pdf', bytes: BYTES, end: 'cut' });
	expect(await fetch('cut')).toMatchObject({ kind: 'refused', code: 'server', reason: expect.stringContaining('cut off') });
	expect(readdirSync(cache)).toEqual([]);
	server.file('cut', { unique: 'u-cut', path: 'documents/file_5.pdf', bytes: BYTES });
	expect(await fetch('cut')).toMatchObject({ kind: 'ok', bytes: BYTES.length, cached: false });
	expect(server.calls('download')).toHaveLength(2);
});

test('a redirect is not followed, and an absolute path from the cloud is refused before any download', async () => {
	const { server, store, cache, fetch } = setup();
	await sent(store, 'moved');
	server.file('moved', { unique: 'u-moved', path: 'documents/file_6.pdf', bytes: BYTES, end: 'redirect' });
	expect(await fetch('moved')).toMatchObject({ kind: 'refused', code: 'server', reason: expect.stringContaining('redirect') });
	expect(server.calls('download').map((call) => call.payload.path)).toEqual(['documents/file_6.pdf']);
	await sent(store, 'absolute');
	server.file('absolute', { unique: 'u-absolute', path: '/var/lib/telegram-bot-api/documents/file_7.pdf', bytes: BYTES });
	expect(await fetch('absolute')).toMatchObject({ kind: 'refused', code: 'shape' });
	expect(server.calls('download')).toHaveLength(1);
	expect(readdirSync(cache)).toEqual([]);
	expect(JSON.stringify(await fetch('moved'))).not.toContain(TOKEN.slice(TOKEN.indexOf(':') + 1));
});

test('a file past the cap is refused, and the cache keeps nothing of it', async () => {
	const { server, store, cache, fetch } = setup();
	const bytes = FETCH_LIMITS.cloud.bytes;
	FETCH_LIMITS.cloud.bytes = 10;
	try {
		await sent(store, 'big');
		server.file('big', { unique: 'u-big', path: 'documents/file_8.pdf', bytes: BYTES });
		expect(await fetch('big')).toMatchObject({ kind: 'refused', code: 'too-large' });
		expect(readdirSync(cache)).toEqual([]);
		await sent(store, 'understated');
		server.file('understated', { unique: 'u-understated', path: 'documents/file_14.pdf', bytes: BYTES, size: 5, end: 'unsized' });
		const probe = await globalThis.fetch(`${server.url}/file/bot${TOKEN}/documents/file_14.pdf`);
		expect(probe.headers.get('content-length')).toBeNull();
		expect((await probe.arrayBuffer()).byteLength).toBe(BYTES.length);
		expect(await fetch('understated')).toEqual({ kind: 'refused', code: 'too-large', reason: 'the file has more than 10 bytes' });
		expect(server.calls('download')).toHaveLength(2);
		expect(readdirSync(cache)).toEqual([]);
	} finally {
		FETCH_LIMITS.cloud.bytes = bytes;
	}
});

async function shortWrites(dir: string, most: number, started: () => void = () => {}): Promise<() => void> {
	type Write = (this: FileHandle, buffer: Uint8Array, offset?: number, length?: number) => Promise<{ bytesWritten: number }>;
	const probe = await open(join(dir, 'probe'), 'w');
	const prototype: { write: Write } = Object.getPrototypeOf(probe);
	await probe.close();
	const original = prototype.write;
	prototype.write = function (buffer, offset, length) {
		started();
		return original.call(this, buffer, offset, length === undefined ? length : Math.min(length, most));
	};
	return () => {
		prototype.write = original;
	};
}

test('a write that takes part of a chunk is continued until the whole file is in the cache', async () => {
	const { root, server, store, fetch } = setup();
	await sent(store, 'short');
	server.file('short', { unique: 'u-short', path: 'documents/file_15.pdf', bytes: BYTES });
	const restore = await shortWrites(root, 2);
	cleanups.push(restore);
	const first = await fetch('short');
	restore();
	expect(first).toMatchObject({ kind: 'ok', bytes: BYTES.length, cached: false });
	if (first.kind !== 'ok') throw new Error('not fetched');
	expect(readFileSync(first.path)).toEqual(Buffer.from(BYTES));
	expect(await fetch('short')).toEqual({ ...first, cached: true });
});

test('no write of a transfer starts past its deadline, and an expired transfer leaves no cache entry', async () => {
	const { root, server, store, cache, fetch } = setup();
	const local = join(root, 'bot-api');
	mkdirSync(local);
	writeFileSync(join(local, 'slow.pdf'), BYTES.slice(0, 6));
	await sent(store, 'slow');
	server.file('slow', { unique: 'u-slow', path: join(local, 'slow.pdf'), bytes: BYTES.slice(0, 6) });
	const ms = FETCH_LIMITS.local.ms;
	FETCH_LIMITS.local.ms = 200;
	const clock = { now: 0 };
	const starts: number[] = [];
	const restore = await shortWrites(root, 2, () => {
		starts.push(clock.now);
		clock.now += 120;
	});
	cleanups.push(restore);
	try {
		const late = await fetchFile({ id: 'slow', store, call: fetchCall({ token: TOKEN, apiUrl: server.url }), cache, chat: 111, allow: [111], from: { localFiles: local }, now: () => clock.now });
		restore();
		expect(late).toMatchObject({ kind: 'refused', code: 'server', reason: 'the transfer passed its deadline' });
		expect(starts).toEqual([0, 120]);
		expect(readdirSync(cache)).toEqual([]);
	} finally {
		restore();
		FETCH_LIMITS.local.ms = ms;
	}
	expect(await fetch('slow', { from: { localFiles: local } })).toMatchObject({ kind: 'ok', bytes: 6 });
});

test('a write that takes nothing fails the transfer, and the cache keeps nothing of it', async () => {
	const { root, server, store, cache, fetch } = setup();
	await sent(store, 'stuck');
	server.file('stuck', { unique: 'u-stuck', path: 'documents/file_16.pdf', bytes: BYTES });
	const restore = await shortWrites(root, 0);
	cleanups.push(restore);
	const stuck = await fetch('stuck');
	restore();
	expect(stuck).toMatchObject({ kind: 'refused', code: 'server', reason: 'the cache took no bytes of the transfer' });
	expect(readdirSync(cache)).toEqual([]);
});

test('a hostile name and a planted link stay inside the cache', async () => {
	const { root, server, store, cache, fetch } = setup();
	await sent(store, 'hostile', { name: '../../.ssh/authorized_keys\n' });
	server.file('hostile', { unique: 'u-hostile', path: 'documents/file_9.pdf', bytes: BYTES });
	const hostile = await fetch('hostile');
	expect(hostile).toMatchObject({ kind: 'ok', path: join(cache, await sha256('u-hostile'), 'sshauthorized_keys') });
	expect(existsSync(join(root, '.ssh'))).toBe(false);

	const outside = join(root, 'outside');
	mkdirSync(outside);
	writeFileSync(join(outside, 'report.pdf'), 'OUTSIDE');
	await sent(store, 'linked', { name: 'report.pdf' });
	server.file('linked', { unique: 'u-linked', path: 'documents/file_10.pdf', bytes: BYTES });
	symlinkSync(outside, join(cache, await sha256('u-linked')));
	const linked = await fetch('linked');
	expect(linked).toMatchObject({ kind: 'ok', path: join(cache, await sha256('u-linked'), 'report.pdf'), cached: false });
	expect(readdirSync(outside)).toEqual(['report.pdf']);
	expect(readFileSync(join(outside, 'report.pdf'), 'utf8')).toBe('OUTSIDE');
	if (linked.kind === 'ok') expect(readFileSync(linked.path)).toEqual(Buffer.from(BYTES));
});

test("a local server's file is copied only from localFiles, also under a secret name, and its copy stays", async () => {
	const { root, server, store, fetch } = setup();
	const local = join(root, 'bot-api');
	mkdirSync(join(local, 'documents'), { recursive: true });
	writeFileSync(join(local, 'documents', '.env'), BYTES);
	writeFileSync(join(root, 'secret.txt'), 'OUTSIDE');
	symlinkSync(join(root, 'secret.txt'), join(local, 'documents', 'escape.pdf'));
	const from: FileSource = { localFiles: local };
	await sent(store, 'local', { name: '.env' });
	server.file('local', { unique: 'u-local', path: join(local, 'documents', '.env'), bytes: BYTES });
	const copied = await fetch('local', { from });
	expect(copied).toMatchObject({ kind: 'ok', bytes: BYTES.length, cached: false });
	if (copied.kind === 'ok') expect(readFileSync(copied.path)).toEqual(Buffer.from(BYTES));
	expect(existsSync(join(local, 'documents', '.env'))).toBe(true);
	await sent(store, 'escape');
	server.file('escape', { unique: 'u-escape', path: join(local, 'documents', 'escape.pdf'), bytes: BYTES });
	expect(await fetch('escape', { from })).toMatchObject({ kind: 'refused', code: 'outside-roots' });
	await sent(store, 'relative');
	server.file('relative', { unique: 'u-relative', path: 'documents/file_11.pdf', bytes: BYTES });
	expect(await fetch('relative', { from })).toMatchObject({ kind: 'refused', code: 'shape' });
	expect(server.calls('download')).toEqual([]);
});

async function child(at: ReturnType<typeof setup>, id: string) {
	const process = Bun.spawn([globalThis.process.execPath, CHILD, at.storeDir, at.cache, at.server.url, id], { stdout: 'pipe', stderr: 'inherit' });
	cleanups.push(() => process.kill('SIGKILL'));
	const reader = process.stdout.pipeThrough(new TextDecoderStream()).getReader();
	let out = '';
	while (!out.includes('started\n')) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`the child ended before it started: ${out}`);
		out += value;
	}
	return {
		process,
		async result(): Promise<unknown> {
			for (;;) {
				const line = out.split('\n').find((candidate) => candidate.startsWith('{'));
				if (line) return JSON.parse(line);
				const { value, done } = await reader.read();
				if (done) throw new Error(`the child ended without a result: ${out}`);
				out += value;
			}
		},
	};
}

async function until(check: () => boolean, what: string, ms = 60_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(20);
	}
}

test(
	'two processes that fetch one file make one download and return the same object, also when the transfer takes longer than 10 s',
	async () => {
		const at = setup();
		await sent(at.store, 'slow');
		at.server.file('slow', { unique: 'u-slow', path: 'documents/file_12.pdf', bytes: BYTES });
		const release = at.server.stall('download');
		cleanups.push(release);
		const first = await child(at, 'slow');
		await until(() => at.server.calls('download').length === 1, 'the first download');
		const second = await child(at, 'slow');
		await Bun.sleep(11_000);
		release();
		const [one, two] = await Promise.all([first.result(), second.result()]);
		expect(one).toMatchObject({ kind: 'ok', cached: false });
		expect(two).toMatchObject({ kind: 'ok', cached: true });
		expect(JSON.stringify([one, two].map((result) => (result instanceof Object && 'path' in result ? result.path : undefined)))).toBe(JSON.stringify([join(at.cache, await sha256('u-slow'), 'report.pdf'), join(at.cache, await sha256('u-slow'), 'report.pdf')]));
		expect(reads(at.server).map((call) => call.method)).toEqual(['getFile', 'download']);
	},
	SPAWNING,
);

test(
	'a fetch takes over from a killed first downloader and leaves none of its transfer',
	async () => {
		const at = setup();
		await sent(at.store, 'taken');
		at.server.file('taken', { unique: 'u-taken', path: 'documents/file_13.pdf', bytes: BYTES });
		const release = at.server.stall('download');
		const first = await child(at, 'taken');
		await until(() => at.server.calls('download').length === 1, 'the first download');
		first.process.kill('SIGKILL');
		await first.process.exited;
		release();
		const second = await child(at, 'taken');
		expect(await second.result()).toMatchObject({ kind: 'ok', cached: false, path: join(at.cache, await sha256('u-taken'), 'report.pdf') });
		expect(at.server.calls('download')).toHaveLength(2);
		expect(readdirSync(at.cache)).toEqual([await sha256('u-taken')]);
	},
	SPAWNING,
);
