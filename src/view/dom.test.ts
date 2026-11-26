import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { Window } from 'happy-dom';
import { mergeLabels } from '../core/labels.ts';
import { BOT, ID, launchKey, MEDIA, MEDIA_KEY, memoryStorage, ORIGIN, UPLOAD_KEY, USER } from './fixtures.ts';
import { PAGE_BRIDGE, PAGE_BRIDGE_HASH } from './bridge.ts';
import { createViewHandler } from './handler.ts';
import { MEDIA_WAIT, PLACEHOLDER_SVG } from './media.ts';
import { SHELL_SCRIPT } from './shell.ts';

MEDIA_WAIT.window = 200;
MEDIA_WAIT.pause = 50;

const windows: Window[] = [];
afterEach(async () => {
	setSystemTime();
	for (const window of windows.splice(0)) await window.happyDOM.close();
});

const { hex, launch } = await launchKey();

async function until<T>(read: () => T | null | undefined | false): Promise<T> {
	for (const end = Date.now() + 5_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 10))) {
		const value = read();
		if (value) return value;
	}
	throw new Error('the shell did not get there within 5 s');
}

const BINDING = { options: [{ index: 0, label: 'Keep notes', tab: 'Notes' }, { index: 1, label: 'Use mock', tab: 'Mock' }], once: false };

const NOTES_AND_MOCK = {
	media: [{ type: 'image/png', bytes: MEDIA.png }],
	tabs: [
		{ label: 'Notes', content: { markdown: '# Notes\n\n<script>alert(1)</script>\n\n| Image |\n| --- |\n| ![shot](a\\|b.png) |\n\n`![example](a|b.png)`', media: { 'a|b.png': 0 } } },
		{ label: 'Mock', content: { page: '<h1>Mock</h1><img src="media:0">' } },
	],
};

async function openShell(
	path: string,
	hidden = (key: string, read: number) => key === `c:${ID}:ask1` && read === 1,
	options: { binding?: unknown; diff?: boolean; published?: { media: { type: string; bytes: Uint8Array<ArrayBuffer> }[]; tabs: unknown[] } } = {},
) {
	const published = options.published ?? NOTES_AND_MOCK;
	const memory = memoryStorage({ hidden });
	const handle = createViewHandler({ storage: memory.storage, botId: BOT, allowedUsers: [USER], uploadKey: UPLOAD_KEY, mediaKey: MEDIA_KEY, publicKey: hex });
	const expiresAt = Date.now() + 86_400_000;
	const upload = (target: string, body: string | Uint8Array<ArrayBuffer>, type = 'application/json') =>
		handle(new Request(`${ORIGIN}${target}`, { method: 'PUT', headers: { Authorization: `Bearer ${UPLOAD_KEY}`, 'Content-Type': type }, body }));
	for (const [index, { type, bytes }] of published.media.entries()) expect((await upload(`/api/media/${ID}/g1/${index}?e=${expiresAt}`, bytes, type)).status).toBe(200);
	const view = { v: 1, title: 'Release 0.1', tabs: [...published.tabs, ...(options.diff ? [{ label: 'Diff', content: { diff: '+a' } }] : [])] };
	const media = published.media.map(({ type, bytes }) => ({ type, size: bytes.byteLength }));
	expect((await upload(`/api/view/${ID}`, JSON.stringify({ generation: 'g1', expiresAt, media, view }))).status).toBe(200);
	const body = { markdown: 'Ship **it**?' };
	expect((await upload(`/api/view/${ID}/context/ask1`, JSON.stringify(options.binding ? { body, choice: options.binding } : body))).status).toBe(200);

	const window = new Window({ url: `${ORIGIN}${path}#tgWebAppData=x`, settings: { disableIframePageLoading: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
	windows.push(window);
	const html = await (await handle(new Request(`${ORIGIN}${path}`))).text();
	const inline = `<script>${SHELL_SCRIPT}</script>`;
	expect(html).toContain(inline);
	window.document.body.innerHTML = (/<body>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '').replace(inline, '');

	const app = {
		initData: await launch(),
		colorScheme: 'light',
		calls: [] as string[],
		handlers: new Map<string, () => void>(),
		mainButton: () => {},
		ready: () => void app.calls.push('ready'),
		expand: () => void app.calls.push('expand'),
		disableVerticalSwipes: () => void app.calls.push('disableVerticalSwipes'),
		close: () => void app.calls.push('close'),
		openLink: (url: string) => void app.calls.push(`openLink ${url}`),
		openTelegramLink: (url: string) => void app.calls.push(`openTelegramLink ${url}`),
		onEvent: (name: string, handler: () => void) => void app.handlers.set(name, handler),
		main: { text: '', shown: false, enabled: true },
		MainButton: {
			setText: (text: string) => {
				app.calls.push(`MainButton ${text}`);
				app.main.text = text;
			},
			onClick: (handler: () => void) => {
				app.mainButton = handler;
			},
			show: () => {
				app.calls.push('MainButton show');
				app.main.shown = true;
			},
			hide: () => {
				app.main.shown = false;
			},
			enable: () => {
				app.main.enabled = true;
			},
			disable: () => {
				app.main.enabled = false;
			},
		},
	};
	Object.assign(window, { Telegram: { WebApp: app } });
	const requests: string[] = [];
	const answers: number[] = [];
	const fetchHost = async (url: string, init?: RequestInit) => {
		requests.push(url);
		const scripted = url.startsWith('/api/answer') ? answers.shift() : undefined;
		if (scripted !== undefined) return Response.json({ error: 'scripted' }, { status: scripted });
		return handle(new Request(new URL(url, ORIGIN).href, init));
	};
	const timeout = (run: () => void, ms: number) => (ms > 60_000 ? 0 : setTimeout(run, 0));
	const globals = { window, document: window.document, location: window.location, history: window.history, fetch: fetchHost, getComputedStyle: window.getComputedStyle.bind(window), DOMParser: window.DOMParser, setTimeout: timeout, clearTimeout: () => {} };
	new Function(...Object.keys(globals), SHELL_SCRIPT)(...Object.values(globals));
	return { window, document: window.document, app, requests, memory, fetchHost, answer: (status: number) => void answers.push(status) };
}

const objectKey = `m:${ID}:g1:0`;
const placeholderUrl = `data:image/svg+xml,${encodeURIComponent(PLACEHOLDER_SVG)}`;

test('a pill draws a tag of one or two characters in a badge before its title, and any other label as text', async () => {
	const labels = ['A', '12', 'C: Soft Shadow', 'Review: x', 'Zusammenfassung'];
	const shell = await openShell(`/?v=${ID}`, () => false, { published: { media: [], tabs: labels.map((label) => ({ label, content: { markdown: label } })) } });
	const buttons = await until(() => {
		const found = [...shell.document.querySelectorAll('#tabs [role="tab"]')];
		return found.length === labels.length && found;
	});
	expect(buttons.map((button) => [button.querySelector('b')?.textContent ?? null, button.querySelector('span')?.textContent ?? null, button.textContent])).toEqual([
		['A', null, 'A'],
		['12', null, '12'],
		['C', 'Soft Shadow', 'C Soft Shadow'],
		[null, 'Review: x', 'Review: x'],
		[null, 'Zusammenfassung', 'Zusammenfassung'],
	]);
});

test('the served shell draws a page in a frame that runs scripts alone, behind the page policy and with the bridge, on the tab of t', async () => {
	const shell = await openShell(`/?v=${ID}&q=ask1&t=Mock`);
	const frame = await until(() => shell.document.querySelector('iframe'));
	expect(frame.hasAttribute('sandbox')).toBe(true);
	expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
	const srcdoc = frame.getAttribute('srcdoc') ?? '';
	expect(srcdoc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src '${PAGE_BRIDGE_HASH}'; style-src 'unsafe-inline'; img-src data: ${ORIGIN}; media-src data: ${ORIGIN}; font-src data:">`)).toBe(true);
	expect(srcdoc).toContain(`<script>${PAGE_BRIDGE}</script>`);
	expect(srcdoc).toMatch(new RegExp(`<h1>Mock</h1><img src="${ORIGIN}/m/${ID}/g1/0\\?e=\\d+&s=[A-Za-z0-9_-]{43}">$`));
	expect(shell.requests[0]).toBe(`/api/view?v=${ID}&q=ask1`);
	expect(shell.window.location.hash).toBe('');
	expect([...shell.document.querySelectorAll('#tabs [role="tab"]')].map((button) => [button.textContent, button.getAttribute('aria-selected')])).toEqual([
		['Notes', 'false'],
		['Mock', 'true'],
	]);
	const notes = await until(() => shell.document.querySelector('.markdown'));
	expect(notes.textContent).toContain('<script>alert(1)</script>');
	expect(notes.querySelector('script')).toBeNull();
	expect(notes.querySelector('td img')?.getAttribute('src')).toStartWith(`${ORIGIN}/m/${ID}/g1/0?`);
	expect(notes.querySelectorAll('img')).toHaveLength(1);
	expect(notes.querySelector('p > code')?.textContent).toBe('![example](a|b.png)');
});

test('a raw page tab keeps the policy and the bridge but no theme and no body rule, and the same page without raw keeps both', async () => {
	const mock = '<h1>Mock</h1>';
	const shell = await openShell(`/?v=${ID}`, () => false, { published: { media: [], tabs: [{ label: 'Raw', content: { page: mock, raw: true } }, { label: 'Themed', content: { page: mock } }] } });
	const frames = await until(() => {
		const found = [...shell.document.querySelectorAll('iframe')];
		return found.length === 2 && found;
	});
	const [raw, themed] = frames.map((frame) => frame.getAttribute('srcdoc') ?? '');
	const head = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src '${PAGE_BRIDGE_HASH}'; style-src 'unsafe-inline'; img-src data: ${ORIGIN}; media-src data: ${ORIGIN}; font-src data:"><meta name="viewport" content="width=device-width, initial-scale=1"><script>${PAGE_BRIDGE}</script>`;
	expect(raw).toBe(`${head}${mock}`);
	expect(themed).toStartWith(head);
	expect(themed).toMatch(/<style>:root \{ [^<]*\} body \{ margin: 16px;[^<]*<\/style><h1>Mock<\/h1>$/);
});

test("a page's image whose load misses the object after the probe found it gets the placeholder image from the host", async () => {
	const shell = await openShell(`/?v=${ID}&t=Mock`, (key, read) => key === objectKey && read >= 2);
	const frame = await until(() => shell.document.querySelector('iframe'));
	const source = /<img src="([^"]+)">$/.exec(frame.getAttribute('srcdoc') ?? '')?.[1] ?? '';
	expect(source).toStartWith(`${ORIGIN}/m/${ID}/g1/0?`);
	const loaded = await shell.fetchHost(source.replaceAll('&amp;', '&'));
	expect(loaded.status).toBe(200);
	expect(loaded.headers.get('Content-Type')).toBe('image/svg+xml');
	expect(loaded.headers.get('Cache-Control')).toBe('no-store');
	expect(await loaded.text()).toBe(PLACEHOLDER_SVG);
	expect(shell.memory.reads.get(objectKey)).toBeGreaterThan(2);
});

test('an object the probe already misses shows as the placeholder in Markdown and in a page', async () => {
	const shell = await openShell(`/?v=${ID}&t=Mock`, (key) => key === objectKey);
	const frame = await until(() => shell.document.querySelector('iframe'));
	expect(frame.getAttribute('srcdoc')).toEndWith(`<img src="${placeholderUrl}">`);
	const notes = await until(() => shell.document.querySelector('.markdown img'));
	expect(notes.getAttribute('src')).toBe(placeholderUrl);
});

test('a gallery tab draws its images and an mp4 video that plays inline, each caption as text, and the video seeks through Range', async () => {
	const missingKey = `m:${ID}:g1:2`;
	const shell = await openShell(`/?v=${ID}&t=Shots`, (key) => key === missingKey, {
		published: {
			media: [
				{ type: 'image/png', bytes: MEDIA.png },
				{ type: 'video/mp4', bytes: MEDIA.mp4 },
				{ type: 'image/jpeg', bytes: MEDIA.jpeg },
			],
			tabs: [
				{ label: 'Diff', content: { diff: '+a' } },
				{ label: 'Shots', content: { gallery: [{ media: 0, type: 'image/png', caption: 'Before <b>x</b>' }, { media: 1, type: 'video/mp4', caption: 'The run' }, { media: 2, type: 'image/jpeg' }] } },
			],
		},
	});
	const gallery = await until(() => shell.document.querySelector('.gallery'));
	expect([...shell.document.querySelectorAll('#tabs [role="tab"]')].map((button) => button.getAttribute('aria-selected'))).toEqual(['false', 'true']);
	const figures = [...gallery.querySelectorAll('figure')];
	expect(figures.map((figure) => [figure.firstElementChild?.tagName, figure.querySelector('figcaption')?.textContent ?? null])).toEqual([
		['IMG', 'Before <b>x</b>'],
		['VIDEO', 'The run'],
		['IMG', null],
	]);
	expect(gallery.querySelector('b')).toBeNull();
	const [image, video, missing] = figures.map((figure) => figure.firstElementChild);
	expect(image?.getAttribute('src')).toStartWith(`${ORIGIN}/m/${ID}/g1/0?`);
	expect(missing?.getAttribute('src')).toBe(placeholderUrl);
	expect([video?.getAttribute('controls'), video?.getAttribute('playsinline'), video?.getAttribute('preload')]).toEqual(['', '', 'metadata']);
	expect(shell.document.querySelector('iframe')).toBeNull();

	const source = video?.getAttribute('src') ?? '';
	expect(source).toStartWith(`${ORIGIN}/m/${ID}/g1/1?`);
	const size = MEDIA.mp4.byteLength;
	for (const [range, start, end] of [
		['bytes=0-1', 0, 1],
		['bytes=16-', 16, size - 1],
	] as const) {
		const part = await shell.fetchHost(source, { headers: { Range: range } });
		expect(part.status, range).toBe(206);
		expect([part.headers.get('Content-Type'), part.headers.get('Accept-Ranges'), part.headers.get('Content-Range')], range).toEqual(['video/mp4', 'bytes', `bytes ${start}-${end}/${size}`]);
		expect(new Uint8Array(await part.arrayBuffer()), range).toEqual(MEDIA.mp4.slice(start, end + 1));
	}
});

test('a gallery video whose object goes missing after its probe shows the placeholder image above its caption', async () => {
	const videoKey = `m:${ID}:g1:0`;
	const shell = await openShell(`/?v=${ID}`, (key, read) => key === videoKey && read > 1, {
		published: { media: [{ type: 'video/mp4', bytes: MEDIA.mp4 }], tabs: [{ label: 'Run', content: { gallery: [{ media: 0, type: 'video/mp4', caption: 'The run' }] } }] },
	});
	const video = await until(() => shell.document.querySelector('.gallery video'));
	const figure = video.parentElement;
	const loaded = await shell.fetchHost(video.getAttribute('src') ?? '', { headers: { Range: 'bytes=0-1' } });
	expect([loaded.status, loaded.headers.get('Content-Type'), await loaded.text()]).toEqual([200, 'image/svg+xml', PLACEHOLDER_SVG]);
	video.dispatchEvent(new shell.window.Event('error'));
	expect([...(figure?.children ?? [])].map((child) => child.tagName)).toEqual(['IMG', 'FIGCAPTION']);
	expect(figure?.querySelector('img')?.getAttribute('src')).toBe(placeholderUrl);
	expect(figure?.querySelector('figcaption')?.textContent).toBe('The run');
	expect(shell.document.querySelector('.gallery video')).toBeNull();
});

test('a diff tab draws one text line per line of the diff, classed by its kind', async () => {
	const diff = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n same\n-old <b>x</b>\n+new\n';
	const shell = await openShell(`/?v=${ID}`, undefined, { published: { media: [], tabs: [{ label: 'Diff', content: { diff } }] } });
	const drawn = await until(() => shell.document.querySelector('.diff'));
	expect([...drawn.children].map((line) => [line.className, line.textContent])).toEqual([
		['meta', 'diff --git a/x b/x'],
		['meta', '--- a/x'],
		['meta', '+++ b/x'],
		['hunk', '@@ -1,2 +1,2 @@'],
		['ctx', ' same'],
		['del', '-old <b>x</b>'],
		['add', '+new'],
	]);
	expect(drawn.querySelector('b')).toBeNull();
	expect(shell.document.querySelector('#tabs')).toBeNull();
});

test('a context that shows after the view adds a folded question above the pill row, with a chevron button that opens it', async () => {
	const shell = await openShell(`/?v=${ID}&q=ask1`);
	await until(() => shell.document.querySelector('iframe'));
	const question = await until(() => shell.document.querySelector('#question'));
	expect(question.querySelector('.context')?.textContent).toBe('Ship it?');
	expect(question.nextElementSibling?.id).toBe('tabs');
	const button = question.querySelector('#ask');
	expect([button?.tagName, button?.getAttribute('aria-label'), button?.getAttribute('aria-controls'), button?.getAttribute('aria-expanded')]).toEqual(['BUTTON', 'Question', 'question', 'false']);
	expect(button?.querySelector('svg')).not.toBeNull();
	button?.dispatchEvent(new shell.window.MouseEvent('click', { bubbles: true }));
	expect([button?.getAttribute('aria-expanded'), question.classList.contains('open')]).toEqual(['true', true]);
	expect(shell.memory.reads.get(`c:${ID}:ask1`)).toBe(2);
});

test("a view without a choice shows no main button and closes through Telegram's own control, a theme change rebuilds the frame, and after 2 hours the view expires", async () => {
	const shell = await openShell(`/?v=${ID}&q=ask1`);
	const frame = await until(() => shell.document.querySelector('iframe'));
	expect(shell.app.calls).toEqual(expect.arrayContaining(['ready', 'expand', 'disableVerticalSwipes']));
	expect(shell.app.main.shown).toBe(false);

	expect(frame.getAttribute('srcdoc')).toContain('color-scheme: light;');
	shell.app.colorScheme = 'dark';
	shell.app.handlers.get('themeChanged')?.();
	expect(shell.document.documentElement.classList.contains('dark')).toBe(true);
	expect(frame.getAttribute('srcdoc')).toContain('color-scheme: dark;');

	shell.app.handlers.get('activated')?.();
	expect(shell.document.querySelector('.state')).toBeNull();
	setSystemTime(new Date(Date.now() + 2 * 3_600_000 + 1_000));
	shell.app.handlers.get('activated')?.();
	setSystemTime();
	expect(shell.document.querySelector('.state')?.textContent).toBe(mergeLabels().viewExpired);
	expect(shell.document.querySelector('iframe')).toBeNull();
});

const hintOf = (document: Window['document']) => {
	const hint = document.querySelector('.hint');
	return hint && !hint.hasAttribute('hidden') ? hint.textContent : null;
};
const posts = (requests: string[]) => requests.filter((url) => url.startsWith('/api/answer'));
const labels = mergeLabels();

test('on a bound tab the main button alone chooses its option; an unbound tab and a view without q show no main button', async () => {
	const bound = await openShell(`/?v=${ID}&q=ask1&t=Mock`, () => false, { binding: BINDING, diff: true });
	await until(() => bound.app.main.text === 'Choose Use mock');
	expect(bound.app.main).toEqual({ text: 'Choose Use mock', shown: true, enabled: true });
	expect(hintOf(bound.document)).toBeNull();

	const unbound = await openShell(`/?v=${ID}&q=ask1&t=Diff`, () => false, { binding: BINDING, diff: true });
	await until(() => unbound.document.querySelector('.diff'));
	await until(() => unbound.document.querySelector('.context'));
	expect(unbound.app.main.shown).toBe(false);
	unbound.app.mainButton();
	expect(posts(unbound.requests)).toEqual([]);
	expect(unbound.app.calls).not.toContain('close');

	const plain = await openShell(`/?v=${ID}&t=Mock`, () => false, { binding: BINDING });
	await until(() => plain.document.querySelector('iframe'));
	expect(plain.app.main.shown).toBe(false);
	expect(hintOf(plain.document)).toBe(labels.viewHint);
});

test('a tap on the main button posts the choice with the launch data, shows labels.chosen and closes', async () => {
	const shell = await openShell(`/?v=${ID}&q=ask1&t=Mock`, () => false, { binding: BINDING });
	await until(() => shell.app.main.text === 'Choose Use mock');
	shell.app.mainButton();
	expect(shell.app.main.enabled).toBe(false);
	await until(() => hintOf(shell.document) === labels.chosen);
	await until(() => shell.app.calls.at(-1) === 'close');
	const [url] = posts(shell.requests);
	expect(url).toMatch(new RegExp(`^/api/answer\\?v=${ID}&q=ask1&n=1&c=[A-Za-z0-9_-]{22}$`));
	const key = `a:${ID}:ask1:${new URL(url ?? '', ORIGIN).searchParams.get('c')}`;
	expect([...shell.memory.entries.keys()]).toContain(key);
	expect(shell.app.main.shown).toBe(false);
});

test('a failed POST keeps the view open and sends the same choice id again, and old launch data asks to open the view again', async () => {
	const shell = await openShell(`/?v=${ID}&q=ask1&t=Mock`, () => false, { binding: BINDING });
	await until(() => shell.app.main.text === 'Choose Use mock');
	shell.answer(503);
	shell.app.mainButton();
	await until(() => hintOf(shell.document) === labels.viewError);
	expect(shell.app.main).toEqual({ text: 'Choose Use mock', shown: true, enabled: true });
	expect(shell.app.calls).not.toContain('close');
	shell.app.mainButton();
	await until(() => hintOf(shell.document) === labels.chosen);
	const [first, second] = posts(shell.requests);
	expect(second).toBe(first);

	const stale = await openShell(`/?v=${ID}&q=ask1&t=Notes`, () => false, { binding: BINDING });
	await until(() => stale.app.main.text === 'Choose Keep notes');
	setSystemTime(new Date(Date.now() + 601_000));
	stale.app.mainButton();
	await until(() => hintOf(stale.document) === labels.viewExpired);
	setSystemTime();
	expect(stale.app.main.shown).toBe(false);
	expect([...stale.memory.entries.keys()].some((key) => key.startsWith('a:'))).toBe(false);
});

test('a binding that shows late turns the main button into Choose, and one still missing after 10 s shows labels.viewLate', async () => {
	const late = await openShell(`/?v=${ID}&q=ask1&t=Mock`, undefined, { binding: BINDING });
	await until(() => late.document.querySelector('.context'));
	await until(() => late.app.main.text === 'Choose Use mock');
	expect(hintOf(late.document)).toBeNull();

	const missing = await openShell(`/?v=${ID}&q=ask1&t=Mock`, (key) => key === `c:${ID}:ask1`, { binding: BINDING });
	await until(() => missing.document.querySelector('iframe'));
	setSystemTime(new Date(Date.now() + 11_000));
	await until(() => hintOf(missing.document) === labels.viewLate);
	expect(missing.app.main.shown).toBe(false);
});

test('a closed binding shows labels.closed and no main button, and a stray tap neither posts nor closes', async () => {
	const shell = await openShell(`/?v=${ID}&q=ask1&t=Mock`, () => false, { binding: { ...BINDING, closed: true } });
	await until(() => hintOf(shell.document) === labels.closed);
	expect(shell.app.main.shown).toBe(false);
	shell.app.mainButton();
	expect(posts(shell.requests)).toEqual([]);
	expect(shell.app.calls).not.toContain('close');
});
