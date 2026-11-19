import { afterEach, expect, setDefaultTimeout, setSystemTime, test } from 'bun:test';
import { createChat, type Delivered } from '../chat/create.ts';
import { setup } from '../chat/harness.ts';
import { choice } from '../core/builders.ts';
import { isRecord } from '../core/check.ts';
import { bindingOf, viewUrl } from '../core/render.ts';
import type { Outcome, Sent, ViewClient } from '../core/types.ts';
import { NOW } from '../fixtures.ts';
import { memoryStore } from '../store/memory.ts';
import { fakeBotApi, TOKEN } from '../telegram/fake-server.ts';
import { fetchCall } from '../telegram/fetch.ts';
import { applyChoices, LISTEN, listen } from '../telegram/listen.ts';
import { viewClient } from './client.ts';
import { BOT, launchKey, MEDIA_KEY, memoryStorage, ORIGIN, UPLOAD_KEY, USER } from './fixtures.ts';
import { createViewHandler } from './handler.ts';

setDefaultTimeout(120_000);
afterEach(() => setSystemTime());

const { hex, launch } = await launchKey();
const TABS = ['A: Compact', 'B: Wide', 'C: Split', 'Notes'];
const BODY = { markdown: 'Which layout should the settings page keep?' };

const cid = (n: number) => `c${String(n).padStart(21, '0')}`;

function sentOf(outcome: Outcome): Sent {
	if (outcome.kind !== 'ok' || !outcome.sent) throw new Error(`no sent in ${JSON.stringify(outcome)}`);
	return outcome.sent;
}

async function world(storage: Parameters<typeof memoryStorage>[0] = {}) {
	setSystemTime(new Date(NOW));
	const memory = memoryStorage(storage);
	const handle = createViewHandler({ storage: memory.storage, botId: BOT, allowedUsers: [USER, 112], uploadKey: UPLOAD_KEY, mediaKey: MEDIA_KEY, publicKey: hex });
	const failing: ((request: Request) => boolean)[] = [];
	const fetch = async (request: Request) => {
		const index = failing.findIndex((match) => match(request));
		if (index === -1) return handle(request);
		failing.splice(index, 1);
		return Response.json({ error: 'the host is down' }, { status: 503 });
	};
	const views = viewClient({ origin: ORIGIN, uploadKey: UPLOAD_KEY, fetch, lateWindow: 0 });
	const put = await views.put({ view: { v: 1, tabs: TABS.map((label) => ({ label, content: { markdown: `# ${label}` } })) }, media: [] });
	if (put.kind !== 'ok') throw new Error(`not published: ${JSON.stringify(put)}`);
	const delivered: Delivered[] = [];
	const harness = setup({ viewOrigin: ORIGIN, views, onAnswer: async (answer) => void delivered.push(answer) });
	const view = { id: put.id, origin: ORIGIN };
	return {
		...harness,
		memory,
		handle,
		views,
		view,
		delivered,
		viewExpiresAt: put.expiresAt,
		fail: (match: (request: Request) => boolean) => void failing.push(match),
		at(ms: number) {
			harness.clock.now = ms;
			setSystemTime(new Date(ms));
		},
		spec: (extras: { once?: boolean } = {}) =>
			choice(
				BODY,
				TABS.slice(0, 3).map((label) => ({ label, tab: label })),
				{ view: put.id, in: 'view', ...extras },
			),
		post: async (ref: string, n: number, c: string, opened: { userId?: number; authDate?: number } = {}) =>
			handle(new Request(`${ORIGIN}/api/answer?v=${put.id}&q=${ref}&n=${n}&c=${c}`, { method: 'POST', headers: { Authorization: `tma ${await launch(opened)}` } })),
		opened: async (ref: string): Promise<Record<string, unknown>> => {
			const response = await handle(new Request(`${ORIGIN}/api/view?v=${put.id}&q=${ref}`, { headers: { Authorization: `tma ${await launch()}` } }));
			const json: unknown = await response.json();
			return isRecord(json) ? json : {};
		},
		choiceKeys: () => [...memory.entries.keys()].filter((key) => key.startsWith('a:')),
		pass: () => applyChoices({ chat: harness.chat, views }),
		markup: (message: number) => harness.server.shows.get(message)?.reply_markup,
		viewRow: (ref: string, text: string, tab?: string) => ({ inline_keyboard: [[{ text, web_app: { url: viewUrl(view, ref, tab) } }]] }),
	};
}

test('a choice made in the view is applied with the mark on the view button and delivered once', async () => {
	const w = await world();
	const sent = sentOf(await w.chat.send(w.spec(), { ref: 'layout' }));
	expect(w.markup(sent.message)).toEqual(w.viewRow('layout', 'Open view'));
	expect(await w.opened('layout')).toMatchObject({
		context: BODY,
		choice: {
			options: TABS.slice(0, 3).map((label, index) => ({ index, label, tab: label })),
			once: false,
			expiresAt: w.viewExpiresAt,
		},
	});
	expect((await w.post('layout', 1, cid(1))).status).toBe(200);
	expect(w.choiceKeys()).toEqual([`a:${w.view.id}:layout:${cid(1)}`]);

	expect(await w.pass()).toEqual({ answered: 1, removed: 1, left: 0 });
	expect(w.choiceKeys()).toEqual([]);
	expect(w.markup(sent.message)).toEqual(w.viewRow('layout', '✓ B: Wide', 'B: Wide'));
	await w.chat.flush();
	expect(w.delivered).toMatchObject([{ ref: 'layout', seq: 1, answer: { kind: 'choice', index: 1, label: 'B: Wide' }, by: { id: USER }, delivery: 'layout:1' }]);
	expect(await w.chat.wait('layout', { seconds: 0 })).toMatchObject({ status: 'answered', answer: { index: 1 } });
	expect(w.server.calls.map(({ call }) => call.method)).toEqual(['sendRichMessage', 'editMessageText']);
	await w.chat.flush();
	expect(w.delivered).toHaveLength(1);
	expect(w.breaches).toEqual([]);
});

test('a pass that dies after the store and before the delete applies nothing twice, and a restart applies the stored choices', async () => {
	const w = await world();
	await w.chat.send(w.spec(), { ref: 'layout' });
	await w.chat.send(w.spec(), { ref: 'second' });
	expect((await w.post('layout', 2, cid(1))).status).toBe(200);
	expect((await w.post('second', 0, cid(2))).status).toBe(200);
	const dying: ViewClient = {
		...w.views,
		removeChoice: async () => {
			throw new Error('the listener was killed');
		},
	};
	expect(await applyChoices({ chat: w.chat, views: dying })).toEqual({ answered: 2, removed: 0, left: 2 });
	expect(w.choiceKeys()).toHaveLength(2);
	expect(await w.pass()).toEqual({ answered: 0, removed: 2, left: 0 });
	for (const [ref, index] of [
		['layout', 2],
		['second', 0],
	] as const) {
		expect(await w.chat.get(ref)).toMatchObject({ status: 'answered', seq: 1, answer: { index } });
	}
	await w.chat.flush();
	expect(w.delivered.map((answer) => answer.delivery).sort()).toEqual(['layout:1', 'second:1']);
});

test('choices visible across two passes apply as corrections, and one pass applies by time, then by choice id', async () => {
	const hidden = new Set<string>();
	const w = await world({ unlisted: (key) => [...hidden].some((id) => key.endsWith(id)) });
	await w.chat.send(w.spec(), { ref: 'layout' });
	hidden.add(cid(1));
	w.at(NOW + 1_000);
	expect((await w.post('layout', 0, cid(1))).status).toBe(200);
	w.at(NOW + 2_000);
	expect((await w.post('layout', 1, cid(2))).status).toBe(200);
	expect(await w.pass()).toEqual({ answered: 1, removed: 1, left: 0 });
	expect(await w.chat.get('layout')).toMatchObject({ seq: 1, answer: { index: 1 } });
	hidden.clear();
	expect(await w.pass()).toEqual({ answered: 1, removed: 1, left: 0 });
	expect(await w.chat.get('layout')).toMatchObject({ seq: 2, answer: { index: 0 }, previous: { index: 1 } });

	for (const [ms, n, id] of [
		[6_000, 2, 4],
		[4_000, 1, 9],
		[6_000, 2, 3],
		[7_000, 0, 5],
	] as const) {
		w.at(NOW + ms);
		expect((await w.post('layout', n, cid(id))).status).toBe(200);
	}
	expect(await w.pass()).toEqual({ answered: 3, removed: 4, left: 0 });
	const question = await w.chat.get('layout');
	expect(question?.applied.slice(-3)).toEqual([`view:${cid(9)}`, `view:${cid(3)}`, `view:${cid(5)}`]);
	expect(question).toMatchObject({ seq: 5, answer: { index: 0 }, previous: { index: 2 } });
});

test('a duplicate POST race stores one choice in effect', async () => {
	let hide = true;
	const w = await world({ unlisted: (key) => hide && key.startsWith('a:') });
	const sent = sentOf(await w.chat.send(w.spec(), { ref: 'layout' }));
	const raced = await Promise.all([w.post('layout', 0, cid(1)), w.post('layout', 0, cid(1))]);
	expect(raced.map((response) => response.status)).toEqual([200, 200]);
	const key = `a:${w.view.id}:layout:${cid(1)}`;
	expect(w.memory.writes.filter((write) => write === `put ${key}`)).toHaveLength(2);
	expect(w.choiceKeys()).toEqual([key]);
	hide = false;
	expect(await w.pass()).toEqual({ answered: 1, removed: 1, left: 0 });
	expect((await w.post('layout', 0, cid(1))).status).toBe(200);
	expect(await w.pass()).toEqual({ answered: 0, removed: 1, left: 0 });
	expect(await w.chat.get('layout')).toMatchObject({ seq: 1, answer: { index: 0 } });
	await w.chat.flush();
	expect(w.delivered).toHaveLength(1);
	expect((await w.post('layout', 1, cid(2))).status).toBe(200);
	const writes = w.memory.writes.length;
	expect((await w.post('layout', 1, cid(2))).status).toBe(200);
	expect(w.memory.writes).toHaveLength(writes);
	expect(w.markup(sent.message)).toEqual(w.viewRow('layout', '✓ A: Compact', 'A: Compact'));
});

test('a failed store and a failed delete each leave the choice for the next pass, with the later choices of its ref', async () => {
	const w = await world();
	await w.chat.send(w.spec(), { ref: 'layout' });
	w.at(NOW + 1_000);
	expect((await w.post('layout', 0, cid(1))).status).toBe(200);
	w.at(NOW + 2_000);
	expect((await w.post('layout', 1, cid(2))).status).toBe(200);
	w.store.fail('set', 'before');
	expect(await w.pass()).toEqual({ answered: 0, removed: 0, left: 2 });
	expect(await w.chat.get('layout')).toMatchObject({ status: 'open', seq: 0 });
	expect(w.choiceKeys()).toHaveLength(2);
	expect(await w.pass()).toEqual({ answered: 2, removed: 2, left: 0 });
	expect(await w.chat.get('layout')).toMatchObject({ seq: 2, answer: { index: 1 }, previous: { index: 0 } });

	expect((await w.post('layout', 2, cid(3))).status).toBe(200);
	w.fail((request) => request.method === 'DELETE');
	expect(await w.pass()).toEqual({ answered: 1, removed: 0, left: 1 });
	expect(w.choiceKeys()).toHaveLength(1);
	expect(await w.pass()).toEqual({ answered: 0, removed: 1, left: 0 });
	expect(await w.chat.get('layout')).toMatchObject({ seq: 3, answer: { index: 2 } });
});

test('a choice stored just before expiresAt and visible after the question closed is refused and removed', async () => {
	const hidden = new Set<string>();
	const w = await world({ unlisted: (key) => [...hidden].some((id) => key.endsWith(id)) });
	const sent = sentOf(await w.chat.send(w.spec(), { ref: 'timed', expiresAt: NOW + 60_000 }));
	expect(await w.opened('timed')).toMatchObject({ choice: { expiresAt: NOW + 60_000 } });
	hidden.add(cid(1));
	w.at(NOW + 59_999);
	expect((await w.post('timed', 0, cid(1))).status).toBe(200);
	w.at(NOW + 60_000);
	await w.chat.flush();
	expect(await w.chat.get('timed')).toMatchObject({ status: 'closed', seq: 0 });
	expect(w.markup(sent.message)).toEqual(w.viewRow('timed', 'Open view'));
	hidden.clear();
	expect(await w.pass()).toEqual({ answered: 0, removed: 1, left: 0 });
	expect(await w.chat.get('timed')).toMatchObject({ status: 'closed', seq: 0 });
	expect(w.choiceKeys()).toEqual([]);
	expect((await w.post('timed', 1, cid(2))).status).toBe(410);
});

test('a choice stored just before its view expires outlives the view on the host and is applied or refused, never dropped', async () => {
	const hidden = new Set<string>();
	const w = await world({ unlisted: (key) => [...hidden].some((id) => key.endsWith(id)) });
	await w.chat.send(w.spec(), { ref: 'near' });
	await w.chat.send(w.spec(), { ref: 'late' });
	const end = w.viewExpiresAt;
	expect(await w.chat.get('late')).toMatchObject({ expiresAt: end });
	w.at(end - 1);
	expect((await w.post('near', 0, cid(1))).status).toBe(200);
	hidden.add(cid(2));
	expect((await w.post('late', 1, cid(2))).status).toBe(200);
	expect(await w.pass()).toEqual({ answered: 1, removed: 1, left: 0 });
	expect(await w.chat.get('near')).toMatchObject({ status: 'answered', answer: { index: 0 } });

	w.at(end + 30_000);
	hidden.clear();
	expect(await w.views.choices()).toMatchObject({ kind: 'ok', choices: [{ ref: 'late', index: 1, id: cid(2) }] });
	expect(await w.pass()).toEqual({ answered: 0, removed: 1, left: 0 });
	expect(await w.chat.get('late')).toMatchObject({ status: 'closed', seq: 0 });
});

test('a close and an expiry store the binding as closed, and the host answers a later choice with 410 without a write', async () => {
	const w = await world();
	await w.chat.send(w.spec(), { ref: 'closing' });
	await w.chat.send(w.spec(), { ref: 'timed', expiresAt: NOW + 60_000 });
	expect((await w.opened('closing')).choice).not.toHaveProperty('closed');
	expect((await w.chat.close('closing', { markdown: 'Wide stays.' })).kind).toBe('ok');
	w.at(NOW + 60_000);
	await w.chat.flush();
	for (const ref of ['closing', 'timed']) {
		expect(await w.chat.get(ref)).toMatchObject({ status: 'closed' });
		const opened = await w.opened(ref);
		expect(opened.choice, ref).toMatchObject({ closed: true, options: TABS.slice(0, 3).map((label, index) => ({ index, label, tab: label })) });
		const writes = w.memory.writes.length;
		const posted = await w.post(ref, 0, cid(ref === 'timed' ? 2 : 1));
		expect(posted.status, ref).toBe(410);
		expect(w.memory.writes, ref).toHaveLength(writes);
	}
	expect(w.choiceKeys()).toEqual([]);
});

test('a question answered in its view whose send is uncertain takes no choice', async () => {
	const w = await world();
	w.server.fail(0, 'lost');
	expect(await w.chat.send(w.spec(), { ref: 'lost' })).toEqual({ kind: 'uncertain', ref: 'lost', reason: expect.stringContaining('close it and ask again') });
	expect(await w.chat.get('lost')).toMatchObject({ status: 'sending' });
	expect((await w.post('lost', 0, cid(1))).status).toBe(200);
	expect(await w.pass()).toEqual({ answered: 0, removed: 1, left: 0 });
	expect(await w.chat.get('lost')).toMatchObject({ status: 'sending', seq: 0 });
	expect(await w.chat.close('lost')).toMatchObject({ kind: 'ok', status: 'closed', warnings: [{ code: 'unconfirmed-message', message: expect.stringContaining('no answer button') }] });
	await w.chat.flush();
	await expectClosedOnHost(w, 'lost');
});

async function expectClosedOnHost(w: Awaited<ReturnType<typeof world>>, ref: string) {
	expect((await w.opened(ref)).choice, ref).toMatchObject({ closed: true });
	expect(await w.chat.get(ref), ref).not.toHaveProperty('bindingOwed');
	const writes = w.memory.writes.length;
	expect((await w.post(ref, 0, cid(99))).status, ref).toBe(410);
	expect(w.memory.writes, ref).toHaveLength(writes);
	expect(w.choiceKeys().filter((key) => key.includes(`:${ref}:`)), ref).toEqual([]);
}

test('a close whose edit Telegram refuses still closes the binding on the host', async () => {
	const w = await world();
	await w.chat.send(w.spec(), { ref: 'refused' });
	w.server.fail(1, 'refused');
	expect(await w.chat.close('refused')).toMatchObject({ kind: 'ok', status: 'closed', warnings: [{ code: 'not-shown' }] });
	expect(await w.chat.get('refused')).toMatchObject({ shown: { want: 1, done: 1, error: expect.any(String) } });
	await expectClosedOnHost(w, 'refused');
	await w.chat.flush();
	await expectClosedOnHost(w, 'refused');
});

test('a recheck that Telegram refuses after an earlier open context landed over the close still closes the binding on the host', async () => {
	const w = await world();
	await w.chat.send(w.spec(), { ref: 'late' });
	const asked = await w.chat.get('late');
	const open = asked && bindingOf(asked);
	if (!asked || !open) throw new Error('unreachable');
	expect((await w.chat.close('late')).kind).toBe('ok');
	await expectClosedOnHost(w, 'late');
	expect(await w.views.context(w.view.id, 'late', asked.spec.body, open)).toMatchObject({ kind: 'ok' });
	expect((await w.opened('late')).choice).not.toHaveProperty('closed');
	const stored = await w.chat.get('late');
	if (!stored) throw new Error('unreachable');
	await w.store.set('q:late', { ...stored, shown: { ...stored.shown, recheckAt: w.clock.now - 1 } });
	w.server.fail(2, 'refused');
	await w.chat.flush();
	expect(await w.chat.get('late')).not.toHaveProperty('shown.recheckAt');
	await expectClosedOnHost(w, 'late');
});

test('a view the host does not show for a while keeps the debt of the closed binding until it shows', async () => {
	let hide = false;
	const w = await world({ hidden: (key) => hide && key.startsWith('v:') });
	w.server.fail(0, 'lost');
	expect((await w.chat.send(w.spec(), { ref: 'hidden' })).kind).toBe('uncertain');
	hide = true;
	expect((await w.chat.close('hidden')).kind).toBe('ok');
	await w.chat.flush();
	expect(await w.chat.get('hidden')).toMatchObject({ status: 'closed', bindingOwed: true });
	hide = false;
	await w.chat.flush();
	await expectClosedOnHost(w, 'hidden');
});

test('the debt of a closed binding ends at expiresAt, from which on the host refuses every choice by itself', async () => {
	const w = await world();
	await w.chat.send(w.spec(), { ref: 'down', expiresAt: NOW + 60_000 });
	for (let n = 0; n < 10; n++) w.fail((request) => request.method === 'PUT' && request.url.endsWith('/context/down'));
	await w.chat.close('down');
	await w.chat.flush();
	expect(await w.chat.get('down')).toMatchObject({ bindingOwed: true });
	w.at(NOW + 60_000);
	await w.chat.flush();
	expect(await w.chat.get('down')).not.toHaveProperty('bindingOwed');
	expect((await w.opened('down')).choice).not.toHaveProperty('closed');
	const writes = w.memory.writes.length;
	expect((await w.post('down', 0, cid(1))).status).toBe(410);
	expect(w.memory.writes).toHaveLength(writes);
});

test('a close whose host writes failed reaches the host after a replacement dropped one of its tabs', async () => {
	const w = await world();
	await w.chat.send(w.spec(), { ref: 'replaced' });
	const context = (request: Request) => request.method === 'PUT' && request.url.endsWith('/context/replaced');
	w.fail(context);
	w.fail(context);
	await w.chat.close('replaced');
	expect(await w.chat.get('replaced')).toMatchObject({ bindingOwed: true });
	const tabs = ['A: Compact', 'C: Split', 'Notes', 'D: Grid'];
	expect(await w.views.put({ view: { v: 1, tabs: tabs.map((label) => ({ label, content: { markdown: label } })) }, media: [] }, { id: w.view.id })).toMatchObject({ kind: 'ok' });
	await w.chat.flush();
	await expectClosedOnHost(w, 'replaced');
});

test('a closed binding the host did not store stays owed, and the next flush stores it', async () => {
	const w = await world();
	await w.chat.send(w.spec(), { ref: 'owed' });
	const context = (request: Request) => request.method === 'PUT' && request.url.endsWith('/context/owed');
	w.fail(context);
	w.fail(context);
	expect(await w.chat.close('owed')).toMatchObject({ kind: 'ok', status: 'closed' });
	expect(await w.chat.get('owed')).toMatchObject({ bindingOwed: true });
	expect((await w.opened('owed')).choice).not.toHaveProperty('closed');
	await w.chat.flush();
	await expectClosedOnHost(w, 'owed');
});

test('a host without answers, a binding the host did not store, a lacking tab and no view client refuse the send before Telegram receives it', async () => {
	const w = await world();
	const stage5 = viewClient({
		origin: ORIGIN,
		uploadKey: UPLOAD_KEY,
		lateWindow: 0,
		fetch: async (request) => (new URL(request.url).pathname === '/api/version' ? Response.json({ version: '0.0.0', formats: [1] }) : w.handle(request)),
	});
	const old = setup({ viewOrigin: ORIGIN, views: stage5 });
	expect(await old.chat.send(w.spec(), { ref: 'old' })).toMatchObject({ kind: 'refused', code: 'view-host', reason: expect.stringContaining('takes no answers') });
	expect(old.server.count).toBe(0);
	expect(await old.inner.list('')).toEqual([]);

	w.fail((request) => request.method === 'PUT' && request.url.endsWith('/context/unbound'));
	expect(await w.chat.send(w.spec(), { ref: 'unbound' })).toMatchObject({ kind: 'refused', code: 'view-host', reason: expect.stringContaining('did not store') });
	const lacking = choice(BODY, [{ label: 'A', tab: 'A: Compact' }, { label: 'D', tab: 'D: Grid' }], { view: w.view.id, in: 'view' });
	expect(await w.chat.send(lacking, { ref: 'lacking' })).toMatchObject({ kind: 'refused', code: 'view-host', reason: expect.stringContaining('"D: Grid"') });
	const without = setup({ viewOrigin: ORIGIN });
	expect(await without.chat.send(w.spec(), { ref: 'none' })).toMatchObject({ kind: 'refused', code: 'view-host' });
	expect(w.server.count + without.server.count).toBe(0);
	expect(await w.inner.list('')).toEqual([]);
	expect(await w.chat.send(w.spec(), { ref: 'unbound' })).toMatchObject({ kind: 'ok', ref: 'unbound' });
});

test('an edit, a correction and a repair by flush keep the binding of the context', async () => {
	const w = await world();
	const sent = sentOf(await w.chat.send(w.spec(), { ref: 'layout' }));
	const binding = (await w.opened('layout')).choice;
	expect(binding).toBeDefined();
	expect((await w.post('layout', 0, cid(1))).status).toBe(200);
	await w.pass();
	const edited = { markdown: 'Which layout should the settings page keep for 0.2?' };
	expect(await w.chat.edit(sent, edited)).toMatchObject({ kind: 'ok', status: 'answered' });
	expect(await w.opened('layout')).toMatchObject({ context: edited, choice: binding });
	expect(w.markup(sent.message)).toEqual(w.viewRow('layout', '✓ A: Compact', 'A: Compact'));
	expect((await w.post('layout', 2, cid(2))).status).toBe(200);
	expect(await w.pass()).toEqual({ answered: 1, removed: 1, left: 0 });
	expect(await w.chat.get('layout')).toMatchObject({ seq: 2, answer: { index: 2 }, previous: { index: 0 } });
	expect((await w.opened('layout')).choice).toEqual(binding);
	w.fail((request) => request.method === 'PUT' && request.url.endsWith('/context/layout'));
	const again = { markdown: 'Which layout should the settings page keep for 0.3?' };
	await w.chat.edit(sent, again);
	expect((await w.opened('layout')).context).toEqual(edited);
	await w.chat.flush();
	expect(await w.opened('layout')).toMatchObject({ context: again, choice: binding });
});

test('the listener applies a choice made in the view within its pass and hands the answer to onAnswer', async () => {
	LISTEN.choices = 50;
	const server = fakeBotApi();
	const memory = memoryStorage();
	const handle = createViewHandler({ storage: memory.storage, botId: BOT, allowedUsers: [USER], uploadKey: UPLOAD_KEY, mediaKey: MEDIA_KEY, publicKey: hex });
	const views = viewClient({ origin: ORIGIN, uploadKey: UPLOAD_KEY, fetch: handle, lateWindow: 0 });
	const store = memoryStore();
	const call = fetchCall({ token: TOKEN, apiUrl: server.url });
	const delivered: Delivered[] = [];
	const chat = createChat({ call, store, chat: 111, viewOrigin: ORIGIN, views, onAnswer: async (answer) => void delivered.push(answer) });
	const controller = new AbortController();
	const running = listen({ chat, target: 111, origin: server.url, allow: [111], call, store, views, signal: controller.signal });
	try {
		const put = await views.put({ view: { v: 1, tabs: ['Compact', 'Wide', 'Notes'].map((label) => ({ label, content: { markdown: label } })) }, media: [] });
		if (put.kind !== 'ok') throw new Error('not published');
		const spec = choice(BODY, [{ label: 'Compact', tab: 'Compact' }, { label: 'Wide', tab: 'Wide' }], { view: put.id, in: 'view' });
		const sent = sentOf(await chat.send(spec, { ref: 'live' }));
		const posted = await handle(new Request(`${ORIGIN}/api/answer?v=${put.id}&q=live&n=1&c=${cid(1)}`, { method: 'POST', headers: { Authorization: `tma ${await launch()}` } }));
		expect(posted.status).toBe(200);
		for (const deadline = Date.now() + 60_000; delivered.length === 0; await Bun.sleep(20)) if (Date.now() > deadline) throw new Error('no delivery within 60 s');
		expect(delivered).toMatchObject([{ ref: 'live', seq: 1, answer: { index: 1, label: 'Wide' } }]);
		expect(server.messages.get(sent.message)?.reply_markup).toEqual({ inline_keyboard: [[{ text: '✓ Wide', web_app: { url: viewUrl({ id: put.id, origin: ORIGIN }, 'live', 'Wide') } }]] });
		expect([...memory.entries.keys()].filter((key) => key.startsWith('a:'))).toEqual([]);
	} finally {
		controller.abort();
		await running;
		server.stop();
	}
});
