// The listener against a local Bot API server: the lease, the poll, the cursor after `handle`,
// the flush at start, every stop reason, the missed-tap notice, the cleanup and `onMessage`.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PACING } from '../chat/calls.ts';
import { commands } from '../commands/table.ts';
import { createChat, type Delivered } from '../chat/create.ts';
import { HEARTBEAT_AGE, listenerStatus, parseListener } from '../chat/listener.ts';
import { choice, text } from '../core/builders.ts';
import { isRecord } from '../core/check.ts';
import { parseQuestion } from '../core/parse.ts';
import { reduce } from '../core/reduce.ts';
import { defaultLabels, type Question, ShapeError, type Store, type ViewClient } from '../core/types.ts';
import { ORIGIN, tap, VIEW } from '../fixtures.ts';
import { fakeViews } from '../chat/harness.ts';
import { fileStore } from '../store/file.ts';
import { memoryStore } from '../store/memory.ts';
import { type FakeBotApi, fakeBotApi, TOKEN } from './fake-server.ts';
import { fetchCall } from './fetch.ts';
import { type Inbound, KEEP_CLOSED, LISTEN, listen, type ListenOptions, type Stopped } from './listen.ts';
import { parseStoredMessage } from './messages.ts';

PACING.interval = 0;
// A loaded machine runs these slowly; each wait below has its own deadline.
setDefaultTimeout(120_000);
LISTEN.beat = 100;
LISTEN.pause = 50;

const SPEC = choice({ markdown: 'Merge `fix/lock` now?' }, [{ label: 'Merge' }, { label: 'Wait' }]);
// Run last first: a listener ends before the directory of its store goes.
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Resolves once `check` holds, polling every 20 ms; throws after `ms`. */
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 30_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(20);
	}
}

/**
 * A server, a chat over fetchCall that records what onAnswer received, and a listener on
 * `store`. `stop()` aborts it and resolves with its reason.
 */
function start(
	options: {
		store?: Store;
		extra?: Partial<Pick<ListenOptions, 'now' | 'push'>>;
		messages?: Inbound[];
		onMessage?: (message: Inbound) => Promise<void>;
		server?: FakeBotApi;
		listen?: boolean;
	} = {},
) {
	const server = options.server ?? fakeBotApi();
	const store = options.store ?? memoryStore();
	const call = fetchCall({ token: TOKEN, apiUrl: server.url });
	const delivered: Delivered[] = [];
	const chat = createChat({ call, store, chat: 111, onAnswer: async (answer) => void delivered.push(answer) });
	const controller = new AbortController();
	const logs: string[] = [];
	const { messages } = options;
	const onMessage = options.onMessage ?? (messages ? async (message: Inbound) => void messages.push(message) : undefined);
	const base = { chat, call, store, signal: controller.signal, log: (line: string) => void logs.push(line), ...options.extra };
	const running: Promise<Stopped> | undefined = options.listen === false ? undefined : listen(onMessage ? { ...base, allow: [111], onMessage } : base);
	cleanups.push(async () => {
		controller.abort();
		await running?.catch(() => {});
		server.stop();
	});
	return {
		server,
		store,
		chat,
		delivered,
		logs,
		running,
		async stop(): Promise<Stopped | undefined> {
			controller.abort();
			return running;
		},
	};
}

test('a tap answers the question, shows the mark, moves the cursor and reaches onAnswer', async () => {
	const { server, store, chat, delivered, stop } = start();
	const sent = await chat.send(SPEC, { ref: 'q1' });
	expect(sent).toMatchObject({ kind: 'ok', sent: { message: 1001 } });
	await server.waitFor('getUpdates');
	const update = server.tap(1001, 1);
	await until(() => delivered.length === 1, 'the delivery');
	expect(delivered[0]).toMatchObject({ ref: 'q1', seq: 1, answer: { kind: 'choice', index: 1, label: 'Wait' }, delivery: 'q1:1' });
	expect(server.messages.get(1001)?.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Merge', callback_data: 'q:q1:0' }], [{ text: '✓ Wait', callback_data: 'q:q1:1' }]] });
	expect(server.calls('answerCallbackQuery')[0]?.payload).toMatchObject({ text: '✓ Wait' });
	await until(async () => isRecord(await store.get('cursor')), 'the cursor');
	expect(await store.get('cursor')).toMatchObject({ v: 1, offset: update.update_id + 1 });
	// The next poll confirms the update, and the polls ask for exactly the 2 update types.
	await until(() => server.calls('getUpdates').some((call) => call.payload.offset === update.update_id + 1), 'a poll with the new offset');
	for (const poll of server.calls('getUpdates')) expect(poll.payload).toMatchObject({ timeout: 50, allowed_updates: ['message', 'callback_query'] });
	expect(await stop()).toEqual({ reason: 'signal' });
	expect(await store.get('listener')).toMatchObject({ v: 1, stopped: 'signal' });
});

test('a text reply answers a text question', async () => {
	const { server, chat, delivered } = start();
	await chat.send(text({ markdown: 'Which branch?' }), { ref: 't1' });
	await server.waitFor('getUpdates');
	server.reply(1001, 'fix/lock');
	await until(() => delivered.length === 1, 'the delivery');
	expect(delivered[0]).toMatchObject({ ref: 't1', answer: { kind: 'text', text: 'fix/lock' } });
	expect(server.calls('setMessageReaction')[0]?.payload).toMatchObject({ reaction: [{ type: 'emoji', emoji: defaultLabels.ack }] });
});

test('the cursor moves only after handle: an update whose handle failed is fetched again', async () => {
	const root = mkdtempSync(join(tmpdir(), 'tau-listen-'));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const inner = fileStore(join(root, 'store'));
	// The first write of the answered question fails, as a full disk would.
	let failed = false;
	const store: Store = {
		...inner,
		async set(key, value) {
			if (!failed && key === 'q:q1' && isRecord(value) && value.status === 'answered') {
				failed = true;
				throw new Error('no space left on device');
			}
			return inner.set(key, value);
		},
	};
	const { server, chat, delivered, logs } = start({ store });
	await chat.send(SPEC, { ref: 'q1' });
	await server.waitFor('getUpdates');
	const update = server.tap(1001, 0);
	await until(() => delivered.length === 1, 'the delivery after the second fetch');
	expect(failed).toBe(true);
	expect(logs.some((line) => line.includes(`update ${update.update_id} failed and is fetched again`))).toBe(true);
	expect(parseQuestion(await store.get('q:q1'))).toMatchObject({ status: 'answered', seq: 1 });
	await until(async () => isRecord(await store.get('cursor')), 'the cursor');
	expect(await store.get('cursor')).toMatchObject({ offset: update.update_id + 1 });
});

test('a second listener on one store gets no lease and never polls', async () => {
	const store = memoryStore({ lockWait: 300 });
	const first = start({ store });
	await first.server.waitFor('getUpdates');
	const second = start({ store, server: first.server });
	expect(await second.running).toMatchObject({ reason: 'lease' });
	expect(first.server.calls('getUpdates')).toHaveLength(1);
	expect(first.server.calls('getWebhookInfo')).toHaveLength(1);
	expect(await first.stop()).toEqual({ reason: 'signal' });
});

test('a 409 from a newer poll stops the listener, which never polls again', async () => {
	const { server, running, store } = start();
	await server.waitFor('getUpdates');
	// Another process polls the same token: Telegram ends the older poll with 409.
	await fetchCall({ token: TOKEN, apiUrl: server.url })({ method: 'getUpdates', payload: { timeout: 0 } });
	expect(await running).toMatchObject({ reason: 'conflict', message: expect.stringContaining('terminated by other getUpdates request') });
	await Bun.sleep(LISTEN.pause * 6);
	expect(server.calls('getUpdates')).toHaveLength(2);
	expect(await store.get('listener')).toMatchObject({ stopped: 'conflict' });
});

test('a webhook stops the listener at the start and when it appears later', async () => {
	const atStart = fakeBotApi();
	atStart.setWebhook('https://hooks.example.com/secret');
	const first = start({ server: atStart });
	expect(await first.running).toMatchObject({ reason: 'webhook' });
	expect(atStart.calls('getUpdates')).toHaveLength(0);

	const later = start();
	await later.server.waitFor('getUpdates');
	later.server.setWebhook('https://hooks.example.com/secret');
	expect(await later.running).toMatchObject({ reason: 'webhook' });
	expect(later.server.calls('getUpdates')).toHaveLength(1);
});

test('a rejected token stops the listener, at the start and in handle', async () => {
	const revoked = fakeBotApi();
	revoked.revoke();
	expect(await start({ server: revoked }).running).toMatchObject({ reason: 'token' });
	expect(revoked.calls('getUpdates')).toHaveLength(0);

	const { server, chat, running, store } = start();
	await chat.send(SPEC, { ref: 'q1' });
	await server.waitFor('getUpdates');
	server.revoke();
	server.tap(1001, 0);
	expect(await running).toMatchObject({ reason: 'token' });
	expect(await store.get('listener')).toMatchObject({ stopped: 'token' });
	// The answer was stored before the toast met the 401.
	expect(parseQuestion(await store.get('q:q1'))).toMatchObject({ status: 'answered' });
});

test('the start flush renews an answer whose deliveries were spent', async () => {
	const store = memoryStore();
	const server = fakeBotApi();
	const call = fetchCall({ token: TOKEN, apiUrl: server.url });
	const failing = createChat({ call, store, chat: 111, onAnswer: async () => Promise.reject(new Error('exit 1')) });
	const sent = await failing.send(SPEC, { ref: 'q1' });
	if (sent.kind !== 'ok' || !sent.sent) throw new Error('the question was not sent');
	await failing.handle(tap({ button: 0, ref: 'q1', message: sent.sent.message }));
	for (let attempt = 0; attempt < 6; attempt++) await failing.flush().catch(() => {});
	expect(parseQuestion(await store.get('q:q1'))?.delivery).toMatchObject({ seq: 0, attempts: 5 });

	const { delivered } = start({ store, server });
	await until(() => delivered.length === 1, 'the renewed delivery');
	expect(delivered[0]).toMatchObject({ delivery: 'q1:1' });
	// `flush` stores the delivery once onAnswer resolved.
	await until(async () => parseQuestion(await store.get('q:q1'))?.delivery.seq === 1, 'the stored delivery');
	expect(parseQuestion(await store.get('q:q1'))?.delivery).toEqual({ seq: 1, attempts: 0 });
});

test('a 429 on the edit of a tap is retried at its time', async () => {
	const { server, chat, delivered } = start();
	await chat.send(SPEC, { ref: 'q1' });
	await server.waitFor('getUpdates');
	server.fail('editMessageText', { status: 429, retryAfter: 1 });
	server.tap(1001, 0);
	await until(() => server.calls('editMessageText').length === 2, 'the second edit');
	const [refused, retried] = server.calls('editMessageText');
	if (!refused || !retried) throw new Error('unreachable: 2 edits arrived');
	expect(retried.at - refused.at).toBeGreaterThanOrEqual(1_000);
	expect(retried.payload).toEqual(refused.payload);
	expect(server.messages.get(1001)?.reply_markup).toMatchObject({ inline_keyboard: [[{ text: '✓ Merge' }], [{ text: 'Wait' }]] });
	await until(() => delivered.length === 1, 'the delivery');
});

test('a poll after a pause of more than 150 s sends one notice while a question takes answers', async () => {
	const store = memoryStore();
	const clock = { now: Date.now() };
	await store.set('listener', { v: 1, heartbeat: clock.now - 200_000, polled: clock.now - 200_000 });
	const quiet = start({ store, extra: { now: () => clock.now }, listen: false });
	await quiet.chat.send(SPEC, { ref: 'q1' });
	quiet.server.stop();

	const { server, stop } = start({ store, extra: { now: () => clock.now } });
	await until(() => server.calls('getUpdates').length >= 1 && server.calls('sendRichMessage').length === 1, 'the notice');
	expect(server.calls('sendRichMessage')[0]?.payload.rich_message).toEqual({ markdown: 'The listener was away for more than 150 s. Taps from that time are lost, tap again.' });
	await Bun.sleep(LISTEN.beat * 3);
	expect(server.calls('sendRichMessage')).toHaveLength(1);
	await stop();

	// Without a question that takes answers, no tap can have been lost.
	const closed = memoryStore();
	await closed.set('listener', { v: 1, heartbeat: clock.now - HEARTBEAT_AGE * 3 });
	const none = start({ store: closed });
	await none.server.waitFor('getUpdates');
	await Bun.sleep(LISTEN.beat * 2);
	expect(none.server.calls('sendRichMessage')).toHaveLength(0);
});

test('closed questions older than 30 days are deleted with a tombstone, all others stay', async () => {
	const store = memoryStore();
	const now = Date.now();
	const old = now - KEEP_CLOSED - 1_000;
	const ask = (ref: string, at: number): Question => {
		const asked = reduce(undefined, { type: 'ask', spec: SPEC, ref, chat: 111, allow: [111] }, { now: at }).question;
		const sent = asked && reduce(asked, { type: 'sent', sent: { chat: 111, message: ref === 'old' ? 7 : 8, files: [], ref } }, { now: at }).question;
		if (!sent) throw new Error('unreachable');
		return sent;
	};
	const closedOld = reduce(ask('old', old), { type: 'close' }, { now: old }).question;
	await store.set('q:old', closedOld);
	await store.set('m:111:7', 'old');
	await store.set('q:open', ask('open', old));
	await store.set('q:fresh', reduce(ask('fresh', now), { type: 'close' }, { now }).question);
	const { server } = start({ store });
	await server.waitFor('getUpdates');
	await until(async () => (await store.get('q:old')) === undefined, 'the delete');
	expect(await store.get('t:old')).toMatchObject({ v: 1 });
	expect(await store.get('m:111:7')).toBeUndefined();
	expect(await store.list('q:')).toEqual(['q:fresh', 'q:open']);
});

test('a closed question older than 30 days that owes the view host its closed binding survives cleanup, and goes once it is stored', async () => {
	const store = memoryStore();
	const old = Date.now() - KEEP_CLOSED - 1_000;
	const inView = choice({ markdown: 'Which layout should stay?' }, [{ label: 'A', tab: 'A' }, { label: 'B', tab: 'B' }], { view: VIEW, in: 'view' });
	/** A question asked 30 days ago on message `message`, closed then; `expiresAt` lies a day ahead. */
	const closedOld = (ref: string, message: number, spec: Question['spec']): Question => {
		const events: Parameters<typeof reduce>[1][] = [{ type: 'sent', sent: { chat: 111, message, files: [], ref, view: { id: VIEW, origin: ORIGIN } } }, { type: 'close' }];
		const first = reduce(undefined, { type: 'ask', spec, ref, chat: 111, allow: [111], viewOrigin: ORIGIN, expiresAt: Date.now() + 86_400_000 }, { now: old }).question;
		const last = events.reduce<Question | undefined>((question, event) => question && reduce(question, event, { now: old }).question, first);
		if (!last) throw new Error('unreachable');
		return last;
	};
	await store.set('q:owing', closedOld('owing', 11, inView));
	expect(parseQuestion(await store.get('q:owing'))).toMatchObject({ status: 'closed', bindingOwed: true });
	// A closed question in the chat beside it shows that the cleanup ran.
	await store.set('q:done', closedOld('done', 12, choice({ markdown: 'Merge?' }, [{ label: 'A' }, { label: 'B' }], { view: VIEW })));

	// The view host takes no write until `up`.
	let up = false;
	const host = fakeViews();
	const views: ViewClient = {
		...host.views,
		context: async (...args) => {
			if (!up) throw new Error('the view host is down');
			return host.views.context(...args);
		},
	};
	const server = fakeBotApi();
	cleanups.push(() => server.stop());
	const call = fetchCall({ token: TOKEN, apiUrl: server.url });
	const chat = createChat({ call, store, chat: 111, viewOrigin: ORIGIN, views });
	const run = () => {
		const controller = new AbortController();
		const running = listen({ chat, call, store, signal: controller.signal });
		cleanups.push(async () => {
			controller.abort();
			await running.catch(() => {});
		});
		return async () => {
			controller.abort();
			await running;
		};
	};
	const stop = run();
	await until(async () => (await store.get('q:done')) === undefined, 'the cleanup of the question that owes nothing');
	await stop();
	expect(parseQuestion(await store.get('q:owing'))).toMatchObject({ bindingOwed: true });
	expect(await store.get('t:owing')).toBeUndefined();

	up = true;
	await chat.flush();
	expect(host.writes.at(-1)).toMatchObject({ ref: 'owing', choice: { closed: true } });
	expect(parseQuestion(await store.get('q:owing'))).not.toHaveProperty('bindingOwed');
	run();
	await until(async () => (await store.get('q:owing')) === undefined, 'the cleanup once the binding is stored');
	expect(await store.get('t:owing')).toMatchObject({ v: 1 });
});

test('a closed question older than 30 days answered in its view survives cleanup while a recheck is due, since an earlier context write may still land over the closed one', async () => {
	const store = memoryStore();
	const old = Date.now() - KEEP_CLOSED - 1_000;
	/** A question asked 30 days ago on message `message` and closed then, its closed binding stored, with a recheck a minute ahead. */
	const rechecking = (ref: string, message: number, spec: Question['spec']): Question => {
		const events: Parameters<typeof reduce>[1][] = [{ type: 'sent', sent: { chat: 111, message, files: [], ref, view: { id: VIEW, origin: ORIGIN } } }, { type: 'close' }];
		const first = reduce(undefined, { type: 'ask', spec, ref, chat: 111, allow: [111], viewOrigin: ORIGIN, expiresAt: Date.now() + 86_400_000 }, { now: old }).question;
		const last = events.reduce<Question | undefined>((question, event) => question && reduce(question, event, { now: old }).question, first);
		if (!last) throw new Error('unreachable');
		const { bindingOwed: _paid, ...closed } = last;
		return { ...closed, shown: { ...closed.shown, done: closed.shown.want, recheckAt: Date.now() + 60_000 } };
	};
	const inView = rechecking('late', 11, choice({ markdown: 'Which layout should stay?' }, [{ label: 'A', tab: 'A' }, { label: 'B', tab: 'B' }], { view: VIEW, in: 'view' }));
	await store.set('q:late', inView);
	expect(parseQuestion(await store.get('q:late'))).toMatchObject({ status: 'closed', shown: { recheckAt: expect.any(Number) } });
	expect(parseQuestion(await store.get('q:late'))).not.toHaveProperty('bindingOwed');
	// A question answered in the chat with the same recheck goes: its host takes no choice for it.
	await store.set('q:chat', rechecking('chat', 12, choice({ markdown: 'Merge?' }, [{ label: 'A' }, { label: 'B' }], { view: VIEW })));

	const server = fakeBotApi();
	cleanups.push(() => server.stop());
	const call = fetchCall({ token: TOKEN, apiUrl: server.url });
	const chat = createChat({ call, store, chat: 111, viewOrigin: ORIGIN, views: fakeViews().views });
	const run = () => {
		const controller = new AbortController();
		const running = listen({ chat, call, store, signal: controller.signal });
		cleanups.push(async () => {
			controller.abort();
			await running.catch(() => {});
		});
		return async () => {
			controller.abort();
			await running;
		};
	};
	const stop = run();
	await until(async () => (await store.get('q:chat')) === undefined, 'the cleanup of the question answered in the chat');
	await stop();
	expect(parseQuestion(await store.get('q:late'))).toMatchObject({ status: 'closed' });
	expect(await store.get('t:late')).toBeUndefined();

	// Once the recheck confirmed the message and its context, the question goes.
	const { recheckAt: _done, ...shown } = inView.shown;
	await store.set('q:late', { ...inView, shown });
	run();
	await until(async () => (await store.get('q:late')) === undefined, 'the cleanup once the recheck is done');
	expect(await store.get('t:late')).toMatchObject({ v: 1 });
});

test('a Chat reused by two listeners in a row stops at the budget info reports as spent', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'tau-reuse-'));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	// The store of fake mode in `dir`, so that the info command reads this very store.
	const store = fileStore(join(dir, 'store'));
	const server = fakeBotApi();
	cleanups.push(() => server.stop());
	const call = fetchCall({ token: TOKEN, apiUrl: server.url });
	let attempts = 0;
	const chat = createChat({
		call,
		store,
		chat: 111,
		onAnswer: async () => {
			attempts++;
			throw new Error('consumer down');
		},
	});
	const attemptsStored = async () => parseQuestion(await store.get('q:reuse'))?.delivery.attempts;
	const sent = await chat.send(SPEC, { ref: 'reuse' });
	if (sent.kind !== 'ok' || !sent.sent) throw new Error('the question was not sent');
	await chat.handle(tap({ button: 0, ref: 'reuse', message: sent.sent.message }));
	for (let flush = 0; flush < 6; flush++) await chat.flush().catch(() => {});
	expect(await attemptsStored()).toBe(5);

	// Each listener run makes only the attempt of its start: the beat would add more.
	const beat = LISTEN.beat;
	LISTEN.beat = 600_000;
	try {
		for (const expected of [6, 7]) {
			const controller = new AbortController();
			const running = listen({ chat, call, store, signal: controller.signal });
			await until(async () => (await attemptsStored()) === expected, `attempt ${expected}`);
			controller.abort();
			expect(await running).toEqual({ reason: 'signal' });
		}
	} finally {
		LISTEN.beat = beat;
	}
	// The second start found 2 attempts since the baseline of 5 and kept it.
	expect(parseListener(await store.get('listener'))?.renewed?.answers).toEqual({ 'reuse:1': 5 });
	for (let flush = 0; flush < 5; flush++) await chat.flush().catch(() => {});
	expect(await attemptsStored()).toBe(10);
	expect(attempts).toBe(10);

	const info = commands.find((command) => command.name === 'info');
	const result = await info?.invoke({}, { env: { TELEGRAM_AGENT_UI_FAKE: dir, HOME: dir }, roots: [dir], log: () => {}, signal: new AbortController().signal });
	expect(result).toMatchObject({ ok: true, output: { questions: { undelivered: [{ ref: 'reuse', seq: 1, attempts: 5, error: 'consumer down' }] } } });
});

test('a closed question older than 30 days whose answer is owed survives cleanup, and goes once it is delivered', async () => {
	const store = memoryStore();
	const old = Date.now() - KEEP_CLOSED - 1_000;
	/** A question asked 30 days ago, answered by a tap and closed, with its answer delivered or owed. */
	const closedAnswered = (ref: string, message: number, delivered: boolean): Question => {
		const events: Parameters<typeof reduce>[1][] = [
			{ type: 'sent', sent: { chat: 111, message, files: [], ref } },
			{ type: 'input', update: tap({ button: 0, ref, message }) },
			...(delivered ? [{ type: 'delivered' as const, seq: 1 }] : []),
			{ type: 'close' },
		];
		const first = reduce(undefined, { type: 'ask', spec: SPEC, ref, chat: 111, allow: [111] }, { now: old }).question;
		const last = events.reduce<Question | undefined>((question, event) => question && reduce(question, event, { now: old }).question, first);
		if (!last) throw new Error('unreachable');
		return last;
	};
	const owed = closedAnswered('owed', 9, false);
	expect(owed).toMatchObject({ status: 'closed', seq: 1, delivery: { seq: 0 } });
	await store.set('q:owed', owed);
	// A delivered one beside it shows that the cleanup ran.
	await store.set('q:done', closedAnswered('done', 10, true));

	// A listener whose consumer refuses every answer: the answer stays owed.
	const server = fakeBotApi();
	const call = fetchCall({ token: TOKEN, apiUrl: server.url });
	const refusing = createChat({ call, store, chat: 111, onAnswer: async () => Promise.reject(new Error('consumer down')) });
	const controller = new AbortController();
	const first = listen({ chat: refusing, call, store, signal: controller.signal });
	cleanups.push(async () => {
		controller.abort();
		await first.catch(() => {});
	});
	await until(async () => (await store.get('q:done')) === undefined, 'the cleanup of the delivered question');
	await until(async () => (parseQuestion(await store.get('q:owed'))?.delivery.attempts ?? 0) >= 1, 'a refused delivery');
	expect(parseQuestion(await store.get('q:owed'))).toMatchObject({ status: 'closed', delivery: { seq: 0 } });
	expect(await store.get('t:owed')).toBeUndefined();
	controller.abort();
	expect(await first).toEqual({ reason: 'signal' });

	// A working consumer takes the answer; the next cleanup, an hour later, deletes the question.
	const clock = { now: Date.now() };
	const { delivered } = start({ store, server, extra: { now: () => clock.now } });
	await until(() => delivered.length === 1, 'the delivery');
	clock.now += 3_600_000;
	await until(async () => (await store.get('q:owed')) === undefined, 'the delete after the delivery');
	expect(await store.get('t:owed')).toMatchObject({ v: 1 });
});

test('an ignored message from an allowed user reaches onMessage with the ref of the question it replies to', async () => {
	const messages: Inbound[] = [];
	const { server, chat, store } = start({ messages });
	await chat.send(SPEC, { ref: 'q1' });
	await server.waitFor('getUpdates');
	server.reply(1001, 'Merge after the release');
	server.say('from a stranger', { user: 999 });
	server.push({ message: { message_id: 4000, from: { id: 111, is_bot: false, first_name: 'Dana' }, chat: { id: 111, type: 'private', first_name: 'Dana' }, date: 1, forward_origin: { type: 'hidden_user', sender_user_name: 'A', date: 1 }, text: 'forwarded words' } });
	server.say('plain words');
	await until(() => messages.length === 3, 'three forwarded messages');
	expect(messages).toEqual([
		{ message: 1002, text: 'Merge after the release', replyTo: 1001, ref: 'q1', files: [] },
		{ message: 4000, forwarded: { text: 'forwarded words' }, files: [] },
		{ message: 1004, text: 'plain words', files: [] },
	]);
	// The reply answered nothing: a choice question takes only a tap.
	expect(parseQuestion(await store.get('q:q1'))).toMatchObject({ status: 'open' });
});

test('a message whose onMessage fails stays stored after the cursor moved, gets 5 attempts, and reaches the consumer after a restart', async () => {
	const store = memoryStore();
	let attempts = 0;
	const first = start({
		store,
		onMessage: async () => {
			attempts++;
			throw new Error('consumer unavailable');
		},
	});
	await first.server.waitFor('getUpdates');
	const update = first.server.say('deploy notes');
	await until(() => attempts === 5, 'five attempts');
	await Bun.sleep(LISTEN.beat * 4);
	expect(attempts).toBe(5);
	// Telegram has the update confirmed: the store holds the message.
	expect(await store.get('cursor')).toMatchObject({ offset: update.update_id + 1 });
	expect(await store.get('in:111:1001')).toMatchObject({ v: 1, attempts: 5, error: 'consumer unavailable', message: { text: 'deploy notes', files: [] } });
	expect(await first.stop()).toEqual({ reason: 'signal' });

	const received: Inbound[] = [];
	start({ store, server: first.server, messages: received });
	await until(() => received.length === 1, 'the delivery after the restart');
	expect(received[0]).toEqual({ message: 1001, text: 'deploy notes', files: [] });
	await until(async () => (await store.get('in:111:1001')) === undefined, 'the delivered message to leave the store');
	expect(received).toHaveLength(1);
});

test('a new message under the update id of a stored one gets its own entry, and both are delivered', async () => {
	const store = memoryStore();
	const first = start({
		store,
		onMessage: async () => {
			throw new Error('consumer unavailable');
		},
	});
	await first.server.waitFor('getUpdates');
	const old = first.server.say('the old note');
	const refused = async () => {
		for (const key of await store.list('in:')) if ((parseStoredMessage(await store.get(key))?.attempts ?? 0) >= 1) return true;
		return false;
	};
	await until(refused, 'a stored, refused message');
	await first.server.waitFor('getUpdates', (call) => call.payload.offset === old.update_id + 1);
	expect(await first.stop()).toEqual({ reason: 'signal' });

	// After a week of silence Telegram restarts its update ids, and the listener sends no old offset.
	await store.set('cursor', { v: 1, offset: old.update_id + 1, at: Date.now() - 7 * 86_400_000 });
	const fresh = first.server.say('the new note', { update: old.update_id });
	expect(fresh.update_id).toBe(old.update_id);
	// The consumer refuses until it was offered 2 messages, so the old entry still waits when the new message arrives.
	const offered = new Set<number>();
	const received: Inbound[] = [];
	start({
		store,
		server: first.server,
		onMessage: async (message) => {
			offered.add(message.message);
			if (offered.size < 2) throw new Error('waiting for the second message');
			received.push(message);
		},
	});
	await until(() => received.length === 2, 'both messages');
	expect(received.map((message) => [message.message, message.text]).sort()).toEqual([
		[1001, 'the old note'],
		[1002, 'the new note'],
	]);
	await until(async () => (await store.list('in:')).length === 0, 'both entries to leave the store');
});

test('one message fetched again under another update id keeps its entry and its spent budget', async () => {
	const store = memoryStore();
	const key = 'in:111:4001';
	// 4 rejections so far: the listener's start makes the fifth, which spends the budget.
	await store.set(key, { v: 1, chat: 111, update: 900, message: { message: 4001, text: 'same note', files: [] }, attempts: 4 });
	let callbacks = 0;
	const { server } = start({
		store,
		onMessage: async () => {
			callbacks++;
			throw new Error('still unavailable');
		},
	});
	await until(async () => parseStoredMessage(await store.get(key))?.attempts === 5, 'the fifth rejection');
	expect(callbacks).toBe(1);
	// The same chat and message, fetched again under another update id.
	const person = { id: 111, is_bot: false, first_name: 'Dana' };
	server.push({ message: { message_id: 4001, from: person, chat: { id: 111, type: 'private', first_name: 'Dana' }, date: 1, text: 'same note' } }, 901);
	await until(async () => {
		const cursor = await store.get('cursor');
		return isRecord(cursor) && cursor.offset === 902;
	}, 'the acknowledged repeat');
	// Flushes go on every beat: none of them may find a fresh budget.
	await Bun.sleep(LISTEN.beat * 5);
	expect(callbacks).toBe(1);
	expect(await store.list('in:')).toEqual([key]);
	expect(parseStoredMessage(await store.get(key))).toEqual({ v: 1, chat: 111, update: 900, message: { message: 4001, text: 'same note', files: [] }, attempts: 5, error: 'still unavailable' });
});

test('a hanging onMessage holds up no tap', async () => {
	let release = () => {};
	const hanging = new Promise<void>((resolve) => {
		release = resolve;
	});
	const { server, chat, delivered, stop } = start({ onMessage: () => hanging });
	await chat.send(SPEC, { ref: 'q1' });
	await server.waitFor('getUpdates');
	server.say('a note while the consumer hangs');
	server.tap(1001, 0);
	await until(() => delivered.length === 1, 'the answer behind the hanging message');
	release();
	expect(await stop()).toEqual({ reason: 'signal' });
});

test('a heartbeat still writing when the listener stops never lands after the stopped record', async () => {
	const inner = memoryStore();
	let armed = false;
	let held = false;
	let open = () => {};
	const gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	// Holds the first heartbeat written once armed, as a slow disk would.
	const store: Store = {
		...inner,
		async set(key, value) {
			if (armed && !held && key === 'listener' && isRecord(value) && value.stopped === undefined) {
				held = true;
				await gate;
			}
			return inner.set(key, value);
		},
	};
	const { server, stop } = start({ store });
	await server.waitFor('getUpdates');
	armed = true;
	await until(() => held, 'a held heartbeat');
	const stopping = stop();
	await Bun.sleep(LISTEN.beat * 2);
	open();
	expect(await stopping).toEqual({ reason: 'signal' });
	await Bun.sleep(LISTEN.beat * 2);
	expect(listenerStatus(await inner.get('listener'), Date.now())).toEqual({ alive: false, stopped: 'signal' });
});

test('a description that quotes the token reaches no log and no stored question', async () => {
	const { server, chat, store, logs } = start({ listen: false });
	await chat.send(SPEC, { ref: 'q1' });
	server.fail('getUpdates', { status: 400, description: `Bad Request: route /bot${TOKEN}/getUpdates is closed` });
	server.fail('editMessageText', { status: 400, description: `Bad Request: proxy refused /bot${TOKEN}/editMessageText` });
	const listening = start({ store, server });
	await until(() => listening.logs.some((line) => line.includes('getUpdates failed')), 'the logged refusal');
	server.tap(1001, 0);
	await until(async () => parseQuestion(await store.get('q:q1'))?.shown.error !== undefined, 'the refused edit');
	const secret = TOKEN.slice(TOKEN.indexOf(':') + 1);
	const written = JSON.stringify([logs, listening.logs, await store.get('q:q1')]);
	expect(written).not.toContain(secret);
	expect(written).toContain('/bot<token>/getUpdates');
	expect(parseQuestion(await store.get('q:q1'))?.shown.error).toBe('Bad Request: proxy refused /bot<token>/editMessageText');
});

test('a push with a hole is refused before the lease, and an accepted one reads back after JSON', async () => {
	const inner = memoryStore();
	const refusedStart = start({ store: inner, extra: { push: { metaKeys: new Array<string>(1) } } });
	await expect(refusedStart.running ?? Promise.resolve()).rejects.toThrow(ShapeError);
	expect(await inner.get('listener')).toBeUndefined();

	// A store that keeps only what JSON keeps.
	const store: Store = { ...inner, set: (key, value) => inner.set(key, JSON.parse(JSON.stringify(value))) };
	const keys = ['session'];
	const { server } = start({ store, extra: { push: { metaKeys: keys } } });
	await server.waitFor('getUpdates');
	keys.push('changed later');
	await Bun.sleep(LISTEN.beat * 2);
	const value = await inner.get('listener');
	expect(parseListener(value)).toMatchObject({ v: 1, push: { metaKeys: ['session'] }, renewed: { answers: {}, messages: {} } });
	expect(listenerStatus(value, Date.now())).toEqual({ alive: true });
});

test('a cursor older than 6 days is not sent, a younger one is', async () => {
	const stale = memoryStore();
	await stale.set('cursor', { v: 1, offset: 900, at: Date.now() - 7 * 86_400_000 });
	const old = start({ store: stale });
	expect((await old.server.waitFor('getUpdates')).payload).not.toHaveProperty('offset');
	const fresh = memoryStore();
	await fresh.set('cursor', { v: 1, offset: 900, at: Date.now() - 86_400_000 });
	const young = start({ store: fresh });
	expect((await young.server.waitFor('getUpdates')).payload).toMatchObject({ offset: 900 });
});
