import type { CallClass, CallResponse } from './types.ts';

/** Telegram's 400 for an edit that shows what the message already shows. */
export const NOT_MODIFIED = 'message is not modified';

/**
 * What a server answer to a call means, the outcome table of 4.5 as a function. "Message is
 * not modified" counts as `unchanged` only for an edit method; for any other method it is a
 * refusal like every other 4xx.
 *
 *   classify('editMessageText', { ok: false, status: 400, description: 'Bad Request: message is not modified: ...' }) // { kind: 'unchanged' }
 */
export function classify(method: string, response: CallResponse): CallClass {
	if ('noAnswer' in response) return { kind: 'uncertain' };
	if (response.ok) return { kind: 'ok', result: response.result };
	const { status, description, retryAfter } = response;
	if (status === 400 && method.startsWith('editMessage') && description.includes(NOT_MODIFIED)) return { kind: 'unchanged' };
	if (status === 401) return { kind: 'refused', code: 'token', reason: description };
	if (status === 429) return { kind: 'retry', ...(retryAfter !== undefined ? { at: retryAfter } : {}) };
	if (status >= 400 && status < 500) return { kind: 'refused', code: 'server', reason: description };
	return { kind: 'uncertain' };
}
