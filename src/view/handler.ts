// The view host: a function from a Request to a Response over a storage of 3 methods. It holds
// no bot token, calls nobody and runs on any runtime with the Fetch API and WebCrypto; `./worker`
// is this function on Cloudflare KV.
//
//   GET    /?v=<id>&q=<ref>&t=<label>              the shell, no view content
//   GET    /api/view?v=<id>&q=<ref>                launch data: the view, the context of ref, a signed URL per media
//   GET    /m/<id>/<generation>/<index>?e=&s=      the signature: one media object, with Range
//   PUT    /api/view/<id>                          upload key: the view, which commits its generation
//   PUT    /api/media/<id>/<generation>/<index>?e= upload key: one media object, expiring at e
//   PUT    /api/view/<id>/context/<ref>            upload key: the body of question ref
//   HEAD   /api/view/<id>                          upload key: 200 with the tab labels, or 404
//   DELETE /api/view/<id>                          upload key: the view and its committed media
//   GET    /api/version                            nothing: { version, formats }
//
// A storage may show a key late and keeps a value up to 60 s past its expiry, so every read
// checks the stored expiry too. A media read of a committed view waits up to 10 s for a late
// object, never past its signature's expiry, and then answers the placeholder image. No GET or
// HEAD route writes, deletes or counts: a page may load images from this origin and so call any
// of them.
import { isInt } from '../core/check.ts';
import { mergeLabels } from '../core/labels.ts';
import type { Body, Labels } from '../core/types.ts';
import { isPublicKey, verifyLaunchData } from './launch.ts';
import { MEDIA_URL_LIFE, MEDIA_WAIT, mediaPath, mediaSigned, PLACEHOLDER_SVG, parseRange } from './media.ts';
import { shellPage, shellPolicy, shellScriptHash } from './shell.ts';
import {
	contextIssue,
	decode,
	encode,
	GENERATION,
	INDEX,
	isMediaType,
	isRef,
	isViewId,
	keys,
	parseContext,
	parseManifest,
	parseUpload,
	parseViewRecord,
	sniff,
	tabLabels,
	VERSION,
	VIEW_FORMATS,
	VIEW_LIMITS,
	type ViewRecord,
} from './stored.ts';
import { type CssVars, parseTheme, themeIssue } from './theme.ts';

export { type LaunchVerdict, TELEGRAM_PUBLIC_KEY, verifyLaunchData } from './launch.ts';
export { SHELL_SCRIPT, shellScriptHash } from './shell.ts';
export { type CssVars, parseTheme, themeIssue } from './theme.ts';

/**
 * Where the host keeps views, media and contexts. A `put` replaces one key whole, a `get` may
 * miss a `put` that resolved less than 60 s ago, and a value is gone at the latest 60 s after
 * `expiresAt`. No listing and no transaction.
 */
export type ViewStorage = {
	get(key: string): Promise<{ value: Uint8Array; type?: string } | undefined>;
	put(key: string, value: Uint8Array, options: { expiresAt: number; type?: string }): Promise<void>;
	delete(key: string): Promise<void>;
};

export type ViewHandlerConfig = {
	storage: ViewStorage;
	/** The bot's numeric id, the part of its token before the colon. */
	botId: string;
	/** The Telegram user ids that may open a view. */
	allowedUsers: number[];
	/** The bearer secret of every PUT, HEAD and DELETE route. */
	uploadKey: string;
	/** The HMAC secret of media URLs. */
	mediaKey: string;
	labels?: Partial<Labels>;
	theme?: CssVars;
	/** Telegram's Ed25519 key as 64 hex digits; the production key by default. */
	publicKey?: string;
};

// A refusal is a status and its reason, answered as JSON `{ error }`.
type Status = 400 | 401 | 403 | 404 | 409 | 413 | 415 | 416 | 500;

const SECURITY = { 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' } as const;
const JSON_TYPE = 'application/json; charset=utf-8';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': JSON_TYPE, 'Cache-Control': 'no-store' } });
const refuse = (status: Status, reason: string) => json({ error: reason }, status);
/** A HEAD answer: the status and headers alone. */
const bare = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

/** Every answer gets the two headers of 4.9. */
function secured(response: Response): Response {
	for (const [name, value] of Object.entries(SECURITY)) response.headers.set(name, value);
	return response;
}

/**
 * The value of `promise`, or undefined once `ms` passed or `signal` aborted, whichever comes
 * first. The promise itself may still settle later; its result is then dropped, and a rejection
 * before the end passes on. A promise that started before the budget ran out gets a handler
 * even when it is not awaited, so its later rejection never escapes the request.
 */
function bounded<T>(promise: Promise<T>, ms: number, signal: AbortSignal): Promise<T | undefined> {
	if (ms <= 0 || signal.aborted) {
		promise.catch(() => undefined);
		return Promise.resolve(undefined);
	}
	return new Promise((resolve, reject) => {
		const end = (settle: () => void) => {
			clearTimeout(timer);
			signal.removeEventListener('abort', stop);
			settle();
		};
		const stop = () => end(() => resolve(undefined));
		const timer = setTimeout(stop, ms);
		signal.addEventListener('abort', stop, { once: true });
		promise.then(
			(value) => end(() => resolve(value)),
			(error: unknown) => end(() => reject(error)),
		);
	});
}

/** True when two secrets are equal, compared through their digests in time that does not depend on where they differ. */
async function sameSecret(given: string, expected: string): Promise<boolean> {
	const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
	const [a, b] = await Promise.all([digest(given), digest(expected)]);
	let difference = 0;
	for (let i = 0; i < a.length; i++) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
	return difference === 0;
}

/**
 * The body of a request, read up to `limit` bytes, or undefined once it holds more. A declared
 * `Content-Length` over the limit refuses before a byte is read.
 */
async function readCapped(request: Request, limit: number): Promise<Uint8Array | undefined> {
	const declared = Number(request.headers.get('Content-Length') ?? '0');
	if (declared > limit) return undefined;
	const reader = request.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > limit) {
			await reader.cancel();
			return undefined;
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

// The view upload: the view of at most 2 MiB plus its generation, expiry and 20 media entries.
const UPLOAD_LIMIT = VIEW_LIMITS.viewBytes + 64 * 1024;
// A context: a question body of 3,500 characters, as blocks with their JSON around them.
const CONTEXT_LIMIT = 256 * 1024;

/** Why the configuration cannot serve, or undefined. */
function configIssue(config: ViewHandlerConfig): string | undefined {
	if (!/^\d{1,20}$/.test(config.botId)) return 'botId is the numeric id of the bot';
	if (config.allowedUsers.length === 0 || !config.allowedUsers.every(isInt)) return 'allowedUsers is a list of 1 or more Telegram user ids';
	if (config.uploadKey.length < 16 || config.mediaKey.length < 16) return 'uploadKey and mediaKey have 16 characters or more';
	if (config.publicKey !== undefined && !isPublicKey(config.publicKey)) return 'publicKey is 64 hex digits';
	if (config.theme !== undefined) return themeIssue(config.theme);
	return undefined;
}

/**
 * The view host as a fetch handler over `config.storage`. Throws for a configuration that
 * cannot serve: a bot id that is no number, no allowed user, a secret under 16 characters, a
 * public key that is not 64 hex digits, or a label or theme that breaks its checks.
 *
 *   const handle = createViewHandler({ storage, botId: '222', allowedUsers: [111], uploadKey, mediaKey });
 *   const response = await handle(new Request('https://views.example.com/api/version'));
 */
export function createViewHandler(config: ViewHandlerConfig): (request: Request) => Promise<Response> {
	const issue = configIssue(config);
	if (issue !== undefined) throw new TypeError(`the view host cannot serve: ${issue}`);
	const { storage, botId, allowedUsers, uploadKey, mediaKey } = config;
	const labels = mergeLabels(config.labels);
	const theme = config.theme === undefined ? undefined : parseTheme(config.theme);
	const shell = shellPage({ labels, theme });
	const launch = { botId, allowedUsers: [...allowedUsers], ...(config.publicKey !== undefined ? { publicKey: config.publicKey } : {}) };

	const uploader = async (request: Request) => {
		const header = request.headers.get('Authorization') ?? '';
		return header.startsWith('Bearer ') && (await sameSecret(header.slice(7), uploadKey));
	};

	/** The stored view of `id`, or undefined when it is missing, broken or past its expiry. */
	async function viewOf(id: string): Promise<ViewRecord | undefined> {
		const stored = await storage.get(keys.view(id));
		const record = stored ? parseViewRecord(decode(stored.value)) : undefined;
		return record && record.expiresAt > Date.now() ? record : undefined;
	}

	/**
	 * The media object `index` of a committed generation with its manifest entry, or undefined.
	 * A signed URL names an object its view committed, so while the manifest or the object is not
	 * there yet, the storage is asked again every MEDIA_WAIT.pause ms: every load of the object
	 * waits out a late key, a frame's image as much as the shell's own request. The wait ends at
	 * `until` or when `signal` aborts, and each read and pause gets only the time left, so a slow
	 * storage cannot stretch it. Only an object of the size and type its view declared is served.
	 */
	async function committedMedia(id: string, generation: string, index: number, until: number, signal: AbortSignal) {
		for (;;) {
			if (signal.aborted || Date.now() >= until) return undefined;
			const read = await bounded(Promise.all([storage.get(keys.manifest(id, generation)), storage.get(keys.media(id, generation, index))]), until - Date.now(), signal);
			if (!read) return undefined;
			const [manifestValue, object] = read;
			const manifest = manifestValue ? parseManifest(decode(manifestValue.value)) : undefined;
			if (manifest && manifest.expiresAt <= Date.now()) return undefined;
			const entry = manifest?.media[index];
			if (manifest && !entry) return undefined;
			if (entry && object) return object.value.byteLength === entry.size && object.type === entry.type ? { entry, object } : undefined;
			const left = until - Date.now();
			const paused = new Promise<boolean>((resolve) => setTimeout(() => resolve(true), Math.min(MEDIA_WAIT.pause, left)));
			if (!(await bounded(paused, left, signal))) return undefined;
		}
	}

	async function getShell(url: URL): Promise<Response> {
		return new Response(shell, {
			headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': shellPolicy(url.origin, await shellScriptHash()), 'Cache-Control': 'no-store' },
		});
	}

	async function getView(request: Request, url: URL): Promise<Response> {
		const header = request.headers.get('Authorization') ?? '';
		if (!header.startsWith('tma ')) return refuse(401, 'Authorization is tma <initData>');
		const verdict = await verifyLaunchData(header.slice(4), { ...launch, now: Date.now() });
		if (!verdict.ok) return refuse(401, verdict.reason);
		const id = url.searchParams.get('v') ?? '';
		const ref = url.searchParams.get('q');
		if (!isViewId(id)) return refuse(400, 'v is a view id of 22 base64url characters');
		if (ref !== null && !isRef(ref)) return refuse(400, 'q is a ref of 1 to 32 characters of [A-Za-z0-9_-]');
		const record = await viewOf(id);
		if (!record) return refuse(404, 'no such view');
		const now = Date.now();
		let context: Body | undefined;
		if (ref !== null) {
			const stored = await storage.get(keys.context(id, ref));
			const found = stored ? parseContext(decode(stored.value)) : undefined;
			if (found && found.expiresAt > now) context = found.body;
		}
		const expires = Math.min(now + MEDIA_URL_LIFE, record.expiresAt);
		const media = await Promise.all(record.media.map(async (_entry, index) => `${url.origin}${await mediaPath(mediaKey, { id, generation: record.generation, index, expires })}`));
		return json({ view: record.view, ...(context ? { context } : {}), media, expiresAt: record.expiresAt });
	}

	async function getMedia(request: Request, url: URL, [id, generation, index]: string[]): Promise<Response> {
		const e = url.searchParams.get('e') ?? '';
		const s = url.searchParams.get('s') ?? '';
		if (id === undefined || generation === undefined || index === undefined || !isViewId(id) || !GENERATION.test(generation) || !INDEX.test(index) || !/^\d{1,15}$/.test(e)) {
			return refuse(403, 'the media URL is forged');
		}
		const expires = Number(e);
		const media = { id, generation, index: Number(index), expires };
		if (!(await mediaSigned(mediaKey, media, s))) return refuse(403, 'the media URL is forged');
		const started = Date.now();
		if (expires <= started) return refuse(403, 'the media URL expired');
		// The wait ends at 10 s, at the signature's expiry or when the request is aborted.
		const found = await committedMedia(id, generation, media.index, Math.min(started + MEDIA_WAIT.window, expires), request.signal);
		const now = Date.now();
		if (expires <= now) return refuse(403, 'the media URL expired');
		// A missing object gets the placeholder, so an image inside a page shows it too.
		if (!found) return new Response(PLACEHOLDER_SVG, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'" } });
		const { entry, object } = found;
		const size = object.value.byteLength;
		const headers: Record<string, string> = {
			'Content-Type': entry.type,
			'Accept-Ranges': 'bytes',
			'Cache-Control': `private, max-age=${Math.floor((expires - now) / 1000)}`,
		};
		const range = parseRange(request.headers.get('Range'), size);
		if (range.kind === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
		if (range.kind === 'full') return new Response(object.value.slice(), { headers: { ...headers, 'Content-Length': String(size) } });
		const part = object.value.slice(range.start, range.end + 1);
		return new Response(part, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': String(part.byteLength) } });
	}

	async function putView(request: Request, id: string): Promise<Response> {
		const body = await readCapped(request, UPLOAD_LIMIT);
		if (!body) return refuse(413, `a view upload has at most ${UPLOAD_LIMIT} bytes`);
		const parsed = parseUpload(decode(body), Date.now());
		if (!parsed.ok) return refuse(parsed.kind === 'format' ? 409 : 400, parsed.reason);
		const { generation, expiresAt, media, view } = parsed.upload;
		// The manifest of the generation first, then the view, whose write commits it.
		await storage.put(keys.manifest(id, generation), encode({ v: 1, expiresAt, media }), { expiresAt });
		await storage.put(keys.view(id), encode({ v: 1, generation, expiresAt, media, view }), { expiresAt });
		return json({ id, generation, expiresAt });
	}

	async function putMedia(request: Request, url: URL, [id, generation, index]: string[]): Promise<Response> {
		if (id === undefined || generation === undefined || index === undefined || !isViewId(id) || !GENERATION.test(generation) || !INDEX.test(index) || Number(index) >= VIEW_LIMITS.media) {
			return refuse(400, `the path is /api/media/<view id>/<generation>/<index below ${VIEW_LIMITS.media}>`);
		}
		const e = url.searchParams.get('e') ?? '';
		const expiresAt = Number(e);
		const now = Date.now();
		if (!/^\d{1,15}$/.test(e) || expiresAt <= now || expiresAt > now + VIEW_LIMITS.ahead) return refuse(400, 'e is the expiry in ms, within the next 365 days');
		const declared = (request.headers.get('Content-Type') ?? '').split(';')[0]?.trim().toLowerCase();
		if (!isMediaType(declared)) return refuse(415, 'Content-Type is image/png, image/jpeg, image/webp, image/gif or video/mp4');
		const bytes = await readCapped(request, VIEW_LIMITS.mediaBytes);
		if (!bytes) return refuse(413, `a media file has at most ${VIEW_LIMITS.mediaBytes} bytes`);
		if (bytes.byteLength === 0) return refuse(400, 'a media file has 1 byte or more');
		if (sniff(bytes) !== declared) return refuse(415, `the bytes are no ${declared}`);
		await storage.put(keys.media(id, generation, Number(index)), bytes, { expiresAt, type: declared });
		return json({ size: bytes.byteLength, type: declared });
	}

	async function putContext(request: Request, id: string, ref: string): Promise<Response> {
		if (!isRef(ref)) return refuse(400, 'a ref has 1 to 32 characters of [A-Za-z0-9_-]');
		const bytes = await readCapped(request, CONTEXT_LIMIT);
		if (!bytes) return refuse(413, `a context has at most ${CONTEXT_LIMIT} bytes`);
		const body = decode(bytes);
		const problem = contextIssue(body);
		if (problem !== undefined) return refuse(400, problem);
		// A context lives as long as its view, so a view that is gone takes none.
		const record = await viewOf(id);
		if (!record) return refuse(404, 'no such view');
		await storage.put(keys.context(id, ref), encode({ v: 1, expiresAt: record.expiresAt, body }), { expiresAt: record.expiresAt });
		return json({ id, ref });
	}

	async function headView(id: string): Promise<Response> {
		const record = await viewOf(id);
		if (!record) return bare(404);
		return bare(200, { 'View-Tabs': encodeURIComponent(JSON.stringify(tabLabels(record.view))), 'View-Expires-At': String(record.expiresAt) });
	}

	async function deleteView(id: string): Promise<Response> {
		const record = await viewOf(id);
		if (!record) return refuse(404, 'no such view');
		await storage.delete(keys.view(id));
		await storage.delete(keys.manifest(id, record.generation));
		for (const [index] of record.media.entries()) await storage.delete(keys.media(id, record.generation, index));
		return json({ id, deleted: true });
	}

	/** The route of a request, or 404. Upload routes check the key before they read a byte. */
	async function route(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const { method } = request;
		const parts = url.pathname.split('/').slice(1);
		const [first, second, third, fourth, fifth] = parts;
		if (method === 'GET' && url.pathname === '/') return getShell(url);
		if (method === 'GET' && url.pathname === '/api/version') return json({ version: VERSION, formats: VIEW_FORMATS });
		if (method === 'GET' && url.pathname === '/api/view') return getView(request, url);
		if (method === 'GET' && first === 'm' && parts.length === 4) return getMedia(request, url, parts.slice(1));

		const viewPath = first === 'api' && second === 'view' && third !== undefined;
		const mediaPathed = first === 'api' && second === 'media' && parts.length === 5;
		if (!viewPath && !mediaPathed) return refuse(404, 'no such route');
		if (!(method === 'PUT' || method === 'HEAD' || method === 'DELETE')) return refuse(404, 'no such route');
		if (!(await uploader(request))) return method === 'HEAD' ? bare(401) : refuse(401, 'Authorization is Bearer <upload key>');
		if (mediaPathed) return method === 'PUT' ? putMedia(request, url, parts.slice(2)) : refuse(404, 'no such route');
		if (!isViewId(third ?? '')) return method === 'HEAD' ? bare(400) : refuse(400, 'a view id has 22 base64url characters');
		const id = third ?? '';
		if (parts.length === 3) {
			if (method === 'PUT') return putView(request, id);
			if (method === 'HEAD') return headView(id);
			return deleteView(id);
		}
		if (parts.length === 5 && fourth === 'context' && fifth !== undefined && method === 'PUT') return putContext(request, id, fifth);
		return refuse(404, 'no such route');
	}

	return async (request) => {
		try {
			return secured(await route(request));
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return secured(refuse(500, `the view host failed: ${reason}`));
		}
	};
}
