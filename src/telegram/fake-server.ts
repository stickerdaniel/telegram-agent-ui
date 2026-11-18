// A Bot API server over HTTP for tests, not part of the package. It keeps what each message
// shows, long-polls getUpdates, confirms updates below an offset, ends an older poll with 409
// when a newer one arrives, refuses getUpdates with 409 while a webhook is set, answers 401 to a
// revoked token, and answers a call from a script, such as 429 with `retry_after`. The messages
// and updates follow facts/records/: a bot 222, a private chat 111 with user 111, the replied-to
// message inside a reply with its keyboard, as Telegram for iOS sends it, a file message with
// its photo, video or document, its caption and the message it replies to, one message per file
// of an album with one `media_group_id`, and record 08's refusal of a caption over 1,024
// characters. getFile answers for the files `file` registers, and `/file/bot<token>/<path>`
// serves them, records each download as the method `download`, and can redirect, hide the size
// or cut a transfer off. getMe reports topic mode while `setTopics(true)` holds.
import captionRefused from '../../facts/records/08-caption-1025.json';
import { isRecord } from '../core/check.ts';
import { NOT_MODIFIED } from '../core/classify.ts';

export const TOKEN = '222:fake-token';
const BOT = { id: 222, is_bot: true, first_name: 'Probe', username: 'probe_bot' };
const PERSON = { id: 111, is_bot: false, first_name: 'Dana' };
const DATE = 1794908513;
const CONFLICT = 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running';
const WEBHOOK_CONFLICT = "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first";
// The file methods and the kind of file each sends.
const FILE_SENDS: Record<string, 'photo' | 'video' | 'document'> = { sendPhoto: 'photo', sendVideo: 'video', sendDocument: 'document' };
const CAPTION_LIMIT = 1_024;

/** One call as the server received it. `at` is the time it arrived, `files` the uploaded parts. */
export type Received = { method: string; payload: Record<string, unknown>; files: { field: string; name: string; type: string; bytes: Uint8Array }[]; at: number };
/** A scripted answer: a refusal with its HTTP status and description, and `retryAfter` in seconds for a 429. */
export type Scripted = { status: number; description?: string; retryAfter?: number };
type Message = Record<string, unknown> & { message_id: number; chat: { id: number; type: string; first_name: string } };
/** An update as the server sends it: JSON with its id. */
export type FakeUpdate = Record<string, unknown> & { update_id: number };

const json = (status: number, body: unknown) => Response.json(body, { status });
const ok = (result: unknown) => json(200, { ok: true, result });
const refusal = (status: number, description: string, retryAfter?: number) =>
	json(status, { ok: false, error_code: status, description, ...(retryAfter !== undefined ? { parameters: { retry_after: retryAfter } } : {}) });
const parsed = (value: string): unknown => {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
};

type Upload = Received['files'][number];
/** One file a files call sends: its kind, its caption and its uploaded part. */
type Item = { kind: string; caption: unknown; file: Upload | undefined };

/** The files a call of `method` sends, in order: the items of an album's `media`, else the one file of its field. */
function itemsOf(method: string, payload: Record<string, unknown>, files: Upload[]): Item[] {
	const single = FILE_SENDS[method];
	if (single) return [{ kind: single, caption: payload.caption, file: files.find((file) => file.field === single) }];
	const media = Array.isArray(payload.media) ? payload.media : [];
	return media.map((entry: unknown) => {
		const item = isRecord(entry) ? entry : {};
		const field = typeof item.media === 'string' ? item.media.replace(/^attach:\/\//, '') : '';
		return { kind: String(item.type), caption: item.caption, file: files.find((file) => file.field === field) };
	});
}

/** The content of a file message as records 06 and 07 show it: a photo as its sizes, a video or a document with its name. */
function contentOf(item: Item, id: string): Record<string, unknown> {
	const size = item.file?.bytes.length ?? 0;
	const named = { file_id: id, file_unique_id: id, file_name: item.file?.name ?? '', mime_type: item.file?.type ?? '', file_size: size };
	if (item.kind === 'photo') return { photo: [{ file_id: id, file_unique_id: id, file_size: size, width: 64, height: 64 }] };
	if (item.kind === 'video') return { video: { ...named, width: 64, height: 64, duration: 1 } };
	return { document: named };
}

/** The request's fields and files: JSON, or multipart with each field's JSON read back. */
async function read(request: Request): Promise<Pick<Received, 'payload' | 'files'>> {
	const type = request.headers.get('content-type') ?? '';
	if (type.startsWith('multipart/form-data')) {
		const payload: Record<string, unknown> = {};
		const files: Received['files'] = [];
		for (const [field, value] of await request.formData()) {
			if (typeof value === 'string') payload[field] = parsed(value);
			else files.push({ field, name: value.name, type: value.type, bytes: new Uint8Array(await value.arrayBuffer()) });
		}
		return { payload, files };
	}
	const text = await request.text();
	const body = text === '' ? {} : parsed(text);
	return { payload: isRecord(body) ? body : {}, files: [] };
}

/**
 * Starts the server on a free local port. `url` is the root to give a transport as its apiUrl.
 * `stop()` ends it and every open poll.
 *
 *   const server = fakeBotApi();
 *   const call = fetchCall({ token: TOKEN, apiUrl: server.url });
 *   server.tap(1001, 0); // the next getUpdates returns a tap on button 0 of message 1001
 */
export function fakeBotApi() {
	const messages = new Map<number, Message>();
	const queue: FakeUpdate[] = [];
	const received: Received[] = [];
	const scripts = new Map<string, Scripted[]>();
	const stalls = new Map<string, Promise<void>>();
	let nextUpdate = 125546275;
	let nextMessage = 1000;
	let nextTopic = 40;
	let nextGroup = 14359268162828234;
	let webhook = '';
	let revoked = false;
	let topics = false;
	/** The files getFile knows, by file id: the path it names, the bytes the download serves, and how a download ends. */
	const served = new Map<string, { unique: string; path: string; bytes: Uint8Array; size?: number; end?: 'redirect' | 'cut' | 'unsized' }>();
	const ICONS = [
		{ custom_emoji_id: '5312536423851630001', emoji: '💡' },
		{ custom_emoji_id: '5312241539987020022', emoji: '✅' },
	];
	let poll: { respond: (response: Response) => void; timer: ReturnType<typeof setTimeout> } | undefined;

	const chatOf = (id: unknown) => ({ id: typeof id === 'number' ? id : 111, first_name: PERSON.first_name, type: 'private' });

	function newMessage(payload: Record<string, unknown>, content: Record<string, unknown>): Message {
		const stored: Message = { message_id: ++nextMessage, from: BOT, chat: chatOf(payload.chat_id), date: DATE, ...content };
		messages.set(stored.message_id, stored);
		return stored;
	}

	/**
	 * A files call: one message per file, each replying to the message `reply_parameters` names
	 * when it exists, an album's under one `media_group_id`. A caption over 1,024 characters
	 * refuses the whole call, as record 08 shows.
	 */
	function sendFiles(method: string, payload: Record<string, unknown>, files: Upload[]): Response {
		const items = itemsOf(method, payload, files);
		if (items.some((item) => typeof item.caption === 'string' && item.caption.length > CAPTION_LIMIT)) return refusal(captionRefused.status, captionRefused.body.description);
		const replyTo = isRecord(payload.reply_parameters) ? messages.get(Number(payload.reply_parameters.message_id)) : undefined;
		const group = method === 'sendMediaGroup' ? { media_group_id: String(++nextGroup) } : {};
		const sent = items.map((item) =>
			newMessage(payload, {
				...(replyTo ? { reply_to_message: structuredClone(replyTo) } : {}),
				...group,
				...contentOf(item, `${item.kind}-${nextMessage + 1}`),
				...(typeof item.caption === 'string' ? { caption: item.caption } : {}),
			}),
		);
		return ok(method === 'sendMediaGroup' ? sent : sent[0]);
	}

	/** Answers the open poll with every queued update. */
	function deliver(): void {
		if (!poll || queue.length === 0) return;
		const open = poll;
		poll = undefined;
		clearTimeout(open.timer);
		open.respond(ok([...queue]));
	}

	function getUpdates(payload: Record<string, unknown>): Response | Promise<Response> {
		if (webhook !== '') return refusal(409, WEBHOOK_CONFLICT);
		if (poll) {
			// Telegram gives the updates to the newest poll and ends the older one.
			clearTimeout(poll.timer);
			poll.respond(refusal(409, CONFLICT));
			poll = undefined;
		}
		const offset = typeof payload.offset === 'number' ? payload.offset : undefined;
		if (offset !== undefined) queue.splice(0, queue.length, ...queue.filter((update) => update.update_id >= offset));
		if (queue.length > 0) return ok([...queue]);
		const timeout = typeof payload.timeout === 'number' ? payload.timeout : 0;
		return new Promise<Response>((respond) => {
			const timer = setTimeout(() => {
				if (poll?.timer === timer) poll = undefined;
				respond(ok([]));
			}, timeout * 1000);
			poll = { respond, timer };
		});
	}

	function answer(method: string, payload: Record<string, unknown>, files: Received['files']): Response | Promise<Response> {
		switch (method) {
			case 'getMe':
				return ok({ ...BOT, ...(topics ? { has_topics_enabled: true } : {}) });
			case 'getFile': {
				const file = served.get(String(payload.file_id));
				if (!file) return refusal(400, 'Bad Request: invalid file_id');
				return ok({ file_id: payload.file_id, file_unique_id: file.unique, file_size: file.size ?? file.bytes.length, file_path: file.path });
			}
			case 'createForumTopic':
				return ok({ message_thread_id: ++nextTopic, name: payload.name, icon_color: 7322096 });
			case 'getForumTopicIconStickers':
				return ok(ICONS.map((icon) => ({ ...icon, file_id: `icon-${icon.custom_emoji_id}`, file_unique_id: `u-${icon.custom_emoji_id}`, type: 'custom_emoji', width: 512, height: 512, is_animated: false, is_video: false })));
			case 'getWebhookInfo':
				return ok({ url: webhook, has_custom_certificate: false, pending_update_count: queue.length });
			case 'getUpdates':
				return getUpdates(payload);
			case 'editMessageText': {
				const stored = messages.get(Number(payload.message_id));
				if (!stored) return refusal(400, 'Bad Request: message to edit not found');
				const before = JSON.stringify([stored.rich_message, stored.reply_markup]);
				stored.rich_message = payload.rich_message;
				if (payload.reply_markup === undefined) delete stored.reply_markup;
				else stored.reply_markup = payload.reply_markup;
				if (before === JSON.stringify([stored.rich_message, stored.reply_markup])) return refusal(400, `Bad Request: ${NOT_MODIFIED}: specified new message content and reply markup are exactly the same`);
				return ok({ ...stored, edit_date: DATE + 1 });
			}
			case 'sendRichMessage':
				return ok(newMessage(payload, { rich_message: payload.rich_message, ...(payload.reply_markup !== undefined ? { reply_markup: payload.reply_markup } : {}) }));
			default:
				if (method === 'sendMediaGroup' || method in FILE_SENDS) return sendFiles(method, payload, files);
				return ok(true);
		}
	}

	/** A download: the file of `path`, a redirect to another route, the file as a stream without its size, or the first half of it and a cut connection. */
	async function serveFile(token: string, path: string): Promise<Response> {
		received.push({ method: 'download', payload: { path }, files: [], at: Date.now() });
		await stalls.get('download');
		if (revoked || token !== TOKEN) return json(401, { ok: false, error_code: 401, description: 'Unauthorized' });
		const file = [...served.values()].find((candidate) => candidate.path === path);
		if (!file) return json(404, { ok: false, error_code: 404, description: 'Not Found' });
		if (file.end === 'redirect') return new Response(null, { status: 302, headers: { location: `${url}/file/bot${TOKEN}/elsewhere` } });
		if (file.end === 'unsized') {
			// A stream whose second part comes later goes out chunked: no Content-Length names its
			// size, which shows only as the bytes arrive. Bun gives a stream it can read at once,
			// such as a Blob's, the header.
			const parts = [file.bytes.slice(0, 8), file.bytes.slice(8)];
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					const part = parts.shift();
					if (!part) return controller.close();
					controller.enqueue(part);
					await Bun.sleep(20);
				},
			});
			return new Response(body, { headers: { 'content-type': 'application/octet-stream' } });
		}
		if (file.end !== 'cut') return new Response(file.bytes, { headers: { 'content-type': 'application/octet-stream' } });
		const half = file.bytes.slice(0, Math.floor(file.bytes.length / 2));
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(half);
				setTimeout(() => controller.error(new Error('the connection was cut')), 50);
			},
		});
		return new Response(body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(file.bytes.length) } });
	}

	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		// A long poll holds its request for up to 50 s.
		idleTimeout: 0,
		async fetch(request) {
			const download = /^\/file\/bot([^/]+)\/(.+)$/.exec(new URL(request.url).pathname);
			if (download?.[1] && download[2]) return serveFile(download[1], decodeURIComponent(download[2]));
			const match = /^\/bot([^/]+)\/(\w+)$/.exec(new URL(request.url).pathname);
			if (!match?.[1] || !match[2]) return json(404, { ok: false, error_code: 404, description: 'Not Found' });
			const [, token, method] = match;
			const { payload, files } = await read(request);
			received.push({ method, payload, files, at: Date.now() });
			await stalls.get(method);
			if (revoked || token !== TOKEN) return refusal(401, 'Unauthorized');
			const scripted = scripts.get(method)?.shift();
			if (scripted) return refusal(scripted.status, scripted.description ?? (scripted.status === 429 ? `Too Many Requests: retry after ${scripted.retryAfter ?? 1}` : 'Bad Request'), scripted.retryAfter);
			return answer(method, payload, files);
		},
	});

	/** Queues an update and answers the open poll with it. `id` sets its update id, as Telegram's restart of ids after a week does. */
	function push(update: Record<string, unknown>, id?: number): FakeUpdate {
		const full: FakeUpdate = { ...update, update_id: id ?? nextUpdate++ };
		queue.push(full);
		deliver();
		return full;
	}

	const url = `http://127.0.0.1:${server.port}`;
	return {
		url,
		/**
		 * Registers a file for getFile and its download. `path` is what getFile names: relative for the
		 * cloud, absolute for a local server. `size` is the file_size getFile names, the length of
		 * `bytes` by default.
		 */
		file(id: string, options: { unique: string; path: string; bytes: Uint8Array; size?: number; end?: 'redirect' | 'cut' | 'unsized' }) {
			served.set(id, options);
		},
		/** Turns topic mode in private chats on or off, as getMe reports it. */
		setTopics(on: boolean) {
			topics = on;
		},
		/** Every call in arrival order. */
		received,
		messages,
		/** The calls of one method. */
		calls: (method: string) => received.filter((call) => call.method === method),
		push,
		/** A tap by `user` on button `button` of message `id`, with the message as it shows now. */
		tap(id: number, button: number, options: { user?: number; callback?: string } = {}): FakeUpdate {
			const shown = messages.get(id);
			if (!shown) throw new Error(`message ${id} does not exist`);
			const markup = shown.reply_markup;
			const rows = isRecord(markup) && Array.isArray(markup.inline_keyboard) ? markup.inline_keyboard.flat() : [];
			const pressed: unknown = rows[button];
			const data = isRecord(pressed) && typeof pressed.callback_data === 'string' ? pressed.callback_data : undefined;
			if (data === undefined) throw new Error(`message ${id} has no button ${button}`);
			const from = { ...PERSON, id: options.user ?? PERSON.id };
			return push({ callback_query: { id: options.callback ?? String(nextUpdate), from, message: structuredClone(shown), chat_instance: '-3510754414410900789', data } });
		},
		/** A reply by `user` to message `id`, which carries that message with its keyboard. */
		reply(id: number, text: string, options: { user?: number } = {}): FakeUpdate {
			const shown = messages.get(id);
			if (!shown) throw new Error(`message ${id} does not exist`);
			const from = { ...PERSON, id: options.user ?? PERSON.id };
			const message = { message_id: ++nextMessage, from, chat: shown.chat, date: DATE + 2, reply_to_message: structuredClone(shown), text };
			return push({ message });
		},
		/** A message that replies to nothing, such as `/start <code>`. */
		say(text: string, options: { user?: number; chat?: { id: number; type: string }; update?: number } = {}): FakeUpdate {
			const from = { ...PERSON, id: options.user ?? PERSON.id };
			const chat = options.chat ? { ...options.chat, first_name: PERSON.first_name } : chatOf(from.id);
			return push({ message: { message_id: ++nextMessage, from, chat, date: DATE + 2, text } }, options.update);
		},
		/** Answers the next calls of `method` with these refusals, in order. */
		fail(method: string, ...answers: Scripted[]) {
			scripts.set(method, [...(scripts.get(method) ?? []), ...answers]);
		},
		/** Holds every call of `method` until the returned function runs. */
		stall(method: string): () => void {
			let release = () => {};
			stalls.set(
				method,
				new Promise<void>((resolve) => {
					release = () => {
						stalls.delete(method);
						resolve();
					};
				}),
			);
			return release;
		},
		/** Sets a webhook: an open poll ends with 409, and every later one too. */
		setWebhook(url: string) {
			webhook = url;
			if (poll) {
				clearTimeout(poll.timer);
				poll.respond(refusal(409, 'Conflict: terminated by setWebhook request'));
				poll = undefined;
			}
		},
		/** From now on every call answers 401. */
		revoke() {
			revoked = true;
		},
		/** Waits until a call of `method` matching `match` arrived, or throws after `ms`. */
		async waitFor(method: string, match: (call: Received) => boolean = () => true, ms = 60_000): Promise<Received> {
			const deadline = Date.now() + ms;
			for (;;) {
				const found = received.find((call) => call.method === method && match(call));
				if (found) return found;
				if (Date.now() > deadline) throw new Error(`no ${method} call arrived within ${ms} ms; calls: ${received.map((call) => call.method).join(', ')}`);
				await Bun.sleep(20);
			}
		},
		stop() {
			if (poll) clearTimeout(poll.timer);
			// A stalled call stays open until the server closes its connection.
			stalls.clear();
			void server.stop(true);
		},
	};
}
export type FakeBotApi = ReturnType<typeof fakeBotApi>;
