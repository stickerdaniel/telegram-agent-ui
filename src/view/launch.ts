// Telegram Mini App launch data (`initData`), checked as a third party: by the Ed25519 signature
// Telegram puts in its `signature` field, without the bot token.
// https://core.telegram.org/bots/webapps#validating-data-for-third-party-use
// It uses WebCrypto alone, so it runs on any runtime with the Fetch API.
import { isInt, isRecord, isString } from '../core/check.ts';
import type { User } from '../core/types.ts';

/** Telegram's production Ed25519 public key for third-party validation, as hex. */
export const TELEGRAM_PUBLIC_KEY = 'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d';

/** How old `auth_date` may be, and how far ahead of the clock, in seconds. */
export const LAUNCH_AGE = { max: 600, ahead: 60 } as const;

export type LaunchVerdict = { ok: true; user: User } | { ok: false; reason: string };

/** True for an Ed25519 public key written as 64 hex digits. */
export const isPublicKey = (hex: string) => /^[0-9a-f]{64}$/i.test(hex);

// One import per key: a handler checks every request with the same one.
const imported = new Map<string, Promise<CryptoKey>>();
function importKey(hex: string): Promise<CryptoKey> {
	let key = imported.get(hex);
	if (!key) {
		const bytes = new Uint8Array(32);
		for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
		key = crypto.subtle.importKey('raw', bytes, { name: 'Ed25519' }, false, ['verify']);
		imported.set(hex, key);
	}
	return key;
}

/** Base64url without padding to bytes; undefined for any other text. */
function base64url(text: string): Uint8Array<ArrayBuffer> | undefined {
	if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
	const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** The user of the `user` field, with first and last name as `name`, or undefined for anything but an object with an integer id. */
function userOf(text: string | undefined): User | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text ?? '');
	} catch {
		return undefined;
	}
	if (!isRecord(value) || !isInt(value.id)) return undefined;
	const name = [value.first_name, value.last_name].filter(isString).join(' ').trim();
	return { id: value.id, ...(name !== '' ? { name } : {}) };
}

/**
 * Checks `initData` as Telegram's client sent it: every field once, an Ed25519 signature of bot
 * `botId` over `<botId>:WebAppData`, a newline, then every field except `hash` and `signature`
 * as `key=value` with its decoded value, sorted by key, one per line; `auth_date` at most 600 s
 * before `now` and at most 60 s after it; `user.id` among `allowedUsers`. `now` is Unix time in
 * ms, and `publicKey` 64 hex digits, Telegram's production key by default. Never throws:
 * anything malformed fails with its reason.
 *
 *   const verdict = await verifyLaunchData(initData, { botId: '222', allowedUsers: [111], now: Date.now() });
 *   if (verdict.ok) console.log(verdict.user.id);
 */
export async function verifyLaunchData(initData: string, options: { botId: string; publicKey?: string; allowedUsers: number[]; now: number }): Promise<LaunchVerdict> {
	const fail = (reason: string): LaunchVerdict => ({ ok: false, reason });
	const hex = options.publicKey ?? TELEGRAM_PUBLIC_KEY;
	if (!isPublicKey(hex)) return fail('the public key is not 64 hex digits');
	const fields = new Map<string, string>();
	for (const [key, value] of new URLSearchParams(initData)) {
		if (fields.has(key)) return fail(`duplicate field ${key}`);
		fields.set(key, value);
	}
	const encoded = fields.get('signature');
	if (encoded === undefined) return fail('missing signature');
	const signature = base64url(encoded);
	if (signature?.length !== 64) return fail('signature is not 64 bytes of base64url');
	const lines = [...fields]
		.filter(([key]) => key !== 'hash' && key !== 'signature')
		.sort(([a], [b]) => (a < b ? -1 : 1))
		.map(([key, value]) => `${key}=${value}`);
	const data = new TextEncoder().encode(`${options.botId}:WebAppData\n${lines.join('\n')}`);
	if (!(await crypto.subtle.verify({ name: 'Ed25519' }, await importKey(hex.toLowerCase()), signature, data))) return fail('bad signature');

	const authDate = fields.get('auth_date');
	if (authDate === undefined || !/^\d{1,12}$/.test(authDate)) return fail('auth_date is not a time in seconds');
	const age = Math.floor(options.now / 1000) - Number(authDate);
	if (age > LAUNCH_AGE.max) return fail(`auth_date is ${age} s old`);
	if (age < -LAUNCH_AGE.ahead) return fail(`auth_date is ${-age} s ahead`);

	const user = userOf(fields.get('user'));
	if (!user) return fail('user is not an object with an integer id');
	if (!options.allowedUsers.includes(user.id)) return fail('user is not an allowed user');
	return { ok: true, user };
}
