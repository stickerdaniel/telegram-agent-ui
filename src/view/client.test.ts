// The publisher's side against the merged view host: `prepareView` on real files, and
// `viewClient` over HTTP to `createViewHandler` on a storage in memory, served by a local server.
// `createChat` with `views` runs on the Telegram model of the chat harness. What a user sees is
// read back the way the shell reads it: GET /api/view with launch data.
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeViews, setup } from '../chat/harness.ts';
import { choice, message, yesNo } from '../core/builders.ts';
import { isRecord, isString } from '../core/check.ts';
import type { Outcome, Sent, ViewClient } from '../core/types.ts';
import { ORIGIN, tap } from '../fixtures.ts';
import { viewClient } from './client.ts';
import { BOT, launchKey, MEDIA, MEDIA_KEY, memoryStorage, UPLOAD_KEY, USER } from './fixtures.ts';
import { createViewHandler } from './handler.ts';
import { prepareView } from './prepare.ts';

const { hex, launch } = await launchKey();
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * The view host on a storage in memory behind a local HTTP server. `fail(match)` answers the
 * next request whose method and path `match` accepts with 503 before the handler sees it.
 */
function host(storage: Parameters<typeof memoryStorage>[0] = {}) {
	const memory = memoryStorage(storage);
	const handle = createViewHandler({ storage: memory.storage, botId: BOT, allowedUsers: [USER], uploadKey: UPLOAD_KEY, mediaKey: MEDIA_KEY, publicKey: hex });
	const failing: ((request: Request) => boolean)[] = [];
	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		fetch(request) {
			const index = failing.findIndex((match) => match(request));
			if (index !== -1) {
				failing.splice(index, 1);
				return new Response('{"error":"the host is down"}', { status: 503 });
			}
			return handle(request);
		},
	});
	cleanups.push(() => server.stop(true));
	const origin = `http://127.0.0.1:${server.port}`;
	return {
		...memory,
		origin,
		client: (lateWindow?: number) => viewClient({ origin, uploadKey: UPLOAD_KEY, ...(lateWindow !== undefined ? { lateWindow } : {}) }),
		fail(match: (request: Request) => boolean) {
			failing.push(match);
		},
		/** What the shell gets for view `id` opened from question `ref`: the view, the context and the media URLs. */
		async open(id: string, ref?: string): Promise<Opened> {
			const response = await fetch(`${origin}/api/view?v=${id}${ref !== undefined ? `&q=${ref}` : ''}`, { headers: { Authorization: `tma ${await launch()}` } });
			const json: unknown = response.ok ? await response.json() : {};
			const media = isRecord(json) && Array.isArray(json.media) ? json.media.filter(isString) : [];
			return { status: response.status, view: isRecord(json) ? json.view : undefined, context: isRecord(json) ? json.context : undefined, media };
		},
	};
}

type Opened = { status: number; view: unknown; context: unknown; media: string[] };

const path = (request: Request) => new URL(request.url).pathname;
/** The tab labels of an opened view. */
const labelsOf = (opened: Opened) => (isRecord(opened.view) && Array.isArray(opened.view.tabs) ? opened.view.tabs.map((tab: unknown) => (isRecord(tab) ? tab.label : undefined)) : []);

/** A project below a temp directory, with a file and a secret beside it. */
function project() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'tau-view-')));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const dir = join(root, 'project');
	mkdirSync(join(dir, 'shots'), { recursive: true });
	writeFileSync(join(dir, 'shots', 'a.png'), MEDIA.png);
	writeFileSync(join(dir, 'shots', 'b.jpg'), MEDIA.jpeg);
	writeFileSync(join(root, 'outside.md'), 'OUTSIDE_SENTINEL');
	writeFileSync(join(root, 'outside.png'), MEDIA.png);
	const file = (name: string, text: string) => {
		writeFileSync(join(dir, name), text);
		return join(dir, name);
	};
	return { root, dir, file, roots: [dir] };
}

async function prepared(input: Parameters<typeof prepareView>[0], roots: string[]) {
	const ready = await prepareView(input, { roots });
	if (ready.kind !== 'ok') throw new Error(`refused: ${ready.reason}`);
	return ready;
}

async function published(client: ViewClient, ready: Awaited<ReturnType<typeof prepared>>, id?: string) {
	const put = await client.put(ready.prepared, id !== undefined ? { id } : {});
	if (put.kind !== 'ok') throw new Error(`not published: ${JSON.stringify(put)}`);
	return put;
}

function sentOf(outcome: Outcome): Sent {
	if (outcome.kind !== 'ok' || !outcome.sent) throw new Error(`no sent in ${JSON.stringify(outcome)}`);
	return outcome.sent;
}

test('prepareView reads the tabs, uploads each local image once, maps Markdown images, rewrites a page and warns for what a page cannot do', async () => {
	const at = project();
	const markdown = '# Notes\n\n![a](shots/a.png) ![again](./shots/a.png) ![remote](https://example.com/x.png)';
	const notes = at.file('notes.md', markdown);
	const page = at.file('mock.html', '<h1 onclick="x()">Mock</h1><img src="shots/b.jpg"><img src=\'shots/a.png\'><a href="https://example.com">site</a>');
	const ready = await prepared({ title: 'Release', tabs: [{ label: 'Notes', content: { file: notes } }, { label: 'Mock', content: { file: page } }, { label: 'Diff', content: { diff: '+a\n-b' } }] }, at.roots);
	expect(ready.prepared.view).toEqual({
		v: 1,
		title: 'Release',
		tabs: [
			{ label: 'Notes', content: { markdown, media: { 'shots/a.png': 0, './shots/a.png': 0 } } },
			{ label: 'Mock', content: { page: '<h1 onclick="x()">Mock</h1><img src="media:1"><img src="media:0"><a href="https://example.com">site</a>' } },
			{ label: 'Diff', content: { diff: '+a\n-b' } },
		],
	});
	expect(ready.prepared.media.map((item) => item.type)).toEqual(['image/png', 'image/jpeg']);
	expect(ready.files.map((file) => file.path)).toEqual([notes, join(at.dir, 'shots', 'a.png'), page, join(at.dir, 'shots', 'b.jpg')]);
	expect(ready.warnings.map((warning) => warning.code).sort()).toEqual(['event-handler', 'link', 'remote-image']);
});

test('a Markdown image inside code or behind an escape stays literal text, and a real image beside it goes up', async () => {
	const at = project();
	writeFileSync(join(at.dir, 'shots', 'a(b).png'), MEDIA.png);
	const source = [
		'Write `![example](missing-example.png)` for an image.',
		'',
		'```markdown',
		'![example](missing-example.png)',
		'```',
		'',
		'\\![escaped](missing-example.png) and the real one: ![shot](shots/a(b).png "A title")',
	].join('\n');
	const ready = await prepared({ tabs: [{ label: 'Docs', content: { markdown: source, base: at.dir } }] }, at.roots);
	expect(ready.prepared.view.tabs[0]?.content).toEqual({ markdown: source, media: { 'shots/a(b).png': 0 } });
	expect(ready.files).toEqual([{ path: join(at.dir, 'shots', 'a(b).png'), bytes: MEDIA.png.length }]);
	// An unclosed fence runs to the end, as the shell draws it.
	expect((await prepared({ tabs: [{ label: 'Docs', content: { markdown: '~~~\n![x](missing.png)', base: at.dir } }] }, at.roots)).files).toEqual([]);
});

test('code in a quote or a list stays literal text, as the shell draws it, and a real image beside it goes up', async () => {
	const at = project();
	const sources = [
		'> ~~~md\n> ![example](missing-example.png)\n> ~~~\n\n![shot](shots/a.png)',
		'- code:\n    ~~~md\n    ![example](missing-example.png)\n    ~~~\n\n![shot](shots/a.png)',
		'- code:\n    ```md\n    ![example](missing-example.png)\n\n    ![another](missing-example.png)\n    ```\n\n![shot](shots/a.png)',
	];
	for (const source of sources) {
		const ready = await prepared({ tabs: [{ label: 'Docs', content: { markdown: source, base: at.dir } }] }, at.roots);
		expect(ready.prepared.view.tabs[0]?.content, source).toEqual({ markdown: source, media: { 'shots/a.png': 0 } });
		expect(ready.files, source).toEqual([{ path: join(at.dir, 'shots', 'a.png'), bytes: MEDIA.png.length }]);
	}
	// A real image's destination that code repeats: the source stays, and the map names the image.
	const repeated = '![shot](shots/a.png)\n\n```md\n![shot](shots/a.png)\n```';
	const both = await prepared({ tabs: [{ label: 'Docs', content: { markdown: repeated, base: at.dir } }] }, at.roots);
	expect(both.prepared.view.tabs[0]?.content).toEqual({ markdown: repeated, media: { 'shots/a.png': 0 } });
});

test('an image in a table cell maps the destination the shell reads, and a code example of the same file stays unchanged', async () => {
	const at = project();
	writeFileSync(join(at.dir, 'a|b.png'), MEDIA.png);
	const source = '| Image |\n| --- |\n| ![shot](a\\|b.png) |\n\n`![example](a|b.png)`';
	const ready = await prepared({ tabs: [{ label: 'Docs', content: { markdown: source, base: at.dir } }] }, at.roots);
	expect(ready.prepared.view.tabs[0]?.content).toEqual({ markdown: source, media: { 'a|b.png': 0 } });
	expect(ready.files).toEqual([{ path: join(at.dir, 'a|b.png'), bytes: MEDIA.png.length }]);
	// The host stores the map, and gives the view back with a signed URL for its index.
	const server = host();
	const put = await published(server.client(), ready);
	const opened = await server.open(put.id);
	expect(opened.view).toEqual({ v: 1, tabs: [{ label: 'Docs', content: { markdown: source, media: { 'a|b.png': 0 } } }] });
	expect(opened.media).toEqual([expect.stringContaining(`/m/${put.id}/`)]);
	// A video is no Markdown image.
	writeFileSync(join(at.dir, 'clip.mp4'), MEDIA.mp4);
	expect(await prepareView({ tabs: [{ label: 'A', content: { markdown: '![clip](clip.mp4)', base: at.dir } }] }, { roots: at.roots })).toMatchObject({ kind: 'refused', code: 'shape' });
});

test('a comment marker inside a quoted attribute opens no comment, and a later image goes up', async () => {
	const at = project();
	const ready = await prepared({ tabs: [{ label: 'Mock', content: { page: '<img alt="<!--"><img src="shots/a.png"><!-- <img src="missing.png"> -->', base: at.dir } }] }, at.roots);
	expect(ready.prepared.view.tabs[0]?.content).toEqual({ page: '<img alt="<!--"><img src="media:0"><!-- <img src="missing.png"> -->' });
	expect(ready.prepared.media).toHaveLength(1);
});

test('a page publishes the images of quoted, unquoted and entity-encoded src and poster attributes, through the same roots', async () => {
	const at = project();
	writeFileSync(join(at.dir, 'shots', 'a&b.png'), MEDIA.png);
	const page = '<!-- <img src=missing.png> --><img alt="x src=missing.png" src=shots/a.png><video poster=shots/b.jpg></video><img src="shots/a&amp;b.png"><img SRC = \'shots/a.png\'>';
	const ready = await prepared({ tabs: [{ label: 'Mock', content: { page, base: at.dir } }] }, at.roots);
	expect(ready.prepared.view.tabs[0]?.content).toEqual({
		page: '<!-- <img src=missing.png> --><img alt="x src=missing.png" src="media:0"><video poster="media:1"></video><img src="media:2"><img SRC = "media:0">',
	});
	expect(ready.prepared.media.map((item) => item.type)).toEqual(['image/png', 'image/jpeg', 'image/png']);
	// A newly recognized form still passes the roots and the secret names.
	writeFileSync(join(at.dir, '.env.png'), MEDIA.png);
	const roots = at.roots;
	expect(await prepareView({ tabs: [{ label: 'A', content: { page: '<img src=../outside.png>', base: at.dir } }] }, { roots })).toMatchObject({ kind: 'refused', code: 'outside-roots' });
	expect(await prepareView({ tabs: [{ label: 'A', content: { page: '<video poster=.env.png>', base: at.dir } }] }, { roots })).toMatchObject({ kind: 'refused', code: 'secret-file' });
	expect(await prepareView({ tabs: [{ label: 'A', content: { page: '<img src="&#46;&#46;/outside.png">', base: at.dir } }] }, { roots })).toMatchObject({ kind: 'refused', code: 'outside-roots' });
	// A source set of local files is refused with its reason, never published without them.
	expect(await prepareView({ tabs: [{ label: 'A', content: { page: '<img srcset="shots/a.png 1x, shots/b.jpg 2x">', base: at.dir } }] }, { roots })).toMatchObject({ kind: 'refused', code: 'shape', reason: expect.stringContaining('srcset') });
});

test('prepareView refuses media that each pass 20 MiB and together exceed 50 MiB, before any upload', async () => {
	const at = project();
	// 3 sparse PNG files of 18 MiB each: a PNG signature, then zeros the file system does not store.
	const paths = ['one', 'two', 'three'].map((name) => {
		const path = join(at.dir, 'shots', `${name}.png`);
		writeFileSync(path, MEDIA.png);
		truncateSync(path, 18 * 1024 * 1024);
		return path;
	});
	const gallery = (count: number) => ({ tabs: [{ label: 'Shots', content: { gallery: paths.slice(0, count).map((path) => ({ path })) } }] });
	expect(await prepareView(gallery(3), { roots: at.roots })).toMatchObject({ kind: 'refused', code: 'shape', reason: expect.stringContaining(String(50 * 1024 * 1024)) });
	// 2 of them stay within the total.
	expect((await prepareView(gallery(2), { roots: at.roots })).kind).toBe('ok');
});

test('prepareView refuses a view of more than 2 MiB without its media before any upload', async () => {
	const at = project();
	expect(await prepareView({ tabs: [{ label: 'A', content: { markdown: 'x'.repeat(2 * 1024 * 1024) } }] }, { roots: at.roots })).toMatchObject({ kind: 'refused', code: 'shape', reason: expect.stringContaining('2097152') });
});

test('prepareView refuses a path outside the roots, a secret, a link that leaves the roots, a script and broken tabs', async () => {
	const at = project();
	const roots = at.roots;
	symlinkSync(join(at.root, 'outside.md'), join(at.dir, 'link.md'));
	at.file('.env', 'TOKEN=1');
	const cases: [Parameters<typeof prepareView>[0], string][] = [
		[{ tabs: [{ label: 'A', content: { file: join(at.root, 'outside.md') } }] }, 'outside-roots'],
		[{ tabs: [{ label: 'A', content: { file: join(at.dir, 'link.md') } }] }, 'outside-roots'],
		[{ tabs: [{ label: 'A', content: { file: join(at.dir, '.env') } }] }, 'secret-file'],
		[{ tabs: [{ label: 'A', content: { markdown: '![x](../outside.png)', base: at.dir } }] }, 'outside-roots'],
		[{ tabs: [{ label: 'A', content: { page: '<SCRIPT>alert(1)</SCRIPT>' } }] }, 'shape'],
		[{ tabs: [{ label: 'A', content: { markdown: '![x](notes.txt)', base: at.dir } }] }, 'shape'],
		[{ tabs: [] }, 'shape'],
		[{ tabs: [{ label: 'A', content: { diff: '' } }, { label: 'A', content: { diff: '' } }] }, 'shape'],
		[{ tabs: [{ label: 'x'.repeat(47), content: { diff: '' } }] }, 'shape'],
	];
	at.file('notes.txt', 'not an image');
	for (const [input, code] of cases) expect(await prepareView(input, { roots }), JSON.stringify(input)).toMatchObject({ kind: 'refused', code });
	// A file whose bytes are not of its ending is refused before any upload.
	at.file('fake.png', 'no png at all');
	expect(await prepareView({ tabs: [{ label: 'A', content: { gallery: [{ path: join(at.dir, 'fake.png') }] } }] }, { roots })).toMatchObject({ kind: 'refused', code: 'shape' });
});

test('put writes every media object before the view object, under a new id of 22 characters, and a repeat is safe', async () => {
	const at = project();
	const server = host();
	const ready = await prepared({ tabs: [{ label: 'Shots', content: { gallery: [{ path: join(at.dir, 'shots', 'a.png') }, { path: join(at.dir, 'shots', 'b.jpg'), caption: 'B' }] } }] }, at.roots);
	const client = server.client();
	const first = await published(client, ready);
	expect(first.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
	expect(first.url).toBe(`${server.origin}/?v=${first.id}`);
	const puts = server.writes.filter((write) => write.startsWith('put '));
	expect(puts.map((write) => write.split(':')[0])).toEqual(['put m', 'put m', 'put g', 'put v']);
	const again = await published(client, ready, first.id);
	expect(again.id).toBe(first.id);
	const opened = await server.open(first.id);
	expect(opened.view).toEqual({ v: 1, tabs: [{ label: 'Shots', content: { gallery: [{ media: 0, type: 'image/png' }, { media: 1, type: 'image/jpeg', caption: 'B' }] } }] });
	expect((await fetch(opened.media[1] ?? '')).headers.get('Content-Type')).toBe('image/jpeg');
	expect(await client.has(first.id)).toEqual({ kind: 'present', tabs: ['Shots'] });
});

test('a publish that fails after its media leaves the earlier view readable with its media', async () => {
	const at = project();
	const server = host();
	const client = server.client();
	const earlier = await published(client, await prepared({ tabs: [{ label: 'Old', content: { markdown: '![a](shots/a.png)', base: at.dir } }] }, at.roots));
	server.fail((request) => request.method === 'PUT' && path(request) === `/api/view/${earlier.id}`);
	const replacement = await prepared({ tabs: [{ label: 'New', content: { markdown: '![b](shots/b.jpg)', base: at.dir } }] }, at.roots);
	expect(await client.put(replacement.prepared, { id: earlier.id })).toMatchObject({ kind: 'uncertain', id: earlier.id });
	// The new generation's media arrived, and nothing committed them.
	expect(server.writes.filter((write) => write.startsWith('put m:')).length).toBe(2);
	const opened = await server.open(earlier.id);
	expect(labelsOf(opened)).toEqual(['Old']);
	const media = await fetch(opened.media[0] ?? '');
	expect(media.headers.get('Content-Type')).toBe('image/png');
	expect(new Uint8Array(await media.arrayBuffer())).toEqual(MEDIA.png);
	// A media upload that fails changes no view either, and says so.
	server.fail((request) => request.method === 'PUT' && path(request).startsWith('/api/media/'));
	expect(await client.put(replacement.prepared, { id: earlier.id })).toMatchObject({ kind: 'refused', reason: expect.stringContaining('No view changed') });
	expect(labelsOf(await server.open(earlier.id))).toEqual(['Old']);
});

test('context asks again while the view is not visible yet, and reports missing after the late window', async () => {
	const at = project();
	const ready = await prepared({ tabs: [{ label: 'A', content: { diff: '+a' } }] }, at.roots);
	// The view object stays hidden from its first 3 reads, as a storage that shows a new key late.
	let hide = false;
	const server = host({ hidden: (key, read) => hide && key.startsWith('v:') && read <= 3 });
	const put = await published(server.client(), ready);
	hide = true;
	expect(await server.client().context(put.id, 'q1', { markdown: 'Which one?' })).toEqual({ kind: 'ok' });
	expect(await server.client(0).context('AAAAAAAAAAAAAAAAAAAAAA', 'q1', { markdown: 'Which one?' })).toEqual({ kind: 'missing' });
	expect(await server.client(0).has('AAAAAAAAAAAAAAAAAAAAAA')).toEqual({ kind: 'missing' });
	expect(await server.client().delete(put.id)).toEqual({ kind: 'ok' });
	expect(await server.client().delete(put.id)).toEqual({ kind: 'missing' });
	// A wrong upload key is a refusal with its status, and a host that is gone rejects.
	expect(await viewClient({ origin: server.origin, uploadKey: 'another-key-0123456789' }).has(put.id)).toMatchObject({ kind: 'refused', status: 401 });
	await expect(viewClient({ origin: 'http://127.0.0.1:9', uploadKey: UPLOAD_KEY }).context(put.id, 'q1', { markdown: 'x' })).rejects.toThrow('no answer');
});

test('two questions on one view each show their own text', async () => {
	const at = project();
	const server = host();
	const views = server.client();
	const put = await published(views, await prepared({ tabs: [{ label: 'Diff', content: { diff: '+a' } }] }, at.roots));
	const { chat } = setup({ viewOrigin: ORIGIN, views });
	await chat.send(yesNo({ markdown: 'Merge the fix now?' }, { view: put.id }), { ref: 'merge' });
	await chat.send(yesNo({ markdown: 'Ship it to staging?' }, { view: put.id }), { ref: 'ship' });
	expect((await server.open(put.id, 'merge')).context).toEqual({ markdown: 'Merge the fix now?' });
	expect((await server.open(put.id, 'ship')).context).toEqual({ markdown: 'Ship it to staging?' });
	expect((await server.open(put.id)).context).toBeUndefined();
});

test('a question with 3 options and a view with 3 tabs opens on the picked tab, and a tab the view lacks is refused', async () => {
	const at = project();
	const server = host();
	const views = server.client();
	const tabs = ['A: Compact', 'B: Wide', 'C: Split'];
	const put = await published(views, await prepared({ tabs: tabs.map((label) => ({ label, content: { page: `<h1>${label}</h1>` } })) }, at.roots));
	const { chat, server: telegram } = setup({ viewOrigin: ORIGIN, views });
	const spec = choice(
		{ markdown: 'Which layout should stay?' },
		tabs.map((label) => ({ label, tab: label })),
		{ view: put.id },
	);
	const sent = sentOf(await chat.send(spec, { ref: 'layout' }));
	/** The URL of the view button that the message shows now. */
	const viewButton = () => {
		const markup = telegram.shows.get(sent.message)?.reply_markup;
		const rows: unknown[] = isRecord(markup) && Array.isArray(markup.inline_keyboard) ? markup.inline_keyboard.flat() : [];
		const button = rows.find((candidate) => isRecord(candidate) && isRecord(candidate.web_app));
		const url = isRecord(button) && isRecord(button.web_app) && isString(button.web_app.url) ? button.web_app.url : 'https://none.invalid';
		return new URL(url);
	};
	expect(viewButton().searchParams.get('q')).toBe('layout');
	expect(viewButton().searchParams.get('t')).toBeNull();
	expect(await chat.handle(tap({ ref: 'layout', button: 1, message: sent.message }))).toMatchObject({ kind: 'answered' });
	expect(Object.fromEntries(viewButton().searchParams)).toEqual({ v: put.id, q: 'layout', t: 'B: Wide' });
	expect(viewButton().origin).toBe(ORIGIN);

	const lacking = choice({ markdown: 'Which one?' }, [{ label: 'A', tab: 'A: Compact' }, { label: 'D', tab: 'D: Grid' }], { view: put.id });
	expect(await chat.send(lacking, { ref: 'lacking' })).toMatchObject({ kind: 'refused', code: 'shape', reason: expect.stringContaining('"D: Grid"') });
	expect(await chat.get('lacking')).toBeUndefined();
});

test('a context write that fails after an edit is repaired by flush', async () => {
	const at = project();
	const server = host();
	const views = server.client();
	const put = await published(views, await prepared({ tabs: [{ label: 'Diff', content: { diff: '+a' } }] }, at.roots));
	const { chat } = setup({ viewOrigin: ORIGIN, views });
	const sent = sentOf(await chat.send(yesNo({ markdown: 'Merge the fix now?' }, { view: put.id }), { ref: 'merge' }));
	server.fail((request) => request.method === 'PUT' && path(request).endsWith('/context/merge'));
	expect(await chat.edit(sent, { markdown: 'Merge the fix to main now?' })).toMatchObject({ kind: 'ok' });
	expect((await server.open(put.id, 'merge')).context).toEqual({ markdown: 'Merge the fix now?' });
	const owed = await chat.get('merge');
	expect(owed && owed.shown.want > owed.shown.done).toBe(true);
	await chat.flush();
	expect((await server.open(put.id, 'merge')).context).toEqual({ markdown: 'Merge the fix to main now?' });
	const repaired = await chat.get('merge');
	expect(repaired?.shown.done).toBe(repaired?.shown.want ?? -1);
});

test('a spec and a plain Sent cannot name another origin', async () => {
	const fake = fakeViews();
	const { chat, server: telegram } = setup({ viewOrigin: ORIGIN, views: fake.views });
	const id = 'Zr8kQ2vT0mN4xW6yB1cD3e';
	expect(await chat.send(message({ markdown: 'See the view.' }, { view: `https://evil.example/?v=${id}` }))).toMatchObject({ kind: 'refused', code: 'shape' });
	const sent = sentOf(await chat.send(message({ markdown: 'See the view.' }, { view: id })));
	expect(sent.view).toEqual({ id, origin: ORIGIN });
	const calls = telegram.count;
	expect(await chat.edit({ ...sent, view: { id, origin: 'https://evil.example' } }, { markdown: 'See it here.' })).toMatchObject({ kind: 'refused', code: 'origin' });
	expect(telegram.count).toBe(calls);
});

test('a question keeps the view origin its ask stored after the configured one moved, and a plain Sent of the old origin is refused', async () => {
	const id = 'Zr8kQ2vT0mN4xW6yB1cD3e';
	const OLD = 'https://old.example.com';
	const before = setup({ viewOrigin: OLD, views: fakeViews().views });
	const asked = sentOf(await before.chat.send(yesNo({ markdown: 'Merge now?' }, { view: id }), { ref: 'old' }));
	const plain = sentOf(await before.chat.send(message({ markdown: 'See the view.' }, { view: id })));
	// The same store and Telegram, after view deploy moved the configured origin to ORIGIN.
	const { chat: moved } = setup({ viewOrigin: ORIGIN, views: fakeViews().views, store: before.inner, call: before.server.call });
	const viewRow = (message: number) => JSON.stringify(before.server.shows.get(message)?.reply_markup);

	expect(await moved.edit(asked, { markdown: 'Merge to main now?' })).toMatchObject({ kind: 'ok', ref: 'old' });
	expect(await moved.close('old', { markdown: 'Merged.' })).toMatchObject({ kind: 'ok', status: 'closed', warnings: [{ code: 'not-shown' }] });
	expect(viewRow(asked.message)).toContain(`${OLD}/?v=${id}&q=old`);
	expect(viewRow(asked.message)).not.toContain(ORIGIN);
	expect((await moved.get('old'))?.status).toBe('closed');

	const calls = before.server.count;
	expect(await moved.edit(plain, { markdown: 'See it here.' })).toMatchObject({ kind: 'refused', code: 'origin' });
	expect(before.server.count).toBe(calls);
});

test('after the configured origin moved, a question writes no context to the new host, counts as shown and warns not-shown', async () => {
	const at = project();
	const ready = await prepared({ tabs: [{ label: 'Diff', content: { diff: '+a' } }] }, at.roots);
	/** A real handler on a storage of its own, reached by its client through the Fetch seam at `origin`. */
	const hostAt = (origin: string) => {
		const memory = memoryStorage();
		const handle = createViewHandler({ storage: memory.storage, botId: BOT, allowedUsers: [USER], uploadKey: UPLOAD_KEY, mediaKey: MEDIA_KEY, publicKey: hex });
		const views = viewClient({ origin, uploadKey: UPLOAD_KEY, fetch: handle });
		const context = async (id: string, ref: string) => {
			const response = await handle(new Request(`${origin}/api/view?v=${id}&q=${ref}`, { headers: { Authorization: `tma ${await launch()}` } }));
			const json: unknown = await response.json();
			return isRecord(json) ? json.context : undefined;
		};
		return { views, context };
	};
	const OLD = 'https://old.example.com';
	const NEW = 'https://new.example.com';
	const old = hostAt(OLD);
	const moved = hostAt(NEW);
	const id = (await published(old.views, ready)).id;
	await published(moved.views, ready, id);

	const before = setup({ viewOrigin: OLD, views: old.views });
	const asked = sentOf(await before.chat.send(yesNo({ markdown: 'Merge now?' }, { view: id }), { ref: 'origin_review' }));
	const after = setup({ viewOrigin: NEW, views: moved.views, store: before.inner, call: before.server.call });

	expect(await after.chat.edit(asked, { markdown: 'Merge to main now?' })).toMatchObject({ kind: 'ok', warnings: [{ code: 'not-shown' }] });
	await after.chat.flush();
	const question = await after.chat.get('origin_review');
	expect(question?.shown).toMatchObject({ failures: 0, error: expect.stringContaining(OLD) });
	expect(question?.shown.done).toBe(question?.shown.want ?? -1);
	// The button still opens the old host, which keeps the context of the ask; the new host got none.
	expect(JSON.stringify(before.server.shows.get(asked.message)?.reply_markup)).toContain(`${OLD}/?v=${id}&q=origin_review`);
	expect(await old.context(id, 'origin_review')).toEqual({ markdown: 'Merge now?' });
	expect(await moved.context(id, 'origin_review')).toBeUndefined();
});
