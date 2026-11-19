import { type Api, type Context, InputFile, type MiddlewareFn } from 'grammy';
import { isInt, isRecord, isString } from '../core/check.ts';
import type { Call, CallResponse, Publishable } from '../core/types.ts';
import type { Chat } from '../chat/create.ts';
import { NO_ANSWER } from '../chat/calls.ts';
import { scrubber } from '../telegram/fetch.ts';

type Method = (payload: Record<string, unknown>) => Promise<unknown>;
const isMethod = (value: unknown): value is Method => typeof value === 'function';

const isApiError = (error: unknown): error is { error_code: number; description: string; parameters?: { retry_after?: number } } =>
	error instanceof Error && 'error_code' in error && isInt(error.error_code) && 'description' in error && isString(error.description);

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

export function grammyCall(api: Api): (call: Call, files?: Record<string, Publishable>) => Promise<CallResponse> {
	const scrub = scrubber(api.token);
	return async (call, files) => {
		const payload = call.files && call.files.length > 0 ? withFiles(call, files ?? {}) : call.payload;
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

export function grammyHandler(chat: Pick<Chat, 'handle' | 'flush'>): MiddlewareFn<Context> {
	return async (ctx, next) => {
		const handled = await chat.handle(ctx.update);
		if (handled.kind === 'ignored') return next();
		if (handled.kind === 'answered') await chat.flush();
	};
}
