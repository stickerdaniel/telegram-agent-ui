// Test doubles of the view host: a storage in memory that can hide chosen reads, launch data
// signed with a generated Ed25519 key in place of Telegram's, raw HTTP requests, and media bytes
// with real leading bytes. The launch data follows the precedents: the query in Telegram's field
// order with percent-encoded values, the data-check string sorted by key with decoded values,
// and `user` with Telegram's escaped slashes, which the check string keeps.
import type { ViewStorage } from './handler.ts';

export const ORIGIN = 'https://views.example.com';
export const BOT = '222';
export const USER = 111;
export const UPLOAD_KEY = 'upload-key-0123456789abcdef';
export const MEDIA_KEY = 'media-key-0123456789abcdef';
export const ID = 'Zr8kQ2vT0mN4xW6yB1cD3e';

type Entry = { value: Uint8Array; type?: string; expiresAt: number };

/**
 * A storage in memory. It keeps every value past its expiry, so a test sees the handler's own
 * expiry checks. A read that `hidden(key, read)` names returns undefined, where `read` counts the
 * reads of that key from 1, as a storage that shows a key late, or misses it once, does. Each
 * read takes `latency` ms. `writes` lists every put and delete.
 */
export function memoryStorage(options: { hidden?: (key: string, read: number) => boolean; latency?: number } = {}) {
	const entries = new Map<string, Entry>();
	const reads = new Map<string, number>();
	const writes: string[] = [];
	const storage: ViewStorage = {
		async get(key) {
			const count = (reads.get(key) ?? 0) + 1;
			reads.set(key, count);
			if (options.latency) await new Promise((resolve) => setTimeout(resolve, options.latency));
			if (options.hidden?.(key, count)) return undefined;
			const entry = entries.get(key);
			return entry && { value: entry.value.slice(), ...(entry.type !== undefined ? { type: entry.type } : {}) };
		},
		async put(key, value, { expiresAt, type }) {
			writes.push(`put ${key}`);
			entries.set(key, { value: value.slice(), expiresAt, ...(type !== undefined ? { type } : {}) });
		},
		async delete(key) {
			writes.push(`delete ${key}`);
			entries.delete(key);
		},
	};
	const snapshot = () => JSON.stringify([...entries].map(([key, entry]) => [key, [...entry.value], entry.type, entry.expiresAt]));
	return { storage, entries, reads, writes, snapshot };
}

const bytes64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString('base64url');

/** A generated Ed25519 key, as `publicKey` hex, and launch data it signs. */
export async function launchKey() {
	const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
	if (!('privateKey' in pair)) throw new Error('Ed25519 makes a key pair');
	const hex = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex');
	/** `initData` of `userId`, opened at `authDate` (Unix seconds, now by default), signed for `botId`. */
	const launch = async (opts: { authDate?: number; userId?: number; botId?: string } = {}) => {
		const authDate = opts.authDate ?? Math.floor(Date.now() / 1000);
		const user = `{"id":${opts.userId ?? USER},"first_name":"Dana","last_name":"S","language_code":"de","allows_write_to_pm":true,"photo_url":"https:\\/\\/t.me\\/i\\/userpic\\/320\\/d.svg"}`;
		const check = `${opts.botId ?? BOT}:WebAppData\nauth_date=${authDate}\nchat_instance=-4790311827741290843\nchat_type=private\nuser=${user}`;
		const signature = bytes64(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(check)));
		return `user=${encodeURIComponent(user)}&chat_instance=-4790311827741290843&chat_type=private&auth_date=${authDate}&signature=${signature}&hash=0c4f8e1d`;
	};
	return { hex, launch };
}

/**
 * A Request from raw HTTP/1.1 text: the request line, one header per line, then a blank line and
 * the body. Leading white space of the head lines is dropped, so a fixture may be indented. The
 * URL takes its host from `Host`; `body` replaces a text body, for bytes.
 *
 *   raw(`GET /api/version HTTP/1.1
 *        Host: views.example.com`);
 */
export function raw(text: string, body?: Uint8Array | ReadableStream<Uint8Array>): Request {
	const split = text.search(/\n[ \t]*\n/);
	const head = (split === -1 ? text : text.slice(0, split)).trim().split('\n').map((line) => line.trim());
	const textBody = split === -1 ? '' : text.slice(text.indexOf('\n', split + 1) + 1);
	const [method = 'GET', target = '/'] = (head[0] ?? '').split(' ');
	const headers = new Headers();
	for (const line of head.slice(1)) {
		const colon = line.indexOf(':');
		headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
	}
	const sent = body ?? (textBody === '' ? undefined : textBody);
	return new Request(`https://${headers.get('Host')}${target}`, { method, headers, ...(sent !== undefined ? { body: sent, duplex: 'half' } : {}) });
}

/** The smallest bytes that pass as each media type: its leading bytes and padding. */
export const MEDIA = {
	png: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 24 }, (_, index) => index)]),
	jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 28 }, (_, index) => index)]),
	mp4: Uint8Array.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, ...Array.from({ length: 20 }, (_, index) => index)]),
};
