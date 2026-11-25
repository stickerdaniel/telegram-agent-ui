import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeLabels } from '../core/labels.ts';
import type { StoredView } from '../core/types.ts';
import { BOT, ID, launchKey, MEDIA, MEDIA_KEY, memoryStorage, ORIGIN, raw, UPLOAD_KEY, USER } from './fixtures.ts';
import { PAGE_BRIDGE_HASH } from './bridge.ts';
import { createViewHandler, type ViewHandlerConfig } from './handler.ts';
import { MEDIA_WAIT, mediaPath, PLACEHOLDER_SVG } from './media.ts';
import { decode, parseChoiceRecord, parseContext, parseManifest, parseViewRecord, VERSION } from './stored.ts';

MEDIA_WAIT.window = 200;
MEDIA_WAIT.pause = 50;
afterEach(() => setSystemTime());

const { hex, launch } = await launchKey();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const OTHER = 'Q7pL0xV3aB9cN2mK5rT8wE';

function host(overrides: Partial<ViewHandlerConfig> = {}, storage: Parameters<typeof memoryStorage>[0] = {}) {
	const memory = memoryStorage(storage);
	const handle = createViewHandler({ storage: memory.storage, botId: BOT, allowedUsers: [USER, 112], uploadKey: UPLOAD_KEY, mediaKey: MEDIA_KEY, publicKey: hex, ...overrides });
	return { ...memory, handle };
}
type Host = ReturnType<typeof host>;

const VIEW: StoredView = {
	v: 1,
	title: 'Release 0.1',
	tabs: [
		{ label: 'Notes', content: { markdown: '# Notes\n\n![shot](media:0)' } },
		{ label: 'Mock', content: { page: '<h1>Mock</h1><img src="media:1">' } },
	],
};

const putView = (at: Host, upload: unknown, key = UPLOAD_KEY, id = ID) =>
	at.handle(
		raw(
			`PUT /api/view/${id} HTTP/1.1
			Host: views.example.com
			Authorization: Bearer ${key}
			Content-Type: application/json

${JSON.stringify(upload)}`,
		),
	);

const putMedia = (at: Host, generation: string, index: number, bytes: Uint8Array, type: string, expiresAt = Date.now() + 7 * DAY, id = ID) =>
	at.handle(
		raw(
			`PUT /api/media/${id}/${generation}/${index}?e=${expiresAt} HTTP/1.1
			Host: views.example.com
			Authorization: Bearer ${UPLOAD_KEY}
			Content-Type: ${type}`,
			bytes,
		),
	);

const putContext = (at: Host, ref: string, body: unknown, id = ID) =>
	at.handle(
		raw(
			`PUT /api/view/${id}/context/${ref} HTTP/1.1
			Host: views.example.com
			Authorization: Bearer ${UPLOAD_KEY}
			Content-Type: application/json

${JSON.stringify(body)}`,
		),
	);

const getView = async (at: Host, query: string, initData?: string) =>
	at.handle(
		raw(`GET /api/view?${query} HTTP/1.1
			Host: views.example.com
			${initData === undefined ? 'Accept: application/json' : `Authorization: tma ${initData}`}`),
	);

async function publish(at: Host, generation = 'g1', expiresAt = Date.now() + 7 * DAY, id = ID) {
	expect((await putMedia(at, generation, 0, MEDIA.png, 'image/png', expiresAt, id)).status).toBe(200);
	expect((await putMedia(at, generation, 1, MEDIA.mp4, 'video/mp4', expiresAt, id)).status).toBe(200);
	const media = [
		{ type: 'image/png', size: MEDIA.png.byteLength },
		{ type: 'video/mp4', size: MEDIA.mp4.byteLength },
	];
	expect((await putView(at, { generation, expiresAt, media, view: VIEW }, UPLOAD_KEY, id)).status).toBe(200);
}

type Opened = { view: StoredView; context?: unknown; choice?: unknown; media: string[]; expiresAt: number };

const BINDING = { options: [{ index: 0, label: 'Keep notes', tab: 'Notes' }, { index: 1, label: 'Use mock', tab: 'Mock' }], once: false };
const CHOICE = 'c'.repeat(22);

const postAnswer = (at: Host, query: string, initData?: string, body?: string) =>
	at.handle(
		raw(
			`POST /api/answer?${query} HTTP/1.1
			Host: views.example.com
			${initData === undefined ? 'Accept: application/json' : `Authorization: tma ${initData}`}${body === undefined ? '' : `\n\n${body}`}`,
		),
	);
const answersOf = (at: Host, key = UPLOAD_KEY) => at.handle(raw(`GET /api/answers HTTP/1.1\nHost: views.example.com\nAuthorization: Bearer ${key}`));
const deleteAnswer = (at: Host, key: string, uploadKey = UPLOAD_KEY) => at.handle(raw(`DELETE /api/answer/${encodeURIComponent(key)} HTTP/1.1\nHost: views.example.com\nAuthorization: Bearer ${uploadKey}`));
async function open(at: Host, query = `v=${ID}`): Promise<Opened> {
	const response = await getView(at, query, await launch());
	expect(response.status).toBe(200);
	return (await response.json()) as Opened;
}

const getMedia = (at: Host, url: string, range?: string, signal?: AbortSignal) => {
	const request = raw(`GET ${url.slice(ORIGIN.length)} HTTP/1.1
			Host: views.example.com
			${range ? `Range: ${range}` : 'Accept: */*'}`);
	return at.handle(signal ? new Request(request, { signal }) : request);
};

async function expectPlaceholder(response: Response) {
	expect(response.status).toBe(200);
	expect(response.headers.get('Content-Type')).toBe('image/svg+xml');
	expect(response.headers.get('Cache-Control')).toBe('no-store');
	expect(await response.text()).toBe(PLACEHOLDER_SVG);
}

test('GET /api/version names this version, the view formats and answers, with the headers of every answer', async () => {
	const at = host();
	const response = await at.handle(raw('GET /api/version HTTP/1.1\nHost: views.example.com'));
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ version: VERSION, formats: [1, 'answers'] });
	const manifest: unknown = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'package.json'), 'utf8'));
	expect(VERSION).toBe((manifest as { version: string }).version);
	for (const answer of [response, await at.handle(raw('GET /nothing HTTP/1.1\nHost: views.example.com'))]) {
		expect(answer.headers.get('Referrer-Policy')).toBe('no-referrer');
		expect(answer.headers.get('X-Content-Type-Options')).toBe('nosniff');
	}
});

test('the view answers 401 without launch data, for another user, for older than 600 s and for more than 60 s ahead', async () => {
	const now = 1_800_000_000;
	setSystemTime(new Date(now * 1000 + 999));
	const at = host();
	await publish(at);
	const refused: [string, string | undefined, string][] = [
		['no launch data', undefined, 'Authorization is tma'],
		['another user', await launch({ userId: 42 }), 'not an allowed user'],
		['another bot', await launch({ botId: '223' }), 'bad signature'],
		['601 s old', await launch({ authDate: now - 601 }), 's old'],
		['61 s ahead', await launch({ authDate: now + 61 }), 's ahead'],
	];
	for (const [name, initData, reason] of refused) {
		const response = await getView(at, `v=${ID}`, initData);
		expect(response.status, name).toBe(401);
		expect(((await response.json()) as { error: string }).error, name).toContain(reason);
	}
	for (const authDate of [now - 600, now + 60]) expect((await getView(at, `v=${ID}`, await launch({ authDate }))).status, String(authDate - now)).toBe(200);
	expect((await getView(at, `v=${ID}`, await launch({ userId: 112 }))).status).toBe(200);
});

test('a view and its media may expire 3650 days ahead and not 1 ms later, and a tab label has up to 54 characters', async () => {
	const now = 1_800_000_000_000;
	setSystemTime(new Date(now));
	const at = host();
	const last = now + 3650 * DAY;
	const media = [{ type: 'image/png', size: MEDIA.png.byteLength }];
	const view = { v: 1, tabs: [{ label: 'C'.repeat(12) + ': ' + 't'.repeat(40), content: { markdown: 'x' } }] };
	expect((await putMedia(at, 'g1', 0, MEDIA.png, 'image/png', last + 1)).status).toBe(400);
	expect((await putView(at, { generation: 'g1', expiresAt: last + 1, media, view })).status).toBe(400);
	expect((await putMedia(at, 'g1', 0, MEDIA.png, 'image/png', last)).status).toBe(200);
	expect((await putView(at, { generation: 'g1', expiresAt: last, media, view })).status).toBe(200);
});

test('an opened view has no-store, its stored view and one signed URL per media', async () => {
	const at = host();
	await publish(at);
	const response = await getView(at, `v=${ID}`, await launch());
	expect(response.headers.get('Cache-Control')).toBe('no-store');
	const opened = (await response.json()) as Opened;
	expect(opened.view).toEqual(VIEW);
	expect(opened.context).toBeUndefined();
	expect(opened.media).toHaveLength(2);
	expect(opened.media[0]).toMatch(new RegExp(`^${ORIGIN}/m/${ID}/g1/0\\?e=\\d+&s=[A-Za-z0-9_-]{43}$`));
	expect((await getView(at, 'v=Zr8kQ2vT0mN4xW6yB1cD3f', await launch())).status).toBe(404);
	expect((await getView(at, 'v=short', await launch())).status).toBe(400);
});

test('an upload without the key, over a limit or of a wrong type is refused and stores nothing', async () => {
	const at = host();
	const expiresAt = Date.now() + DAY;
	const media = [{ type: 'image/png', size: MEDIA.png.byteLength }];
	const upload = { generation: 'g1', expiresAt, media, view: VIEW };
	const tab = (label: string, content: unknown = { markdown: 'x' }) => ({ label, content });
	const refused: [string, Promise<Response>, number][] = [
		['no key', at.handle(raw(`PUT /api/view/${ID} HTTP/1.1\nHost: views.example.com\n\n${JSON.stringify(upload)}`)), 401],
		['a wrong key', putView(at, upload, 'upload-key-0123456789abcdeX'), 401],
		['9 tabs', putView(at, { ...upload, view: { v: 1, tabs: Array.from({ length: 9 }, (_, index) => tab(`t${index}`)) } }), 400],
		['a label of 55 characters', putView(at, { ...upload, view: { v: 1, tabs: [tab('x'.repeat(55))] } }), 400],
		['a label twice', putView(at, { ...upload, view: { v: 1, tabs: [tab('a'), tab('a')] } }), 400],
		['a page with a script', putView(at, { ...upload, view: { v: 1, tabs: [tab('p', { page: '<p>x</p><SCRIPT>1</SCRIPT>' })] } }), 400],
		['a view over 6 MiB', putView(at, { ...upload, view: { v: 1, tabs: [tab('big', { markdown: 'x'.repeat(6 * 1024 * 1024) })] } }), 400],
		['a body over the upload limit', putView(at, { ...upload, view: { v: 1, tabs: [tab('big', { markdown: 'x'.repeat(7 * 1024 * 1024) })] } }), 413],
		['21 media', putView(at, { ...upload, media: Array.from({ length: 21 }, () => media[0]) }), 400],
		['media of 51 MiB', putView(at, { ...upload, media: [0, 1, 2].map(() => ({ type: 'video/mp4', size: 17 * 1024 * 1024 })) }), 400],
		['a media type outside the list', putView(at, { ...upload, media: [{ type: 'image/svg+xml', size: 10 }] }), 400],
		['a gallery of another type than its media', putView(at, { ...upload, view: { v: 1, tabs: [tab('g', { gallery: [{ media: 0, type: 'video/mp4' }] })] } }), 400],
		['a Markdown image of a media index the view lacks', putView(at, { ...upload, view: { v: 1, tabs: [tab('m', { markdown: '![a](a.png)', media: { 'a.png': 1 } })] } }), 400],
		['a Markdown image of a video', putView(at, { ...upload, media: [{ type: 'video/mp4', size: 10 }], view: { v: 1, tabs: [tab('m', { markdown: '![a](a.mp4)', media: { 'a.mp4': 0 } })] } }), 400],
		['a Markdown map whose index is an object JSON cannot turn into text', putView(at, { ...upload, view: { v: 1, tabs: [tab('m', { markdown: '![x](x.png)', media: { 'x.png': { toString: null } } })] } }), 400],
		['a Markdown map that is no object', putView(at, { ...upload, view: { v: 1, tabs: [tab('m', { markdown: '![a](a.png)', media: [0] })] } }), 400],
		['an expiry past 3650 days', putView(at, { ...upload, expiresAt: Date.now() + 3651 * DAY }), 400],
		['an expiry in the past', putView(at, { ...upload, expiresAt: Date.now() - 1 }), 400],
		['a view format of another release', putView(at, { ...upload, view: { ...VIEW, v: 2 } }), 409],
		['media of a declared type with other bytes', putMedia(at, 'g1', 0, MEDIA.jpeg, 'image/png'), 415],
		['media of a type outside the list', putMedia(at, 'g1', 0, new TextEncoder().encode('<svg onload=x>'), 'image/svg+xml'), 415],
		['media over 20 MiB', putMedia(at, 'g1', 0, new Uint8Array(20 * 1024 * 1024 + 1), 'image/png'), 413],
		['media index 20', putMedia(at, 'g1', 20, MEDIA.png, 'image/png'), 400],
		['media expiring past 3650 days', putMedia(at, 'g1', 0, MEDIA.png, 'image/png', Date.now() + 3651 * DAY), 400],
	];
	for (const [name, response, status] of refused) expect((await response).status, name).toBe(status);
	expect(at.writes).toEqual([]);
});

test('an upload with a wrong key is refused before a byte of its body is read', async () => {
	const at = host();
	let pulled = false;
	const body = new ReadableStream<Uint8Array>(
		{
			pull() {
				pulled = true;
				throw new Error('the body was read');
			},
		},
		{ highWaterMark: 0 },
	);
	const response = await at.handle(raw(`PUT /api/media/${ID}/g1/0?e=${Date.now() + DAY} HTTP/1.1\nHost: views.example.com\nAuthorization: Bearer wrong\nContent-Type: image/png`, body));
	expect(response.status).toBe(401);
	expect(pulled).toBe(false);
});

test('contexts of 2 refs on one view each come back for their own ref', async () => {
	const at = host();
	await publish(at);
	expect((await putContext(at, 'ask1', { markdown: 'Ship **0.1** now?' })).status).toBe(200);
	expect((await putContext(at, 'ask2', { markdown: 'Which mock wins?' })).status).toBe(200);
	expect((await open(at, `v=${ID}&q=ask1`)).context).toEqual({ markdown: 'Ship **0.1** now?' });
	expect((await open(at, `v=${ID}&q=ask2`)).context).toEqual({ markdown: 'Which mock wins?' });
	expect((await open(at, `v=${ID}&q=ask3`)).context).toBeUndefined();
	expect((await putContext(at, 'ask1', { markdown: 'Ship **0.2** now?' })).status).toBe(200);
	expect((await open(at, `v=${ID}&q=ask1`)).context).toEqual({ markdown: 'Ship **0.2** now?' });
	expect((await open(at, `v=${ID}&q=ask2`)).context).toEqual({ markdown: 'Which mock wins?' });
	expect((await putContext(at, 'ask1', { markdown: 'a </details> b' })).status).toBe(400);
	expect((await putContext(at, 'bad.ref', { markdown: 'x' })).status).toBe(400);
	expect((await getView(at, `v=${ID}&q=bad.ref`, await launch())).status).toBe(400);
	const fresh = host();
	expect((await putContext(fresh, 'ask1', { markdown: 'x' })).status).toBe(404);
});

test('one ref on two views comes back with each view its own context', async () => {
	const at = host();
	await publish(at, 'g1', Date.now() + DAY, ID);
	await publish(at, 'g1', Date.now() + DAY, OTHER);
	expect((await putContext(at, 'ask1', { markdown: 'Ship the release notes?' }, ID)).status).toBe(200);
	expect((await putContext(at, 'ask1', { markdown: 'Ship the mock?' }, OTHER)).status).toBe(200);
	expect((await open(at, `v=${ID}&q=ask1`)).context).toEqual({ markdown: 'Ship the release notes?' });
	expect((await open(at, `v=${OTHER}&q=ask1`)).context).toEqual({ markdown: 'Ship the mock?' });
});

test('a choice is stored only for a bound option of a registered question, with fresh launch data of an allowed user', async () => {
	const now = 1_800_000_000;
	setSystemTime(new Date(now * 1000 + 999));
	const at = host();
	await publish(at);
	expect((await putContext(at, 'ask1', { body: { markdown: 'Which one stays?' }, choice: BINDING })).status).toBe(200);
	expect((await putContext(at, 'chat1', { markdown: 'Ship it?' })).status).toBe(200);
	expect(await open(at, `v=${ID}&q=ask1`)).toMatchObject({ context: { markdown: 'Which one stays?' }, choice: BINDING });
	expect((await open(at, `v=${ID}&q=chat1`)).choice).toBeUndefined();
	const before = at.snapshot();
	const old = await launch({ authDate: now - 601 });
	const refused: [string, Promise<Response>, number][] = [
		['no launch data', postAnswer(at, `v=${ID}&q=ask1&n=1&c=${CHOICE}`), 401],
		['another user', postAnswer(at, `v=${ID}&q=ask1&n=1&c=${CHOICE}`, await launch({ userId: 42 })), 401],
		['launch data 601 s old', postAnswer(at, `v=${ID}&q=ask1&n=1&c=${CHOICE}`, old), 401],
		['an unregistered ref', postAnswer(at, `v=${ID}&q=nosuch&n=1&c=${CHOICE}`, await launch()), 404],
		['a question answered in the chat', postAnswer(at, `v=${ID}&q=chat1&n=1&c=${CHOICE}`, await launch()), 404],
		['an index the binding does not list', postAnswer(at, `v=${ID}&q=ask1&n=2&c=${CHOICE}`, await launch()), 400],
		['an index above 7', postAnswer(at, `v=${ID}&q=ask1&n=8&c=${CHOICE}`, await launch()), 400],
		['a choice id of 21 characters', postAnswer(at, `v=${ID}&q=ask1&n=1&c=${CHOICE.slice(1)}`, await launch()), 400],
		['a view the host lacks', postAnswer(at, `v=${OTHER}&q=ask1&n=1&c=${CHOICE}`, await launch()), 404],
		['a body', postAnswer(at, `v=${ID}&q=ask1&n=1&c=${CHOICE}`, await launch(), '{"n":0}'), 413],
	];
	for (const [name, response, status] of refused) expect((await response).status, name).toBe(status);
	expect(at.snapshot()).toBe(before);

	const stored = await postAnswer(at, `v=${ID}&q=ask1&n=1&c=${CHOICE}`, await launch());
	expect(stored.status).toBe(200);
	expect(stored.headers.get('Cache-Control')).toBe('no-store');
	expect(stored.headers.get('X-Content-Type-Options')).toBe('nosniff');
	expect(await stored.json()).toEqual({ view: ID, ref: 'ask1', choice: CHOICE, stored: true });
	const entry = at.entries.get(`a:${ID}:ask1:${CHOICE}`);
	expect(entry && decode(entry.value)).toEqual({ v: 1, expiresAt: Date.now() + 7 * DAY, index: 1, user: { id: USER, name: 'Dana S' }, at: Date.now() });
});

test('a binding names distinct options and indexes, each with a tab of the view, or the context is refused', async () => {
	const at = host();
	await publish(at);
	const [first, second] = BINDING.options;
	const refused: [string, unknown][] = [
		['a tab the view lacks', { ...BINDING, options: [first, { ...second, tab: 'Gone' }] }],
		['one tab twice', { ...BINDING, options: [first, { ...second, tab: 'Notes' }] }],
		['one index twice', { ...BINDING, options: [first, { ...second, index: 0 }] }],
		['one option', { ...BINDING, options: [first] }],
		['a label of 47 characters', { ...BINDING, options: [first, { ...second, label: 'x'.repeat(47) }] }],
		['no once', { options: BINDING.options }],
		['a key of its own', { ...BINDING, more: 1 }],
	];
	for (const [name, choice] of refused) expect((await putContext(at, 'ask1', { body: { markdown: 'Which?' }, choice })).status, name).toBe(400);
	expect((await putContext(at, 'ask1', { body: { markdown: 'Which?' }, choice: BINDING, more: 1 })).status).toBe(400);
	expect([...at.entries.keys()].some((key) => key.startsWith('c:'))).toBe(false);
	const gone = { ...BINDING, options: [first, { ...second, tab: 'Gone' }] };
	expect((await putContext(at, 'ask1', { body: { markdown: 'Which?' }, choice: gone })).status).toBe(400);
	expect((await putContext(at, 'ask1', { body: { markdown: 'Which?' }, choice: { ...gone, options: [first, { ...second, tab: 'Notes' }], closed: true } })).status).toBe(400);
	expect((await putContext(at, 'ask1', { body: { markdown: 'Which?' }, choice: { ...gone, closed: true } })).status).toBe(200);
	expect((await open(at, `v=${ID}&q=ask1`)).choice).toEqual({ ...gone, closed: true });
});

test('a binding past its expiry takes no choice, a listed choice id is answered without a write, and a ref takes 32 choices', async () => {
	const at = host();
	await publish(at);
	expect((await putContext(at, 'timed', { body: { markdown: 'Which?' }, choice: { ...BINDING, expiresAt: Date.now() + 1_000 } })).status).toBe(200);
	expect((await putContext(at, 'many', { body: { markdown: 'Which?' }, choice: BINDING })).status).toBe(200);
	expect((await postAnswer(at, `v=${ID}&q=timed&n=0&c=${CHOICE}`, await launch())).status).toBe(200);
	setSystemTime(new Date(Date.now() + 1_000));
	expect((await postAnswer(at, `v=${ID}&q=timed&n=0&c=${'d'.repeat(22)}`, await launch())).status).toBe(410);
	expect((await putContext(at, 'closed', { body: { markdown: 'Which?' }, choice: { ...BINDING, closed: true } })).status).toBe(200);
	expect((await open(at, `v=${ID}&q=closed`)).choice).toEqual({ ...BINDING, closed: true });
	const before = at.writes.length;
	expect((await postAnswer(at, `v=${ID}&q=closed&n=0&c=${'e'.repeat(22)}`, await launch())).status).toBe(410);
	expect(at.writes.length).toBe(before);
	expect((await putContext(at, 'closed', { body: { markdown: 'Which?' }, choice: { ...BINDING, closed: 'yes' } })).status).toBe(400);

	const id = (n: number) => `m${String(n).padStart(21, '0')}`;
	for (let n = 0; n < 32; n++) expect((await postAnswer(at, `v=${ID}&q=many&n=${n % 2}&c=${id(n)}`, await launch())).status).toBe(200);
	const writes = at.writes.length;
	expect((await postAnswer(at, `v=${ID}&q=many&n=1&c=${id(32)}`, await launch())).status).toBe(429);
	expect((await postAnswer(at, `v=${ID}&q=many&n=0&c=${id(0)}`, await launch())).status).toBe(200);
	expect(at.writes.length).toBe(writes);
});

test('the answers routes need the upload key: GET lists every live choice and writes nothing, DELETE removes one', async () => {
	setSystemTime(new Date(1_800_000_000_000));
	const at = host();
	await publish(at, 'g1', Date.now() + DAY);
	await putContext(at, 'ask1', { body: { markdown: 'Which?' }, choice: BINDING });
	expect((await postAnswer(at, `v=${ID}&q=ask1&n=1&c=${CHOICE}`, await launch({ userId: 112 }))).status).toBe(200);
	const key = `a:${ID}:ask1:${CHOICE}`;
	expect((await answersOf(at, 'wrong-key-0123456789abcdef')).status).toBe(401);
	expect((await deleteAnswer(at, key, 'wrong-key-0123456789abcdef')).status).toBe(401);
	const listed = await answersOf(at);
	expect(listed.headers.get('Cache-Control')).toBe('no-store');
	expect(await listed.json()).toEqual({ choices: [{ key, view: ID, ref: 'ask1', id: CHOICE, index: 1, user: { id: 112, name: 'Dana S' }, at: Date.now() }] });
	setSystemTime(new Date(Date.now() + DAY + 1));
	const writes = at.writes.length;
	expect(await (await answersOf(at)).json()).toEqual({ choices: [] });
	expect(at.writes.length).toBe(writes);
	expect(at.entries.has(key)).toBe(true);
	setSystemTime();
	expect((await deleteAnswer(at, 'c:not-a-choice')).status).toBe(400);
	expect((await deleteAnswer(at, key)).status).toBe(200);
	expect(at.entries.has(key)).toBe(false);
	expect((await deleteAnswer(at, key)).status).toBe(200);
});

test('the load of a media object waits out a read that misses it after the probe found it', async () => {
	const objectKey = `m:${ID}:g1:0`;
	const at = host({}, { hidden: (key, read) => key === objectKey && read === 2 });
	await publish(at);
	const [png = ''] = (await open(at)).media;
	expect((await getMedia(at, png, 'bytes=0-0')).status).toBe(206);
	const loaded = await getMedia(at, png);
	expect(loaded.status).toBe(200);
	expect(new Uint8Array(await loaded.arrayBuffer())).toEqual(MEDIA.png);
	expect(at.reads.get(objectKey)).toBe(3);
	const gone = host({}, { hidden: (key) => key === objectKey });
	await publish(gone);
	const [missing = ''] = (await open(gone)).media;
	await expectPlaceholder(await getMedia(gone, missing));
});

test('the media wait is 10 s of elapsed time on a slow storage, and an aborted request stops it', async () => {
	const objectKey = `m:${ID}:g1:0`;
	const at = host({}, { hidden: (key) => key === objectKey, latency: 400 });
	await publish(at);
	const [png = ''] = (await open(at)).media;
	at.reads.clear();
	const started = performance.now();
	await expectPlaceholder(await getMedia(at, png));
	const elapsed = performance.now() - started;
	expect(elapsed).toBeGreaterThanOrEqual(MEDIA_WAIT.window - 5);
	expect(elapsed).toBeLessThan(MEDIA_WAIT.window + 150);
	expect(at.reads.get(objectKey)).toBe(1);

	at.reads.clear();
	const aborted = performance.now();
	await expectPlaceholder(await getMedia(at, png, undefined, AbortSignal.abort()));
	expect(performance.now() - aborted).toBeLessThan(100);
	expect(at.reads.get(objectKey)).toBeUndefined();

	const controller = new AbortController();
	setTimeout(() => controller.abort(), 60);
	const cut = performance.now();
	await expectPlaceholder(await getMedia(at, png, undefined, controller.signal));
	expect(performance.now() - cut).toBeLessThan(MEDIA_WAIT.window);
});

test('the media wait ends at the signature expiry, and a cache lifetime counts from the answer', async () => {
	const objectKey = `m:${ID}:g1:0`;
	const start = 1_800_000_000_000;
	const expires = start + 2 * HOUR;
	const slow = (key: string, read: number) => {
		if (key !== objectKey || read !== 1) return false;
		setSystemTime(new Date(Date.now() + 100));
		return true;
	};
	for (const [before, status, cache, reads] of [
		[3_050, 200, 'private, max-age=2', 2],
		[50, 403, 'no-store', 1],
	] as const) {
		setSystemTime(new Date(start));
		const at = host({}, { hidden: slow });
		await publish(at, 'g1', start + DAY);
		const [png = ''] = (await open(at)).media;
		expect(png).toContain(`e=${expires}&`);
		setSystemTime(new Date(expires - before));
		const response = await getMedia(at, png);
		expect(response.status, String(before)).toBe(status);
		expect(response.headers.get('Cache-Control'), String(before)).toBe(cache);
		expect(at.reads.get(objectKey), String(before)).toBe(reads);
	}
});

test('a media URL serves its object, and fails after its expiry, after a key rotation and when forged', async () => {
	const at = host();
	await publish(at);
	const [png, mp4] = (await open(at)).media;
	if (png === undefined || mp4 === undefined) throw new Error('two media URLs');
	const served = await getMedia(at, png);
	expect(served.status).toBe(200);
	expect(new Uint8Array(await served.arrayBuffer())).toEqual(MEDIA.png);
	expect(served.headers.get('Content-Type')).toBe('image/png');
	expect(served.headers.get('Accept-Ranges')).toBe('bytes');
	const maxAge = Number(/^private, max-age=(\d+)$/.exec(served.headers.get('Cache-Control') ?? '')?.[1]);
	expect(maxAge).toBeGreaterThan(7_000);
	expect(maxAge).toBeLessThanOrEqual(7_200);

	const rotated = host({ mediaKey: 'media-key-rotated-0123456789' });
	for (const [key, value] of at.entries) rotated.entries.set(key, value);
	expect((await getMedia(rotated, png)).status).toBe(403);

	const forged = [png.replace(/s=./, (match) => (match === 's=A' ? 's=B' : 's=A')), png.replace('/g1/0', '/g1/1'), png.replace('/g1/', '/g2/'), png.replace(/e=(\d+)/, (_, e) => `e=${Number(e) + 1}`)];
	for (const url of forged) expect((await getMedia(at, url)).status, url).toBe(403);

	setSystemTime(new Date(Date.now() + 2 * HOUR + 1_000));
	expect((await getMedia(at, png)).status).toBe(403);
	expect(((await (await getMedia(at, png)).json()) as { error: string }).error).toContain('expired');
});

test('a media URL lives no longer than its view', async () => {
	const at = host();
	const expiresAt = Date.now() + 10 * 60_000;
	await publish(at, 'g1', expiresAt);
	const [png] = (await open(at)).media;
	expect(Number(/e=(\d+)/.exec(png ?? '')?.[1])).toBe(expiresAt);
	setSystemTime(new Date(expiresAt + 1));
	expect((await getView(at, `v=${ID}`, await launch())).status).toBe(404);
	expect((await getMedia(at, png ?? '')).status).toBe(403);
});

test('Range returns 206 with Content-Range, and a range past the end 416', async () => {
	const at = host();
	await publish(at);
	const [, mp4 = ''] = (await open(at)).media;
	const size = MEDIA.mp4.byteLength;
	const parts: [string, number, number][] = [
		['bytes=0-0', 0, 0],
		['bytes=4-7', 4, 7],
		['bytes=10-', 10, size - 1],
		['bytes=-4', size - 4, size - 1],
		['bytes=0-999', 0, size - 1],
	];
	for (const [range, start, end] of parts) {
		const response = await getMedia(at, mp4, range);
		expect(response.status, range).toBe(206);
		expect(response.headers.get('Content-Range'), range).toBe(`bytes ${start}-${end}/${size}`);
		expect(response.headers.get('Content-Length'), range).toBe(String(end - start + 1));
		expect(new Uint8Array(await response.arrayBuffer()), range).toEqual(MEDIA.mp4.slice(start, end + 1));
	}
	for (const range of [`bytes=${size}-`, 'bytes=-0']) {
		const response = await getMedia(at, mp4, range);
		expect(response.status, range).toBe(416);
		expect(response.headers.get('Content-Range'), range).toBe(`bytes */${size}`);
	}
	for (const range of ['bytes=5-2', 'bytes=0-1,4-5', 'items=0-1']) expect((await getMedia(at, mp4, range)).status, range).toBe(200);
});

test('every GET and HEAD route leaves the storage unchanged', async () => {
	const at = host();
	await publish(at);
	await putContext(at, 'ask1', { body: { markdown: 'Ship it?' }, choice: BINDING });
	expect((await postAnswer(at, `v=${ID}&q=ask1&n=0&c=${CHOICE}`, await launch())).status).toBe(200);
	const before = at.snapshot();
	const writes = at.writes.length;
	const { media } = await open(at, `v=${ID}&q=ask1`);
	const requests = [
		raw(`GET /?v=${ID}&q=ask1&t=Mock HTTP/1.1\nHost: views.example.com`),
		raw('GET /api/version HTTP/1.1\nHost: views.example.com'),
		raw(`GET /api/view?v=${ID}&q=ask1 HTTP/1.1\nHost: views.example.com\nAuthorization: tma ${await launch()}`),
		raw(`GET /api/view?v=${ID} HTTP/1.1\nHost: views.example.com\nAuthorization: tma ${await launch({ userId: 42 })}`),
		raw(`GET /api/view?v=${ID} HTTP/1.1\nHost: views.example.com`),
		raw(`GET ${(media[0] ?? '').slice(ORIGIN.length)} HTTP/1.1\nHost: views.example.com\nRange: bytes=0-0`),
		raw(`GET ${(media[1] ?? '').slice(ORIGIN.length)} HTTP/1.1\nHost: views.example.com`),
		raw(`GET /m/${ID}/g1/0?e=1&s=x HTTP/1.1\nHost: views.example.com`),
		raw(`GET /api/view/${ID} HTTP/1.1\nHost: views.example.com\nAuthorization: Bearer ${UPLOAD_KEY}`),
		raw(`GET /api/media/${ID}/g1/0 HTTP/1.1\nHost: views.example.com\nAuthorization: Bearer ${UPLOAD_KEY}`),
		raw(`HEAD /api/view/${ID} HTTP/1.1\nHost: views.example.com\nAuthorization: Bearer ${UPLOAD_KEY}`),
		raw(`HEAD /api/view/${ID} HTTP/1.1\nHost: views.example.com`),
		raw(`GET /api/answers HTTP/1.1\nHost: views.example.com\nAuthorization: Bearer ${UPLOAD_KEY}`),
		raw(`GET /api/answers HTTP/1.1\nHost: views.example.com`),
		raw(`GET /api/answer?v=${ID}&q=ask1&n=1&c=${CHOICE.replace('c', 'd')} HTTP/1.1\nHost: views.example.com\nAuthorization: tma ${await launch()}`),
		raw(`GET /api/answer/${encodeURIComponent(`a:${ID}:ask1:${CHOICE}`)} HTTP/1.1\nHost: views.example.com\nAuthorization: Bearer ${UPLOAD_KEY}`),
	];
	for (const request of requests) await at.handle(request);
	expect(at.writes.length).toBe(writes);
	expect(at.snapshot()).toBe(before);
});

test('HEAD reports the tab labels, DELETE removes the view and its media', async () => {
	const at = host();
	await publish(at);
	const head = (key = UPLOAD_KEY) => at.handle(raw(`HEAD /api/view/${ID} HTTP/1.1\nHost: views.example.com\nAuthorization: Bearer ${key}`));
	const present = await head();
	expect(present.status).toBe(200);
	expect(JSON.parse(decodeURIComponent(present.headers.get('View-Tabs') ?? ''))).toEqual(['Notes', 'Mock']);
	expect((await head('wrong-key-0123456789abcdef')).status).toBe(401);
	const { media } = await open(at);
	const deleted = await at.handle(raw(`DELETE /api/view/${ID} HTTP/1.1\nHost: views.example.com\nAuthorization: Bearer ${UPLOAD_KEY}`));
	expect(deleted.status).toBe(200);
	expect((await head()).status).toBe(404);
	expect((await getView(at, `v=${ID}`, await launch())).status).toBe(404);
	await expectPlaceholder(await getMedia(at, media[0] ?? ''));
	expect((await at.handle(raw(`DELETE /api/view/${ID} HTTP/1.1\nHost: views.example.com\nAuthorization: Bearer ${UPLOAD_KEY}`))).status).toBe(404);
});

test('a replaced view keeps the media of its earlier generation, and an object unlike its committed entry is not served', async () => {
	const at = host();
	await publish(at, 'g1');
	const first = await open(at);
	await publish(at, 'g2');
	const second = await open(at);
	expect(second.media[0]).toContain('/g2/0?');
	expect((await getMedia(at, first.media[0] ?? '')).status).toBe(200);
	expect((await getMedia(at, second.media[0] ?? '')).status).toBe(200);
	expect((await putMedia(at, 'g2', 0, MEDIA.jpeg, 'image/jpeg')).status).toBe(200);
	await expectPlaceholder(await getMedia(at, second.media[0] ?? ''));
});

test('every stored value is JSON that parses back through its own parse function', async () => {
	const at = host();
	await publish(at);
	await putContext(at, 'ask1', { blocks: [{ type: 'paragraph', text: 'Ship it?' }] });
	await putContext(at, 'ask2', { body: { markdown: 'Which one?' }, choice: { ...BINDING, expiresAt: Date.now() + DAY } });
	expect((await postAnswer(at, `v=${ID}&q=ask2&n=1&c=${CHOICE}`, await launch())).status).toBe(200);
	const parsers: Record<string, (value: unknown) => unknown> = { v: parseViewRecord, g: parseManifest, c: parseContext, a: parseChoiceRecord };
	let records = 0;
	for (const [key, entry] of at.entries) {
		const parse = parsers[key.slice(0, 1)];
		if (!parse) continue;
		const value = decode(entry.value);
		expect(parse(value), key).toEqual(value);
		records++;
	}
	expect(records).toBe(5);
});

test('the shell carries one script, the policy with its sha256, and labels and theme in data blocks', async () => {
	const shellOf = async (overrides: Partial<ViewHandlerConfig>) => {
		const response = await host(overrides).handle(raw(`GET /?v=${ID}&q=ask1&t=Mock HTTP/1.1\nHost: views.example.com`));
		return { response, html: await response.text() };
	};
	const { response, html } = await shellOf({ labels: { choose: 'Wähle </script><b>' }, theme: { light: { background: '#fff' } } });
	expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
	const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
	const executable = scripts.filter(([, attributes]) => !/type="application\/json"/.test(attributes ?? ''));
	expect(executable.map(([, attributes]) => attributes)).toEqual([' src="https://telegram.org/js/telegram-web-app.js"', '']);
	const inline = executable[1]?.[2] ?? '';
	const hash = createHash('sha256').update(inline).digest('base64');
	expect(response.headers.get('Content-Security-Policy')).toBe(
		`default-src 'none'; script-src 'sha256-${hash}' '${PAGE_BRIDGE_HASH}' https://telegram.org; style-src 'unsafe-inline'; img-src data: ${ORIGIN}; media-src data: ${ORIGIN}; font-src data:; connect-src 'self'; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'`,
	);
	const blocks = Object.fromEntries(scripts.flatMap(([, attributes, body]) => (/id="(\w+)"/.exec(attributes ?? '')?.[1] ? [[/id="(\w+)"/.exec(attributes ?? '')?.[1], JSON.parse(body ?? '')]] : [])));
	expect(blocks.labels.choose).toBe('Wähle </script><b>');
	expect(blocks.labels.viewGone).toBe(mergeLabels().viewGone);
	expect(blocks.theme).toEqual({ light: { background: '#fff' } });
	expect(html).not.toContain('</script><b>');
	const other = await shellOf({});
	expect(other.response.headers.get('Content-Security-Policy')).toBe(response.headers.get('Content-Security-Policy'));
});

test('a configuration that cannot serve throws', () => {
	const base = { storage: memoryStorage().storage, botId: BOT, allowedUsers: [USER], uploadKey: UPLOAD_KEY, mediaKey: MEDIA_KEY };
	const broken: Partial<ViewHandlerConfig>[] = [
		{ botId: 'bot' },
		{ allowedUsers: [] },
		{ allowedUsers: [1.5] },
		{ uploadKey: 'short' },
		{ mediaKey: '' },
		{ publicKey: 'abc' },
		{ labels: { viewGone: '' } },
		{ theme: { light: { background: 'red; } body { display: none' } } },
	];
	for (const overrides of broken) expect(() => createViewHandler({ ...base, ...overrides }), JSON.stringify(overrides)).toThrow();
	expect(() => createViewHandler(base)).not.toThrow();
});

test('a storage read that starts before the media deadline and rejects after it never escapes the request', async () => {
	let reads = 0;
	const escaped: unknown[] = [];
	const watch = (reason: unknown) => escaped.push(reason);
	process.on('unhandledRejection', watch);
	try {
		const storage = {
			get: async () => {
				reads++;
				if (reads === 1) {
					Bun.sleepSync(60);
					throw new Error('read failed after its setup');
				}
				return undefined;
			},
			put: async () => {},
			delete: async () => {},
			list: async () => [],
		};
		const handler = createViewHandler({ storage, botId: BOT, allowedUsers: [USER], uploadKey: UPLOAD_KEY, mediaKey: MEDIA_KEY });
		const path = await mediaPath(MEDIA_KEY, { id: ID, generation: 'g1', index: 0, expires: Date.now() + 40 });
		const response = await handler(new Request(ORIGIN + path));
		expect(response.status).toBe(403);
		await Bun.sleep(50);
		expect(escaped).toEqual([]);
	} finally {
		process.off('unhandledRejection', watch);
	}
});
