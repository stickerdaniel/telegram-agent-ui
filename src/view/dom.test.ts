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

/** A binding of `ask1` to the Markdown tab and the page tab. */
const BINDING = { options: [{ index: 0, label: 'Keep notes', tab: 'Notes' }, { index: 1, label: 'Use mock', tab: 'Mock' }], once: false };

/**
 * A published view of a Markdown tab and a page tab with one image each, the context of `ask1`
 * hidden from its first read, and the shell opened at `path` with launch data. With `binding`
 * the context carries it, with `diff` the view ends with a diff tab no option names, and with
 * `secondary: false` the client has no SecondaryButton. `answer(status)` makes the next POST
 * of a choice get that status before the host sees it.
 */
async function openShell(path: string, hidden = (key: string, read: number) => key === `c:${ID}:ask1` && read === 1, options: { binding?: unknown; diff?: boolean; secondary?: boolean } = {}) {
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
			// The image's destination in a table cell carries an escaped pipe; the code example names the same file.
			{ label: 'Notes', content: { markdown: '# Notes\n\n<script>alert(1)</script>\n\n| Image |\n| --- |\n| ![shot](a\\|b.png) |\n\n`![example](a|b.png)`', media: { 'a|b.png': 0 } } },
			{ label: 'Mock', content: { page: '<h1>Mock</h1><img src="media:0">' } },
			...(options.diff ? [{ label: 'Diff', content: { diff: '+a' } }] : []),
		],
	};
	await upload(`/api/view/${ID}`, JSON.stringify({ generation: 'g1', expiresAt, media: [{ type: 'image/png', size: MEDIA.png.byteLength }], view }));
	const body = { markdown: 'Ship **it**?' };
	expect((await upload(`/api/view/${ID}/context/ask1`, JSON.stringify(options.binding ? { body, choice: options.binding } : body))).status).toBe(200);

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
		/** What the bottom buttons show now. */
		main: { text: '', shown: false, enabled: true },
		secondary: { text: '', shown: false },
		secondaryButton: () => {},
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
			enable: () => {
				app.main.enabled = true;
			},
			disable: () => {
				app.main.enabled = false;
			},
		},
		SecondaryButton:
			options.secondary === false
				? undefined
				: {
						setText: (text: string) => {
							app.secondary.text = text;
						},
						onClick: (handler: () => void) => {
							app.secondaryButton = handler;
						},
						show: () => {
							app.secondary.shown = true;
						},
						hide: () => {
							app.secondary.shown = false;
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
	// Pauses of the shell's own asks run at once; the 2 hours of expiry wait for `activated`.
	const timeout = (run: () => void, ms: number) => (ms > 60_000 ? 0 : setTimeout(run, 0));
	const globals = { window, document: window.document, location: window.location, history: window.history, fetch: fetchHost, getComputedStyle: window.getComputedStyle.bind(window), DOMParser: window.DOMParser, setTimeout: timeout, clearTimeout: () => {} };
	new Function(...Object.keys(globals), SHELL_SCRIPT)(...Object.values(globals));
	return { window, document: window.document, app, requests, memory, fetchHost, answer: (status: number) => void answers.push(status) };
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
	expect(notes.querySelector('td img')?.getAttribute('src')).toStartWith(`${ORIGIN}/m/${ID}/g1/0?`);
	expect(notes.querySelectorAll('img')).toHaveLength(1);
	expect(notes.querySelector('p > code')?.textContent).toBe('![example](a|b.png)');
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

/** The text of the line below the content, or null while it is hidden. */
const hintOf = (document: Window['document']) => {
	const hint = document.querySelector('.hint');
	return hint && !hint.hasAttribute('hidden') ? hint.textContent : null;
};
const posts = (requests: string[]) => requests.filter((url) => url.startsWith('/api/answer'));
const labels = mergeLabels();

test('on a bound tab the main button chooses its option and the secondary button closes; an unbound tab and a view without q show Close alone', async () => {
	const bound = await openShell(`/?v=${ID}&q=ask1&t=Mock`, () => false, { binding: BINDING, diff: true });
	await until(() => bound.app.main.text === 'Choose Use mock');
	expect(bound.app.secondary).toEqual({ text: 'Close', shown: true });
	expect(hintOf(bound.document)).toBeNull();
	bound.app.secondaryButton();
	expect(bound.app.calls.at(-1)).toBe('close');

	const unbound = await openShell(`/?v=${ID}&q=ask1&t=Diff`, () => false, { binding: BINDING, diff: true });
	await until(() => unbound.document.querySelector('.diff'));
	expect(unbound.app.main).toEqual({ text: 'Close', shown: true, enabled: true });
	expect(unbound.app.secondary.shown).toBe(false);
	unbound.app.mainButton();
	expect(unbound.app.calls.at(-1)).toBe('close');
	expect(posts(unbound.requests)).toEqual([]);

	const plain = await openShell(`/?v=${ID}&t=Mock`, () => false, { binding: BINDING });
	await until(() => plain.document.querySelector('iframe'));
	expect(plain.app.main.text).toBe('Close');
	expect(plain.app.secondary.shown).toBe(false);
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
	expect(shell.app.main.text).toBe('Close');
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
	// The launch data turns 601 s old while the view stays open.
	setSystemTime(new Date(Date.now() + 601_000));
	stale.app.mainButton();
	await until(() => hintOf(stale.document) === labels.viewExpired);
	setSystemTime();
	expect(stale.app.main.text).toBe('Close');
	expect([...stale.memory.entries.keys()].some((key) => key.startsWith('a:'))).toBe(false);
});

test('a client without SecondaryButton keeps the choose button', async () => {
	const shell = await openShell(`/?v=${ID}&q=ask1&t=Notes`, () => false, { binding: BINDING, secondary: false });
	await until(() => shell.app.main.text === 'Choose Keep notes');
	shell.app.mainButton();
	await until(() => hintOf(shell.document) === labels.chosen);
});

test('a binding that shows late turns the main button into Choose, and one still missing after 10 s shows labels.viewLate', async () => {
	const late = await openShell(`/?v=${ID}&q=ask1&t=Mock`, undefined, { binding: BINDING });
	await until(() => late.document.querySelector('.context'));
	await until(() => late.app.main.text === 'Choose Use mock');
	expect(hintOf(late.document)).toBeNull();

	const missing = await openShell(`/?v=${ID}&q=ask1&t=Mock`, (key) => key === `c:${ID}:ask1`, { binding: BINDING });
	await until(() => missing.document.querySelector('iframe'));
	// The shell's pauses run at once here; its 10 s of asking end once the clock passes them.
	setSystemTime(new Date(Date.now() + 11_000));
	await until(() => hintOf(missing.document) === labels.viewLate);
	expect(missing.app.main.text).toBe('Close');
	expect(missing.app.secondary.shown).toBe(false);
});

test('a closed binding shows Close alone with labels.closed, and the main button closes without a POST', async () => {
	const shell = await openShell(`/?v=${ID}&q=ask1&t=Mock`, () => false, { binding: { ...BINDING, closed: true } });
	await until(() => hintOf(shell.document) === labels.closed);
	expect(shell.app.main).toEqual({ text: 'Close', shown: true, enabled: true });
	expect(shell.app.secondary.shown).toBe(false);
	shell.app.mainButton();
	expect(shell.app.calls.at(-1)).toBe('close');
	expect(posts(shell.requests)).toEqual([]);
});
