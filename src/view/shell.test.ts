import { expect, test } from 'bun:test';
import { PAGE_BRIDGE, PAGE_BRIDGE_HASH } from './bridge.ts';
import { BOT, ID, launchKey, MEDIA_KEY, memoryStorage, ORIGIN, UPLOAD_KEY, USER } from './fixtures.ts';
import { createViewHandler } from './handler.ts';
import { PLACEHOLDER_SVG } from './media.ts';
import { LATE_KEY, SHELL_LIB, SHELL_SCRIPT } from './shell.ts';

type Node = string | { t: string; c?: Node[]; k?: string; href?: string; telegram?: boolean; src?: string; alt?: string; start?: number };
type Io = { fetch: (url: string, init: RequestInit) => Promise<Response>; sleep: (ms: number) => Promise<void>; now: () => number };
type Lib = {
	fetchRetry(url: string, init: RequestInit, io: Io): Promise<Response>;
	fetchContext(url: string, init: RequestInit, io: Io): Promise<unknown>;
	pagePrefix(origin: string, vars: Record<string, string>, dark: boolean, raw: boolean, bridge: boolean): string;
	themeBlocks(theme: unknown, dark: boolean): Record<string, string>;
	resolveVars(names: string[], read: (name: string) => string): Record<string, string>;
	mediaIndexes(text: string): number[];
	resolveMedia(text: string, urls: (string | undefined)[]): string;
	mapIndexes(map: Record<string, number>): number[];
	imageSource(src: string, images?: { urls: (string | undefined)[]; map: Record<string, number> }): string | undefined;
	safeLink(href: string): { href: string; telegram: boolean } | null;
	markdownBlocks(text: string): Node[];
	diffLines(text: string): Node[];
	contextNodes(body: unknown, htmlText: (html: string) => string): Node[];
	galleryItems(gallery: unknown, urls: (string | undefined)[]): { kind: 'image' | 'video'; src: string; caption: string }[];
	TAGS: string[];
	PLACEHOLDER: string;
};
const names = ['fetchRetry', 'fetchContext', 'pagePrefix', 'themeBlocks', 'resolveVars', 'mediaIndexes', 'mapIndexes', 'resolveMedia', 'imageSource', 'safeLink', 'markdownBlocks', 'diffLines', 'contextNodes', 'galleryItems', 'TAGS', 'PLACEHOLDER'];
const lib = new Function(`'use strict';\n${SHELL_LIB}\nreturn { ${names.join(', ')} };`)() as Lib;

const texts = (nodes: Node[]): string[] => nodes.flatMap((node) => (typeof node === 'string' ? [node] : texts(node.c ?? [])));
const elements = (nodes: Node[]): Exclude<Node, string>[] => nodes.flatMap((node) => (typeof node === 'string' ? [] : [node, ...elements(node.c ?? [])]));

test('the served script holds the library, no backtick, no ${ and no closing script tag, and compiles', () => {
	expect(SHELL_SCRIPT).toContain(SHELL_LIB);
	expect(SHELL_SCRIPT).not.toContain('`');
	expect(SHELL_SCRIPT).not.toContain('${');
	expect(SHELL_SCRIPT.toLowerCase()).not.toContain('</script');
	expect(() => new Function(SHELL_SCRIPT)).not.toThrow();
});

async function published(hidden: (key: string, read: number) => boolean) {
	const { hex, launch } = await launchKey();
	let live = false;
	const memory = memoryStorage({ hidden: (key, read) => live && hidden(key, read) });
	const handle = createViewHandler({ storage: memory.storage, botId: BOT, allowedUsers: [USER], uploadKey: UPLOAD_KEY, mediaKey: MEDIA_KEY, publicKey: hex });
	const expiresAt = Date.now() + 86_400_000;
	const upload = (path: string, body: string, type = 'application/json') => handle(new Request(`${ORIGIN}${path}`, { method: 'PUT', headers: { Authorization: `Bearer ${UPLOAD_KEY}`, 'Content-Type': type }, body }));
	await upload(`/api/view/${ID}`, JSON.stringify({ generation: 'g1', expiresAt, media: [], view: { v: 1, tabs: [{ label: 'A', content: { markdown: 'a' } }] } }));
	expect((await upload(`/api/view/${ID}/context/ask1`, JSON.stringify({ markdown: 'Ship it?' }))).status).toBe(200);
	memory.reads.clear();
	live = true;
	const clock = { now: 0, asks: 0 };
	const io: Io = {
		fetch: (url, init) => {
			clock.asks++;
			return handle(new Request(new URL(url, ORIGIN).href, init));
		},
		sleep: async (ms) => {
			clock.now += ms;
		},
		now: () => clock.now,
	};
	const init = { headers: { Authorization: `tma ${await launch()}` } };
	return { io, init, clock, url: `/api/view?v=${ID}&q=ask1` };
}

test('a view that a storage shows late is asked for again until it shows, for up to 10 s', async () => {
	expect(LATE_KEY).toEqual({ window: 10_000, pause: 1_000 });
	for (const [late, status, asks] of [
		[0, 200, 1],
		[4, 200, 5],
		[10, 200, 11],
		[11, 404, 11],
	] as const) {
		const at = await published((key, read) => key === `v:${ID}` && read <= late);
		expect((await lib.fetchRetry(at.url, at.init, at.io)).status, String(late)).toBe(status);
		expect(at.clock, String(late)).toEqual({ now: (asks - 1) * 1_000, asks });
	}
});

test('a context that a storage shows after its view is asked for again, for up to 10 s', async () => {
	const late = await published((key, read) => key === `c:${ID}:ask1` && read === 1);
	const first = await lib.fetchRetry(late.url, late.init, late.io);
	expect(((await first.json()) as { context?: unknown }).context).toBeUndefined();
	expect(await lib.fetchContext(late.url, late.init, late.io)).toMatchObject({ context: { markdown: 'Ship it?' } });
	expect(late.clock).toEqual({ now: 1_000, asks: 2 });
	const never = await published((key) => key === `c:${ID}:ask1`);
	expect(await lib.fetchContext(never.url, never.init, never.io)).toBeNull();
	expect(never.clock).toEqual({ now: 10_000, asks: 10 });
});

const policy = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src '${PAGE_BRIDGE_HASH}'; style-src 'unsafe-inline'; img-src data: ${ORIGIN}; media-src data: ${ORIGIN}; font-src data:">`;
const theme = ':root { --background: #101010; --foreground: #fafafa; color-scheme: dark; }';

test('a page starts with the doctype, the page policy of its origin and the resolved theme', () => {
	const prefix = lib.pagePrefix(ORIGIN, { background: '#101010', foreground: '#fafafa' }, true, false, false);
	expect(prefix.startsWith(policy)).toBe(true);
	expect(prefix).toContain(theme);
	expect(prefix).not.toContain('<script');
});

test('a page of a view of several tabs runs the bridge, and a raw page gets no theme and no body rule', () => {
	const several = lib.pagePrefix(ORIGIN, { background: '#101010', foreground: '#fafafa' }, true, false, true);
	expect(several.startsWith(policy)).toBe(true);
	expect(several).toContain(`<script>${PAGE_BRIDGE}</script>`);
	expect(several).toContain(theme);
	const raw = lib.pagePrefix(ORIGIN, { background: '#101010', foreground: '#fafafa' }, true, true, true);
	expect(raw).toBe(`${policy}<meta name="viewport" content="width=device-width, initial-scale=1"><script>${PAGE_BRIDGE}</script>`);
});

test('the bridge hash is the sha256 of the bridge text', async () => {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(PAGE_BRIDGE));
	expect(PAGE_BRIDGE_HASH).toBe(`sha256-${Buffer.from(digest).toString('base64')}`);
});

test('a theme block wins in its own colour scheme, and a value that could leave its declaration is dropped', () => {
	const theme = { theme: { radius: '0.5rem' }, light: { background: '#fff', primary: 'red; } body { display: none' }, dark: { background: '#000', ring: 'x</style><script>' } };
	expect(lib.themeBlocks(theme, false)).toEqual({ radius: '0.5rem', background: '#fff' });
	expect(lib.themeBlocks(theme, true)).toEqual({ radius: '0.5rem', background: '#000' });
	expect(lib.resolveVars(['a', 'b', 'c'], (name) => ({ a: ' #fff ', b: '', c: 'x{y' })[name] ?? '')).toEqual({ a: '#fff' });
});

test('Markdown is drawn as text nodes: raw HTML stays text, a link opens only http, https or t.me, an image only a media reference', () => {
	const nodes = lib.markdownBlocks(
		[
			'# Title <b>bold</b>',
			'',
			'<script>alert(1)</script> and <img src=x onerror=alert(2)>',
			'',
			'[ok](https://example.com/a) [tg](t.me/somebot) [bad](javascript:alert(3)) [data](data:text/html,x)',
			'',
			'![shot](shot.png) ![remote](https://evil.example/x.png) ![gone](gone.png) ![unmapped](other.png) ![old](media:0)',
			'',
			'| a | b |',
			'| --- | --- |',
			'| `x` | **y** |',
			'',
			'- one',
			'- two',
			'',
			'```',
			'<b>code</b>',
			'```',
		].join('\n'),
	);
	expect(elements(nodes).every((node) => lib.TAGS.includes(node.t))).toBe(true);
	const all = texts(nodes).join('');
	expect(all).toContain('<b>bold</b>');
	expect(all).toContain('<script>alert(1)</script> and <img src=x onerror=alert(2)>');
	expect(all).toContain('<b>code</b>');
	const links = elements(nodes).filter((node) => node.t === 'a');
	expect(links.map((link) => [link.href, link.telegram])).toEqual([
		['https://example.com/a', false],
		['https://t.me/somebot', true],
	]);
	const images = elements(nodes).filter((node) => node.t === 'img');
	const urls = [`${ORIGIN}/m/${ID}/g1/0?e=1&s=x`, ''];
	const map = { 'shot.png': 0, 'gone.png': 1 };
	expect(lib.mapIndexes({ ...map, 'again.png': 0 })).toEqual([0, 1]);
	expect(images.map((image) => lib.imageSource(image.src ?? '', { urls, map }))).toEqual([urls[0], undefined, lib.PLACEHOLDER, undefined, undefined]);
	expect(lib.imageSource('shot.png')).toBeUndefined();
	expect(lib.imageSource('toString', { urls, map })).toBeUndefined();
	expect(elements(nodes).map((node) => node.t)).toEqual(expect.arrayContaining(['h1', 'table', 'th', 'td', 'code', 'strong', 'ul', 'li', 'pre']));
});

test("the shell's placeholder is the image the host answers for a missing object", () => {
	expect(lib.PLACEHOLDER).toBe(`data:image/svg+xml,${encodeURIComponent(PLACEHOLDER_SVG)}`);
});

test('media references resolve to their URL, to the placeholder after a failed probe, and stay as written without an entry', () => {
	const page = '<img src="media:0"><video src="media:1"></video><img src="media:7">';
	expect(lib.mediaIndexes(page)).toEqual([0, 1, 7]);
	const urls: (string | undefined)[] = ['https://a/0', ''];
	expect(lib.resolveMedia(page, urls)).toBe(`<img src="https://a/0"><video src="${lib.PLACEHOLDER}"></video><img src="media:7">`);
});

test('a diff is one text line each, classed by its kind', () => {
	const lines = lib.diffLines('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n same\n-old <b>\n+new\n');
	expect(lines.map((line) => (typeof line === 'string' ? line : line.k))).toEqual(['meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add']);
	expect(texts(lines)).toContain('-old <b>');
});

test('a gallery item is a video or an image from its URL, and the placeholder image when its probe found it missing', () => {
	const gallery = [
		{ media: 0, type: 'image/png', caption: 'Before <b>' },
		{ media: 1, type: 'video/mp4', caption: 'The run' },
		{ media: 2, type: 'video/mp4' },
		{ media: 3, type: 'image/jpeg' },
		{ media: 'x', type: 'image/png' },
	];
	expect(lib.galleryItems(gallery, ['https://a/0', 'https://a/1', ''])).toEqual([
		{ kind: 'image', src: 'https://a/0', caption: 'Before <b>' },
		{ kind: 'video', src: 'https://a/1', caption: 'The run' },
		{ kind: 'image', src: lib.PLACEHOLDER, caption: '' },
		{ kind: 'image', src: lib.PLACEHOLDER, caption: '' },
	]);
	expect(lib.galleryItems(undefined, [])).toEqual([]);
});

test('a context draws Markdown, and HTML and blocks as plain text', () => {
	expect(texts(lib.contextNodes({ markdown: 'Ship **it**?' }, () => '')).join('')).toBe('Ship it?');
	expect(lib.contextNodes({ html: '<b>Ship</b> it?' }, (html) => html.replace(/<[^>]+>/g, ''))).toEqual([{ t: 'p', c: ['Ship it?'] }]);
	expect(texts(lib.contextNodes({ blocks: [{ type: 'paragraph', text: [{ type: 'bold', text: 'Ship' }, ' it?'] }] }, () => ''))).toEqual(['Ship it?']);
});
