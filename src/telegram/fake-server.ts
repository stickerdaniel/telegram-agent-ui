// A Bot API server over HTTP for tests, not part of the package. It keeps what each message
// shows, long-polls getUpdates, confirms updates below an offset, ends an older poll with 409
// when a newer one arrives, refuses getUpdates with 409 while a webhook is set, answers 401 to a
// revoked token, and answers a call from a script, such as 429 with `retry_after`. The messages
// and updates follow facts/records/: a bot 222, a private chat 111 with user 111, and the
// replied-to message inside a reply with its keyboard, as Telegram for iOS sends it.
import { isRecord } from '../core/check.ts';
import { NOT_MODIFIED } from '../core/classify.ts';

export const TOKEN = '222:fake-token';
const BOT = { id: 222, is_bot: true, first_name: 'Probe', username: 'probe_bot' };
const PERSON = { id: 111, is_bot: false, first_name: 'Dana' };
const DATE = 1794908513;
const CONFLICT = 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running';
const WEBHOOK_CONFLICT = "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first";
const SENDS = new Set(['sendPhoto', 'sendVideo', 'sendDocument', 'sendRichMessage']);

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
	let webhook = '';
	let revoked = false;
	let poll: { respond: (response: Response) => void; timer: ReturnType<typeof setTimeout> } | undefined;

	const chatOf = (id: unknown) => ({ id: typeof id === 'number' ? id : 111, first_name: PERSON.first_name, type: 'private' });

	function newMessage(payload: Record<string, unknown>, content: Record<string, unknown>): Message {
		const stored: Message = { message_id: ++nextMessage, from: BOT, chat: chatOf(payload.chat_id), date: DATE, ...content };
		messages.set(stored.message_id, stored);
		return stored;
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
				return ok(BOT);
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
			case 'sendMediaGroup':
				return ok(files.map((file) => newMessage(payload, { document: { file_id: file.field, file_name: file.name, file_size: file.bytes.length } })));
			default:
				if (method === 'sendRichMessage') return ok(newMessage(payload, { rich_message: payload.rich_message, ...(payload.reply_markup !== undefined ? { reply_markup: payload.reply_markup } : {}) }));
				if (SENDS.has(method)) return ok(newMessage(payload, { document: { file_id: files[0]?.field ?? '', file_name: files[0]?.name ?? '', file_size: files[0]?.bytes.length ?? 0 } }));
				return ok(true);
		}
	}

	const server = Bun.serve({
		port: 0,
		hostname: '127.0.0.1',
		// A long poll holds its request for up to 50 s.
		idleTimeout: 0,
		async fetch(request) {
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

	return {
		url: `http://127.0.0.1:${server.port}`,
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
