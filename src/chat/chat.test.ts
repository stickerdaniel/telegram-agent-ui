import { describe, expect, jest, test } from 'bun:test';
import { choice, message, text, yesNo } from '../core/builders.ts';
import { renderEdit } from '../core/render.ts';
import { RECHECK_DELAY } from '../core/reduce.ts';
import { type Call, type CallResponse, type Outcome, type Sent, ShapeError, type Store, TokenRefused } from '../core/types.ts';
import { CHAT, NOW, ORIGIN, REF, reply, tap, VIEW } from '../fixtures.ts';
import { memoryStore } from '../store/memory.ts';
import { StoreFault } from '../testing/index.ts';
import { DEADLINES, PACING, START_WINDOW } from './calls.ts';
import { createChat } from './create.ts';
import { fakeFiles, fakeViews, memoryFile, setup, shownOf, telegram } from './harness.ts';
import { HEARTBEAT_AGE } from './listener.ts';

const deploy = choice({ markdown: 'Deploy now?' }, [{ label: 'Deploy', style: 'primary' }, { label: 'Wait' }]);
const keyboard = (ref = REF) => ({
	inline_keyboard: [[{ text: 'Deploy', callback_data: `q:${ref}:0`, style: 'primary' }], [{ text: 'Wait', callback_data: `q:${ref}:1` }]],
});
const BODY = 1001;

function sentOf(outcome: Outcome): Sent {
	if ((outcome.kind !== 'ok' && outcome.kind !== 'partial') || !outcome.sent) throw new Error(`no sent in ${JSON.stringify(outcome)}`);
	return outcome.sent;
}

describe('the acceptance of stage 2', () => {
	test('a body whose answer was lost stays sending, closes with unconfirmed-message, and a later tap reveals it and removes its buttons', async () => {
		const { server, chat, inner, breaches } = setup();
		server.fail(0, 'lost');
		expect(await chat.send(deploy, { ref: REF })).toMatchObject({ kind: 'uncertain', ref: REF });
		expect(server.shows.get(BODY)).toEqual({ rich_message: { markdown: 'Deploy now?' }, reply_markup: keyboard() });
		expect((await chat.get(REF))?.status).toBe('sending');

		const closed = await chat.close(REF);
		expect(closed).toMatchObject({ kind: 'ok', ref: REF, status: 'closed', warnings: [{ code: 'unconfirmed-message' }] });
		expect(closed).not.toHaveProperty('sent');

		expect(await chat.handle(tap({ button: 0, message: BODY, inaccessible: true }))).toEqual({ kind: 'stale', reason: 'closed' });
		expect(server.shows.get(BODY)).toEqual({ rich_message: { markdown: 'Deploy now?' } });
		const question = await chat.get(REF);
		expect(question).toMatchObject({ status: 'closed', sent: { message: BODY, ref: REF }, seq: 0 });
		expect(question?.shown.done).toBe(question?.shown.want ?? -1);
		expect(await inner.get(`m:${CHAT}:${BODY}`)).toBe(REF);
		expect(breaches).toEqual([]);
	});

	test('a second close after an uncertain one ends closed and shows the resolved form', async () => {
		const { server, chat, breaches } = setup();
		await chat.send(deploy, { ref: REF });
		server.fail(1, 'gateway');
		expect(await chat.close(REF, { markdown: 'Deployed from the terminal.' })).toMatchObject({ kind: 'ok', status: 'closed', warnings: [] });
		const uncertain = await chat.get(REF);
		expect(uncertain?.shown).toMatchObject({ failures: 1 });
		expect(uncertain && uncertain.shown.want > uncertain.shown.done).toBe(true);

		expect(await chat.close(REF)).toMatchObject({ kind: 'ok', status: 'closed', warnings: [] });
		const question = await chat.get(REF);
		if (!question) throw new Error('no question');
		expect(question).toMatchObject({ status: 'closed', resolved: { markdown: 'Deployed from the terminal.' }, shown: { failures: 0 } });
		expect(question.shown.done).toBe(question.shown.want);
		expect(server.shows.get(BODY)).toEqual(shownOf(renderEdit(question).payload));
		expect(breaches).toEqual([]);
	});

	test('an edit of a question whose index entry is missing keeps its buttons', async () => {
		const { server, chat, inner, breaches } = setup();
		const { ref: _ref, ...plainSent } = sentOf(await chat.send(deploy, { ref: REF }));
		await inner.delete(`m:${CHAT}:${BODY}`);
		expect(await chat.edit(plainSent, { markdown: 'Deploy to staging now?' })).toMatchObject({ kind: 'ok', ref: REF, status: 'pending', sent: { message: BODY } });
		expect(server.shows.get(BODY)).toEqual({ rich_message: { markdown: 'Deploy to staging now?' }, reply_markup: keyboard() });
		expect((await chat.get(REF))?.spec.body).toEqual({ markdown: 'Deploy to staging now?' });
		expect(await inner.get(`m:${CHAT}:${BODY}`)).toBe(REF);
		expect(breaches).toEqual([]);
	});

	test('an edit with a Sent of another chat is refused as chat and sends nothing', async () => {
		const { server, chat } = setup();
		const sent = sentOf(await chat.send(deploy, { ref: REF }));
		expect(await chat.edit({ ...sent, chat: 333 }, { markdown: 'Elsewhere?' })).toMatchObject({ kind: 'refused', code: 'chat' });
		expect(await chat.edit({ chat: 333, message: 5, files: [] }, { markdown: 'Elsewhere' })).toMatchObject({ kind: 'refused', code: 'chat' });
		expect(server.calls).toHaveLength(1);
	});

	test('a refused send leaves its ref taken at every fault point: by the tombstone, or by the question until the tombstone is written', async () => {
		const points = [
			['set', 1],
			['set', 2],
			['delete', 1],
		] as const;
		const runs = [undefined, ...points.flatMap(([method, nth]) => (['before', 'after'] as const).map((when) => ({ method, nth, when })))];
		for (const fault of runs) {
			const { server, chat, store, inner, breaches } = setup();
			server.fail(0, 'refused');
			if (fault) store.fail(fault.method, fault.when, fault.nth);
			const outcome: Outcome | Error = await chat.send(deploy, { ref: REF }).catch((error: Error) => error);
			const bodySent = server.calls.some(({ call }) => call.method === 'sendRichMessage');
			const tombstone = await inner.get(`t:${REF}`);
			const question = await inner.get(`q:${REF}`);
			const label = JSON.stringify(fault);
			if (bodySent) expect(tombstone !== undefined || question !== undefined, label).toBe(true);
			if (!(outcome instanceof Error) && outcome.kind === 'refused') expect([tombstone !== undefined, question], label).toEqual([true, undefined]);
			if (tombstone === undefined && question === undefined) expect(bodySent, label).toBe(false);
			const calls = server.calls.length;
			const again = await chat.send(deploy, { ref: REF });
			if (bodySent) {
				expect(server.calls.length, label).toBe(calls);
				expect(again.kind, label).not.toBe('dry');
			}
			expect(breaches).toEqual([]);
		}
	});

	test('a files step after the body carries the body message id', async () => {
		const reader = fakeFiles();
		const { server, chat, breaches } = setup({ files: reader.files });
		const spec = choice({ markdown: 'Keep the new screens?' }, [{ label: 'Keep' }, { label: 'Revert' }], {
			attach: [{ path: '/p/before.png' }, { path: '/p/after.png' }, { path: '/p/report.pdf' }],
		});
		const outcome = await chat.send(spec, { ref: REF });
		expect(outcome).toMatchObject({ kind: 'ok', ref: REF, sent: { message: BODY, files: [1002, 1003, 1004] } });
		expect(server.calls.map(({ call }) => [call.method, call.payload.reply_parameters])).toEqual([
			['sendRichMessage', undefined],
			['sendMediaGroup', { message_id: BODY }],
			['sendDocument', { message_id: BODY }],
		]);
		expect([...server.replies.values()]).toEqual([BODY, BODY, BODY]);
		expect(server.calls[1]?.files).toEqual({ file0: reader.opened[0], file1: reader.opened[1] });
		expect(server.calls[2]?.files).toEqual({ document: reader.opened[2] });
		expect((await chat.get(REF))?.status === 'open' && (await chat.get(REF))).toMatchObject({ sent: { files: [1002, 1003, 1004] } });
		expect(reader.opened.map((file) => file.closed)).toEqual([1, 1, 1]);
		expect(breaches).toEqual([]);
	});

	test('a reply to a sending choice question without an index entry gives it its Sent, leaves the ref in the index and answers nothing', async () => {
		const { server, chat, inner, breaches } = setup();
		server.fail(0, 'lost');
		await chat.send(deploy, { ref: REF });
		expect(await inner.get(`m:${CHAT}:${BODY}`)).toBeUndefined();
		const handled = await chat.handle(reply({ id: 900, replyTo: BODY, text: 'Why not both?' }));
		expect(handled).toEqual({ kind: 'ignored' });
		expect(await chat.get(REF)).toMatchObject({ status: 'open', seq: 0, sent: { chat: CHAT, message: BODY, ref: REF } });
		expect(await inner.get(`m:${CHAT}:${BODY}`)).toBe(REF);
		expect(server.calls.map(({ call }) => call.method)).toEqual(['sendRichMessage']);
		expect(breaches).toEqual([]);
	});
});

describe('send', () => {
	test('a message without answer is stateless and returns its Sent', async () => {
		const { server, chat, store } = setup();
		expect(await chat.send(message({ markdown: 'Build passed.' }), { topic: 7 })).toEqual({ kind: 'ok', sent: { chat: CHAT, topic: 7, message: BODY, files: [] }, warnings: [] });
		expect(server.calls[0]?.call.payload).toMatchObject({ chat_id: CHAT, message_thread_id: 7 });
		expect(store.ops).toEqual([]);
	});

	test('ref, meta and expiresAt on a message without answer are refused', async () => {
		const { chat } = setup();
		expect(await chat.send(message({ markdown: 'Hi' }), { ref: 'abc' })).toMatchObject({ kind: 'refused', code: 'shape' });
		expect(await chat.send(message({ markdown: 'Hi' }), { meta: { a: 1 } })).toMatchObject({ kind: 'refused', code: 'shape' });
	});

	test('a question gets a generated ref of 8 characters, a stored question and an index entry', async () => {
		const { chat, inner } = setup();
		const outcome = await chat.send(yesNo({ markdown: 'Merge?' }), { meta: { session: 's1' } });
		if (outcome.kind !== 'ok' || outcome.ref === undefined) throw new Error('not sent');
		expect(outcome.ref).toMatch(/^[a-z2-7]{8}$/);
		expect(outcome).toMatchObject({ status: 'pending', sent: { ref: outcome.ref, message: BODY } });
		expect(await chat.get(outcome.ref)).toMatchObject({ status: 'open', meta: { session: 's1' }, allow: [CHAT] });
		expect(await inner.get(`m:${CHAT}:${BODY}`)).toBe(outcome.ref);
	});

	test('a held ref with an equal spec sends nothing and returns what the question says; another spec is ref-conflict', async () => {
		const { server, chat } = setup();
		await chat.send(deploy, { ref: REF });
		expect(await chat.send(deploy, { ref: REF })).toMatchObject({ kind: 'ok', ref: REF, status: 'pending', sent: { message: BODY } });
		expect(await chat.send(yesNo({ markdown: 'Other?' }), { ref: REF })).toMatchObject({ kind: 'refused', code: 'ref-conflict' });
		expect(server.calls).toHaveLength(1);
	});

	test('a dry run returns the steps and touches neither server nor store', async () => {
		const { server, chat, store } = setup();
		const outcome = await chat.send(deploy, { ref: REF, dryRun: true });
		expect(outcome).toMatchObject({ kind: 'dry', steps: [{ role: 'body', call: { method: 'sendRichMessage' } }] });
		expect(server.calls).toEqual([]);
		expect(store.ops).toEqual([]);
	});

	test('a guard refuses with its reason before anything is sent', async () => {
		const { server, chat, store } = setup({ guards: [(spec) => (JSON.stringify(spec).includes('secret') ? 'the spec names a secret' : undefined)] });
		expect(await chat.send(message({ markdown: 'The secret is 42.' }))).toEqual({ kind: 'refused', code: 'guard', reason: 'the spec names a secret' });
		expect(await chat.send(message({ markdown: 'Nothing to hide.' }))).toMatchObject({ kind: 'ok' });
		expect(server.calls).toHaveLength(1);
		expect(store.ops).toEqual([]);
	});

	test('strict turns a warning into a refusal; without it the warning comes back', async () => {
		const { server, chat } = setup();
		const spec = choice({ markdown: 'Tap a button to deploy' }, [{ label: 'Deploy' }, { label: 'Wait' }]);
		expect(await chat.send(spec, { strict: true })).toMatchObject({ kind: 'refused', code: 'shape' });
		expect(server.calls).toEqual([]);
		const outcome = await chat.send(spec);
		expect(outcome.kind === 'ok' && outcome.warnings.map((warning) => warning.code)).toEqual(['no-question-mark', 'answer-hint']);
	});

	test('a shape refusal stores nothing', async () => {
		const { chat, store } = setup();
		expect(await chat.send(choice({ markdown: 'Pick?' }, [{ label: 'Only' }]))).toMatchObject({ kind: 'refused', code: 'shape' });
		expect(await chat.send(deploy, { ref: 'no spaces' })).toMatchObject({ kind: 'refused', code: 'shape' });
		expect(await chat.send(deploy, { meta: { bad: Number.NaN } })).toMatchObject({ kind: 'refused', code: 'shape' });
		expect(store.ops).toEqual([]);
	});

	test('an expiresAt that has passed is refused as closed, and nothing is written or sent', async () => {
		const { chat, store, server } = setup();
		expect(await chat.send(deploy, { expiresAt: NOW })).toMatchObject({ kind: 'refused', code: 'closed' });
		expect(store.ops.filter((op) => op.method === 'set' || op.method === 'delete')).toEqual([]);
		expect(server.calls).toEqual([]);
	});

	test('needsListener refuses a question while no listener is alive', async () => {
		const { server, chat, inner, clock } = setup();
		const ask = () => chat.send(deploy, { needsListener: true });
		expect(await ask()).toMatchObject({ kind: 'refused', code: 'no-listener' });
		await inner.set('listener', { v: 1, heartbeat: clock.now - HEARTBEAT_AGE });
		expect(await ask()).toMatchObject({ kind: 'refused', code: 'no-listener' });
		await inner.set('listener', { v: 1, heartbeat: clock.now, stopped: 'conflict' });
		expect(await ask()).toMatchObject({ kind: 'refused', code: 'no-listener' });
		expect(server.calls).toEqual([]);
		await inner.set('listener', { v: 1, heartbeat: clock.now - 1_000 });
		expect(await ask()).toMatchObject({ kind: 'ok' });
		await inner.delete('listener');
		expect(await chat.send(message({ markdown: 'Done.' }), { needsListener: true })).toMatchObject({ kind: 'ok' });
	});

	test('a body refused by the server leaves a tombstone and no question', async () => {
		for (const [fault, code] of [
			['refused', 'server'],
			['token', 'token'],
			[{ busy: NOW + 60_000 }, 'busy'],
		] as const) {
			const { server, chat, inner } = setup();
			server.fail(0, fault);
			expect(await chat.send(deploy, { ref: REF })).toMatchObject({ kind: 'refused', code });
			expect(await inner.get(`q:${REF}`)).toBeUndefined();
			expect(await inner.get(`t:${REF}`)).toEqual({ v: 1, at: NOW });
			expect(await chat.send(deploy, { ref: REF })).toMatchObject({ kind: 'refused', code: 'ref-conflict' });
		}
	});

	test('a 429 whose time lies within 5 s is retried once', async () => {
		const { server, chat } = setup();
		server.fail(0, { busy: NOW });
		expect(await chat.send(deploy, { ref: REF })).toMatchObject({ kind: 'ok', sent: { message: BODY } });
		expect(server.calls.map(({ call }) => call.method)).toEqual(['sendRichMessage', 'sendRichMessage']);
	});

	test('a second 429 after the retry gives up: two calls, busy and a tombstone', async () => {
		const { server, chat, inner } = setup();
		server.fail(0, { busy: NOW });
		server.fail(1, { busy: NOW });
		expect(await chat.send(deploy, { ref: REF })).toMatchObject({ kind: 'refused', code: 'busy' });
		expect(server.calls).toHaveLength(2);
		expect([await inner.get(`q:${REF}`), await inner.get(`t:${REF}`)]).toEqual([undefined, { v: 1, at: NOW }]);
	});

	test('attach without a file reader is refused, and a reader refusal comes back with its code', async () => {
		const spec = message({ markdown: 'Logs.' }, { attach: [{ path: '/p/a.log' }] });
		expect(await setup().chat.send(spec)).toMatchObject({ kind: 'refused', code: 'shape' });
		const { chat, server } = setup({ files: async () => ({ kind: 'refused', code: 'secret-file', reason: '.env is a secret' }) });
		expect(await chat.send(spec)).toEqual({ kind: 'refused', code: 'secret-file', reason: '.env is a secret' });
		expect(server.calls).toEqual([]);
	});

	test('a photo over 10 MB is refused before the body and its file is closed', async () => {
		const big = memoryFile('/p/big.png', new Uint8Array(10_000_001));
		const { chat, server } = setup({ files: async () => ({ kind: 'ok', files: [big] }) });
		expect(await chat.send(message({ markdown: 'Screen.' }, { attach: [{ path: '/p/big.png' }] }))).toMatchObject({ kind: 'refused', code: 'shape' });
		expect(server.calls).toEqual([]);
		expect(big.closed).toBe(1);
	});

	test('a files step that fails after the body returns partial with the files that arrived', async () => {
		const reader = fakeFiles();
		const { server, chat } = setup({ files: reader.files });
		server.fail(2, 'refused');
		const spec = message({ markdown: 'Screens and report.' }, { attach: [{ path: '/p/a.png' }, { path: '/p/b.png' }, { path: '/p/report.pdf' }] });
		expect(await chat.send(spec)).toEqual({
			kind: 'partial',
			sent: { chat: CHAT, message: BODY, files: [1002, 1003] },
			failed: { step: 2, class: 'refused', reason: 'Bad Request: chat not found' },
			warnings: [],
		});
		server.fail(4, 'lost');
		expect(await chat.send(spec)).toMatchObject({ kind: 'partial', failed: { step: 1, class: 'uncertain' } });
		expect(server.calls.map(({ call }) => call.method)).toEqual(['sendRichMessage', 'sendMediaGroup', 'sendDocument', 'sendRichMessage', 'sendMediaGroup']);
	});

	test('a call without an answer counts as uncertain after 30 s, a video step after 600 s', async () => {
		jest.useFakeTimers();
		const settle = async (done: () => boolean) => {
			for (let tick = 0; tick < 100 && !done(); tick++) await Promise.resolve();
		};
		try {
			let calls = 0;
			const never = () => {
				calls++;
				return new Promise<never>(() => {});
			};
			const silent = createChat({ call: never, store: memoryStore(), chat: CHAT, now: () => NOW });
			const settled: Outcome[] = [];
			void silent.send(deploy, { ref: REF }).then((outcome) => settled.push(outcome));
			await settle(() => calls === 1);
			jest.advanceTimersByTime(DEADLINES.call - 1);
			await settle(() => false);
			expect(settled).toEqual([]);
			jest.advanceTimersByTime(1);
			await settle(() => settled.length > 0);
			expect(settled).toMatchObject([{ kind: 'uncertain', ref: REF }]);

			calls = 0;
			settled.length = 0;
			const video = createChat({
				call: async (call) => (calls === 0 ? (calls++, { ok: true, result: { message_id: BODY } }) : never()),
				store: memoryStore(),
				chat: CHAT,
				files: fakeFiles().files,
			});
			void video.send(message({ markdown: 'The run.' }, { attach: [{ path: '/p/run.mp4' }] })).then((outcome) => settled.push(outcome));
			await settle(() => calls === 2);
			jest.advanceTimersByTime(DEADLINES.call);
			await settle(() => false);
			expect(settled).toEqual([]);
			jest.advanceTimersByTime(DEADLINES.video - DEADLINES.call);
			await settle(() => settled.length > 0);
			expect(settled).toMatchObject([{ kind: 'partial', failed: { step: 1, class: 'uncertain' } }]);
		} finally {
			jest.useRealTimers();
		}
	});
});

describe('edit and close', () => {
	test('a status line is edited without state; an uncertain edit is reported as uncertain', async () => {
		const { server, chat, store } = setup();
		const sent = sentOf(await chat.send(message({ markdown: 'Step 1 of 3' })));
		expect(await chat.edit(sent, { markdown: 'Step 2 of 3' })).toEqual({ kind: 'ok', sent, warnings: [] });
		expect(server.shows.get(BODY)).toEqual({ rich_message: { markdown: 'Step 2 of 3' } });
		server.fail(server.count, 'lost');
		expect(await chat.edit(sent, { markdown: 'Step 3 of 3' })).toMatchObject({ kind: 'uncertain' });
		expect(store.ops.filter((op) => op.method === 'set' || op.method === 'delete')).toEqual([]);
	});

	test('an edit of a question keeps answer state and options, and a closed question is refused as closed', async () => {
		const { server, chat } = setup();
		const sent = sentOf(await chat.send(deploy, { ref: REF }));
		await chat.handle(tap({ button: 1, message: BODY }));
		expect(await chat.edit(sent, { markdown: 'Deploy at 18:00?' })).toMatchObject({ kind: 'ok', status: 'answered' });
		expect(server.shows.get(BODY)).toEqual({
			rich_message: { markdown: 'Deploy at 18:00?' },
			reply_markup: { inline_keyboard: [[{ text: 'Deploy', callback_data: `q:${REF}:0`, style: 'primary' }], [{ text: '✓ Wait', callback_data: `q:${REF}:1` }]] },
		});
		await chat.close(REF);
		expect(await chat.edit(sent, { markdown: 'Too late?' })).toMatchObject({ kind: 'refused', code: 'closed' });
	});

	test('an edit refused by the server stores the body and warns not-shown', async () => {
		const { server, chat } = setup();
		const sent = sentOf(await chat.send(deploy, { ref: REF }));
		server.fail(1, 'refused');
		expect(await chat.edit(sent, { markdown: 'Deploy later?' })).toMatchObject({ kind: 'ok', warnings: [{ code: 'not-shown' }] });
		expect((await chat.get(REF))?.spec.body).toEqual({ markdown: 'Deploy later?' });
	});

	test('a Sent whose view names another origin is refused as origin', async () => {
		const { chat } = setup({ viewOrigin: ORIGIN });
		const sent: Sent = { chat: CHAT, message: 5, files: [], view: { id: VIEW, origin: 'https://evil.example.com' } };
		expect(await chat.edit(sent, { markdown: 'Look.' })).toMatchObject({ kind: 'refused', code: 'origin' });
		expect(await setup().chat.edit({ ...sent, view: { id: VIEW, origin: ORIGIN } }, { markdown: 'Look.' })).toMatchObject({ kind: 'refused', code: 'origin' });
	});

	test('close of an unknown ref is refused; a resolved body of another form is refused as shape', async () => {
		const { chat } = setup();
		expect(await chat.close('nothing')).toMatchObject({ kind: 'refused', code: 'unknown-ref' });
		await chat.send(deploy, { ref: REF });
		expect(await chat.close(REF, { html: '<b>Done</b>' })).toMatchObject({ kind: 'refused', code: 'shape' });
		expect((await chat.get(REF))?.status).toBe('open');
	});
});

describe('handle', () => {
	test('a tap answers, toasts before the edit, and the message shows the mark', async () => {
		const { server, chat, breaches } = setup();
		await chat.send(deploy, { ref: REF });
		expect(await chat.handle(tap({ button: 0, message: BODY }))).toMatchObject({ kind: 'answered', ref: REF, seq: 1, answer: { kind: 'choice', index: 0, label: 'Deploy' } });
		expect(server.calls.map(({ call }) => call.method)).toEqual(['sendRichMessage', 'answerCallbackQuery', 'editMessageText']);
		const question = await chat.get(REF);
		if (!question) throw new Error('no question');
		expect(server.shows.get(BODY)).toEqual(shownOf(renderEdit(question).payload));
		expect(breaches).toEqual([]);
	});

	test('a text reply answers a text question found by the index, with a reaction', async () => {
		const { server, chat } = setup();
		await chat.send(text({ markdown: 'What should the commit say?' }), { ref: REF });
		const handled = await chat.handle(reply({ id: 901, replyTo: BODY, text: 'fix: the lock', markupRef: null }));
		expect(handled).toMatchObject({ kind: 'answered', answer: { kind: 'text', text: 'fix: the lock' } });
		expect(server.calls.at(-1)?.call).toMatchObject({ method: 'setMessageReaction', payload: { message_id: 901 } });
	});

	test('a reply whose question the index lost is found after a rebuild', async () => {
		const { chat, inner } = setup();
		await chat.send(text({ markdown: 'Why?' }), { ref: REF });
		await inner.delete(`m:${CHAT}:${BODY}`);
		expect(await chat.handle(reply({ id: 902, replyTo: BODY, text: 'Because.', markupRef: null }))).toMatchObject({ kind: 'answered' });
		expect(await inner.get(`m:${CHAT}:${BODY}`)).toBe(REF);
	});

	test('a tap on an unknown ref gets the configured toast, and labels are checked once at createChat', async () => {
		const { server, chat } = setup({ labels: { unknown: 'Unbekannte Frage' } });
		expect(await chat.handle(tap({ button: 0, ref: 'gone', message: 77 }))).toEqual({ kind: 'stale', reason: 'unknown' });
		expect(server.calls[0]?.call.payload).toMatchObject({ text: 'Unbekannte Frage' });
		expect(() => setup({ labels: { unknown: ' ' } })).toThrow(ShapeError);
	});

	test('a message that replies to nothing is ignored without a store write', async () => {
		const { chat, store } = setup();
		expect(await chat.handle({ update_id: 1 })).toEqual({ kind: 'ignored' });
		expect(store.ops).toEqual([]);
	});
});

describe('views', () => {
	test('a question with a view writes its context before the body; a failed write is repaired by flush', async () => {
		const fake = fakeViews([0]);
		const { server, chat } = setup({ viewOrigin: ORIGIN, views: fake.views });
		const spec = choice({ markdown: 'Which tab first?' }, [{ label: 'Views' }, { label: 'Lock' }], { view: VIEW });
		expect(await chat.send(spec, { ref: REF })).toMatchObject({ kind: 'ok', sent: { view: { id: VIEW, origin: ORIGIN } } });
		expect(fake.writes).toEqual([
			{ id: VIEW, ref: REF, body: spec.body },
			{ id: VIEW, ref: REF, body: spec.body },
		]);
		const question = await chat.get(REF);
		expect(question?.shown.done).toBe(question?.shown.want ?? -1);
		expect(server.calls.map(({ call }) => call.method)).toEqual(['sendRichMessage', 'editMessageText']);

		await chat.edit({ chat: CHAT, message: BODY, files: [], ref: REF, view: { id: VIEW, origin: ORIGIN } }, { markdown: 'Which tab first, now?' });
		expect(fake.writes.at(-1)).toEqual({ id: VIEW, ref: REF, body: { markdown: 'Which tab first, now?' } });
	});

	test('a spec with a view and no configured origin is refused as shape', async () => {
		const { chat } = setup();
		expect(await chat.send(message({ markdown: 'See the view.' }, { view: VIEW }))).toMatchObject({ kind: 'refused', code: 'shape' });
	});
});

async function settle(done: () => boolean) {
	for (let tick = 0; tick < 200 && !done(); tick++) await Promise.resolve();
}

function editStore(clock: { now: number }) {
	const inner = memoryStore();
	const plan = { armed: false, sets: 0, slowMark: 0, cut: false };
	const store: Store = {
		...inner,
		async set(key, value) {
			if (plan.armed) {
				plan.sets++;
				if (plan.sets === 2) clock.now += plan.slowMark;
				if (plan.sets === 3 && plan.cut) throw new StoreFault('the answer was not stored');
			}
			await inner.set(key, value);
		},
	};
	return {
		store,
		arm(options: { slowMark?: number; cut?: boolean }) {
			Object.assign(plan, { armed: true, sets: 0, slowMark: options.slowMark ?? 0, cut: options.cut ?? false });
		},
	};
}

function holdingFirstEdit() {
	const state = { shows: new Map<number, unknown>(), edits: 0, held: undefined as Call | undefined, release: undefined as ((response: CallResponse) => void) | undefined };
	const notModified: CallResponse = { ok: false, status: 400, description: 'Bad Request: message is not modified' };
	const call = async (request: Call): Promise<CallResponse> => {
		if (request.method === 'sendRichMessage') {
			state.shows.set(BODY, request.payload.rich_message);
			return { ok: true, result: { message_id: BODY } };
		}
		if (request.method !== 'editMessageText') return { ok: true, result: true };
		if (++state.edits === 1) {
			state.held = request;
			return new Promise((resolve) => {
				state.release = resolve;
			});
		}
		const same = JSON.stringify(state.shows.get(BODY)) === JSON.stringify(request.payload.rich_message);
		state.shows.set(BODY, request.payload.rich_message);
		return same ? notModified : { ok: true, result: { message_id: BODY } };
	};
	return { state, call };
}

async function lateEdit(options: { cut: boolean; slowMark?: number; lateTimeout?: number }) {
	const slowMark = options.slowMark ?? 0;
	jest.useFakeTimers();
	try {
		const { state, call } = holdingFirstEdit();
		const clock = { now: NOW };
		const { store, arm } = editStore(clock);
		const chat = createChat({ call, store, chat: CHAT, now: () => clock.now });
		const sent = sentOf(await chat.send(deploy, { ref: REF }));

		arm(options);
		const first = chat.edit(sent, { markdown: 'First?' }).catch((error: unknown) => error);
		await settle(() => state.held !== undefined);
		const start = NOW + slowMark;
		expect(clock.now).toBe(start);
		const windowEnd = start + DEADLINES.call + RECHECK_DELAY;
		const answered = start + DEADLINES.call + (options.lateTimeout ?? 0);
		clock.now = answered;
		jest.advanceTimersByTime(DEADLINES.call);
		const outcome = await first;
		if (options.cut) expect(outcome).toBeInstanceOf(StoreFault);
		else expect(outcome).toMatchObject({ kind: 'ok' });
		const recheckAt = options.cut ? NOW + START_WINDOW + DEADLINES.call + RECHECK_DELAY : answered + RECHECK_DELAY;
		expect(recheckAt).toBeGreaterThanOrEqual(windowEnd);
		expect((await chat.get(REF))?.shown).toMatchObject({ failures: options.cut ? 0 : 1, recheckAt });

		expect(await chat.edit(sent, { markdown: 'Second?' })).toMatchObject({ kind: 'ok', warnings: [] });
		expect((await chat.get(REF))?.shown).toEqual({ want: 2, done: 2, failures: 0, recheckAt });

		if (options.cut && slowMark > 0) {
			clock.now = NOW + DEADLINES.call + RECHECK_DELAY;
			await chat.flush();
			expect(state.edits).toBe(2);
		}
		clock.now = windowEnd - 1;
		state.shows.set(BODY, state.held?.payload.rich_message);
		state.release?.({ ok: true, result: { message_id: BODY } });
		expect(state.shows.get(BODY)).toEqual({ markdown: 'First?' });

		clock.now = recheckAt - 1;
		await chat.flush();
		expect(state.edits).toBe(2);
		clock.now = recheckAt;
		await chat.flush();
		expect(state.edits).toBe(3);
		expect(state.shows.get(BODY)).toEqual({ markdown: 'Second?' });
		expect((await chat.get(REF))?.shown).toEqual({ want: 2, done: 2, failures: 0 });
		await chat.flush();
		expect(state.edits).toBe(3);
	} finally {
		jest.useRealTimers();
	}
}

describe('recovery', () => {
	test('an edit that passed its deadline and lands after a newer one is repaired by the recheck', () => lateEdit({ cut: false }));

	test('a store write that fails after an edit call still leaves the recheck, since the mark was stored before the call', () => lateEdit({ cut: true }));

	test('a mark written slowly still lies past the repair window when the uncertain answer is not stored', () => lateEdit({ cut: true, slowMark: 20_000 }));

	test('a call started near its cap whose timeout is processed late is repaired up to 60 s after its deadline from the start', () =>
		lateEdit({ cut: true, slowMark: START_WINDOW - 1_000, lateTimeout: 10_000 }));

	test('the repair window ends 60 s after the deadline counted from the start: an early uncertain answer does not shorten it', async () => {
		const shows = new Map<number, unknown>();
		let held: Call | undefined;
		let edits = 0;
		const call = async (request: Call): Promise<CallResponse> => {
			if (request.method === 'sendRichMessage') {
				shows.set(BODY, request.payload.rich_message);
				return { ok: true, result: { message_id: BODY } };
			}
			if (request.method !== 'editMessageText') return { ok: true, result: true };
			if (++edits === 1) {
				held = request;
				return { ok: false, status: 502, description: 'Bad Gateway' };
			}
			const same = JSON.stringify(shows.get(BODY)) === JSON.stringify(request.payload.rich_message);
			shows.set(BODY, request.payload.rich_message);
			return same ? { ok: false, status: 400, description: 'Bad Request: message is not modified' } : { ok: true, result: { message_id: BODY } };
		};
		const clock = { now: NOW };
		const chat = createChat({ call, store: memoryStore(), chat: CHAT, now: () => clock.now });
		const sent = sentOf(await chat.send(deploy, { ref: REF }));
		const start = NOW + 1_000;
		clock.now = start;
		expect(await chat.edit(sent, { markdown: 'First?' })).toMatchObject({ kind: 'ok' });
		const windowEnd = start + DEADLINES.call + RECHECK_DELAY;
		expect((await chat.get(REF))?.shown).toMatchObject({ failures: 1, recheckAt: windowEnd });
		expect(await chat.edit(sent, { markdown: 'Second?' })).toMatchObject({ kind: 'ok' });

		clock.now = windowEnd - 1;
		shows.set(BODY, held?.payload.rich_message);
		await chat.flush();
		expect(edits).toBe(2);
		clock.now = windowEnd;
		await chat.flush();
		expect(edits).toBe(3);
		expect(shows.get(BODY)).toEqual({ markdown: 'Second?' });
	});

	test('an edit that cannot start within 30 s of its mark is not sent and counts as a failed edit', async () => {
		const { state, call } = holdingFirstEdit();
		const clock = { now: NOW };
		const { store, arm } = editStore(clock);
		const chat = createChat({ call, store, chat: CHAT, now: () => clock.now });
		const sent = sentOf(await chat.send(deploy, { ref: REF }));
		arm({ slowMark: START_WINDOW + 1 });
		expect(await chat.edit(sent, { markdown: 'First?' })).toMatchObject({ kind: 'ok', status: 'pending', warnings: [] });
		expect(state.edits).toBe(0);
		expect((await chat.get(REF))?.shown).toEqual({ want: 1, done: 0, failures: 1 });
		const flushing = chat.flush();
		await settle(() => state.edits === 1);
		expect(state.held?.payload.rich_message).toEqual({ markdown: 'First?' });
		state.release?.({ ok: true, result: { message_id: BODY } });
		await flushing;
		expect((await chat.get(REF))?.shown).toMatchObject({ want: 1, done: 1, failures: 0 });
	});

	test('an equal ref retry answers from the stored question after the listener, the files and the expiry changed', async () => {
		const reader = fakeFiles();
		let refuse = false;
		const { chat, inner, server, clock } = setup({
			files: async (paths) => (refuse ? { kind: 'refused', code: 'outside-roots', reason: 'the file moved' } : reader.files(paths)),
		});
		await inner.set('listener', { v: 1, heartbeat: NOW });
		const spec = choice({ markdown: 'Keep the screen?' }, [{ label: 'Keep' }, { label: 'Drop' }], { attach: [{ path: '/p/screen.png' }] });
		const options = { ref: REF, needsListener: true, expiresAt: NOW + 60_000 };
		const first = await chat.send(spec, options);
		expect(first).toMatchObject({ kind: 'ok', sent: { message: BODY, files: [1002] } });
		const calls = server.calls.length;

		await inner.delete('listener');
		refuse = true;
		clock.now = NOW + 120_000;
		expect(await chat.send(spec, options)).toMatchObject({ kind: 'ok', ref: REF, sent: { message: BODY, files: [1002] } });
		expect(server.calls).toHaveLength(calls);
	});

	test('flush finishes the delete of a question whose tombstone was written', async () => {
		const { server, chat, store, inner } = setup();
		server.fail(0, 'refused');
		store.fail('delete', 'before');
		await expect(chat.send(deploy, { ref: REF })).rejects.toThrow('failed before it ran');
		expect(await inner.get(`q:${REF}`)).toMatchObject({ status: 'sending' });
		await chat.flush();
		expect([await inner.get(`q:${REF}`), await inner.get(`t:${REF}`)]).toEqual([undefined, { v: 1, at: NOW }]);
		expect(await chat.wait(REF)).toMatchObject({ status: 'closed' });
	});

	test('a send that expires during its body call reports the closed question it stored and shows', async () => {
		const clock = { now: NOW };
		const server = telegram();
		const { chat } = setup({
			now: () => clock.now,
			call: async (call, files) => {
				if (call.method === 'sendRichMessage') clock.now += 2;
				return server.call(call, files);
			},
		});
		const outcome = await chat.send(deploy, { ref: REF, expiresAt: NOW + 1 });
		const question = await chat.get(REF);
		if (!question) throw new Error('no question');
		expect(outcome).toMatchObject({ kind: 'ok', status: 'closed' });
		expect(question).toMatchObject({ status: 'closed', resolved: { markdown: 'Expired without an answer.' } });
		expect(server.shows.get(BODY)).toEqual(shownOf(renderEdit(question).payload));
	});

	test('a 401 stores what was decided and rejects with TokenRefused; a new message that never went out is refused as token', async () => {
		const { server, chat } = setup();
		const sent = sentOf(await chat.send(deploy, { ref: REF }));
		server.fail(1, 'token');
		await expect(chat.edit(sent, { markdown: 'Deploy later?' })).rejects.toBeInstanceOf(TokenRefused);
		const edited = await chat.get(REF);
		expect(edited?.spec.body).toEqual({ markdown: 'Deploy later?' });
		expect(edited && edited.shown.want > edited.shown.done).toBe(true);

		server.fail(2, 'token');
		await expect(chat.flush()).rejects.toBeInstanceOf(TokenRefused);
		expect((await chat.get(REF))?.shown).toEqual(edited?.shown);

		server.fail(3, 'token');
		await expect(chat.handle(tap({ button: 0, message: BODY }))).rejects.toBeInstanceOf(TokenRefused);
		expect(await chat.get(REF)).toMatchObject({ status: 'answered', seq: 1 });

		server.fail(4, 'token');
		expect(await chat.send(message({ markdown: 'Hello?' }))).toMatchObject({ kind: 'refused', code: 'token' });
	});
});

describe('files', () => {
	const sized = (path: string, size: number) => Object.assign(memoryFile(path), { size });

	test('a non-photo file over fileLimit is refused before the body: 50,000,000 bytes by default', async () => {
		const spec = message({ markdown: 'The log.' }, { attach: [{ path: '/p/run.log' }] });
		const over = sized('/p/run.log', 50_000_001);
		const cloud = setup({ files: async () => ({ kind: 'ok', files: [over] }) });
		expect(await cloud.chat.send(spec)).toMatchObject({ kind: 'refused', code: 'shape' });
		expect(cloud.server.calls).toEqual([]);
		expect(over.closed).toBe(1);

		const atLimit = setup({ files: async () => ({ kind: 'ok', files: [sized('/p/run.log', 50_000_000)] }) });
		expect(await atLimit.chat.send(spec)).toMatchObject({ kind: 'ok' });
		const local = setup({ fileLimit: 2_000_000_000, files: async () => ({ kind: 'ok', files: [sized('/p/run.log', 50_000_001)] }) });
		expect(await local.chat.send(spec)).toMatchObject({ kind: 'ok', sent: { files: [1002] } });
		expect(() => setup({ fileLimit: 0 })).toThrow(ShapeError);
	});

	test('every opened handle is closed once, two attachments of one path included', async () => {
		const spec = message({ markdown: 'Twice.' }, { attach: [{ path: '/p/a.pdf' }, { path: '/p/a.pdf' }] });
		const sent = fakeFiles();
		expect(await setup({ files: sent.files }).chat.send(spec)).toMatchObject({ kind: 'ok' });
		expect(sent.opened.map((file) => file.closed)).toEqual([1, 1]);

		const big = [sized('/p/a.pdf', 60_000_000), sized('/p/a.pdf', 1)];
		expect(await setup({ files: async () => ({ kind: 'ok', files: big }) }).chat.send(spec)).toMatchObject({ kind: 'refused', code: 'shape' });
		expect(big.map((file) => file.closed)).toEqual([1, 1]);

		const asked = fakeFiles();
		expect(await setup({ files: asked.files }).chat.send(choice({ markdown: 'Both?' }, [{ label: 'Yes' }, { label: 'No' }], { attach: spec.attach ?? [] }), { ref: REF })).toMatchObject({ kind: 'ok' });
		expect(asked.opened.map((file) => file.closed)).toEqual([1, 1]);
	});

	test('one path as document and as photo is checked on the handle both fields send, before the body', async () => {
		const spec = message({ markdown: 'Same file twice.' }, { attach: [{ path: '/p/same.png', as: 'document' }, { path: '/p/same.png', as: 'photo' }] });
		const handles = [sized('/p/same.png', 10_000_001), sized('/p/same.png', 1)];
		const { chat, server } = setup({ files: async () => ({ kind: 'ok', files: handles }) });
		expect(await chat.send(spec)).toMatchObject({ kind: 'refused', code: 'shape' });
		expect(server.calls).toEqual([]);
		expect(handles.map((file) => file.closed)).toEqual([1, 1]);
	});

	test('a files step that answers 401 stores the ids so far, then rejects with TokenRefused', async () => {
		const { server, chat } = setup({ files: fakeFiles().files });
		server.fail(2, 'token');
		const spec = choice({ markdown: 'Keep them?' }, [{ label: 'Keep' }, { label: 'Drop' }], { attach: [{ path: '/p/a.png' }, { path: '/p/b.png' }, { path: '/p/c.pdf' }] });
		await expect(chat.send(spec, { ref: REF })).rejects.toBeInstanceOf(TokenRefused);
		expect(server.calls.map(({ call }) => call.method)).toEqual(['sendRichMessage', 'sendMediaGroup', 'sendDocument']);
		expect(await chat.get(REF)).toMatchObject({ status: 'open', sent: { message: BODY, files: [1002, 1003] } });
	});
});

describe('pacing', () => {
	test('sends and edits of one chat start at least 1 s apart across chats of the process; another chat is not held', async () => {
		PACING.interval = 1_000;
		try {
			const starts: { chat: number; method: string; at: number }[] = [];
			const server = telegram();
			const call = async (request: Call): Promise<CallResponse> => {
				starts.push({ chat: Number(request.payload.chat_id), method: request.method, at: performance.now() });
				return server.call(request);
			};
			const one = createChat({ call, store: memoryStore(), chat: CHAT });
			const two = createChat({ call, store: memoryStore(), chat: CHAT, files: fakeFiles().files });
			const other = createChat({ call, store: memoryStore(), chat: 222 });
			const [first] = await Promise.all([one.send(message({ markdown: 'One.' })), two.send(message({ markdown: 'Two.' })), other.send(message({ markdown: 'Other.' }))]);
			await two.send(message({ markdown: 'With a file.' }, { attach: [{ path: '/p/a.png' }] }));
			const sent = sentOf(first ?? { kind: 'dry', steps: [], warnings: [] });
			await one.edit(sent, { markdown: 'One, edited.' });
			await one.edit(sent, { markdown: 'One, edited again.' });

			const paced = starts.filter((start) => start.chat === CHAT);
			expect(paced.map((start) => start.method)).toEqual(['sendRichMessage', 'sendRichMessage', 'sendRichMessage', 'sendPhoto', 'editMessageText', 'editMessageText']);
			for (const [index, start] of paced.entries()) if (index > 0) expect(start.at - (paced[index - 1]?.at ?? 0)).toBeGreaterThanOrEqual(1_000);
			const otherStart = starts.find((start) => start.chat === 222)?.at ?? Number.POSITIVE_INFINITY;
			expect(otherStart - (paced[0]?.at ?? 0)).toBeLessThan(900);
		} finally {
			PACING.interval = 0;
		}
	}, 30_000);

	test('queued work between a call admitted by the gate and its transport call cannot shorten the interval', async () => {
		PACING.interval = 1_000;
		try {
			const entries: number[] = [];
			const server = telegram();
			const call = async (request: Call): Promise<CallResponse> => {
				entries.push(performance.now());
				return server.call(request);
			};
			const one = createChat({ call, store: memoryStore(), chat: 333 });
			const two = createChat({ call, store: memoryStore(), chat: 333 });
			const busy = () => {
				const until = performance.now() + 10;
				while (performance.now() < until) {}
			};
			const nest = (depth: number): void => queueMicrotask(() => (depth === 0 ? busy() : nest(depth - 1)));
			for (let depth = 0; depth < 100; depth++) nest(depth);
			await Promise.all([one.send(message({ markdown: 'One.' })), two.send(message({ markdown: 'Two.' }))]);
			expect(entries).toHaveLength(2);
			expect((entries[1] ?? 0) - (entries[0] ?? 0)).toBeGreaterThanOrEqual(1_000);
		} finally {
			PACING.interval = 0;
		}
	}, 30_000);

	test('work in the transport before its request starts cannot shorten the interval to the next call', async () => {
		PACING.interval = 1_000;
		try {
			const entries: number[] = [];
			const server = telegram();
			const call = async (request: Call): Promise<CallResponse> => {
				if (entries.length === 0) {
					const until = performance.now() + 20;
					while (performance.now() < until) {}
				}
				entries.push(performance.now());
				return server.call(request);
			};
			const one = createChat({ call, store: memoryStore(), chat: 444 });
			const two = createChat({ call, store: memoryStore(), chat: 444 });
			await Promise.all([one.send(message({ markdown: 'One.' })), two.send(message({ markdown: 'Two.' }))]);
			expect(entries).toHaveLength(2);
			expect((entries[1] ?? 0) - (entries[0] ?? 0)).toBeGreaterThanOrEqual(1_000);
		} finally {
			PACING.interval = 0;
		}
	}, 30_000);
});
