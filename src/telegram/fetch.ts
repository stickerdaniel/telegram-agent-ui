// The Bot API over the Fetch API. A call without files goes out as JSON. A call with files goes
// out as multipart/form-data, streamed from each opened file, so a file of 2,000 MB is never held
// in memory. The server's answer becomes a CallResponse: `classify` reads its meaning.
import { isInt, isRecord, isString } from '../core/check.ts';
import type { Call, CallResponse, Publishable } from '../core/types.ts';
import { deadlineOf, NO_ANSWER } from '../chat/calls.ts';

/** A Bot API transport: what `createChat` and `listen` call. `files` holds the opened files of a call by multipart field. */
export type Transport = (call: Call, files?: Record<string, Publishable>) => Promise<CallResponse>;

/** The cloud Bot API. */
export const CLOUD_API = 'https://api.telegram.org';
// A request is cut this long after its deadline. `createChat` gives up on a call at the
// deadline itself; the cut only ends a request that nobody waits for any more.
const GRACE = 10_000;

const encoder = new TextEncoder();

/** How long a request may take before the transport cuts it: a long poll its `timeout`, any other call its deadline, each plus GRACE. */
function limitOf(call: Call): number {
	if (call.method === 'getUpdates') {
		const timeout = call.payload.timeout;
		return (isInt(timeout) && timeout > 0 ? timeout * 1000 : 0) + GRACE;
	}
	return deadlineOf(call) + GRACE;
}

/** A form value as Telegram reads it: a string as it is, any other value as JSON. */
const formValue = (value: unknown) => (isString(value) ? value : JSON.stringify(value));
/** A file name without the characters that would break its header line. */
const fileName = (path: string) => (path.split('/').pop() || 'file').replace(/["\r\n\\]/g, '_');

/**
 * The multipart body of a call, as a stream: every payload field, then every file of
 * `call.files`, each read from its opened handle. Throws when `files` lacks an opened file for a
 * field the call names: the call is then never sent.
 */
function multipart(call: Call, files: Record<string, Publishable>): { body: ReadableStream<Uint8Array>; type: string } {
	const boundary = `tau-${crypto.randomUUID()}`;
	const parts: (Uint8Array | Publishable)[] = [];
	for (const [key, value] of Object.entries(call.payload)) {
		if (value === undefined) continue;
		parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${formValue(value)}\r\n`));
	}
	for (const { field, path } of call.files ?? []) {
		const file = files[field];
		if (!file) throw new Error(`no opened file for the field ${field} of ${call.method}`);
		parts.push(encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${fileName(path)}"\r\nContent-Type: ${file.type || 'application/octet-stream'}\r\n\r\n`));
		parts.push(file, encoder.encode('\r\n'));
	}
	parts.push(encoder.encode(`--${boundary}--\r\n`));
	let index = 0;
	// The reader of the file being sent. Typed by what is used: Bun's and Node's reader types differ.
	let reader: { read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>; cancel(reason?: unknown): Promise<void> } | undefined;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			for (;;) {
				if (reader) {
					const chunk = await reader.read();
					if (!chunk.done && chunk.value) return controller.enqueue(chunk.value);
					if (!chunk.done) continue;
					reader = undefined;
				}
				const part = parts[index++];
				if (part === undefined) return controller.close();
				if (part instanceof Uint8Array) return controller.enqueue(part);
				reader = part.stream().getReader();
			}
		},
		async cancel(reason) {
			await reader?.cancel(reason);
		},
	});
	return { body, type: `multipart/form-data; boundary=${boundary}` };
}

/**
 * A function that replaces the bot token in a text with `<token>`: the whole token, its secret
 * after the colon, and both in URL encoding. A server or proxy can quote the request path,
 * which carries the token, in its error description.
 */
export function scrubber(token: string): (text: string) => string {
	const secret = token.slice(token.indexOf(':') + 1);
	const forms = [...new Set([token, encodeURIComponent(token), secret, encodeURIComponent(secret)])].filter((form) => form.length >= 8).sort((a, b) => b.length - a.length);
	return (text) => forms.reduce((scrubbed, form) => scrubbed.replaceAll(form, '<token>'), text);
}

/**
 * What a server answered, as a CallResponse. `retry_after` becomes an absolute time, counted
 * from `at`. A body that is not the Bot API's JSON is no answer for a 2xx, since the call may
 * have been applied, and a failure with the HTTP status for anything else. `scrub` cleans the
 * description, which a server may fill with the request's URL.
 */
export function readAnswer(status: number, text: string, at: number, scrub: (text: string) => string = (same) => same): CallResponse {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		body = undefined;
	}
	if (isRecord(body) && body.ok === true && 'result' in body) return { ok: true, result: body.result };
	if (isRecord(body) && body.ok === false) {
		const retry = isRecord(body.parameters) && isInt(body.parameters.retry_after) && body.parameters.retry_after >= 0 ? body.parameters.retry_after : undefined;
		const code = status >= 400 ? status : isInt(body.error_code) ? body.error_code : status;
		return { ok: false, status: code, description: isString(body.description) ? scrub(body.description) : `HTTP ${status}`, ...(retry !== undefined ? { retryAfter: at + retry * 1000 } : {}) };
	}
	return status >= 200 && status < 300 ? NO_ANSWER : { ok: false, status, description: `HTTP ${status}` };
}

/**
 * A transport over `fetch` to the Bot API at `apiUrl`, the cloud by default. A request that
 * fails, or that the transport cuts after its deadline, is no answer. The token travels only in
 * the URL and never into a response.
 *
 *   const call = fetchCall({ token: process.env.TELEGRAM_BOT_TOKEN ?? '' });
 *   const chat = createChat({ call, store, chat: 111 });
 *   await call({ method: 'getMe', payload: {} }); // { ok: true, result: { id: 222, ... } }
 */
export function fetchCall(options: { token: string; apiUrl?: string }): Transport {
	const root = (options.apiUrl ?? CLOUD_API).replace(/\/+$/, '');
	const scrub = scrubber(options.token);
	return async (call, files) => {
		const request = call.files && call.files.length > 0 ? multipart(call, files ?? {}) : undefined;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), limitOf(call));
		// `duplex` lets Node send a stream as the body; Bun and the DOM types do not know it.
		const init: RequestInit & { duplex: 'half' } = {
			method: 'POST',
			headers: { 'content-type': request ? request.type : 'application/json' },
			body: request ? request.body : JSON.stringify(call.payload),
			signal: controller.signal,
			duplex: 'half',
		};
		try {
			const response = await fetch(`${root}/bot${options.token}/${call.method}`, init);
			return readAnswer(response.status, await response.text(), Date.now(), scrub);
		} catch {
			return NO_ANSWER;
		} finally {
			clearTimeout(timer);
		}
	};
}
