// fetchCall against a local Bot API server: JSON calls, multipart uploads streamed from the
// opened file, and each kind of answer as `classify` reads it.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { memoryFile } from '../chat/harness.ts';
import { classify } from '../core/classify.ts';
import type { Publishable } from '../core/types.ts';
import { type FakeBotApi, fakeBotApi, TOKEN } from './fake-server.ts';
import { fetchCall, readAnswer } from './fetch.ts';

let server: FakeBotApi;
beforeEach(() => {
	server = fakeBotApi();
});
afterEach(() => server.stop());

/** A file of `size` bytes whose stream yields 64 KiB chunks and counts what was read. */
function streamedFile(path: string, size: number, type: string): Publishable & { read: number } {
	const chunk = 65_536;
	const file = {
		path,
		type,
		size,
		read: 0,
		stream: () => {
			let sent = 0;
			return new ReadableStream<Uint8Array>({
				pull(controller) {
					if (sent >= size) return controller.close();
					const length = Math.min(chunk, size - sent);
					controller.enqueue(new Uint8Array(length).fill(sent / chunk));
					sent += length;
					file.read += length;
				},
			});
		},
		bytes: async () => {
			throw new Error('the transport reads the stream, never the whole file');
		},
		close: async () => {},
	};
	return file;
}

test('a call without files goes out as JSON and its result comes back', async () => {
	const call = fetchCall({ token: TOKEN, apiUrl: server.url });
	const response = await call({ method: 'sendRichMessage', payload: { chat_id: 111, rich_message: { markdown: 'Build passed.' } } });
	expect(response).toMatchObject({ ok: true, result: { message_id: 1001, chat: { id: 111 } } });
	expect(server.calls('sendRichMessage')[0]?.payload).toEqual({ chat_id: 111, rich_message: { markdown: 'Build passed.' } });
});

test('a call with files streams each opened file as a multipart part', async () => {
	const call = fetchCall({ token: TOKEN, apiUrl: server.url });
	const big = streamedFile('/work/build "log".pdf', 3_000_000, 'application/pdf');
	const response = await call(
		{ method: 'sendDocument', payload: { chat_id: 111, caption: 'The log', reply_parameters: { message_id: 1001 } }, files: [{ field: 'document', path: big.path }] },
		{ document: big },
	);
	expect(response).toMatchObject({ ok: true });
	const [received] = server.calls('sendDocument');
	expect(received?.payload).toEqual({ chat_id: 111, caption: 'The log', reply_parameters: { message_id: 1001 } });
	expect(received?.files.map(({ field, name, type, bytes }) => ({ field, name, type, size: bytes.length }))).toEqual([{ field: 'document', name: 'build _log_.pdf', type: 'application/pdf', size: 3_000_000 }]);
	expect(received?.files[0]?.bytes[2_999_999]).toBe(Math.floor(2_999_999 / 65_536));
	expect(big.read).toBe(3_000_000);
});

test('an album sends one part per file under the fields its media names', async () => {
	const call = fetchCall({ token: TOKEN, apiUrl: server.url });
	const media = [
		{ type: 'photo', media: 'attach://file0' },
		{ type: 'photo', media: 'attach://file1' },
	];
	const response = await call(
		{
			method: 'sendMediaGroup',
			payload: { chat_id: 111, media },
			files: [
				{ field: 'file0', path: '/work/a.png' },
				{ field: 'file1', path: '/work/b.png' },
			],
		},
		{ file0: memoryFile('/work/a.png', new Uint8Array([1])), file1: memoryFile('/work/b.png', new Uint8Array([2, 2])) },
	);
	expect(response).toMatchObject({ ok: true, result: [{ message_id: 1001 }, { message_id: 1002 }] });
	const [received] = server.calls('sendMediaGroup');
	expect(received?.payload.media).toEqual(media);
	expect(received?.files.map((file) => [file.field, file.name, [...file.bytes]])).toEqual([
		['file0', 'a.png', [1]],
		['file1', 'b.png', [2, 2]],
	]);
});

test('a call that names a field without an opened file is never sent', async () => {
	const call = fetchCall({ token: TOKEN, apiUrl: server.url });
	await expect(call({ method: 'sendPhoto', payload: { chat_id: 111 }, files: [{ field: 'photo', path: '/work/a.png' }] })).rejects.toThrow('no opened file for the field photo');
	expect(server.received).toEqual([]);
});

test('a 429 carries the time from which a retry is allowed', async () => {
	const call = fetchCall({ token: TOKEN, apiUrl: server.url });
	server.fail('editMessageText', { status: 429, retryAfter: 3 });
	const before = Date.now();
	const response = await call({ method: 'editMessageText', payload: { chat_id: 111, message_id: 1001, rich_message: { markdown: 'x' } } });
	const after = Date.now();
	if ('noAnswer' in response || response.ok) throw new Error(`expected a refusal, got ${JSON.stringify(response)}`);
	expect(response.status).toBe(429);
	expect(response.retryAfter).toBeGreaterThanOrEqual(before + 3_000);
	expect(response.retryAfter).toBeLessThanOrEqual(after + 3_000);
	expect(classify('editMessageText', response)).toEqual({ kind: 'retry', at: response.retryAfter ?? 0 });
});

test('a rejected token, a refusal, a server error and a dead server keep their classes', async () => {
	const call = fetchCall({ token: '222:wrong', apiUrl: server.url });
	expect(classify('getMe', await call({ method: 'getMe', payload: {} }))).toEqual({ kind: 'refused', code: 'token', reason: 'Unauthorized' });
	const good = fetchCall({ token: TOKEN, apiUrl: server.url });
	server.fail('sendRichMessage', { status: 400, description: 'Bad Request: chat not found' }, { status: 502, description: 'Bad Gateway' });
	expect(classify('sendRichMessage', await good({ method: 'sendRichMessage', payload: {} }))).toEqual({ kind: 'refused', code: 'server', reason: 'Bad Request: chat not found' });
	expect(classify('sendRichMessage', await good({ method: 'sendRichMessage', payload: {} }))).toEqual({ kind: 'uncertain' });
	server.stop();
	expect(await good({ method: 'getMe', payload: {} })).toEqual({ noAnswer: true });
});

test('an answer that is not the Bot API JSON is no answer on success and a refusal by status otherwise', () => {
	expect(readAnswer(200, '<html>proxy</html>', 0)).toEqual({ noAnswer: true });
	expect(readAnswer(502, '<html>Bad Gateway</html>', 0)).toEqual({ ok: false, status: 502, description: 'HTTP 502' });
	expect(readAnswer(413, '', 0)).toEqual({ ok: false, status: 413, description: 'HTTP 413' });
	expect(readAnswer(429, JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } }), 1_000)).toEqual({
		ok: false,
		status: 429,
		description: 'Too Many Requests: retry after 7',
		retryAfter: 8_000,
	});
});

test('a description that quotes the token, its secret or their URL encoding comes back without them', async () => {
	const call = fetchCall({ token: TOKEN, apiUrl: server.url });
	const secret = TOKEN.slice(TOKEN.indexOf(':') + 1);
	server.fail('sendRichMessage', { status: 400, description: `Proxy route /bot${TOKEN}/sendRichMessage, ${encodeURIComponent(TOKEN)} and ${secret} are unavailable` });
	expect(await call({ method: 'sendRichMessage', payload: {} })).toEqual({ ok: false, status: 400, description: 'Proxy route /bot<token>/sendRichMessage, <token> and <token> are unavailable' });
});
