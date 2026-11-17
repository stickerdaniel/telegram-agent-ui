// Stage 2 acceptance: a fault before and after every store write, and every failure class on
// every call, of `send`, `edit`, `close` and `handle` ends in a state that `flush` repairs or
// that the outcome names. After each faulted run a second chat on the same store, without
// faults and a day later, runs `flush`; then every question reads back, every known message
// shows its question's state and has its index entry, and every stored answer was delivered.
import { describe, expect, test } from 'bun:test';
import { choice, message, text } from '../core/builders.ts';
import { renderEdit } from '../core/render.ts';
import type { Outcome, Question } from '../core/types.ts';
import { CHAT, NOW, ORIGIN, REF, reply, tap, VIEW } from '../fixtures.ts';
import { type Chat, type ChatIO, createChat } from './create.ts';
import { type Fault, fakeFiles, fakeViews, questions, setup, shownOf, type Telegram } from './harness.ts';

const DAY = 86_400_000;
const BODY = 1001;
const deploy = choice({ markdown: 'Deploy now?' }, [{ label: 'Deploy', style: 'primary' }, { label: 'Wait' }]);
const why = text({ markdown: 'Why did the run fail?' });

type Scenario = {
	name: string;
	/** How many bodies the scenario sends at most: no fault may show a body twice. */
	sends: number;
	io?: () => Partial<ChatIO> & { writes?: { id: string; ref: string; body: unknown }[] };
	prepare?: (chat: Chat, server: Telegram) => Promise<unknown>;
	act: (chat: Chat) => Promise<Outcome | { kind: string }>;
};

/** A send whose body arrived and whose answer was lost: the question stays sending, message 1001 exists. */
const lostSend = (spec: Question['spec']) => async (chat: Chat, server: Telegram) => {
	server.fail(server.count, 'lost');
	await chat.send(spec, { ref: REF });
};
const sent = (spec: Question['spec']) => async (chat: Chat) => chat.send(spec, { ref: REF });
const withViews = (failing: number[]) => () => {
	const fake = fakeViews(failing);
	return { viewOrigin: ORIGIN, views: fake.views, writes: fake.writes };
};

const scenarios: Scenario[] = [
	{ name: 'send a choice', sends: 1, act: (chat) => chat.send(deploy, { ref: REF }) },
	{ name: 'send a text question', sends: 1, act: (chat) => chat.send(why, { ref: REF }) },
	{ name: 'send a message', sends: 1, act: (chat) => chat.send(message({ markdown: 'Build passed.' })) },
	{
		name: 'send a question with a view',
		sends: 1,
		io: withViews([]),
		act: (chat) => chat.send(choice({ markdown: 'Which tab?' }, [{ label: 'Views', tab: 'Views' }, { label: 'Lock' }], { view: VIEW }), { ref: REF }),
	},
	{
		name: 'send a question with a view whose context write fails',
		sends: 1,
		io: withViews([0]),
		act: (chat) => chat.send(choice({ markdown: 'Which tab?' }, [{ label: 'Views' }, { label: 'Lock' }], { view: VIEW }), { ref: REF }),
	},
	{
		name: 'send a question with files',
		sends: 1,
		io: () => ({ files: fakeFiles().files }),
		act: (chat) => chat.send(choice({ markdown: 'Keep them?' }, [{ label: 'Keep' }, { label: 'Revert' }], { attach: [{ path: '/p/a.png' }, { path: '/p/b.png' }, { path: '/p/c.pdf' }] }), { ref: REF }),
	},
	{ name: 'edit a question', sends: 1, prepare: sent(deploy), act: (chat) => chat.edit({ chat: CHAT, message: BODY, files: [], ref: REF }, { markdown: 'Deploy at 18:00?' }) },
	{ name: 'edit a question by its index', sends: 1, prepare: sent(deploy), act: (chat) => chat.edit({ chat: CHAT, message: BODY, files: [] }, { markdown: 'Deploy at 18:00?' }) },
	{
		name: 'edit a status line',
		sends: 1,
		prepare: (chat) => chat.send(message({ markdown: 'Step 1 of 2' })),
		act: (chat) => chat.edit({ chat: CHAT, message: BODY, files: [] }, { markdown: 'Step 2 of 2' }),
	},
	{ name: 'close a question with a body', sends: 1, prepare: sent(deploy), act: (chat) => chat.close(REF, { markdown: 'Deployed from the terminal.' }) },
	{
		name: 'close an answered question',
		sends: 1,
		prepare: async (chat) => {
			await chat.send(deploy, { ref: REF });
			await chat.handle(tap({ button: 1, message: BODY }));
		},
		act: (chat) => chat.close(REF),
	},
	{ name: 'close a sending question', sends: 1, prepare: lostSend(deploy), act: (chat) => chat.close(REF, { markdown: 'Done without it.' }) },
	{ name: 'handle a tap', sends: 1, prepare: sent(deploy), act: (chat) => chat.handle(tap({ button: 0, message: BODY })) },
	{
		name: 'handle a corrected tap',
		sends: 1,
		prepare: async (chat) => {
			await chat.send(deploy, { ref: REF });
			await chat.handle(tap({ button: 0, id: 'first', message: BODY }));
		},
		act: (chat) => chat.handle(tap({ button: 1, id: 'second', message: BODY })),
	},
	{ name: 'handle a tap that reveals a sending question', sends: 1, prepare: lostSend(deploy), act: (chat) => chat.handle(tap({ button: 0, message: BODY, inaccessible: true })) },
	{ name: 'handle a text reply', sends: 1, prepare: sent(why), act: (chat) => chat.handle(reply({ id: 900, replyTo: BODY, text: 'The lock timed out.', markupRef: null })) },
	{ name: 'handle a reply to a sending choice question', sends: 1, prepare: lostSend(deploy), act: (chat) => chat.handle(reply({ id: 900, replyTo: BODY, text: 'Both?' })) },
];

type StoreFault = { method: 'set' | 'delete'; when: 'before' | 'after'; nth: number };
type Injected = { store?: StoreFault; call?: { index: number; fault: Fault } };

const CALL_FAULTS: Fault[] = ['lost', 'gateway', 'refused', 'token', { busy: NOW }, { busy: NOW + 60_000 }];
// Each matrix runs dozens of scenarios: room for a machine 10 times slower than an idle one.
const MATRIX = 60_000;

async function run(scenario: Scenario, injected: Injected = {}) {
	const { writes, ...io } = scenario.io?.() ?? {};
	const env = setup(io);
	if (scenario.prepare) await scenario.prepare(env.chat, env.server);
	const start = { ops: env.store.ops.length, calls: env.server.count };
	if (injected.store) env.store.fail(injected.store.method, injected.store.when, injected.store.nth);
	if (injected.call) env.server.fail(start.calls + injected.call.index, injected.call.fault);
	const result = await scenario.act(env.chat).catch((error: unknown) => ({ kind: 'rejected', error }));
	const ops = env.store.ops.slice(start.ops);
	return { env, io, writes, result, sets: ops.filter((op) => op.method === 'set').length, deletes: ops.filter((op) => op.method === 'delete').length, calls: env.server.count - start.calls };
}

async function verify(scenario: Scenario, ran: Awaited<ReturnType<typeof run>>) {
	const { env, io, writes, result } = ran;
	const { server, inner, breaches } = env;
	expect(breaches).toEqual([]);
	const before = await questions(inner);

	// What the outcome names.
	if (result.kind === 'refused' && scenario.name.startsWith('send')) expect(before.has(REF)).toBe(false);
	if (result.kind === 'ok' && 'ref' in result && result.ref !== undefined) {
		const question = before.get(result.ref);
		expect(question).toBeDefined();
		const codes = result.warnings.map((warning) => warning.code);
		if (question && !('sent' in question && question.sent)) expect(codes).toContain('unconfirmed-message');
		if (question?.shown.error !== undefined) expect(codes).toContain('not-shown');
	}

	// The repair: another chat on the same store, a day later, without faults.
	const delivered: string[] = [];
	const repair = createChat({ ...io, call: server.call, store: inner, chat: CHAT, now: () => NOW + DAY, onAnswer: async (answer) => void delivered.push(answer.delivery) });
	await repair.flush();
	expect(breaches).toEqual([]);

	for (const [ref, question] of await questions(inner)) {
		expect(question).toBeDefined();
		expect(await inner.get(`t:${ref}`)).toBeUndefined();
		if (!question) continue;
		const sent = 'sent' in question ? question.sent : undefined;
		if (sent) {
			expect(await inner.get(`m:${CHAT}:${sent.message}`)).toBe(ref);
			expect(question.shown.done).toBe(question.shown.want);
			if (question.shown.error === undefined) {
				expect(server.shows.get(sent.message)).toEqual(shownOf(renderEdit(question).payload));
				if (writes && question.spec.view !== undefined) expect(writes.findLast((write) => write.ref === ref)?.body).toEqual(question.spec.body);
			}
			for (const file of sent.files) expect(server.replies.get(file)).toBe(sent.message);
		}
		if (question.seq > 0) {
			expect(question.delivery.seq).toBe(question.seq);
			expect(delivered).toContain(`${ref}:${question.seq}`);
		}
	}
	expect(server.shows.size).toBeLessThanOrEqual(scenario.sends);
}

/** Runs and verifies, naming the fault in a failure. */
async function check(scenario: Scenario, injected: Injected = {}) {
	const ran = await run(scenario, injected);
	try {
		await verify(scenario, ran);
	} catch (error) {
		throw new Error(`${scenario.name} with ${JSON.stringify(injected)} returned ${JSON.stringify(ran.result)}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return ran;
}

for (const scenario of scenarios) {
	describe(scenario.name, () => {
		test('a fault before and after every store write ends repaired or named', async () => {
			const base = await check(scenario);
			const points = [...Array.from({ length: base.sets }, (_, index) => ['set', index + 1] as const), ...Array.from({ length: base.deletes }, (_, index) => ['delete', index + 1] as const)];
			for (const [method, nth] of points) for (const when of ['before', 'after'] as const) await check(scenario, { store: { method, when, nth } });
		}, MATRIX);

		test('every failure class on every call ends repaired or named', async () => {
			const base = await run(scenario);
			for (let index = 0; index < base.calls; index++) for (const fault of CALL_FAULTS) await check(scenario, { call: { index, fault } });
		}, MATRIX);
	});
}
