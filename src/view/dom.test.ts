// The served shell, started as a page starts it: the body the handler serves, Telegram's SDK as
// a stand-in, and the exact inline script of that page run against happy-dom's document, with
// every request going to the handler. It checks what the browser builds: the frame and its
// empty sandbox, the page prefix, `q` and `t`, the context, Telegram's main button, a theme
// change and the expiry. Layout, scrolling and swipes need a real browser and a phone.
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { Window } from 'happy-dom';
import { mergeLabels } from '../core/labels.ts';
import { BOT, ID, launchKey, MEDIA, MEDIA_KEY, memoryStorage, ORIGIN, UPLOAD_KEY, USER } from './fixtures.ts';
import { createViewHandler } from './handler.ts';
import { MEDIA_WAIT, PLACEHOLDER_SVG } from './media.ts';
import { SHELL_SCRIPT } from './shell.ts';

// A missing media object is asked for again over 200 ms here, in place of 10 s.
MEDIA_WAIT.window = 200;
MEDIA_WAIT.pause = 50;

const windows: Window[] = [];
afterEach(async () => {
	setSystemTime();
	for (const window of windows.splice(0)) await window.happyDOM.close();
});

const { hex, launch } = await launchKey();

/** Polls `read` every 10 ms until it returns a value, for at most 5 s. */
async function until<T>(read: () => T | null | undefined | false): Promise<T> {
	for (const end = Date.now() + 5_000; Date.now() < end; await new Promise((resolve) => setTimeout(resolve, 10))) {
		const value = read();
		if (value) return value;
	}
	throw new Error('the shell did not get there within 5 s');
}

/**
 * A published view of a Markdown tab and a page tab with one image each, the context of `ask1`
 * hidden from its first read, and the shell opened at `path` with launch data.
 */
async function openShell(path: string, hidden = (key: string, read: number) => key === `c:${ID}:ask1` && read === 1) {
	const memory = memoryStorage({ hidden });
	const handle = createViewHandler({ storage: memory.storage, botId: BOT, allowedUsers: [USER], uploadKey: UPLOAD_KEY, mediaKey: MEDIA_KEY, publicKey: hex });
	const expiresAt = Date.now() + 86_400_000;
	const upload = (target: string, body: string | Uint8Array<ArrayBuffer>, type = 'application/json') =>
		handle(new Request(`${ORIGIN}${target}`, { method: 'PUT', headers: { Authorization: `Bearer ${UPLOAD_KEY}`, 'Content-Type': type }, body }));
	await upload(`/api/media/${ID}/g1/0?e=${expiresAt}`, MEDIA.png, 'image/png');
	const view = {
		v: 1,
		title: 'Release 0.1',
		tabs: [
			{ label: 'Notes', content: { markdown: '# Notes\n\n<script>alert(1)</script>\n\n![shot](media:0)' } },
			{ label: 'Mock', content: { page: '<h1>Mock</h1><img src="media:0">' } },
		],
	};
	await upload(`/api/view/${ID}`, JSON.stringify({ generation: 'g1', expiresAt, media: [{ type: 'image/png', size: MEDIA.png.byteLength }], view }));
	expect((await upload(`/api/view/${ID}/context/ask1`, JSON.stringify({ markdown: 'Ship **it**?' }))).status).toBe(200);

	const window = new Window({ url: `${ORIGIN}${path}#tgWebAppData=x`, settings: { disableIframePageLoading: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
	windows.push(window);
	const html = await (await handle(new Request(`${ORIGIN}${path}`))).text();
	const inline = `<script>${SHELL_SCRIPT}</script>`;
	expect(html).toContain(inline);
	// The body as served, without the one script, which runs below: innerHTML runs no script.
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
		MainButton: {
			setText: (text: string) => void app.calls.push(`MainButton ${text}`),
			onClick: (handler: () => void) => {
				app.mainButton = handler;
			},
			show: () => void app.calls.push('MainButton show'),
		},
	};
	Object.assign(window, { Telegram: { WebApp: app } });
	const requests: string[] = [];
	const fetchHost = (url: string, init?: RequestInit) => {
		requests.push(url);
		return handle(new Request(new URL(url, ORIGIN).href, init));
	};
	// Pauses of the shell's own asks run at once; the 2 hours of expiry wait for `activated`.
	const timeout = (run: () => void, ms: number) => (ms > 60_000 ? 0 : setTimeout(run, 0));
	const globals = { window, document: window.document, location: window.location, history: window.history, fetch: fetchHost, getComputedStyle: window.getComputedStyle.bind(window), DOMParser: window.DOMParser, setTimeout: timeout, clearTimeout: () => {} };
	new Function(...Object.keys(globals), SHELL_SCRIPT)(...Object.values(globals));
	return { window, document: window.document, app, requests, memory, fetchHost };
}

const objectKey = `m:${ID}:g1:0`;
const placeholderUrl = `data:image/svg+xml,${encodeURIComponent(PLACEHOLDER_SVG)}`;

test('the served shell draws a page in a frame with an empty sandbox behind the page policy, on the tab of t', async () => {
	const shell = await openShell(`/?v=${ID}&q=ask1&t=Mock`);
	const frame = await until(() => shell.document.querySelector('iframe'));
	expect(frame.hasAttribute('sandbox')).toBe(true);
	expect(frame.getAttribute('sandbox')).toBe('');
	const srcdoc = frame.getAttribute('srcdoc') ?? '';
	expect(srcdoc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: ${ORIGIN}; media-src ${ORIGIN}; font-src data:">`)).toBe(true);
	expect(srcdoc).toMatch(new RegExp(`<h1>Mock</h1><img src="${ORIGIN}/m/${ID}/g1/0\\?e=\\d+&s=[A-Za-z0-9_-]{43}">$`));
	expect(shell.requests[0]).toBe(`/api/view?v=${ID}&q=ask1`);
	expect(shell.window.location.hash).toBe('');
	expect([...shell.document.querySelectorAll('#tabs button')].map((button) => [button.textContent, button.getAttribute('aria-selected')])).toEqual([
		['Notes', 'false'],
		['Mock', 'true'],
	]);
	// Raw HTML in Markdown is a text node.
	const notes = await until(() => shell.document.querySelector('.markdown'));
	expect(notes.textContent).toContain('<script>alert(1)</script>');
	expect(notes.querySelector('script')).toBeNull();
	expect(notes.querySelector('img')?.getAttribute('src')).toStartWith(`${ORIGIN}/m/${ID}/g1/0?`);
});

test("a page's image whose load misses the object after the probe found it gets the placeholder image from the host", async () => {
	// The probe's read finds the object; every later read misses it.
	const shell = await openShell(`/?v=${ID}&t=Mock`, (key, read) => key === objectKey && read >= 2);
	const frame = await until(() => shell.document.querySelector('iframe'));
	const source = /<img src="([^"]+)">$/.exec(frame.getAttribute('srcdoc') ?? '')?.[1] ?? '';
	expect(source).toStartWith(`${ORIGIN}/m/${ID}/g1/0?`);
	// The frame's own load of that image, as the browser makes it: no Range, the URL as written.
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

test('a context that shows after the view is added to the open view', async () => {
	const shell = await openShell(`/?v=${ID}&q=ask1`);
	await until(() => shell.document.querySelector('iframe'));
	const context = await until(() => shell.document.querySelector('.context'));
	expect(context.textContent).toBe('Ship it?');
	expect(shell.memory.reads.get(`c:${ID}:ask1`)).toBe(2);
});

test("Telegram's main button closes the view, a theme change rebuilds the frame, and after 2 hours the view expires", async () => {
	const shell = await openShell(`/?v=${ID}&q=ask1`);
	const frame = await until(() => shell.document.querySelector('iframe'));
	expect(shell.app.calls).toEqual(expect.arrayContaining(['ready', 'expand', 'disableVerticalSwipes', 'MainButton Close', 'MainButton show']));
	shell.app.mainButton();
	expect(shell.app.calls.at(-1)).toBe('close');

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
