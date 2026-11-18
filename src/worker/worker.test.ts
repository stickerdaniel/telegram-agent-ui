// The Cloudflare entry on a KV stand-in that answers as Workers KV does: values as ArrayBuffer
// with their metadata, and an expiration in seconds that KV refuses under 60 s ahead.
import { expect, test } from 'bun:test';
import { BOT, ID, launchKey, MEDIA, MEDIA_KEY, ORIGIN, UPLOAD_KEY, USER } from '../view/fixtures.ts';
import worker, { type Env } from './index.ts';

type Stored = { value: Uint8Array; expiration: number; metadata?: { type: string } };

/**
 * Workers KV over a Map. A put with an expiration under 60 s ahead throws, as KV answers 400. A
 * list answers pages of 2 keys in key order, with a cursor until the last.
 */
function fakeKv() {
	const map = new Map<string, Stored>();
	const kv: Env['VIEWS'] = {
		async list({ prefix, cursor }) {
			const names = [...map.keys()].filter((key) => key.startsWith(prefix)).sort();
			const start = cursor === undefined ? 0 : Number(cursor);
			const keys = names.slice(start, start + 2).map((name) => ({ name }));
			return start + 2 >= names.length ? { keys, list_complete: true } : { keys, list_complete: false, cursor: String(start + 2) };
		},
		async getWithMetadata(key) {
			const stored = map.get(key);
			if (!stored) return { value: null, metadata: null };
			return { value: stored.value.slice().buffer, metadata: stored.metadata ?? null };
		},
		async put(key, value, { expiration, metadata }) {
			if (expiration < Math.floor(Date.now() / 1000) + 60) throw new Error('KV PUT failed: 400 Invalid expiration');
			map.set(key, { value: value.slice(), expiration, ...(metadata ? { metadata } : {}) });
		},
		async delete(key) {
			map.delete(key);
		},
	};
	return { kv, map };
}

const { hex, launch } = await launchKey();

function envOf(overrides: Partial<Env> = {}) {
	const { kv, map } = fakeKv();
	const env: Env = { VIEWS: kv, BOT_ID: BOT, ALLOWED_USERS: JSON.stringify([USER]), UPLOAD_KEY, MEDIA_KEY, LABELS: JSON.stringify({ choose: 'Wähle' }), THEME: '', PUBLIC_KEY: hex, ...overrides };
	return { env, map };
}

const call = (env: Env, path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env);

test('a view published through the Worker opens with its media, stored in KV with type and expiration', async () => {
	const { env, map } = envOf();
	const expiresAt = Date.now() + 30_000;
	const auth = { Authorization: `Bearer ${UPLOAD_KEY}` };
	expect((await call(env, `/api/media/${ID}/g1/0?e=${expiresAt}`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'image/png' }, body: MEDIA.png })).status).toBe(200);
	const upload = { generation: 'g1', expiresAt, media: [{ type: 'image/png', size: MEDIA.png.byteLength }], view: { v: 1, tabs: [{ label: 'A', content: { markdown: '![a](media:0)' } }] } };
	expect((await call(env, `/api/view/${ID}`, { method: 'PUT', headers: auth, body: JSON.stringify(upload) })).status).toBe(200);
	// An expiry 30 s ahead is stored 60 s ahead, the least KV takes.
	expect(map.get(`m:${ID}:g1:0`)?.metadata).toEqual({ type: 'image/png' });
	expect(map.get(`v:${ID}`)?.expiration).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) + 59);

	const opened = await call(env, `/api/view?v=${ID}`, { headers: { Authorization: `tma ${await launch()}` } });
	expect(opened.status).toBe(200);
	const { media } = (await opened.json()) as { media: string[] };
	const served = await worker.fetch(new Request(media[0] ?? '', { headers: { Range: 'bytes=0-3' } }), env);
	expect(served.status).toBe(206);
	expect(new Uint8Array(await served.arrayBuffer())).toEqual(MEDIA.png.slice(0, 4));

	const shell = await (await call(env, '/')).text();
	expect(shell).toContain('"choose":"Wähle"');
});

test('choices posted through the Worker are listed across every page of KV and removed one by one', async () => {
	const { env, map } = envOf();
	const auth = { Authorization: `Bearer ${UPLOAD_KEY}` };
	const upload = { generation: 'g1', expiresAt: Date.now() + 86_400_000, media: [], view: { v: 1, tabs: ['A', 'B'].map((label) => ({ label, content: { markdown: label } })) } };
	expect((await call(env, `/api/view/${ID}`, { method: 'PUT', headers: auth, body: JSON.stringify(upload) })).status).toBe(200);
	const choice = { options: ['A', 'B'].map((label, index) => ({ index, label, tab: label })), once: false };
	expect((await call(env, `/api/view/${ID}/context/ask1`, { method: 'PUT', headers: auth, body: JSON.stringify({ body: { markdown: 'Which?' }, choice }) })).status).toBe(200);
	const ids = ['a', 'b', 'c'].map((letter) => letter.repeat(22));
	for (const id of ids) expect((await call(env, `/api/answer?v=${ID}&q=ask1&n=1&c=${id}`, { method: 'POST', headers: { Authorization: `tma ${await launch()}` } })).status).toBe(200);
	// KV answers pages of 2 keys: the 3 choices take 2 pages beside the view, its manifest and the context.
	expect(map.size).toBe(6);
	const listed = async () => ((await (await call(env, '/api/answers', { headers: auth })).json()) as { choices: { key: string; id: string }[] }).choices;
	expect((await listed()).map((choice) => choice.id)).toEqual(ids);
	const [first] = await listed();
	expect((await call(env, `/api/answer/${encodeURIComponent(first?.key ?? '')}`, { method: 'DELETE', headers: auth })).status).toBe(200);
	expect((await listed()).map((choice) => choice.id)).toEqual(ids.slice(1));
});

test('a variable that breaks its format answers every request with 500 and names it', async () => {
	const broken: Partial<Env>[] = [{ ALLOWED_USERS: '[1.5]' }, { ALLOWED_USERS: 'x' }, { LABELS: '{"viewGone":""}' }, { THEME: '{"light":{"background":"x;y"}}' }, { BOT_ID: '' }, { UPLOAD_KEY: '' }];
	for (const overrides of broken) {
		const { env } = envOf(overrides);
		const response = await call(env, '/api/version');
		expect(response.status, JSON.stringify(overrides)).toBe(500);
		expect(await response.text()).toContain('the view host is misconfigured');
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
	}
	const { env } = envOf({ THEME: JSON.stringify({ dark: { background: '#000' } }) });
	expect((await call(env, '/api/version')).status).toBe(200);
});
