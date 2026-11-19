import type { CallClass, CallResponse } from './types.ts';

export const NOT_MODIFIED = 'message is not modified';

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
