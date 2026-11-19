import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { choice, message } from '../core/builders.ts';
import { classify } from '../core/classify.ts';
import type { Readable, Spec } from '../core/types.ts';
import { readPublishable } from '../files/index.ts';
import { memoryStore } from '../store/memory.ts';
import { type FakeBotApi, fakeBotApi, TOKEN } from '../telegram/fake-server.ts';
import { fetchCall, type Transport } from '../telegram/fetch.ts';
import { isUpdate } from '../telegram/listen.ts';
import { PACING } from './calls.ts';
import { createChat } from './create.ts';

PACING.interval = 0;

const CHAT = 111;
const BODY = 1001;

const DEADLINE = 30_000;

const cleanups: (() => unknown)[] = [];
const bodies: { settled: Promise<void>; torn: boolean }[] = [];

function acceptance(name: string, body: () => Promise<void>): void {
	test(
		name,
		() => {
			const run = body();
			const entry = { settled: Promise.resolve(), torn: false };
			entry.settled = run.then(
				() => undefined,
				(error: unknown) => {
					if (entry.torn) throw error;
				},
			);
			bodies.push(entry);
			return run;
		},
		DEADLINE,
	);
}

afterEach(
	async () => {
		const ended = bodies.splice(0);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, DEADLINE);
		});
		await Promise.race([Promise.all(ended.map((entry) => entry.settled)), late]);
		clearTimeout(timer);
		for (const entry of ended) entry.torn = true;
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	},
	{ timeout: 2 * DEADLINE },
);

function machine(wrap: (call: Transport) => Transport = (call) => call) {
	const server: FakeBotApi = fakeBotApi();
	cleanups.push(() => server.stop());
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'tau-content-')));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const asked: string[] = [];
	const closed: string[] = [];
	const files = async (paths: string[]): Promise<Readable> => {
		asked.push(...paths);
		const read = await readPublishable(paths, { roots: [root] });
		if (read.kind === 'refused') return read;
		return { kind: 'ok', files: read.files.map((opened) => ({ ...opened, close: () => (closed.push(opened.path), opened.close()) })) };
	};
	const store = memoryStore();
	const chat = createChat({ call: wrap(fetchCall({ token: TOKEN, apiUrl: server.url })), store, chat: CHAT, files });
	const file = (name: string, bytes: number[] = [1, 2, 3]) => {
		const path = join(root, name);
		writeFileSync(path, Uint8Array.from(bytes));
		return path;
	};
	const sends = () => server.received.map((call) => call.method).filter((method) => method !== 'answerCallbackQuery');
	return { server, chat, store, asked, closed, file, sends };
}

function replyOf(server: FakeBotApi, id: number): unknown {
	const reply = server.messages.get(id)?.reply_to_message;
	return typeof reply === 'object' && reply !== null && 'message_id' in reply ? reply.message_id : undefined;
}

acceptance('an album of 3 images under a body of 1,500 characters, with the question on the body', async () => {
	const { server, chat, file, sends } = machine();
	const body = `${'The run changed 3 screens. '.repeat(60).slice(0, 1_499)}?`;
	expect(body).toHaveLength(1_500);
	const paths = [file('before.png', [1]), file('after.png', [2, 2]), file('diff.png', [3, 3, 3])];
	const spec = choice({ markdown: body }, [{ label: 'Keep' }, { label: 'Revert' }], { attach: [{ path: paths[0] ?? '', caption: 'before' }, { path: paths[1] ?? '' }, { path: paths[2] ?? '' }] });

	expect(await chat.send(spec, { ref: 'album1' })).toMatchObject({ kind: 'ok', ref: 'album1', status: 'pending', sent: { message: BODY, files: [1002, 1003, 1004] } });
	expect(sends()).toEqual(['sendRichMessage', 'sendMediaGroup']);
	expect(server.messages.get(BODY)).toMatchObject({ rich_message: { markdown: body }, reply_markup: { inline_keyboard: [[{ text: 'Keep', callback_data: 'q:album1:0' }], [{ text: 'Revert', callback_data: 'q:album1:1' }]] } });
	const album = [1002, 1003, 1004].map((id) => server.messages.get(id));
	expect(album.map((shown) => [shown?.media_group_id, Array.isArray(shown?.photo), shown?.reply_markup])).toEqual([
		[album[0]?.media_group_id, true, undefined],
		[album[0]?.media_group_id, true, undefined],
		[album[0]?.media_group_id, true, undefined],
	]);
	expect([1002, 1003, 1004].map((id) => replyOf(server, id))).toEqual([BODY, BODY, BODY]);
	expect(album[0]?.caption).toBe('before');
	expect(server.calls('sendMediaGroup')[0]?.files.map((part) => [...part.bytes])).toEqual([[1], [2, 2], [3, 3, 3]]);

	const tapped = server.tap(BODY, 1);
	if (!isUpdate(tapped)) throw new Error('the tap has no update id');
	expect(await chat.handle(tapped)).toMatchObject({ kind: 'answered', ref: 'album1', answer: { kind: 'choice', label: 'Revert' } });
	expect(await chat.get('album1')).toMatchObject({ status: 'answered', sent: { message: BODY, files: [1002, 1003, 1004] } });
});

acceptance('photos, a video and 2 documents under one body all reply to the body', async () => {
	const { server, chat, file, sends } = machine();
	const attach = ['a.png', 'b.jpg', 'run.mp4', 'report.pdf', 'run.log'].map((name) => ({ path: file(name) }));
	const outcome = await chat.send(message({ markdown: 'The run of `main`: 2 screens, the recording, the report and the log.' }, { attach }));
	expect(outcome).toMatchObject({ kind: 'ok', sent: { message: BODY, files: [1002, 1003, 1004, 1005, 1006] } });
	expect(sends()).toEqual(['sendRichMessage', 'sendMediaGroup', 'sendMediaGroup']);
	const [visual, documents] = server.calls('sendMediaGroup');
	expect(visual?.payload.media).toEqual([
		{ type: 'photo', media: 'attach://file0' },
		{ type: 'photo', media: 'attach://file1' },
		{ type: 'video', media: 'attach://file2', supports_streaming: true },
	]);
	expect(documents?.payload.media).toEqual([
		{ type: 'document', media: 'attach://file0' },
		{ type: 'document', media: 'attach://file1' },
	]);
	expect([1002, 1003, 1004, 1005, 1006].map((id) => replyOf(server, id))).toEqual([BODY, BODY, BODY, BODY, BODY]);
	expect([1002, 1003, 1004, 1005, 1006].map((id) => Object.keys(server.messages.get(id) ?? {}).find((key) => ['photo', 'video', 'document'].includes(key)))).toEqual(['photo', 'photo', 'video', 'document', 'document']);

	for (const [name, method] of [
		['one.png', 'sendPhoto'],
		['one.mp4', 'sendVideo'],
		['one.pdf', 'sendDocument'],
	] as const) {
		const before = server.received.length;
		const single = await chat.send(message({ markdown: `The file ${name}.` }, { attach: [{ path: file(name), caption: name }] }));
		if (single.kind !== 'ok' || !single.sent) throw new Error(`no Sent for ${name}: ${JSON.stringify(single)}`);
		expect(server.received.slice(before).map((call) => call.method)).toEqual(['sendRichMessage', method]);
		const [id] = single.sent.files;
		expect(replyOf(server, id ?? 0)).toBe(single.sent.message);
		expect(server.messages.get(id ?? 0)?.caption).toBe(name);
	}
});

acceptance('a caption of 1,025 characters is refused before the body is sent, and one of 1,024 goes out', async () => {
	const { server, chat, store, asked, file } = machine();
	const path = file('screen.png');
	const long: Spec[] = [
		message({ markdown: 'The screen.' }, { attach: [{ path, caption: 'x'.repeat(1_025) }] }),
		choice({ markdown: 'Keep the screen?' }, [{ label: 'Keep' }, { label: 'Drop' }], { attach: [{ path: file('other.png') }, { path, caption: 'x'.repeat(1_025) }] }),
	];
	for (const spec of long) expect(await chat.send(spec, spec.answer ? { ref: 'long1' } : {})).toMatchObject({ kind: 'refused', code: 'shape', reason: expect.stringContaining('1024') });
	expect(server.received).toEqual([]);
	expect(asked).toEqual([]);
	expect(await store.list('')).toEqual([]);

	const direct = await fetchCall({ token: TOKEN, apiUrl: server.url })({ method: 'sendMediaGroup', payload: { chat_id: CHAT, media: [{ type: 'photo', media: 'https://x/1.png', caption: 'x'.repeat(1_025) }] } });
	expect(classify('sendMediaGroup', direct)).toEqual({ kind: 'refused', code: 'server', reason: 'Bad Request: message caption is too long' });

	expect(await chat.send(message({ markdown: 'The screen.' }, { attach: [{ path, caption: 'x'.repeat(1_024) }] }))).toMatchObject({ kind: 'ok', sent: { files: [expect.any(Number)] } });
});

acceptance('a files step that the server refuses after the body returns partial, and a retry and flush send nothing again', async () => {
	const { server, chat, file, sends } = machine();
	server.fail('sendDocument', { status: 400, description: 'Bad Request: file is too big' });
	const spec = choice({ markdown: 'Keep the new screens?' }, [{ label: 'Keep' }, { label: 'Revert' }], { attach: [{ path: file('a.png') }, { path: file('b.png') }, { path: file('report.pdf') }] });
	const partial = { kind: 'partial', ref: 'part1', sent: { message: BODY, files: [1002, 1003] } };
	expect(await chat.send(spec, { ref: 'part1' })).toMatchObject({ ...partial, failed: { step: 2, class: 'refused', reason: 'Bad Request: file is too big' } });
	expect(await chat.get('part1')).toMatchObject({ status: 'open', sent: { message: BODY, files: [1002, 1003] } });

	expect(await chat.send(spec, { ref: 'part1' })).toMatchObject({ ...partial, failed: { step: 2, class: 'uncertain' } });
	await chat.flush();
	expect(sends()).toEqual(['sendRichMessage', 'sendMediaGroup', 'sendDocument']);

	server.fail('sendMediaGroup', { status: 502, description: 'Bad Gateway' });
	expect(await chat.send(message({ markdown: 'The screens.' }, { attach: [{ path: file('c.png') }, { path: file('d.png') }] }))).toMatchObject({
		kind: 'partial',
		sent: { message: 1004, files: [] },
		failed: { step: 1, class: 'uncertain' },
	});
});

acceptance('a files step whose answer is lost after the server applied it returns partial, and a retry and flush send nothing again', async () => {
	const { server, chat, file, sends } = machine((call) => async (request, files) => {
		const response = await call(request, files);
		return request.method === 'sendMediaGroup' ? { noAnswer: true } : response;
	});
	const spec = choice({ markdown: 'Keep the new screens?' }, [{ label: 'Keep' }, { label: 'Revert' }], { attach: [{ path: file('a.png') }, { path: file('b.png') }, { path: file('report.pdf') }] });
	expect(await chat.send(spec, { ref: 'lost1' })).toMatchObject({ kind: 'partial', ref: 'lost1', sent: { message: BODY, files: [] }, failed: { step: 1, class: 'uncertain' } });
	expect([1002, 1003].map((id) => replyOf(server, id))).toEqual([BODY, BODY]);
	expect(sends()).toEqual(['sendRichMessage', 'sendMediaGroup']);

	expect(await chat.send(spec, { ref: 'lost1' })).toMatchObject({ kind: 'partial', failed: { step: 1, class: 'uncertain' } });
	await chat.flush();
	expect(sends()).toEqual(['sendRichMessage', 'sendMediaGroup']);
	expect(server.messages.size).toBe(3);
});

acceptance('a dry run opens and checks every attachment, sends nothing and closes each file', async () => {
	const { server, chat, asked, closed, file } = machine();
	const path = file('screen.png');
	expect(await chat.send(message({ markdown: 'The screen.' }, { attach: [{ path }] }), { dryRun: true })).toMatchObject({ kind: 'dry', steps: [{ role: 'body' }, { role: 'files', call: { method: 'sendPhoto' } }] });
	expect([asked, closed]).toEqual([[path], [path]]);
	const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'tau-elsewhere-')));
	cleanups.push(() => rmSync(elsewhere, { recursive: true, force: true }));
	const outside = join(elsewhere, 'outside.png');
	writeFileSync(outside, 'OUTSIDE');
	expect(await chat.send(message({ markdown: 'The screen.' }, { attach: [{ path: outside }] }), { dryRun: true })).toMatchObject({ kind: 'refused', code: 'outside-roots' });
	expect(server.received).toEqual([]);
});
