export const MEDIA_URL_LIFE = 2 * 60 * 60 * 1000;

export const MEDIA_WAIT = { window: 10_000, pause: 250 };

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

export async function mediaPath(secret: string, media: { id: string; generation: string; index: number; expires: number }): Promise<string> {
	const { id, generation, index, expires } = media;
	const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), signed(id, generation, index, expires)));
	return `/m/${id}/${generation}/${index}?e=${expires}&s=${toBase64url(signature)}`;
}

export async function mediaSigned(secret: string, media: { id: string; generation: string; index: number; expires: number }, s: string): Promise<boolean> {
	const signature = fromBase64url(s);
	if (!signature) return false;
	return crypto.subtle.verify('HMAC', await hmacKey(secret), signature, signed(media.id, media.generation, media.index, media.expires));
}

export type Ranged = { kind: 'full' } | { kind: 'part'; start: number; end: number } | { kind: 'unsatisfiable' };

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
