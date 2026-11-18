import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { CHAT, input, MESSAGE, NOW, ORIGIN, REF, reply, sentFor, states, step, tap, USER, VIEW } from '../fixtures.ts';
import { choice, text } from './builders.ts';
import { parseQuestion } from './parse.ts';
import { reduce } from './reduce.ts';
import { mergeLabels } from './labels.ts';
import { bodyLike } from './render.ts';
import { type Body, type CallClass, defaultLabels, type Labels, type Question, type QuestionEvent, ShapeError } from './types.ts';

const choiceSpec = choice({ markdown: 'Which way?' }, [{ label: 'Rebase', tab: 'Rebase' }, { label: 'Merge' }, { label: 'Close' }], { view: VIEW });
const { open, answered, closedAnswered } = states(choiceSpec);
const corrected = step(answered, input(tap({ button: 1, id: 'b1' })));
const blocksOpen = states(text({ blocks: [{ type: 'paragraph', text: 'Why?' }] })).open;
const inViewSpec = choice({ markdown: 'Which tab?' }, [{ label: 'A', tab: 'A' }, { label: 'B', tab: 'B' }, { label: 'C', tab: 'C' }], { view: VIEW, in: 'view' });
const inViewOpen = states(inViewSpec).open;

/** A stored question with some fields replaced, as JSON. A field set to undefined is removed. */
const stored = (question: Question, change: Record<string, unknown>): unknown =>
	Object.fromEntries(Object.entries({ ...structuredClone(question), ...change }).filter(([, value]) => value !== undefined));

describe('parseQuestion', () => {
	test('returns every question of the fixtures unchanged', () => {
		for (const question of [...Object.values(states(choiceSpec)), ...Object.values(states(text({ markdown: 'Why?' })))]) expect(parseQuestion(structuredClone(question))).toEqual(question);
		expect(parseQuestion(corrected)).toEqual(corrected);
	});

	test('drops fields it does not know', () => {
		expect(parseQuestion(stored(open, { extra: 1 }))).toEqual(open);
	});

	// One fixture per rule of 4.2, each a valid question with one rule broken.
	const fixtures: [string, unknown][] = [
		['not a question at all', 'q'],
		['another version', stored(open, { v: 2 })],
		['an unknown status', stored(open, { status: 'pending' })],
		['a ref outside its pattern', stored(open, { ref: 'a b', sent: { ...sentFor(open), ref: 'a b' } })],
		['a spec that breaks a shape check: one option', stored(open, { spec: { ...choiceSpec, answer: { type: 'choice', options: [{ label: 'A' }] } } })],
		['a spec without an answer', stored(open, { spec: { body: choiceSpec.body, view: VIEW } })],
		['viewOrigin without a view', stored(states(text({ markdown: 'Why?' })).sending, { viewOrigin: ORIGIN })],
		['a view without viewOrigin', stored(states(choiceSpec).sending, { viewOrigin: undefined })],
		['an answer of the other kind', stored(answered, { answer: { kind: 'text', text: 'x' } })],
		['a choice answer whose index names no option', stored(answered, { answer: { kind: 'choice', index: 3, label: 'x' } })],
		['a previous of the other kind', stored(corrected, { previous: { kind: 'text', text: 'x' } })],
		['a closed question with an answer and no sent', stored(closedAnswered, { sent: undefined })],
		['seq above 0 while open', stored(open, { seq: 1 })],
		['seq 0 once answered', stored(answered, { seq: 0, delivery: { seq: 0, attempts: 0 } })],
		['a closed question with seq 1 and no answer', stored(closedAnswered, { answer: undefined, by: undefined, answeredAt: undefined })],
		['a closed question with an answer and seq 0', stored(closedAnswered, { seq: 0 })],
		['an answer without by', stored(answered, { by: undefined })],
		['an answer without answeredAt', stored(answered, { answeredAt: undefined })],
		['previous with seq 1', stored(answered, { previous: { kind: 'choice', index: 1, label: 'Merge' } })],
		['delivery.seq above seq', stored(answered, { delivery: { seq: 2, attempts: 0 } })],
		['shown.done above shown.want', stored(open, { shown: { want: 1, done: 2, failures: 0 } })],
		['33 applied keys', stored(open, { applied: Array.from({ length: 33 }, (_, n) => `cq:${n}`) })],
		['a negative counter', stored(open, { shown: { want: 0, done: 0, failures: -1 } })],
		['a time that is not an integer', stored(open, { createdAt: 1.5 })],
		['a recheck time that is not an integer', stored(open, { shown: { want: 0, done: 0, failures: 0, recheckAt: 1.5 } })],
		['sent.chat of another chat', stored(open, { sent: { ...sentFor(open), chat: CHAT + 1 } })],
		['sent.ref of another question', stored(open, { sent: { ...sentFor(open), ref: 'other' } })],
		['sent.view of another view', stored(open, { sent: { ...sentFor(open), view: { id: 'BBBBBBBBBBBBBBBBBBBBBB', origin: ORIGIN } } })],
		['sent.view of another origin', stored(open, { sent: { ...sentFor(open), view: { id: VIEW, origin: 'https://evil.example.com' } } })],
		['sent.message 0', stored(open, { sent: { ...sentFor(open), message: 0 } })],
		['a sending question with a sent', stored(states(choiceSpec).sending, { sent: sentFor(open) })],
		['a resolved body with </details>', stored(states(choiceSpec).closed, { resolved: { markdown: 'a</details>' } })],
		['meta that is not JSON', stored(open, { meta: { at: Number.NaN } })],
		['meta that is a Date, not a plain object', stored(open, { meta: new Date(0) })],
		['a block of an unknown type', stored(blocksOpen, { spec: { ...blocksOpen.spec, body: { blocks: [{ type: 'not-a-rich-block' }] } } })],
		['a paragraph whose text is a number', stored(blocksOpen, { spec: { ...blocksOpen.spec, body: { blocks: [{ type: 'paragraph', text: 123 }] } } })],
		['a heading without its size', stored(blocksOpen, { spec: { ...blocksOpen.spec, body: { blocks: [{ type: 'heading', text: 'Why?' }] } } })],
		['a details block holding a malformed block', stored(blocksOpen, { spec: { ...blocksOpen.spec, body: { blocks: [{ type: 'details', summary: 'More', blocks: [{ type: 'paragraph' }] }] } } })],
		['a rich text node of an unknown type', stored(blocksOpen, { spec: { ...blocksOpen.spec, body: { blocks: [{ type: 'paragraph', text: { type: 'blink', text: 'Why?' } }] } } })],
		['a url node without its url', stored(blocksOpen, { spec: { ...blocksOpen.spec, body: { blocks: [{ type: 'paragraph', text: [{ type: 'url', text: 'Why?' }] }] } } })],
		['a resolved body of another form than the question body', stored(states(choiceSpec).closed, { resolved: { html: 'Done' } })],
		['an answer in the view with an option that names no tab', stored(inViewOpen, { spec: { ...inViewSpec, answer: { ...inViewSpec.answer, options: [{ label: 'A', tab: 'A' }, { label: 'B' }] } } })],
		['an answer in the view with a tab named twice', stored(inViewOpen, { spec: { ...inViewSpec, answer: { ...inViewSpec.answer, options: [{ label: 'A', tab: 'A' }, { label: 'B', tab: 'A' }] } } })],
		['an open question that owes its closed binding', stored(inViewOpen, { bindingOwed: true })],
		['a debt of the closed binding that is not true', stored(states(inViewSpec).closed, { bindingOwed: false })],
		['an answer in a place that is neither chat nor view', stored(inViewOpen, { spec: { ...inViewSpec, answer: { ...inViewSpec.answer, in: 'thread' } } })],
	];
	for (const [name, value] of fixtures) {
		test(`rejects ${name}`, () => {
			expect(parseQuestion(value)).toBeUndefined();
		});
	}

	test('keeps well-formed rich blocks and a resolved body of the same form', () => {
		const body: Body = {
			blocks: [
				{ type: 'heading', text: 'Results', size: 2 },
				{ type: 'paragraph', text: ['Which way for ', { type: 'code', text: 'fix/lock' }, '? See ', { type: 'url', text: 'the run', url: 'https://example.com' }] },
				{ type: 'table', cells: [[{ text: 'Branch', is_header: true, align: 'center', valign: 'middle' }], [{ text: { type: 'code', text: 'feat/views' }, align: 'left', valign: 'middle' }]], is_bordered: true },
				{ type: 'details', summary: 'Details', blocks: [{ type: 'paragraph', text: 'The second branch fails 1 of 212 tests.' }] },
				{ type: 'list', items: [{ blocks: [{ type: 'paragraph', text: { type: 'bold', text: 'One' } }] }] },
				{ type: 'pre', text: 'log', language: 'sh' },
				{ type: 'divider' },
			],
		};
		const question = states(text(body)).open;
		expect(parseQuestion(JSON.parse(JSON.stringify(question)))).toEqual(question);
		const closed = step(question, { type: 'close', body: { blocks: [{ type: 'paragraph', text: 'Done' }] } });
		expect(parseQuestion(JSON.parse(JSON.stringify(closed)))).toEqual(closed);
	});
});

describe('every state reduce produces passes parseQuestion', () => {
	const bodies: Body[] = [{ markdown: 'New text?' }, { html: '<b>New</b> text?' }, { blocks: [{ type: 'paragraph', text: 'New text?' }] }];
	const outcomes: CallClass[] = [
		{ kind: 'ok', result: true },
		{ kind: 'unchanged' },
		{ kind: 'refused', code: 'server', reason: 'Bad Request' },
		{ kind: 'refused', code: 'token', reason: 'Unauthorized' },
		{ kind: 'retry', at: NOW + 1000 },
		{ kind: 'retry' },
		{ kind: 'uncertain' },
	];
	const specs: Question['spec'][] = [
		choiceSpec,
		choice({ markdown: 'Allow?' }, [{ label: 'Allow' }, { label: 'Deny' }], { once: true, layout: 'row' }),
		text({ markdown: 'Why?' }),
		text({ blocks: [{ type: 'paragraph', text: 'Why?' }] }, { once: true }),
		choice({ html: '<b>Which?</b>' }, [{ label: 'A' }, { label: 'B' }]),
		inViewSpec,
	];
	/** `usual` 4 times in 5, else `rare`: most inputs fit, so that answers and corrections happen. */
	const mostly = <T>(usual: T, rare: T) => fc.oneof({ arbitrary: fc.constant(usual), weight: 4 }, { arbitrary: fc.constant(rare), weight: 1 });
	const message = mostly(MESSAGE, MESSAGE + 1);
	const user = mostly(USER, 999);
	// `valid: false` marks an event that breaks the stored types: reduce must throw ShapeError for it.
	type Made = { event: QuestionEvent; valid: boolean; now?: number };
	type Make = (question: Question, ask: QuestionEvent) => Made;
	const ok = (event: QuestionEvent): Made => ({ event, valid: true });
	const event: fc.Arbitrary<Make> = fc.oneof(
		{ arbitrary: message.map((id): Make => (question) => ok({ type: 'sent', sent: { ...sentFor(question), message: id } })), weight: 2 },
		{
			arbitrary: fc.record({ button: fc.nat(3), id: fc.constantFrom('t1', 't2', 't3', 't4', 't5', 't6'), message, user, inaccessible: fc.boolean(), ref: mostly(REF, 'other') }).map((options): Make => () => ok(input(tap(options)))),
			weight: 6,
		},
		{
			arbitrary: fc
				.record({ id: fc.constantFrom(700, 701, 702, 703), replyTo: message, text: mostly<string | null>('yes', null), user, markupRef: fc.constantFrom(REF, null) })
				.map((options): Make => () => ok(input(reply(options)))),
			weight: 6,
		},
		{
			arbitrary: fc
				.record({ index: fc.nat(3), id: fc.constantFrom('v1', 'v2', 'v3', 'v4').map((id) => id.padEnd(22, '0')), user })
				.map(({ index, id, user }): Make => () => ok({ type: 'choice', id, user: { id: user }, index, at: NOW })),
			weight: 6,
		},
		{ arbitrary: fc.constantFrom(...bodies).map((body): Make => () => ok({ type: 'edit', body })), weight: 1 },
		{ arbitrary: fc.boolean().map((withBody): Make => (question) => ok(withBody ? { type: 'close', body: bodyLike(question.spec.body, 'Done.') } : { type: 'close' })), weight: 1 },
		{ arbitrary: fc.record({ ahead: fc.nat(2), outcome: fc.constantFrom(...outcomes) }).map(({ ahead, outcome }): Make => (question) => ok({ type: 'shown', want: Math.max(0, question.shown.want - ahead), outcome })), weight: 2 },
		{
			arbitrary: fc.record({ back: fc.nat(1), error: fc.option(fc.constant('exit 1'), { nil: undefined }) }).map(({ back, error }): Make => (question) => ok({ type: 'delivered', seq: Math.max(0, question.seq - back), ...(error ? { error } : {}) })),
			weight: 2,
		},
		// The same ask again, as a caller that repeats a send does.
		{ arbitrary: fc.constant((_: Question, ask: QuestionEvent): Made => ok(ask)), weight: 1 },
		// Values at the boundary that the types let through and a question may not store.
		{
			arbitrary: fc
				.constantFrom<Make>(
					(question) => ({ event: { type: 'shown', want: question.shown.want - 0.5, outcome: { kind: 'ok', result: true } }, valid: false }),
					() => ({ event: { type: 'shown', want: -1, outcome: { kind: 'unchanged' } }, valid: false }),
					() => ({ event: { type: 'shown', want: 0, outcome: { kind: 'retry', at: 1.5 } }, valid: false }),
					(question) => ({ event: { type: 'delivered', seq: question.seq + 0.5 }, valid: false }),
					() => ({ event: { type: 'delivered', seq: Number.NaN }, valid: false }),
					(question) => ({ event: { type: 'sent', sent: { ...sentFor(question), files: [0.5] } }, valid: false }),
					(_, ask) => ({ event: { ...ask, type: 'ask', meta: Number.POSITIVE_INFINITY } as QuestionEvent, valid: false }),
					(_, ask) => ({ event: { ...ask, type: 'ask', expiresAt: -1 } as QuestionEvent, valid: false }),
					() => ({ event: { type: 'edit', body: { blocks: [{ type: 'paragraph', text: 5 as unknown as string }] } }, valid: false }),
					() => ({ event: { type: 'delivered', seq: 0 }, valid: false, now: NOW + 0.5 }),
					() => ({ event: { type: 'choice', id: 'short', user: { id: USER }, index: 0, at: NOW }, valid: false }),
				),
			weight: 1,
		},
	);
	const labelSets: Labels[] = [
		defaultLabels,
		mergeLabels({ expired: '</details> ```', question: '</summary><b>Q</b>' }),
		mergeLabels({ expired: 'x'.repeat(200), question: '`' }),
	];

	test('over random sequences of events, labels and clock steps', () => {
		fc.assert(
			fc.property(
				fc.constantFrom(...specs),
				fc.constantFrom(undefined, NOW, NOW + 300_000),
				fc.constantFrom(...labelSets),
				fc.array(fc.tuple(event, fc.nat(40_000)), { maxLength: 40 }),
				(spec, expiresAt, labels, events) => {
					const ask: QuestionEvent = { type: 'ask', spec, ref: REF, chat: CHAT, allow: [USER], ...(spec.view !== undefined ? { viewOrigin: ORIGIN } : {}), ...(expiresAt !== undefined ? { expiresAt } : {}) };
					let now = NOW;
					const first = reduce(undefined, ask, { now, labels }).question;
					if (!first) throw new Error('ask left no question');
					let question: Question = first;
					expect(parseQuestion(structuredClone(question))).toEqual(question);
					for (const [make, elapsed] of events) {
						now += elapsed;
						const made = make(question, ask);
						const at = made.now ?? now;
						if (!made.valid) {
							expect(() => reduce(question, made.event, { now: at, labels })).toThrow(ShapeError);
							continue;
						}
						const next: Question | undefined = reduce(question, made.event, { now: at, labels }).question;
						if (!next) throw new Error('reduce lost the question');
						question = next;
						// What a store holds: the JSON text. It reads back equal, and it parses to the same question.
						const json: unknown = JSON.parse(JSON.stringify(question));
						expect(json).toStrictEqual(question);
						expect(parseQuestion(json)).toStrictEqual(question);
					}
				},
			),
			{ numRuns: 300 },
		);
		// About 0.05 s on an idle machine (2026-11-18). A loaded review machine ran 1,000 runs in
		// 140 s, so 300 runs and this limit leave room for one 1,000 times slower than idle.
	}, 120_000);
});
