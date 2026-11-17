// The adapter for a bot that already runs on grammY: `grammyCall` sends the package's calls
// through the bot's own Api, with its transformers and its API root, and `grammyHandler` passes
// the updates of the bot's own loop to `chat.handle`. Nothing here polls: the host's loop is the
// one consumer of getUpdates or of its webhook.
import { type Api, type Context, InputFile, type MiddlewareFn } from 'grammy';
import { isInt, isRecord, isString } from '../core/check.ts';
import type { Call, CallResponse, Publishable } from '../core/types.ts';
import type { Chat } from '../chat/create.ts';
import { NO_ANSWER } from '../chat/calls.ts';
import { scrubber } from '../telegram/fetch.ts';

type Method = (payload: Record<string, unknown>) => Promise<unknown>;
const isMethod = (value: unknown): value is Method => typeof value === 'function';

/** The fields grammY's GrammyError carries for a refusal of the Bot API. Read by shape, so a second copy of grammY in a project still counts. */
const isApiError = (error: unknown): error is { error_code: number; description: string; parameters?: { retry_after?: number } } =>
	error instanceof Error && 'error_code' in error && isInt(error.error_code) && 'description' in error && isString(error.description);

/** The chunks of a stream, as the async iterable InputFile reads. */
async function* chunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
	const reader = stream.getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * The call's payload with each opened file in place, as grammY uploads it: a single file under
 * its own field, an album's file in the `media` item that names `attach://<field>`.
 */
function withFiles(call: Call, files: Record<string, Publishable>): Record<string, unknown> {
	const payload: Record<string, unknown> = { ...call.payload };
	const media = Array.isArray(payload.media) ? payload.media.map((item: unknown) => (isRecord(item) ? { ...item } : item)) : undefined;
	for (const { field, path } of call.files ?? []) {
		const file = files[field];
		if (!file) throw new Error(`no opened file for the field ${field} of ${call.method}`);
		const input = new InputFile(chunks(file.stream()), path.split('/').pop() || 'file');
		const item = media?.find((entry) => isRecord(entry) && entry.media === `attach://${field}`);
		if (isRecord(item)) item.media = input;
		else payload[field] = input;
	}
	if (media) payload.media = media;
	return payload;
}

/**
 * A transport over a grammY bot's Api. A refusal of the Bot API keeps its code, its description
 * without the bot token, and `retry_after` as an absolute time; a network failure is no answer.
 *
 *   const bot = new Bot(token);
 *   const chat = createChat({ call: grammyCall(bot.api), store, chat: 111 });
 */
export function grammyCall(api: Api): (call: Call, files?: Record<string, Publishable>) => Promise<CallResponse> {
	const scrub = scrubber(api.token);
	return async (call, files) => {
		const payload = call.files && call.files.length > 0 ? withFiles(call, files ?? {}) : call.payload;
		// grammY's raw Api answers every method name, typed per known method; this one is a string.
		const method: unknown = Reflect.get(api.raw, call.method);
		if (!isMethod(method)) throw new Error(`grammY has no method ${call.method}`);
		try {
			return { ok: true, result: await method(payload) };
		} catch (error) {
			if (!isApiError(error)) return NO_ANSWER;
			const retry = error.parameters?.retry_after;
			return { ok: false, status: error.error_code, description: scrub(error.description), ...(isInt(retry) ? { retryAfter: Date.now() + retry * 1000 } : {}) };
		}
	};
}

/**
 * A middleware that hands every update to `chat.handle`. An update that is no input of a
 * question goes on to the next middleware. After an answer it runs `chat.flush()`, which
 * delivers it to `onAnswer`. The host runs `chat.flush({ restart: true })` once at start and
 * `chat.flush()` every 30 s, and asks its loop for `chat.updates`. A rejected token rejects
 * with TokenRefused into the host's error handler.
 *
 *   bot.use(grammyHandler(chat));
 *   await chat.flush({ restart: true });
 *   bot.start({ allowed_updates: [...chat.updates] });
 */
export function grammyHandler(chat: Pick<Chat, 'handle' | 'flush'>): MiddlewareFn<Context> {
	return async (ctx, next) => {
		const handled = await chat.handle(ctx.update);
		if (handled.kind === 'ignored') return next();
		if (handled.kind === 'answered') await chat.flush();
	};
}
