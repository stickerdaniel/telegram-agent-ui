import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { DEADLINES, PACING } from '../chat/calls.ts';
import { createChat } from '../chat/create.ts';
import { choice, text } from '../core/builders.ts';
import { isRecord } from '../core/check.ts';
import { parseQuestion } from '../core/parse.ts';
import { type Call, type CallResponse, defaultLabels, type Store, type Update } from '../core/types.ts';
import { memoryStore } from '../store/memory.ts';
import { filesOf, parseFileRecord, recordFiles } from './inbound.ts';
import { CURSOR_KEY, type Inbound, isUpdate, LISTEN, listen, parseCursor, type Stopped } from './listen.ts';
import { courier, parseStoredMessage } from './messages.ts';
import { LANES, type InboundUpdate, parseStoredUpdate } from './updates.ts';

PACING.interval = 0;
LISTEN.beat = 100;
LISTEN.pause = 50;
setDefaultTimeout(60_000);

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PERSON = { id: 111, is_bot: false, first_name: 'Dana' };
const CHAT = { id: 111, type: 'private', first_name: 'Dana' };
const DATE = 1_794_908_513;

function asUpdate(value: Record<string, unknown>): Update {
	if (!isUpdate(value)) throw new Error('no update');
	return value;
}

function telegram() {
	const queue: Update[] = [];
	const calls: Call[] = [];
	const stalls = new Map<string, Promise<void>>();
	let nextUpdate = 1;
	let nextMessage = 500;
	let wake = () => {};
	const call = async (request: Call): Promise<CallResponse> => {
		calls.push(request);
		await stalls.get(request.method);
		if (request.method === 'getWebhookInfo') return { ok: true, result: { url: '' } };
		if (request.method === 'getUpdates') {
			const offset = request.payload.offset;
			if (typeof offset === 'number') queue.splice(0, queue.length, ...queue.filter((update) => update.update_id >= offset));
			if (queue.length === 0) await new Promise<void>((resolve) => {
				wake = resolve;
				setTimeout(resolve, 100);
			});
			return { ok: true, result: [...queue] };
		}
		if (request.method === 'sendRichMessage') return { ok: true, result: { message_id: ++nextMessage, date: DATE, chat: { id: request.payload.chat_id, type: 'private' } } };
		return { ok: true, result: true };
	};
	return {
		call,
		calls,
		push(...updates: Record<string, unknown>[]): Update[] {
			const pushed = updates.map((update) => asUpdate({ ...update, update_id: typeof update.update_id === 'number' ? update.update_id : nextUpdate++ }));
			queue.push(...pushed);
			wake();
			return pushed;
		},
		stall(method: string): () => void {
			let release = () => {};
			stalls.set(
				method,
				new Promise<void>((resolve) => {
					release = () => {
						stalls.delete(method);
						resolve();
					};
				}),
			);
			return release;
		},
		nextMessage: () => nextMessage + 1,
	};
}
type Telegram = ReturnType<typeof telegram>;

const message = (id: number, fields: Record<string, unknown> = {}) => ({ message: { message_id: id, from: PERSON, chat: CHAT, date: DATE, text: 'hello', ...fields } });
const edited = (id: number, fields: Record<string, unknown> = {}) => ({ edited_message: { message_id: id, from: PERSON, chat: CHAT, date: DATE, edit_date: DATE + 5, text: 'hello, edited', ...fields } });
const reaction = (id: number, fields: Record<string, unknown> = {}) => ({
	message_reaction: { chat: CHAT, message_id: id, user: PERSON, date: DATE + 6, old_reaction: [], new_reaction: [{ type: 'emoji', emoji: '👍' }], ...fields },
});
const tapOn = (id: string, data: string, fields: Record<string, unknown> = {}, on: number = 700) => ({
	callback_query: { id, from: PERSON, chat_instance: '1', data, message: { message_id: on, date: DATE, chat: CHAT }, ...fields },
});
const document = (id: string, name = 'notes.pdf') => ({ file_id: id, file_unique_id: `u-${id}`, file_name: name, mime_type: 'application/pdf', file_size: 1200 });

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 20_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(20);
	}
}

function run(
	transport: Telegram,
	store: Store,
	options: {
		origin?: string;
		onUpdate?: (update: InboundUpdate, deadline: number) => Promise<void>;
		onMessage?: (message: Inbound) => Promise<void>;
		withoutUpdates?: boolean;
		handled?: (update: Update) => void;
		now?: () => number;
	} = {},
) {
	const updates: InboundUpdate[] = [];
	const messages: Inbound[] = [];
	const logs: string[] = [];
	const chat = createChat({ call: transport.call, store, chat: 111 });
	const controller = new AbortController();
	const onUpdate = options.onUpdate ?? (async (update: InboundUpdate) => void updates.push(update));
	const { handled } = options;
	const running = listen({
		chat: handled
			? {
					...chat,
					handle: async (update) => {
						const result = await chat.handle(update);
						handled(update);
						return result;
					},
				}
			: chat,
		...(options.now ? { now: options.now } : {}),
		target: 111,
		origin: options.origin ?? 'https://api.telegram.org',
		allow: [111],
		call: transport.call,
		store,
		signal: controller.signal,
		log: (line) => void logs.push(line),
		onMessage: options.onMessage ?? (async (inbound) => void messages.push(inbound)),
		...(options.withoutUpdates ? {} : { onUpdate }),
	});
	const stop = async (): Promise<Stopped> => {
		controller.abort();
		return running;
	};
	cleanups.push(() => stop().catch(() => {}));
	return { chat, updates, messages, logs, running, stop };
}

function byKey(updates: InboundUpdate[]): Map<string, InboundUpdate[]> {
	const keys = new Map<string, InboundUpdate[]>();
	for (const update of updates) keys.set(update.key, [...(keys.get(update.key) ?? []), update]);
	return keys;
}

test('a message, two edits and two reactions in one second, a tap on a foreign button and a message whose body handle refuses each reach onUpdate under their own key', async () => {
	const transport = telegram();
	const store = memoryStore();
	const listener = run(transport, store);
	await until(() => transport.calls.some((call) => call.method === 'getUpdates'), 'the first poll');
	const asked = await listener.chat.send(text({ markdown: 'Which branch?' }), { ref: 'branch' });
	if (asked.kind !== 'ok' || !asked.sent) throw new Error('the question was not sent');
	const [hello, edit1, edit2, react1, react2, foreign, unreadable] = transport.push(
		message(600),
		edited(600),
		edited(600, { text: 'hello, edited twice' }),
		reaction(600),
		reaction(600, { new_reaction: [] }),
		tapOn('cq-foreign', 'desk:draft:7'),
		message(601, { text: 42, reply_to_message: { message_id: asked.sent.message, date: DATE, chat: CHAT } }),
	);
	await until(() => byKey(listener.updates).size === 7, 'seven receipts');
	expect([...byKey(listener.updates).keys()].sort()).toEqual(
		['up:m:111:600', `up:u:1:${edit1?.update_id}`, `up:u:1:${edit2?.update_id}`, `up:u:1:${react1?.update_id}`, `up:u:1:${react2?.update_id}`, 'up:c:cq-foreign', 'up:m:111:601'].sort(),
	);
	const got = (key: string) => listener.updates.find((update) => update.key === key);
	expect(got('up:m:111:600')).toMatchObject({ key: 'up:m:111:600', epoch: 1, updateId: hello?.update_id ?? 0, handled: { kind: 'ignored' } });
	expect(got('up:m:111:600')?.update).toEqual(hello ?? asUpdate({ update_id: 0 }));
	expect(got('up:c:cq-foreign')).toMatchObject({ update: foreign, handled: { kind: 'ignored' } });
	expect(got('up:m:111:601')).toMatchObject({ update: unreadable, handled: { error: 'the text of the message breaks its type' } });
	expect(transport.calls.filter((call) => call.method === 'answerCallbackQuery')).toEqual([]);
	for (const poll of transport.calls.filter((call) => call.method === 'getUpdates')) expect(poll.payload.allowed_updates).toEqual(['message', 'edited_message', 'callback_query', 'message_reaction']);
	await until(async () => (await store.list('up:')).length === 0, 'the delivered receipts to leave the store');
	expect(parseQuestion(await store.get('q:branch'))).toMatchObject({ status: 'open' });
});

test('updates of another chat, of another user, an anonymous reaction and an inline tap reach no consumer and are counted, and a forbidden tap still gets its toast', async () => {
	const transport = telegram();
	const store = memoryStore();
	const listener = run(transport, store);
	await until(() => transport.calls.some((call) => call.method === 'getUpdates'), 'the first poll');
	const asked = await listener.chat.send(choice({ markdown: 'Merge now?' }, [{ label: 'Merge' }, { label: 'Wait' }]), { ref: 'merge' });
	if (asked.kind !== 'ok' || !asked.sent) throw new Error('the question was not sent');
	const stranger = { ...PERSON, id: 999 };
	transport.push(
		message(610, { chat: { id: 222, type: 'private', first_name: 'Dana' }, document: document('elsewhere') }),
		message(611, { from: stranger, chat: { id: 111, type: 'private' }, document: document('stranger') }),
		reaction(600, { user: undefined, actor_chat: { id: -100, type: 'channel', title: 'News' } }),
		tapOn('cq-stranger', 'q:merge:0', { from: stranger }, asked.sent.message),
		{ callback_query: { id: 'cq-inline', from: PERSON, chat_instance: '1', inline_message_id: 'AAA', data: 'x' } },
		message(612, { text: 'the one that passes', document: document('mine') }),
	);
	await until(async () => parseCursor(await store.get(CURSOR_KEY))?.refused === 5, 'five refused updates');
	await until(() => listener.updates.length === 1 && listener.messages.length === 1, 'the admitted message');
	expect(listener.updates.map((update) => update.key)).toEqual(['up:m:111:612']);
	expect(listener.messages).toEqual([{ kind: 'message', message: 612, text: 'the one that passes', files: [{ id: 'mine', name: 'notes.pdf', bytes: 1200 }] }]);
	const records = await Promise.all((await store.list('fa:')).map(async (key) => parseFileRecord(await store.get(key))?.id));
	expect(records).toEqual(['mine']);
	expect(transport.calls.filter((call) => call.method === 'answerCallbackQuery').map((call) => call.payload)).toEqual([{ callback_query_id: 'cq-stranger', text: defaultLabels.forbidden }]);
	expect(parseQuestion(await store.get('q:merge'))).toMatchObject({ status: 'open' });
});

test('a new origin, also a return to an earlier one, starts a new epoch before its first poll, and its edits get keys of that epoch', async () => {
	const store = memoryStore();
	const first = telegram();
	const one = run(first, store, { origin: 'https://api.telegram.org' });
	const [edit] = first.push({ ...edited(600), update_id: 7 });
	await until(() => one.updates.length === 1, 'the first edit');
	expect(one.updates[0]?.key).toBe('up:u:1:7');
	await until(async () => parseCursor(await store.get(CURSOR_KEY))?.offset === 8, 'the moved cursor');
	await one.stop();

	const second = telegram();
	const two = run(second, store, { origin: 'http://127.0.0.1:8081' });
	await until(() => second.calls.some((call) => call.method === 'getUpdates'), 'the first poll of the new origin');
	const firstPoll = second.calls.find((call) => call.method === 'getUpdates');
	expect(firstPoll?.payload).not.toHaveProperty('offset');
	expect(await store.get(CURSOR_KEY)).toMatchObject({ origin: 'http://127.0.0.1:8081', epoch: 2 });
	second.push({ ...edited(600), update_id: 7 });
	await until(() => two.updates.length === 1, 'the edit of the new origin');
	expect(two.updates[0]?.key).toBe('up:u:2:7');
	await two.stop();

	const third = telegram();
	run(third, store, { origin: 'https://api.telegram.org' });
	await until(() => third.calls.some((call) => call.method === 'getUpdates'), 'the first poll back on the cloud');
	expect(third.calls.find((call) => call.method === 'getUpdates')?.payload).not.toHaveProperty('offset');
	expect(await store.get(CURSOR_KEY)).toMatchObject({ origin: 'https://api.telegram.org', epoch: 3 });
	expect(edit?.update_id).toBe(7);
});

function mortal(inner: Store, at: (method: 'set' | 'delete', key: string) => boolean) {
	let dead = false;
	const dying = (method: 'set' | 'delete', key: string) => {
		if (!dead && at(method, key)) dead = true;
		if (dead) throw new Error('the process is gone');
	};
	const store: Store = {
		get: async (key) => {
			if (dead) throw new Error('the process is gone');
			return inner.get(key);
		},
		set: async (key, value) => {
			dying('set', key);
			return inner.set(key, value);
		},
		delete: async (key) => {
			dying('delete', key);
			return inner.delete(key);
		},
		list: async (prefix) => {
			if (dead) throw new Error('the process is gone');
			return inner.list(prefix);
		},
		lock: (key, fn, options) => inner.lock(key, fn, options),
	};
	return { store, dead: () => dead };
}

for (const [point, update, at] of [
	['before the record', message(600), (method: string, key: string) => method === 'set' && key.startsWith('up:')],
	['between the record and the cursor', edited(600), (method: string, key: string) => method === 'set' && key === CURSOR_KEY],
	['after the command and before its receipt is cleared', reaction(600), (method: string, key: string) => method === 'delete' && key.startsWith('up:')],
] as const) {
	test(`a listener that dies ${point} hands the update to the consumer once in effect after its restart`, async () => {
		const inner = memoryStore();
		const transport = telegram();
		const before = mortal(inner, () => false);
		const first = run(transport, before.store);
		await until(async () => parseCursor(await inner.get(CURSOR_KEY)) !== undefined, 'the first cursor');
		await first.stop();
		const dying = mortal(inner, at);
		const doomed = run(transport, dying.store);
		const [pushed] = transport.push(update);
		await until(() => dying.dead(), 'the death');
		await doomed.stop();

		if (!pushed) throw new Error('nothing was pushed');
		const restarted = run(transport, inner);
		await until(() => restarted.updates.length >= 1, 'the delivery after the restart');
		await until(async () => (await inner.list('up:')).length === 0, 'the cleared receipt');
		const keys = byKey([...doomed.updates, ...restarted.updates]);
		expect(keys.size).toBe(1);
		const [key, deliveries = []] = [...keys][0] ?? [];
		expect(key).toBe(point === 'before the record' ? 'up:m:111:600' : `up:u:1:${pushed.update_id}`);
		for (const delivery of deliveries) expect(delivery).toEqual({ key: key ?? '', epoch: 1, updateId: pushed.update_id, update: pushed, handled: { kind: 'ignored' } });
		if (point === 'before the record') expect(doomed.updates).toEqual([]);
		else expect(doomed.updates).toHaveLength(1);
	});
}

test('a tap reaches onUpdate within 2 s while a message command and 3 tap commands hang, and a package tap whose toast stalls arrives right after the toast deadline', async () => {
	const deadlines = { tap: LANES.tap.deadline, other: LANES.other.deadline, call: DEADLINES.call };
	LANES.tap.deadline = 20_000;
	LANES.other.deadline = 20_000;
	DEADLINES.call = 1_500;
	try {
		const transport = telegram();
		const store = memoryStore();
		const arrived = new Map<string, number>();
		const handledAt = new Map<string, number>();
		const hang = new Promise<void>(() => {});
		const listener = run(transport, store, {
			onUpdate: async (update) => {
				arrived.set(update.key, Date.now());
				if (update.key === 'up:m:111:600' || ['up:c:cq-1', 'up:c:cq-2', 'up:c:cq-3'].includes(update.key)) await hang;
			},
			handled: (update) => {
				if (update.callback_query) handledAt.set(`up:c:${update.callback_query.id}`, Date.now());
			},
		});
		const sinceHandled = (key: string) => (arrived.get(key) ?? Number.POSITIVE_INFINITY) - (handledAt.get(key) ?? Number.NEGATIVE_INFINITY);
		await until(() => transport.calls.some((call) => call.method === 'getUpdates'), 'the first poll');
		transport.push(message(600), tapOn('cq-1', 'desk:1'), tapOn('cq-2', 'desk:2'), tapOn('cq-3', 'desk:3'));
		await until(() => arrived.size === 4, 'the hanging message and taps');
		const pushedAt = Date.now();
		transport.push(tapOn('cq-4', 'desk:4'));
		await until(() => arrived.has('up:c:cq-4'), 'the fourth tap', 5_000);
		expect((arrived.get('up:c:cq-4') ?? Number.POSITIVE_INFINITY) - pushedAt).toBeLessThan(2_000);
		expect(sinceHandled('up:c:cq-4')).toBeLessThan(2_000);

		const asked = await listener.chat.send(choice({ markdown: 'Merge now?' }, [{ label: 'Merge' }, { label: 'Wait' }]), { ref: 'merge' });
		if (asked.kind !== 'ok' || !asked.sent) throw new Error('the question was not sent');
		const release = transport.stall('answerCallbackQuery');
		cleanups.push(release);
		const tappedAt = Date.now();
		transport.push(tapOn('cq-package', 'q:merge:0', {}, asked.sent.message));
		await until(() => arrived.has('up:c:cq-package'), 'the package tap', 10_000);
		const after = (arrived.get('up:c:cq-package') ?? 0) - tappedAt;
		expect(after).toBeGreaterThanOrEqual(DEADLINES.call);
		expect(after).toBeLessThan(DEADLINES.call + 2_000);
		expect((handledAt.get('up:c:cq-package') ?? 0) - tappedAt).toBeGreaterThanOrEqual(DEADLINES.call);
		expect(sinceHandled('up:c:cq-package')).toBeLessThan(2_000);
		expect(parseQuestion(await store.get('q:merge'))).toMatchObject({ status: 'answered' });
	} finally {
		LANES.tap.deadline = deadlines.tap;
		LANES.other.deadline = deadlines.other;
		DEADLINES.call = deadlines.call;
	}
});

test('the other lane runs updates 9 and 10 in that order, also from the store after a restart', async () => {
	const store = memoryStore();
	const stored = (updateId: number) => ({ v: 1, key: `up:u:1:${updateId}`, epoch: 1, updateId, update: { ...edited(600), update_id: updateId }, handled: { kind: 'ignored' }, attempts: 0 });
	await store.set('up:u:1:10', stored(10));
	await store.set('up:u:1:9', stored(9));
	await store.set(CURSOR_KEY, { v: 1, origin: 'https://api.telegram.org', epoch: 1, offset: 11, at: Date.now(), refused: 0 });
	const transport = telegram();
	const order: number[] = [];
	run(transport, store, { onUpdate: async (update) => void order.push(update.updateId) });
	transport.push({ ...edited(600), update_id: 11 }, { ...edited(600), update_id: 12 });
	await until(() => order.length === 4, 'four updates');
	expect(order).toEqual([9, 10, 11, 12]);
});

test('a receipt whose command keeps failing holds back no later one, counts its attempts with the next retry, and is still retried past 5', async () => {
	const retry = { ...LANES.retry };
	LANES.retry.first = 50;
	LANES.retry.most = 200;
	try {
		const transport = telegram();
		const store = memoryStore();
		const delivered: number[] = [];
		const tries = new Map<number, number>();
		run(transport, store, {
			onUpdate: async (update) => {
				tries.set(update.updateId, (tries.get(update.updateId) ?? 0) + 1);
				if (update.updateId === 20) throw new Error('the consumer is down for 20');
				delivered.push(update.updateId);
			},
		});
		transport.push({ ...edited(600), update_id: 20 }, { ...edited(600), update_id: 21 }, { ...edited(600), update_id: 22 });
		await until(() => delivered.length === 2, 'the later updates');
		expect(delivered).toEqual([21, 22]);
		await until(async () => (parseStoredUpdate(await store.get('up:u:1:20'))?.attempts ?? 0) >= 7, 'seven failed attempts');
		const failing = parseStoredUpdate(await store.get('up:u:1:20'));
		expect(failing).toMatchObject({ error: 'the consumer is down for 20', retryAt: expect.any(Number) });
		expect(await store.list('up:')).toEqual(['up:u:1:20']);
	} finally {
		Object.assign(LANES.retry, retry);
	}
});

test('a forwarded text, caption and file sit only under forwarded, and a forward that replies to a text question answers nothing', async () => {
	const transport = telegram();
	const store = memoryStore();
	const listener = run(transport, store, { withoutUpdates: true });
	await until(() => transport.calls.some((call) => call.method === 'getUpdates'), 'the first poll');
	const asked = await listener.chat.send(text({ markdown: 'Which branch?' }), { ref: 'branch' });
	if (asked.kind !== 'ok' || !asked.sent) throw new Error('the question was not sent');
	const origin = { type: 'user' as const, sender_user: { id: 5, is_bot: false, first_name: 'Ari' }, date: DATE - 60 };
	const replyTo = { message_id: asked.sent.message, date: DATE, chat: CHAT };
	transport.push(
		message(620, { forward_origin: origin, text: 'see https://example.com and the docs', entities: [{ type: 'url', offset: 4, length: 19 }, { type: 'text_link', offset: 32, length: 4, url: 'https://docs.example.com' }], reply_to_message: replyTo }),
		message(621, { forward_origin: origin, text: undefined, caption: 'the report', document: document('forwarded-file', 'report.pdf') }),
	);
	await until(() => listener.messages.length === 2, 'two forwards');
	expect(listener.messages).toEqual([
		{ kind: 'forward', message: 620, replyTo: asked.sent.message, ref: 'branch', forwarded: { origin, text: 'see https://example.com and the docs', links: ['https://example.com', 'https://docs.example.com'], files: [] } },
		{ kind: 'forward', message: 621, forwarded: { origin, caption: 'the report', links: [], files: [{ id: 'forwarded-file', name: 'report.pdf', bytes: 1200 }] } },
	]);
	expect(parseQuestion(await store.get('q:branch'))).toMatchObject({ status: 'open', seq: 0 });
	expect(transport.calls.filter((call) => call.method === 'setMessageReaction')).toEqual([]);
	expect((await store.list('fa:')).length).toBe(1);
});

test('the file records keep one occurrence per message, edit and position, a replay adds none, and a photo or an animation counts once', async () => {
	const store = memoryStore();
	const photo = [
		{ file_id: 'small', file_unique_id: 'u-small', width: 90, height: 90, file_size: 900 },
		{ file_id: 'large', file_unique_id: 'u-large', width: 1280, height: 1280, file_size: 90_000 },
	];
	const animation = { file_id: 'gif', file_unique_id: 'u-gif', file_name: 'loop.mp4', mime_type: 'video/mp4', width: 1, height: 1, duration: 1 };
	const sticker = { file_id: 'sticker', file_unique_id: 'u-sticker', type: 'regular', width: 1, height: 1, is_animated: false, is_video: false };
	expect(filesOf({ photo, animation, document: { ...animation }, sticker }).map((file) => [file.kind, file.id])).toEqual([
		['photo', 'large'],
		['animation', 'gif'],
		['sticker', 'sticker'],
	]);
	const sent = asUpdate({ update_id: 1, ...message(630, { document: document('doc') }) });
	await recordFiles(store, sent);
	await recordFiles(store, sent);
	await recordFiles(store, asUpdate({ update_id: 2, ...edited(630, { document: document('doc') }) }));
	await recordFiles(store, asUpdate({ update_id: 3, ...message(631, { from: { ...PERSON, id: 112 }, document: document('doc', 'renamed.pdf') }) }));
	const [key] = await store.list('fa:');
	expect(key).toMatch(/^fa:[0-9a-f]{64}$/);
	expect(parseFileRecord(await store.get(key ?? ''))).toEqual({
		v: 1,
		id: 'doc',
		unique: 'u-doc',
		kind: 'document',
		occurrences: [
			{ chat: 111, sender: 111, message: 630, edit: 0, position: 0, name: 'notes.pdf', type: 'application/pdf', bytes: 1200 },
			{ chat: 111, sender: 111, message: 630, edit: DATE + 5, position: 0, name: 'notes.pdf', type: 'application/pdf', bytes: 1200 },
			{ chat: 111, sender: 112, message: 631, edit: 0, position: 0, name: 'renamed.pdf', type: 'application/pdf', bytes: 1200 },
		],
	});
	expect(isRecord(await store.get(key ?? ''))).toBe(true);
});

test('a tap on an open question of a former chat is refused before handle: no answer, no toast, no delivery', async () => {
	const transport = telegram();
	const store = memoryStore();
	const former = createChat({ call: transport.call, store, chat: 111 });
	const asked = await former.send(choice({ markdown: 'Merge now?' }, [{ label: 'Merge' }, { label: 'Wait' }]), { ref: 'old-chat' });
	if (asked.kind !== 'ok' || !asked.sent) throw new Error('the question was not sent');
	const answers: unknown[] = [];
	const updates: InboundUpdate[] = [];
	const chat = createChat({ call: transport.call, store, chat: 222, allow: [222], onAnswer: async (answer) => void answers.push(answer) });
	const controller = new AbortController();
	const running = listen({ chat, target: 222, origin: 'https://api.telegram.org', allow: [222], call: transport.call, store, signal: controller.signal, onUpdate: async (update) => void updates.push(update) });
	cleanups.push(async () => {
		controller.abort();
		await running;
	});
	transport.push(tapOn('cq-old', 'q:old-chat:0', {}, asked.sent.message));
	await until(async () => parseCursor(await store.get(CURSOR_KEY))?.refused === 1, 'the refused tap');
	await Bun.sleep(LISTEN.beat * 3);
	expect(answers).toEqual([]);
	expect(updates).toEqual([]);
	expect(parseQuestion(await store.get('q:old-chat'))).toMatchObject({ status: 'open', seq: 0 });
	expect(transport.calls.filter((call) => call.method === 'answerCallbackQuery' || call.method === 'editMessageText')).toEqual([]);
});

test('a cursor without an offset older than 6 days starts a new epoch before the poll, so a new update never takes a delivered key', async () => {
	const store = memoryStore();
	await store.set(CURSOR_KEY, { v: 1, origin: 'https://api.telegram.org', epoch: 7, at: Date.now() - 7 * 86_400_000, refused: 0 });
	const applied = new Set(['up:u:7:9']);
	const fresh: string[] = [];
	const transport = telegram();
	run(transport, store, {
		onUpdate: async (update) => {
			if (!applied.has(update.key)) fresh.push(update.key);
			applied.add(update.key);
		},
	});
	await until(() => transport.calls.some((call) => call.method === 'getUpdates'), 'the first poll');
	expect(parseCursor(await store.get(CURSOR_KEY))).toMatchObject({ epoch: 8 });
	transport.push({ ...edited(601), update_id: 9 });
	await until(() => fresh.length === 1, 'the new edit');
	expect(fresh).toEqual(['up:u:8:9']);
});

test('a message queued by an earlier release, without kind, is delivered after a restart as a message', async () => {
	const store = memoryStore();
	await store.set('in:111:600', { v: 1, chat: 111, update: 42, message: { message: 600, text: 'queued before stage 8', files: [] }, attempts: 5, error: 'consumer unavailable' });
	expect(parseStoredMessage(await store.get('in:111:600'))).toMatchObject({ attempts: 5, message: { kind: 'message', message: 600 } });
	const delivered: Inbound[] = [];
	await courier(store, async (message) => void delivered.push(message), () => {}).deliver({ restart: true });
	expect(delivered).toEqual([{ kind: 'message', message: 600, text: 'queued before stage 8', files: [] }]);
	expect(await store.list('in:')).toEqual([]);
});

test('a forward queued by an earlier release is delivered as a forward without origin, and keeps its stored form while delivery fails', async () => {
	const store = memoryStore();
	const old = { v: 1, chat: 111, update: 42, message: { message: 600, forwarded: { text: 'forwarded release instructions', caption: 'third-party attachment' }, files: [{ id: 'forwarded-file', name: 'report.pdf', bytes: 12 }] }, attempts: 0 };
	await store.set('in:111:600', old);
	let down = true;
	const delivered: Inbound[] = [];
	const messages = courier(
		store,
		async (message) => {
			if (down) throw new Error('consumer unavailable');
			delivered.push(message);
		},
		() => {},
	);
	await messages.deliver();
	expect(await store.get('in:111:600')).toEqual({ ...old, attempts: 1, error: 'consumer unavailable' });
	down = false;
	await messages.deliver();
	expect(delivered).toEqual([
		{ kind: 'forward', message: 600, forwarded: { text: 'forwarded release instructions', caption: 'third-party attachment', links: [], files: [{ id: 'forwarded-file', name: 'report.pdf', bytes: 12 }] } },
	]);
	expect(await store.list('in:')).toEqual([]);
});

test('a consumer that rejects with the text "stopped" gets the failure path: a retry later, and the receipt after it runs', async () => {
	const retry = { ...LANES.retry };
	LANES.retry.first = 60_000;
	try {
		const transport = telegram();
		const store = memoryStore();
		const tries: number[] = [];
		run(transport, store, {
			onUpdate: async (update) => {
				tries.push(update.updateId);
				await Bun.sleep(1);
				if (update.updateId === 9) throw new Error('stopped');
			},
		});
		transport.push({ ...edited(600), update_id: 9 }, { ...edited(600), update_id: 10 });
		await until(() => tries.includes(10), 'update 10');
		await until(async () => parseStoredUpdate(await store.get('up:u:1:9'))?.attempts === 1, 'one stored attempt');
		expect(parseStoredUpdate(await store.get('up:u:1:9'))).toMatchObject({ attempts: 1, error: 'stopped', retryAt: expect.any(Number) });
		expect(parseStoredUpdate(await store.get('up:u:1:9'))?.retryAt ?? 0).toBeGreaterThan(Date.now());
		expect(tries).toEqual([9, 10]);
	} finally {
		Object.assign(LANES.retry, retry);
	}
});

for (const [what, fails] of [
	['the list of receipts', (method: string, key: string) => method === 'list' && key === 'up:'],
	['the read of a receipt after one it read', (method: string, key: string) => method === 'get' && key === 'up:u:1:11'],
] as const) {
	test(`a startup scan whose store fails ${what} once runs again whole, delivers nothing of the failed scan, and then every stored receipt`, async () => {
		const inner = memoryStore();
		const stored = (updateId: number) => ({ v: 1, key: `up:u:1:${updateId}`, epoch: 1, updateId, update: { ...edited(600), update_id: updateId }, handled: { kind: 'ignored' }, attempts: 0 });
		for (const id of [9, 10, 11]) await inner.set(`up:u:1:${id}`, stored(id));
		await inner.set(CURSOR_KEY, { v: 1, origin: 'https://api.telegram.org', epoch: 1, offset: 12, at: Date.now(), refused: 0 });
		const events: string[] = [];
		let failed = false;
		const once = (method: string, key: string) => {
			if (failed || !fails(method, key)) return;
			failed = true;
			events.push(`fail ${key}`);
			throw new Error('the disk is busy');
		};
		const store: Store = {
			...inner,
			get: async (key) => {
				once('get', key);
				if (key.startsWith('up:')) events.push(`get ${key}`);
				return inner.get(key);
			},
			list: async (prefix) => {
				once('list', prefix);
				if (prefix === 'up:') events.push('list');
				return inner.list(prefix);
			},
		};
		const order: number[] = [];
		const listener = run(telegram(), store, {
			onUpdate: async (update) => {
				events.push(`deliver ${update.updateId}`);
				order.push(update.updateId);
			},
		});
		await until(() => order.length === 3, 'the three stored receipts');
		expect(failed).toBe(true);
		expect(order).toEqual([9, 10, 11]);
		expect(listener.logs.some((line) => line.includes('the stored receipts were not read and are read again'))).toBe(true);
		const failure = events.findIndex((event) => event.startsWith('fail'));
		const firstDelivery = events.findIndex((event) => event.startsWith('deliver'));
		const retried = events.indexOf('list', failure);
		expect(retried).toBeGreaterThan(failure);
		expect(firstDelivery).toBeGreaterThan(retried);
		if (what === 'the read of a receipt after one it read') expect(events.slice(0, failure)).toEqual(['list', 'get up:u:1:10']);
	});
}
