// The view host: a function from a Request to a Response over a storage of 4 methods. It holds
// no bot token, calls nobody and runs on any runtime with the Fetch API and WebCrypto; `./worker`
// is this function on Cloudflare KV.
//
//   GET    /?v=<id>&q=<ref>&t=<label>              the shell, no view content
//   GET    /api/view?v=<id>&q=<ref>                launch data: the view, the context of ref with its binding, a signed URL per media
//   GET    /m/<id>/<generation>/<index>?e=&s=      the signature: one media object, with Range
//   PUT    /api/view/<id>                          upload key: the view, which commits its generation
//   PUT    /api/media/<id>/<generation>/<index>?e= upload key: one media object, expiring at e
//   PUT    /api/view/<id>/context/<ref>            upload key: the body of question ref, or { body, choice } with its binding
//   HEAD   /api/view/<id>                          upload key: 200 with the tab labels and the expiry, or 404
//   DELETE /api/view/<id>                          upload key: the view and its committed media
//   POST   /api/answer?v=<id>&q=<ref>&n=<index>&c=<choice id>   launch data: stores one choice of a bound option
//   GET    /api/answers                            upload key: every stored choice, read only
//   DELETE /api/answer/<key>                       upload key: one stored choice
//   GET    /api/version                            nothing: { version, formats }, with `answers` among the formats
//
// A storage may show a key late and keeps a value up to 60 s past its expiry, so every read
// checks the stored expiry too. A media read of a committed view waits up to 10 s for a late
// object, never past its signature's expiry, and then answers the placeholder image. No GET or
// HEAD route writes, deletes or counts: a page may load images from this origin and so call any
// of them. The one route that writes without the upload key is the POST of a choice, and it
// needs launch data that Telegram signed for an allowed user.
import { isInt, isRecord } from '../core/check.ts';
import { mergeLabels } from '../core/labels.ts';
import { CHOICE_ID } from '../core/shape.ts';
import type { ChoiceBinding, Labels, StoredChoice, User } from '../core/types.ts';
import { isPublicKey, verifyLaunchData } from './launch.ts';
import { MEDIA_URL_LIFE, MEDIA_WAIT, mediaPath, mediaSigned, PLACEHOLDER_SVG, parseRange } from './media.ts';
import { shellPage, shellPolicy, shellScriptHash } from './shell.ts';
import {
	bindingIssue,
	boundTabs,
	CHOICE_LIMITS,
	type ChoiceRecord,
	contextIssue,
	decode,
	encode,
	GENERATION,
	HOST_FORMATS,
	INDEX,
	isBinding,
	isMediaType,
	isRef,
	isViewId,
	keys,
	parseChoiceKey,
	parseChoiceRecord,
	parseContext,
	parseManifest,
	parseUpload,
	parseViewRecord,
	sniff,
	tabLabels,
	VERSION,
	VIEW_LIMITS,
	type ViewRecord,
} from './stored.ts';
import { type CssVars, parseTheme, themeIssue } from './theme.ts';

export { type LaunchVerdict, TELEGRAM_PUBLIC_KEY, verifyLaunchData } from './launch.ts';
export { SHELL_SCRIPT, shellScriptHash } from './shell.ts';
export { type CssVars, parseTheme, themeIssue } from './theme.ts';

/**
 * Where the host keeps views, media, contexts and choices. A `put` replaces one key whole, a
 * `get` or a `list` may miss a `put` that resolved less than 60 s ago, and a value is gone at the
 * latest 60 s after `expiresAt`. `list` returns every key with the prefix, in any order. No
 * transaction: two writes of one key both land, and the later wins.
 */
export type ViewStorage = {
	get(key: string): Promise<{ value: Uint8Array; type?: string } | undefined>;
	put(key: string, value: Uint8Array, options: { expiresAt: number; type?: string }): Promise<void>;
	delete(key: string): Promise<void>;
	list(prefix: string): Promise<string[]>;
};

export type ViewHandlerConfig = {
	storage: ViewStorage;
	/** The bot's numeric id, the part of its token before the colon. */
	botId: string;
	/** The Telegram user ids that may open a view. */
	allowedUsers: number[];
	/** The bearer secret of every PUT, HEAD and DELETE route and of `GET /api/answers`. */
	uploadKey: string;
	/** The HMAC secret of media URLs. */
	mediaKey: string;
	labels?: Partial<Labels>;
	theme?: CssVars;
	/** Telegram's Ed25519 key as 64 hex digits; the production key by default. */
	publicKey?: string;
};

// A refusal is a status and its reason, answered as JSON `{ error }`.
type Status = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 416 | 429 | 500;

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
// A context: a question body of 3,500 characters, as blocks with their JSON around them, and a binding of 8 options.
const CONTEXT_LIMIT = 256 * 1024;
// The index of a bound option in a choice's query: 0 to 7.
const OPTION = /^[0-7]$/;

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

	/** The user of a request's launch data, or the 401 that refuses it: `Authorization: tma <initData>`, checked as 4.9 says. */
	async function launchUser(request: Request): Promise<User | Response> {
		const header = request.headers.get('Authorization') ?? '';
		if (!header.startsWith('tma ')) return refuse(401, 'Authorization is tma <initData>');
		const verdict = await verifyLaunchData(header.slice(4), { ...launch, now: Date.now() });
		return verdict.ok ? verdict.user : refuse(401, verdict.reason);
	}

	/** The context of `ref` on view `id` while it lives, or undefined. */
	async function contextOf(id: string, ref: string, now: number) {
		const stored = await storage.get(keys.context(id, ref));
		const found = stored ? parseContext(decode(stored.value)) : undefined;
		return found && found.expiresAt > now ? found : undefined;
	}

	async function getView(request: Request, url: URL): Promise<Response> {
		const user = await launchUser(request);
		if (user instanceof Response) return user;
		const id = url.searchParams.get('v') ?? '';
		const ref = url.searchParams.get('q');
		if (!isViewId(id)) return refuse(400, 'v is a view id of 22 base64url characters');
		if (ref !== null && !isRef(ref)) return refuse(400, 'q is a ref of 1 to 32 characters of [A-Za-z0-9_-]');
		const record = await viewOf(id);
		if (!record) return refuse(404, 'no such view');
		const now = Date.now();
		const context = ref !== null ? await contextOf(id, ref, now) : undefined;
		const expires = Math.min(now + MEDIA_URL_LIFE, record.expiresAt);
		const media = await Promise.all(record.media.map(async (_entry, index) => `${url.origin}${await mediaPath(mediaKey, { id, generation: record.generation, index, expires })}`));
		const shown = context ? { context: context.body, ...(context.choice ? { choice: context.choice } : {}) } : {};
		return json({ view: record.view, ...shown, media, expiresAt: record.expiresAt });
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

	/**
	 * A context: the body alone, or `{ body, choice }` for a question answered in the view. An open
	 * binding names tabs of the view as it is now, so a choice can only pick a tab the view has. A
	 * closed binding enables no choice, so it is checked for its structure alone: a view replaced
	 * without one of its tabs still takes the close of a question that bound it.
	 */
	async function putContext(request: Request, id: string, ref: string): Promise<Response> {
		if (!isRef(ref)) return refuse(400, 'a ref has 1 to 32 characters of [A-Za-z0-9_-]');
		const bytes = await readCapped(request, CONTEXT_LIMIT);
		if (!bytes) return refuse(413, `a context has at most ${CONTEXT_LIMIT} bytes`);
		const value = decode(bytes);
		// A body never has a key `body`, so the two forms cannot be mistaken.
		const wrapped = isRecord(value) && 'body' in value;
		if (wrapped && Object.keys(value).some((key) => key !== 'body' && key !== 'choice')) return refuse(400, 'a context is a body, or { body, choice }');
		const body = wrapped ? value.body : value;
		const choice = wrapped ? value.choice : undefined;
		const problem = contextIssue(body);
		if (problem !== undefined) return refuse(400, problem);
		// A context lives as long as its view, so a view that is gone takes none.
		const record = await viewOf(id);
		if (!record) return refuse(404, 'no such view');
		const tabs = isRecord(choice) && choice.closed === true ? boundTabs(choice) : tabLabels(record.view);
		if (choice !== undefined && !isBinding(choice, tabs)) return refuse(400, bindingIssue(choice, tabs) ?? 'the binding breaks its type');
		await storage.put(keys.context(id, ref), encode({ v: 1, expiresAt: record.expiresAt, body, ...(choice !== undefined ? { choice } : {}) }), { expiresAt: record.expiresAt });
		return json({ id, ref });
	}

	/**
	 * One choice from the view, with launch data: the context of the ref holds a binding with
	 * option `n` that is not closed, and the host's clock lies before the binding's expiry. A
	 * closed or expired binding answers 410 without a write. The choice is stored under
	 * its id until the later of its view's expiry and 1 day after now, so it outlasts a listener
	 * that was down. A choice id that is already listed is answered as stored without a write. A
	 * ref with 32 listed choices takes no more.
	 */
	async function postAnswer(request: Request, url: URL): Promise<Response> {
		const user = await launchUser(request);
		if (user instanceof Response) return user;
		const query = (name: string) => url.searchParams.get(name) ?? '';
		const [id, ref, n, c] = [query('v'), query('q'), query('n'), query('c')] as const;
		if (!isViewId(id) || !isRef(ref) || !OPTION.test(n) || !CHOICE_ID.test(c)) {
			return refuse(400, 'the query is v=<view id>&q=<ref>&n=<option index 0 to 7>&c=<choice id of 22 base64url characters>');
		}
		if (!(await readCapped(request, 0))) return refuse(413, 'a choice has an empty body');
		const record = await viewOf(id);
		if (!record) return refuse(404, 'no such view');
		const now = Date.now();
		const binding: ChoiceBinding | undefined = (await contextOf(id, ref, now))?.choice;
		if (!binding) return refuse(404, `question ${ref} takes no answer in this view`);
		const index = Number(n);
		if (!binding.options.some((option) => option.index === index)) return refuse(400, `question ${ref} has no option ${index}`);
		if (binding.closed === true || (binding.expiresAt !== undefined && now >= binding.expiresAt)) return refuse(410, `question ${ref} is closed`);
		const key = keys.choice(id, ref, c);
		const listed = await storage.list(keys.choices(id, ref));
		const stored = { view: id, ref, choice: c, stored: true };
		if (listed.includes(key)) return json(stored);
		if (listed.length >= CHOICE_LIMITS.perRef) return refuse(429, `question ${ref} holds ${listed.length} choices that are not applied yet`);
		const expiresAt = Math.max(record.expiresAt, now + CHOICE_LIMITS.life);
		const choice: ChoiceRecord = { v: 1, expiresAt, index, user, at: now };
		await storage.put(key, encode(choice), { expiresAt });
		return json(stored);
	}

	/** Every stored choice that lives, with its key. Reads only. */
	async function getAnswers(): Promise<Response> {
		const now = Date.now();
		const choices: StoredChoice[] = [];
		for (const key of await storage.list(keys.choices())) {
			const named = parseChoiceKey(key);
			const stored = named ? await storage.get(key) : undefined;
			const record = stored ? parseChoiceRecord(decode(stored.value)) : undefined;
			if (named && record && record.expiresAt > now) choices.push({ key, ...named, index: record.index, user: record.user, at: record.at });
		}
		return json({ choices });
	}

	/** Deletes one stored choice. A choice that is gone already answers the same. */
	async function deleteAnswer(encoded: string): Promise<Response> {
		let key: string;
		try {
			key = decodeURIComponent(encoded);
		} catch {
			key = '';
		}
		if (!parseChoiceKey(key)) return refuse(400, 'the key is a:<view id>:<ref>:<choice id>');
		await storage.delete(key);
		return json({ key, deleted: true });
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
		if (method === 'GET' && url.pathname === '/api/version') return json({ version: VERSION, formats: HOST_FORMATS });
		if (method === 'GET' && url.pathname === '/api/view') return getView(request, url);
		if (method === 'GET' && first === 'm' && parts.length === 4) return getMedia(request, url, parts.slice(1));
		if (method === 'POST' && url.pathname === '/api/answer') return postAnswer(request, url);
		const answers = method === 'GET' && url.pathname === '/api/answers';
		const answer = method === 'DELETE' && first === 'api' && second === 'answer' && parts.length === 3 && third !== undefined;
		if (answers || answer) {
			if (!(await uploader(request))) return refuse(401, 'Authorization is Bearer <upload key>');
			return answers ? getAnswers() : deleteAnswer(third ?? '');
		}

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
