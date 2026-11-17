// The view probe: a Cloudflare Worker that serves one stored view to ALLOWED_USER inside
// Telegram and stores what the phone observed while showing it. `publish.ts` PUTs a view and
// sends its Web App button; the shell at `GET /?v=<id>` fetches the view with the launch data,
// draws a text tab and a sandboxed page tab, and POSTs its observations to `/api/report`.
// `/hit` logs any request the sandboxed page manages to make. The bearer routes read it all back.
// Launch data is checked as a third party, by Telegram's Ed25519 signature, without the bot token.
// https://core.telegram.org/bots/webapps#validating-data-for-third-party-use
// workerd takes every value this module exports as an entrypoint, so it exports only the handler.

/** The part of a Workers KV binding the probe uses. */
export type Kv = {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
	list(options: { prefix: string; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
};

export type Env = {
	VIEWS: Kv;
	/** The bot's numeric ID, the part of its token before the colon. */
	BOT_ID: string;
	/** The one Telegram user ID the view is served to. */
	ALLOWED_USER: string;
	/** The bearer token of the write and read routes, a Worker secret. */
	READ_KEY: string;
	/** An Ed25519 public key as hex for tests; Telegram's production key without it. */
	PUBLIC_KEY?: string;
};

/** Telegram's production Ed25519 public key for third-party validation, as hex. */
const TELEGRAM_KEY = 'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d';
const MAX_AGE = 600;
const MAX_SKEW = 60;
const DAY = 86400;
const ID = /^[A-Za-z0-9_-]{22}$/;

type Verdict = { ok: true; authDate: number; hasSignature: boolean } | { ok: false; reason: string };

async function importKey(hex: string): Promise<CryptoKey> {
	if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('an Ed25519 public key is 64 hex digits');
	const bytes = new Uint8Array(32);
	for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
	return crypto.subtle.importKey('raw', bytes, { name: 'Ed25519' }, false, ['verify']);
}

/** Base64url without padding to bytes; undefined for any other text. */
function base64url(text: string): Uint8Array<ArrayBuffer> | undefined {
	if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
	const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/**
 * Checks `initData` as Telegram's client sent it: every field once, an Ed25519 signature of bot
 * `botId` over `<botId>:WebAppData`, then every field except `hash` and `signature` as
 * `key=value` with its decoded value, sorted by key, one per line; `auth_date` at most MAX_AGE
 * seconds old and MAX_SKEW ahead; `user.id` equal to `userId`.
 */
async function verifyInitData(initData: string, opts: { botId: string; publicKey: CryptoKey; userId: number; nowSeconds: number }): Promise<Verdict> {
	const fail = (reason: string): Verdict => ({ ok: false, reason });
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
	const data = new TextEncoder().encode(`${opts.botId}:WebAppData\n${lines.join('\n')}`);
	if (!(await crypto.subtle.verify({ name: 'Ed25519' }, opts.publicKey, signature, data))) return fail('bad signature');

	const authDate = fields.get('auth_date');
	if (authDate === undefined || !/^\d{1,12}$/.test(authDate)) return fail('auth_date is not a time in seconds');
	const age = opts.nowSeconds - Number(authDate);
	if (age > MAX_AGE) return fail(`auth_date is ${age} s old`);
	if (age < -MAX_SKEW) return fail(`auth_date is ${-age} s ahead`);

	let user: unknown;
	try {
		user = JSON.parse(fields.get('user') ?? '');
	} catch {
		return fail('user is not JSON');
	}
	const id = typeof user === 'object' && user !== null && 'id' in user ? user.id : undefined;
	if (id !== opts.userId) return fail('user is not the allowed user');
	return { ok: true, authDate: Number(authDate), hasSignature: fields.has('signature') };
}

// The one inline script of the shell; the CSP names it by the SHA-256 of this exact text. It runs
// first in <head>: it registers the violation and message listeners before the SDK loads, and
// does the rest on DOMContentLoaded, after the SDK has read the launch data from the fragment.
// It holds no backticks, `${` or backslashes, so the template literal keeps it verbatim.
const SHELL_SCRIPT = `
const seen = {
	platform: null, version: null, colorScheme: null, initDataLength: 0, hasSignatureField: false,
	fragmentRemoved: false, sessionStorageKeys: [], viewFetchStatus: null, viewFetchMs: null,
	notFoundRetries: 0, frameLoaded: false, frameContentAccessible: null, violations: [],
	messagesFromFrame: 0, userAgent: navigator.userAgent,
};
document.addEventListener('securitypolicyviolation', (event) => {
	if (seen.violations.length < 100) seen.violations.push({ violatedDirective: event.violatedDirective, blockedURI: event.blockedURI, disposition: event.disposition });
});
window.addEventListener('message', () => { seen.messagesFromFrame++; });

document.addEventListener('DOMContentLoaded', () => {
	const app = window.Telegram && window.Telegram.WebApp;
	const status = document.getElementById('status');
	const log = document.getElementById('log');
	const view = new URLSearchParams(location.search).get('v');
	const initData = app ? app.initData : '';
	if (app) Object.assign(seen, { platform: app.platform, version: app.version, colorScheme: app.colorScheme });
	seen.initDataLength = initData.length;
	seen.hasSignatureField = new URLSearchParams(initData).has('signature');
	history.replaceState(null, '', location.pathname + location.search);
	seen.fragmentRemoved = location.hash === '';
	if (!initData) { status.textContent = 'Only in Telegram'; return; }
	if (view === null || !/^[A-Za-z0-9_-]{22}$/.test(view)) { status.textContent = 'No such view'; return; }
	app.ready();
	app.expand();
	const auth = { Authorization: 'tma ' + initData };
	let frame = null;
	let shown = null;
	let pageShown = false;

	function storageKeys() {
		try {
			const keys = [];
			for (let i = 0; i < sessionStorage.length; i++) keys.push(sessionStorage.key(i));
			return keys;
		} catch (error) {
			return ['<throws: ' + error.name + '>'];
		}
	}
	function frameAccess() {
		if (!frame) return null;
		try {
			return frame.contentDocument === null ? 'null' : 'accessible';
		} catch (error) {
			return 'throws';
		}
	}
	// Sends every observation so far, with what caused the report and the shown tab.
	function report(trigger) {
		Object.assign(seen, { sessionStorageKeys: storageKeys(), frameContentAccessible: frameAccess() });
		const body = JSON.stringify(Object.assign({ trigger: trigger, tab: shown, reportedAt: Date.now() }, seen));
		fetch('/api/report?v=' + view, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, auth), body: body })
			.then((response) => { log.textContent = 'report ' + trigger + ': ' + response.status; }, (error) => { log.textContent = 'report ' + trigger + ': ' + error.message; });
	}

	// Fetches the view; a 404 retries every second until 15 s have passed since the first try.
	async function load() {
		const start = performance.now();
		for (;;) {
			let response;
			try {
				response = await fetch('/api/view?v=' + view, { headers: auth });
			} catch (error) {
				seen.viewFetchStatus = 0;
				seen.viewFetchMs = Math.round(performance.now() - start);
				return { error: error.message };
			}
			if (response.status === 404 && performance.now() - start + 1000 <= 15000) {
				seen.notFoundRetries++;
				await new Promise((resolve) => setTimeout(resolve, 1000));
				continue;
			}
			seen.viewFetchStatus = response.status;
			seen.viewFetchMs = Math.round(performance.now() - start);
			return response.ok ? { view: await response.json() } : { error: response.status + ' ' + (await response.text()) };
		}
	}

	// Tab 1 is the markdown as one text node; tab 2 is the page in an iframe with an empty
	// sandbox and its own early policy, built when the tab first shows.
	function draw(data) {
		const tabs = document.createElement('div');
		tabs.id = 'tabs';
		const panels = {
			markdown: document.createElement('pre'),
			page: document.createElement('div'),
		};
		panels.markdown.textContent = data.markdown;
		panels.page.id = 'page';
		const buttons = {};
		for (const [name, label] of [['markdown', 'markdown tab'], ['page', 'page tab']]) {
			const button = document.createElement('button');
			button.type = 'button';
			button.textContent = label;
			button.addEventListener('click', () => select(name));
			buttons[name] = button;
			tabs.append(button);
		}
		function select(name) {
			if (name === shown) return;
			const first = shown === null;
			shown = name;
			for (const key of Object.keys(panels)) {
				panels[key].hidden = key !== name;
				buttons[key].setAttribute('aria-selected', String(key === name));
			}
			if (name === 'page' && !frame) {
				frame = document.createElement('iframe');
				frame.setAttribute('sandbox', '');
				frame.addEventListener('load', () => { seen.frameLoaded = true; });
				const origin = location.origin;
				frame.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src ' + "'none'" + '; style-src ' + "'unsafe-inline'" + '; img-src data: ' + origin + '; media-src ' + origin + '; font-src data:">' + data.page;
				panels.page.append(frame);
			}
			if (name === 'page' && !pageShown) {
				pageShown = true;
				setTimeout(() => report('timer'), 3000);
			} else if (!first) {
				report('switch');
			}
		}
		document.body.replaceChildren(tabs, panels.markdown, panels.page, log);
		select('page');
	}

	load().then((result) => {
		if (result.view) {
			draw(result.view);
		} else {
			status.textContent = 'View fetch failed: ' + result.error;
			report('fetch-failed');
		}
	});
});
`;

const SHELL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>View probe</title>
<script>${SHELL_SCRIPT}</script>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
html, body { margin: 0; height: 100%; font: 16px/1.5 system-ui, -apple-system, sans-serif; background: var(--tg-theme-bg-color, #ffffff); color: var(--tg-theme-text-color, #000000); }
body { display: flex; flex-direction: column; }
#status, #log { padding: 8px 16px; font-size: 13px; }
#tabs { display: flex; gap: 8px; padding: 12px; }
#tabs button { flex: 1; min-height: 44px; border: 0; border-radius: 22px; font: inherit; background: var(--tg-theme-secondary-bg-color, #e5e5ea); color: inherit; }
#tabs button[aria-selected="true"] { background: var(--tg-theme-button-color, #007aff); color: var(--tg-theme-button-text-color, #ffffff); }
pre { flex: 1; margin: 0 12px; padding: 12px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
#page { flex: 1; display: flex; margin: 0 12px; }
#page[hidden], pre[hidden] { display: none; }
iframe { flex: 1; border: 0; background: #ffffff; }
</style>
</head>
<body>
<p id="status">Loading</p>
<p id="log"></p>
</body>
</html>
`;

let shellHash: Promise<string> | undefined;
/** The CSP source of the shell script, `sha256-<base64>`, computed once per isolate. */
function scriptHash(): Promise<string> {
	shellHash ??= crypto.subtle.digest('SHA-256', new TextEncoder().encode(SHELL_SCRIPT)).then((digest) => `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`);
	return shellHash;
}

const shellPolicy = (origin: string, hash: string) =>
	`default-src 'none'; script-src '${hash}' https://telegram.org; style-src 'unsafe-inline'; img-src data: ${origin}; media-src ${origin}; font-src data:; connect-src 'self'; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'`;

const text = (body: string, status: number) => new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
// A transparent 1x1 GIF.
const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (char) => char.charCodeAt(0));

/** Every value under `prefix`, following the list cursor, as `{ key, value }` with parsed JSON. */
async function readAll(kv: Kv, prefix: string): Promise<{ key: string; value: unknown }[]> {
	const out: { key: string; value: unknown }[] = [];
	let cursor: string | undefined;
	for (;;) {
		const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
		for (const { name } of page.keys) {
			const value = await kv.get(name);
			if (value !== null) out.push({ key: name, value: JSON.parse(value) });
		}
		if (page.list_complete || !page.cursor) return out;
		cursor = page.cursor;
	}
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const parseObject = (body: string): Record<string, unknown> | undefined => {
	try {
		const value: unknown = JSON.parse(body);
		return isObject(value) ? value : undefined;
	} catch {
		return undefined;
	}
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const { pathname } = url;
		const id = url.searchParams.get('v');
		const route = `${request.method} ${pathname}`;
		const bearer = () => env.READ_KEY.length > 0 && request.headers.get('Authorization') === `Bearer ${env.READ_KEY}`;
		const launch = async (): Promise<Verdict> => {
			const authorization = request.headers.get('Authorization');
			if (!authorization) return { ok: false, reason: 'missing authorization' };
			if (!authorization.startsWith('tma ')) return { ok: false, reason: 'authorization is not tma <initData>' };
			return verifyInitData(authorization.slice(4), {
				botId: env.BOT_ID,
				publicKey: await importKey(env.PUBLIC_KEY ?? TELEGRAM_KEY),
				userId: Number(env.ALLOWED_USER),
				nowSeconds: Math.floor(Date.now() / 1000),
			});
		};

		if (route === 'GET /') {
			return new Response(SHELL_HTML, {
				headers: {
					'Content-Type': 'text/html; charset=utf-8',
					'Content-Security-Policy': shellPolicy(url.origin, await scriptHash()),
					'Referrer-Policy': 'no-referrer',
					'X-Content-Type-Options': 'nosniff',
					'Cache-Control': 'no-store',
				},
			});
		}

		if (route === 'GET /api/view' || route === 'POST /api/report') {
			const verdict = await launch();
			if (!verdict.ok) return text(verdict.reason, 401);
			if (id === null || !ID.test(id)) return text('not found', 404);
			if (request.method === 'POST') {
				const body = await request.text();
				if (body.length > 32768) return text('report is over 32 KiB', 413);
				if (!parseObject(body)) return text('report is not a JSON object', 400);
				await env.VIEWS.put(`report:${id}:${Date.now()}`, body, { expirationTtl: DAY });
				return json({ stored: true });
			}
			const stored = await env.VIEWS.get(`view:${id}`);
			if (stored === null) return text('not found', 404);
			const authAgeSeconds = Math.floor(Date.now() / 1000) - verdict.authDate;
			return json({ ...parseObject(stored), verified: true, hasSignature: verdict.hasSignature, authAgeSeconds });
		}

		if (request.method === 'PUT' && pathname.startsWith('/api/view/')) {
			if (!bearer()) return text('missing or wrong bearer', 401);
			const viewId = pathname.slice('/api/view/'.length);
			if (!ID.test(viewId)) return text('the id is 22 base64url characters', 400);
			const view = parseObject(await request.text());
			if (typeof view?.markdown !== 'string' || typeof view.page !== 'string') return text('the body is { markdown: string, page: string }', 400);
			await env.VIEWS.put(`view:${viewId}`, JSON.stringify({ markdown: view.markdown, page: view.page }), { expirationTtl: DAY });
			return json({ storedAt: Date.now() });
		}

		if (route === 'GET /api/reports') {
			if (!bearer()) return text('missing or wrong bearer', 401);
			if (id === null || !ID.test(id)) return text('not found', 404);
			return json(await readAll(env.VIEWS, `report:${id}:`));
		}

		if (route === 'GET /api/hits') {
			if (!bearer()) return text('missing or wrong bearer', 401);
			return json(await readAll(env.VIEWS, 'hit:'));
		}

		// Records the request as `hit:<label>:<ms>` with the headers that say what made it.
		if (route === 'GET /hit') {
			const label = (url.searchParams.get('from') ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'unlabelled';
			const seen = {
				at: Date.now(),
				dest: request.headers.get('Sec-Fetch-Dest'),
				mode: request.headers.get('Sec-Fetch-Mode'),
				site: request.headers.get('Sec-Fetch-Site'),
				referer: request.headers.get('Referer'),
				userAgent: request.headers.get('User-Agent'),
			};
			await env.VIEWS.put(`hit:${label}:${seen.at}`, JSON.stringify(seen), { expirationTtl: DAY });
			return new Response(GIF, { headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' } });
		}

		return text('not found', 404);
	},
};
