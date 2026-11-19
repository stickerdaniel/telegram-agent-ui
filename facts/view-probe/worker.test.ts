import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import worker, { type Env, type Kv } from './worker.ts';

const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
const publicHex = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex');
const now = () => Math.floor(Date.now() / 1000);
async function launch(opts: { authDate?: number; userId?: number } = {}): Promise<string> {
	const authDate = opts.authDate ?? now();
	const user = `{"id":${opts.userId ?? 111},"first_name":"x","allows_write_to_pm":true,"photo_url":"https:\\/\\/t.me\\/i\\/userpic\\/320\\/x.svg"}`;
	const check = `222:WebAppData\nauth_date=${authDate}\nchat_instance=-479031\nchat_type=private\nuser=${user}`;
	const signature = Buffer.from(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(check))).toString('base64url');
	return `tma user=${encodeURIComponent(user)}&chat_instance=-479031&chat_type=private&auth_date=${authDate}&signature=${signature}&hash=0c4f8e1d`;
}

function fakeKv(): Kv {
	const map = new Map<string, string>();
	return {
		get: async (key) => map.get(key) ?? null,
		put: async (key, value) => void map.set(key, value),
		list: async ({ prefix }) => ({ keys: [...map.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
	};
}

const ORIGIN = 'https://probe.example.workers.dev';
const ID = 'Zr8kQ2vT0mN4xW6yB1cD3e';
const env: Env = { VIEWS: fakeKv(), BOT_ID: '222', ALLOWED_USER: '111', READ_KEY: 'read-key', PUBLIC_KEY: publicHex };
const call = (method: string, path: string, headers: Record<string, string> = {}, body?: string) => worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body }), env);
const put = (headers: Record<string, string>) => call('PUT', `/api/view/${ID}`, headers, JSON.stringify({ markdown: '# m', page: '<p>p</p>' }));

test('the shell carries the CSP with the sha256 of its inline script', async () => {
	const response = await call('GET', `/?v=${ID}`);
	const scripts = [...(await response.text()).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1] ?? '');
	expect(scripts).toHaveLength(1);
	const hash = createHash('sha256').update(scripts[0] ?? '').digest('base64');
	expect(response.headers.get('Content-Security-Policy')).toBe(
		`default-src 'none'; script-src 'sha256-${hash}' https://telegram.org; style-src 'unsafe-inline'; img-src data: ${ORIGIN}; media-src ${ORIGIN}; font-src data:; connect-src 'self'; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'`,
	);
	expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
	expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
	expect(response.headers.get('Cache-Control')).toBe('no-store');
});

test('PUT is refused without the bearer', async () => {
	expect((await put({})).status).toBe(401);
	expect((await put({ Authorization: 'Bearer wrong' })).status).toBe(401);
});

test('the view answers 200 to valid launch data of the allowed user', async () => {
	expect((await call('GET', `/api/view?v=${ID}`, { Authorization: await launch() })).status).toBe(404);
	expect((await put({ Authorization: 'Bearer read-key' })).status).toBe(200);
	const response = await call('GET', `/api/view?v=${ID}`, { Authorization: await launch({ authDate: now() - 5 }) });
	expect(response.status).toBe(200);
	const body: unknown = await response.json();
	expect(body).toMatchObject({ markdown: '# m', page: '<p>p</p>', verified: true, hasSignature: true });
	expect(body).toHaveProperty('authAgeSeconds');
	const age = typeof body === 'object' && body !== null && 'authAgeSeconds' in body ? body.authAgeSeconds : undefined;
	expect(age).toBeGreaterThanOrEqual(5);
});

test.each([
	['without a header', async () => ({}), 'missing authorization'],
	['for another user', async () => ({ Authorization: await launch({ userId: 42 }) }), 'user is not the allowed user'],
	['for data older than 600 s', async () => ({ Authorization: await launch({ authDate: now() - 601 }) }), 'auth_date is'],
])('the view answers 401 %s', async (_, headers, reason) => {
	const response = await call('GET', `/api/view?v=${ID}`, await headers());
	expect(response.status).toBe(401);
	expect(await response.text()).toContain(reason);
});

test('a report from the shell reads back through the bearer route', async () => {
	const stored = await call('POST', `/api/report?v=${ID}`, { Authorization: await launch(), 'Content-Type': 'application/json' }, JSON.stringify({ trigger: 'timer', frameLoaded: true }));
	expect(stored.status).toBe(200);
	expect((await call('GET', `/api/reports?v=${ID}`)).status).toBe(401);
	const reports: unknown = await (await call('GET', `/api/reports?v=${ID}`, { Authorization: 'Bearer read-key' })).json();
	expect(reports).toEqual([{ key: expect.stringMatching(new RegExp(`^report:${ID}:\\d+$`)), value: { trigger: 'timer', frameLoaded: true } }]);
});
