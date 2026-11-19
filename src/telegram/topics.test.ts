import { afterEach, expect, test } from 'bun:test';
import { fakeBotApi, TOKEN } from './fake-server.ts';
import { fetchCall } from './fetch.ts';
import { createTopic, setTopicIcon, topicIcons } from './topics.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function setup() {
	const server = fakeBotApi();
	cleanups.push(() => server.stop());
	return { server, call: fetchCall({ token: TOKEN, apiUrl: server.url }) };
}

const methods = (server: ReturnType<typeof fakeBotApi>) => server.received.map((call) => call.method);

test('each topic function refuses without topic mode and sends nothing but getMe', async () => {
	const { server, call } = setup();
	expect(await createTopic(call, 111, 'growth-desk')).toMatchObject({ kind: 'refused', code: 'no-topics' });
	expect(await topicIcons(call)).toMatchObject({ kind: 'refused', code: 'no-topics' });
	expect(await setTopicIcon(call, 111, 41, '5312536423851630001')).toMatchObject({ kind: 'refused', code: 'no-topics' });
	expect(methods(server)).toEqual(['getMe', 'getMe', 'getMe']);
});

test('a token that getMe refuses is refused as token by each topic function, before any topic call', async () => {
	const { server, call } = setup();
	server.setTopics(true);
	server.revoke();
	for (const result of [await createTopic(call, 111, 'growth-desk'), await topicIcons(call), await setTopicIcon(call, 111, 41, '5312536423851630001')]) {
		expect(result).toMatchObject({ kind: 'refused', code: 'token' });
	}
	expect(methods(server)).toEqual(['getMe', 'getMe', 'getMe']);
});

test('topic create makes a topic in the private chat and returns its id', async () => {
	const { server, call } = setup();
	server.setTopics(true);
	expect(await createTopic(call, 111, 'growth-desk')).toEqual({ kind: 'ok', topic: 41, name: 'growth-desk' });
	expect(server.calls('createForumTopic').map((call) => call.payload)).toEqual([{ chat_id: 111, name: 'growth-desk' }]);
	expect(await createTopic(call, 111, 'x'.repeat(129))).toMatchObject({ kind: 'refused', code: 'shape' });
	expect(server.calls('createForumTopic')).toHaveLength(1);
});

test('a create whose answer is lost is uncertain and is not sent again', async () => {
	const { server, call } = setup();
	server.setTopics(true);
	server.fail('createForumTopic', { status: 502, description: 'Bad Gateway' });
	expect(await createTopic(call, 111, 'growth-desk')).toMatchObject({ kind: 'uncertain' });
	expect(server.calls('createForumTopic')).toHaveLength(1);
});

test('topic icons lists the allowed icons, and topic icon sets one of them and counts an unchanged icon as done', async () => {
	const { server, call } = setup();
	server.setTopics(true);
	expect(await topicIcons(call)).toEqual({
		kind: 'ok',
		icons: [
			{ id: '5312536423851630001', emoji: '💡' },
			{ id: '5312241539987020022', emoji: '✅' },
		],
	});
	expect(await setTopicIcon(call, 111, 41, '999')).toMatchObject({ kind: 'refused', code: 'shape' });
	expect(server.calls('editForumTopic')).toEqual([]);
	expect(await setTopicIcon(call, 111, 41, '5312241539987020022')).toEqual({ kind: 'ok', changed: true });
	expect(server.calls('editForumTopic').map((call) => call.payload)).toEqual([{ chat_id: 111, message_thread_id: 41, icon_custom_emoji_id: '5312241539987020022' }]);
	server.fail('editForumTopic', { status: 400, description: 'Bad Request: TOPIC_NOT_MODIFIED' });
	expect(await setTopicIcon(call, 111, 41, '5312241539987020022')).toEqual({ kind: 'ok', changed: false });
});
