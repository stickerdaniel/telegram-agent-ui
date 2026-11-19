import { isInt, isRecord, isString } from '../core/check.ts';
import type { Call, CallResponse, Publishable } from '../core/types.ts';
import { deadlineOf, NO_ANSWER } from '../chat/calls.ts';

export type Transport = (call: Call, files?: Record<string, Publishable>) => Promise<CallResponse>;

export const CLOUD_API = 'https://api.telegram.org';
const GRACE = 10_000;

const encoder = new TextEncoder();

function limitOf(call: Call): number {
	if (call.method === 'getUpdates') {
		const timeout = call.payload.timeout;
		return (isInt(timeout) && timeout > 0 ? timeout * 1000 : 0) + GRACE;
	}
	return deadlineOf(call) + GRACE;
}

const formValue = (value: unknown) => (isString(value) ? value : JSON.stringify(value));
const fileName = (path: string) => (path.split('/').pop() || 'file').replace(/["\r\n\\]/g, '_');

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

export function scrubber(token: string): (text: string) => string {
	const secret = token.slice(token.indexOf(':') + 1);
	const forms = [...new Set([token, encodeURIComponent(token), secret, encodeURIComponent(secret)])].filter((form) => form.length >= 8).sort((a, b) => b.length - a.length);
	return (text) => forms.reduce((scrubbed, form) => scrubbed.replaceAll(form, '<token>'), text);
}

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

export type Download = (path: string, signal: AbortSignal) => Promise<Response>;

export function fileDownload(options: { token: string; apiUrl?: string }): Download {
	const root = (options.apiUrl ?? CLOUD_API).replace(/\/+$/, '');
	return async (path, signal) => {
		const segments = path.split('/');
		if (path.startsWith('/') || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) throw new Error('the file path is no relative path of the server');
		try {
			return await fetch(`${root}/file/bot${options.token}/${segments.map(encodeURIComponent).join('/')}`, { redirect: 'manual', signal });
		} catch {
			throw new Error(signal.aborted ? 'the download passed its deadline' : 'the download got no answer');
		}
	};
}

export function fetchCall(options: { token: string; apiUrl?: string }): Transport {
	const root = (options.apiUrl ?? CLOUD_API).replace(/\/+$/, '');
	const scrub = scrubber(options.token);
	return async (call, files) => {
		const request = call.files && call.files.length > 0 ? multipart(call, files ?? {}) : undefined;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), limitOf(call));
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
