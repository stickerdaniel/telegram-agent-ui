import { isInt, isRecord, isString } from '../core/check.ts';
import type { User } from '../core/types.ts';

export const TELEGRAM_PUBLIC_KEY = 'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d';

export const LAUNCH_AGE = { max: 600, ahead: 60 } as const;

export type LaunchVerdict = { ok: true; user: User } | { ok: false; reason: string };

export const isPublicKey = (hex: string) => /^[0-9a-f]{64}$/i.test(hex);

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

function base64url(text: string): Uint8Array<ArrayBuffer> | undefined {
	if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
	const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

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
