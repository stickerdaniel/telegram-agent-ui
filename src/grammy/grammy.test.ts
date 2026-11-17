// A grammY bot that hosts the package: its Api is the transport, its update handling feeds
// `chat.handle`, and the package makes no getUpdates call of its own.
import { afterEach, expect, test } from 'bun:test';
import { Bot } from 'grammy';
import { memoryFile } from '../chat/harness.ts';
import { createChat, type Delivered } from '../chat/create.ts';
import { choice } from '../core/builders.ts';
import { classify } from '../core/classify.ts';
import { parseQuestion } from '../core/parse.ts';
import { plain, tap } from '../fixtures.ts';
import { memoryStore } from '../store/memory.ts';
import { type FakeBotApi, fakeBotApi, TOKEN } from '../telegram/fake-server.ts';
import { grammyCall, grammyHandler } from './index.ts';

let server: FakeBotApi | undefined;
afterEach(() => server?.stop());

/** A grammY bot on the local server, with the bot's info given, so it calls no getMe. */
function bot(api: FakeBotApi) {
	return new Bot(TOKEN, {
		client: { apiRoot: api.url },
		botInfo: {
			id: 222,
			is_bot: true,
			first_name: 'Probe',
			username: 'probe_bot',
			can_join_groups: false,
			can_read_all_group_messages: false,
			can_manage_bots: false,
			supports_inline_queries: false,
			can_connect_to_business: false,
			has_main_web_app: false,
			has_topics_enabled: false,
			allows_users_to_create_topics: false,
			supports_join_request_queries: false,
		},
	});
}

test('a grammY bot with grammyHandler answers a question and makes no getUpdates call of its own', async () => {
	server = fakeBotApi();
	const host = bot(server);
	const delivered: Delivered[] = [];
	const store = memoryStore();
	const chat = createChat({ call: grammyCall(host.api), store, chat: 111, onAnswer: async (answer) => void delivered.push(answer) });
	const passed: string[] = [];
	host.use(grammyHandler(chat));
	host.on('message:text', (ctx) => void passed.push(ctx.message.text));

	const sent = await chat.send(choice({ markdown: 'Merge now?' }, [{ label: 'Merge' }, { label: 'Wait' }]), { ref: 'g1' });
	expect(sent).toMatchObject({ kind: 'ok', sent: { message: 1001, ref: 'g1' } });
	// The host's loop hands over each update, as its poll or its webhook received it.
	await host.handleUpdate(tap({ button: 0, ref: 'g1', message: 1001, id: 'cq-g1' }));
	await host.handleUpdate(plain('not for the package'));

	expect(parseQuestion(await store.get('q:g1'))).toMatchObject({ status: 'answered', answer: { label: 'Merge' } });
	expect(delivered).toMatchObject([{ ref: 'g1', delivery: 'g1:1' }]);
	expect(server.messages.get(1001)?.reply_markup).toEqual({ inline_keyboard: [[{ text: '✓ Merge', callback_data: 'q:g1:0' }], [{ text: 'Wait', callback_data: 'q:g1:1' }]] });
	expect(passed).toEqual(['not for the package']);
	expect(server.received.map((call) => call.method)).toEqual(['sendRichMessage', 'answerCallbackQuery', 'editMessageText']);
	expect(server.calls('getUpdates')).toHaveLength(0);
});

test('grammyCall uploads opened files and keeps the class of every answer', async () => {
	server = fakeBotApi();
	const call = grammyCall(bot(server).api);
	const document = await call(
		{ method: 'sendDocument', payload: { chat_id: 111, reply_parameters: { message_id: 1001 } }, files: [{ field: 'document', path: '/work/report.pdf' }] },
		{ document: memoryFile('/work/report.pdf', new Uint8Array([7, 8, 9]), 'application/pdf') },
	);
	expect(document).toMatchObject({ ok: true, result: { message_id: 1001 } });
	expect(server.calls('sendDocument')[0]?.files.map((file) => [file.name, [...file.bytes]])).toEqual([['report.pdf', [7, 8, 9]]]);
	expect(server.calls('sendDocument')[0]?.payload).toMatchObject({ chat_id: 111, reply_parameters: { message_id: 1001 } });

	const album = await call(
		{
			method: 'sendMediaGroup',
			payload: { chat_id: 111, media: [{ type: 'photo', media: 'attach://file0' }, { type: 'photo', media: 'attach://file1', caption: 'second' }] },
			files: [
				{ field: 'file0', path: '/work/a.png' },
				{ field: 'file1', path: '/work/b.png' },
			],
		},
		{ file0: memoryFile('/work/a.png', new Uint8Array([1])), file1: memoryFile('/work/b.png', new Uint8Array([2])) },
	);
	expect(album).toMatchObject({ ok: true, result: [{}, {}] });
	const [received] = server.calls('sendMediaGroup');
	expect(received?.files.map((file) => [...file.bytes])).toEqual([[1], [2]]);
	expect(received?.payload.media).toMatchObject([{ type: 'photo' }, { type: 'photo', caption: 'second' }]);

	server.fail('editMessageText', { status: 429, retryAfter: 2 }, { status: 400, description: 'Bad Request: message to edit not found' });
	const before = Date.now();
	const busy = await call({ method: 'editMessageText', payload: { chat_id: 111, message_id: 1, rich_message: { markdown: 'x' } } });
	expect(classify('editMessageText', busy)).toMatchObject({ kind: 'retry' });
	expect(!('noAnswer' in busy) && !busy.ok && (busy.retryAfter ?? 0) >= before + 2_000).toBe(true);
	expect(classify('editMessageText', await call({ method: 'editMessageText', payload: {} }))).toEqual({ kind: 'refused', code: 'server', reason: 'Bad Request: message to edit not found' });
	server.fail('sendRichMessage', { status: 400, description: `Proxy route /bot${TOKEN}/sendRichMessage is unavailable` });
	expect(await call({ method: 'sendRichMessage', payload: {} })).toEqual({ ok: false, status: 400, description: 'Proxy route /bot<token>/sendRichMessage is unavailable' });
	server.stop();
	expect(await call({ method: 'getMe', payload: {} })).toEqual({ noAnswer: true });
});
