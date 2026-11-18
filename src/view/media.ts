// Media URLs and `Range`. A media URL is a bearer URL: `/m/<view id>/<generation>/<index>?e=&s=`,
// where `e` is its expiry in Unix ms and `s` the HMAC-SHA-256 of view id, generation, index and
// expiry under the media key, as base64url. It lives 2 hours and never past its view. A new
// media key ends every URL signed with the old one.

/** How long a media URL lives. */
export const MEDIA_URL_LIFE = 2 * 60 * 60 * 1000;

/**
 * How long the host asks its storage again for a media object of a committed view that it does
 * not see yet, and the pause between two asks, in ms. The tests of this package shorten it.
 */
export const MEDIA_WAIT = { window: 10_000, pause: 250 };

/**
 * The image that stands in for a media object that did not show: the host answers it in place
 * of the object, and the shell shows it as a `data:` URL where it knows the object is missing.
 */
export const PLACEHOLDER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="100%" height="100%" fill="#8888"/></svg>';

const keyCache = new Map<string, Promise<CryptoKey>>();
function hmacKey(secret: string): Promise<CryptoKey> {
	let key = keyCache.get(secret);
	if (!key) {
		key = crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
		keyCache.set(secret, key);
	}
	return key;
}

const signed = (id: string, generation: string, index: number, expires: number) => new TextEncoder().encode(`${id}:${generation}:${index}:${expires}`);

const toBase64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

function fromBase64url(text: string): Uint8Array<ArrayBuffer> | undefined {
	if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return undefined;
	return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0));
}

/** The path and query of a signed media URL. */
export async function mediaPath(secret: string, media: { id: string; generation: string; index: number; expires: number }): Promise<string> {
	const { id, generation, index, expires } = media;
	const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), signed(id, generation, index, expires)));
	return `/m/${id}/${generation}/${index}?e=${expires}&s=${toBase64url(signature)}`;
}

/** True when `s` signs this media and expiry under `secret`. WebCrypto compares in constant time. */
export async function mediaSigned(secret: string, media: { id: string; generation: string; index: number; expires: number }, s: string): Promise<boolean> {
	const signature = fromBase64url(s);
	if (!signature) return false;
	return crypto.subtle.verify('HMAC', await hmacKey(secret), signature, signed(media.id, media.generation, media.index, media.expires));
}

/** What a `Range` header asks of an object of `size` bytes: all of it, one part, or nothing it can serve. */
export type Ranged = { kind: 'full' } | { kind: 'part'; start: number; end: number } | { kind: 'unsatisfiable' };

/**
 * One `bytes=` range of RFC 9110 against `size`: `a-b`, `a-` or the suffix `-n`. A header that
 * is absent, malformed, names several ranges or has a first position past its last is ignored,
 * as the RFC allows, and the whole object is served. A range that starts at or past the end is
 * unsatisfiable.
 */
export function parseRange(header: string | null, size: number): Ranged {
	const match = header === null ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match) return { kind: 'full' };
	const [, first = '', last = ''] = match;
	if (first === '' && last === '') return { kind: 'full' };
	if (first === '') {
		const suffix = Number(last);
		if (suffix === 0) return { kind: 'unsatisfiable' };
		return { kind: 'part', start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number(first);
	if (last !== '' && Number(last) < start) return { kind: 'full' };
	if (start >= size) return { kind: 'unsatisfiable' };
	return { kind: 'part', start, end: last === '' ? size - 1 : Math.min(Number(last), size - 1) };
}
