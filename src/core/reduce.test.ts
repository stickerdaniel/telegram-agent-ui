import { describe, expect, test } from 'bun:test';
import { asked, CHAT, input, MESSAGE, NOW, ORIGIN, plain, REF, reply, sentFor, states, step, tap, USER, VIEW } from '../fixtures.ts';
import { choice, text } from './builders.ts';
import { locate, reduce } from './reduce.ts';
import { renderEdit } from './render.ts';
import { defaultLabels, type Handled, type Question, type QuestionEvent, ShapeError, type Update } from './types.ts';

const choiceSpec = choice({ markdown: 'Which way for `fix/lock`?' }, [{ label: 'Rebase', style: 'primary' }, { label: 'Merge' }, { label: 'Close', style: 'danger' }]);
const textSpec = text({ markdown: 'What should the commit message say?' });
const STATUSES = ['sending', 'open', 'answered', 'answeredOnce', 'closed', 'closedUnsent', 'closedAnswered'] as const;

const outcome = (handled: Handled | undefined) => (handled?.kind === 'stale' ? handled.reason : handled?.kind);
type Outcome = ReturnType<typeof outcome>;
/** The same outcome in every status. */
const every = (expected: Outcome) => STATUSES.map(() => expected);
/** The keyboard texts of a question's edit, row by row. */
const buttons = (question: Question) => {
	const markup = renderEdit(question).payload.reply_markup as { inline_keyboard: { text: string }[][] } | undefined;
	return markup?.inline_keyboard.map((row) => row.map((button) => button.text)) ?? [];
};

describe('the inputs of 4.6 in every status', () => {
	// Expected Handled per input, in the order of STATUSES. Answers came from button 0 by tap `a0`, or from reply 700.
	const choiceTable: [string, Update, Outcome[]][] = [
		['a tap on button 0', tap({ button: 0, id: 'b0' }), ['answered', 'answered', 'repeat', 'repeat', 'closed', 'closed', 'closed']],
		['a tap on button 1', tap({ button: 1, id: 'b1' }), ['answered', 'answered', 'answered', 'repeat', 'closed', 'closed', 'closed']],
		['the replayed tap a0', tap({ button: 0, id: 'a0' }), ['answered', 'answered', 'repeat', 'repeat', 'closed', 'closed', 'closed']],
		['a tap that names another ref', tap({ button: 0, ref: 'other' }), every('unknown')],
		['a tap on a button that does not exist', tap({ button: 3 }), every('unknown')],
		['a tap on another message', tap({ button: 0, message: 999 }), ['answered', 'unknown', 'unknown', 'unknown', 'unknown', 'closed', 'unknown']],
		['a tap in another chat', tap({ button: 0, chat: 333 }), every('unknown')],
		['a tap by a user outside allow', tap({ button: 0, user: 999 }), every('forbidden')],
		['a text reply', reply({ id: 701, text: 'rebase it' }), every('ignored')],
		['a message that replies to nothing', plain(), every('ignored')],
	];
	const choices = states(choiceSpec);
	for (const [name, update, expected] of choiceTable) {
		test(`choice: ${name}`, () => {
			expect(STATUSES.map((status) => outcome(reduce(choices[status], input(update), { now: NOW }).handled))).toEqual(expected);
		});
	}

	// A text question has no buttons, so the replied-to message carries no keyboard.
	const textTable: [string, Update, Outcome[]][] = [
		['a new reply', reply({ id: 701, text: 'second', markupRef: null }), ['ignored', 'answered', 'answered', 'repeat', 'ignored', 'ignored', 'ignored']],
		['the replayed reply 700', reply({ id: 700, text: 'first', markupRef: null }), ['ignored', 'answered', 'repeat', 'repeat', 'ignored', 'ignored', 'ignored']],
		['a reply with a caption only', reply({ id: 701, text: null, caption: 'see photo', markupRef: null }), ['ignored', 'answered', 'answered', 'repeat', 'ignored', 'ignored', 'ignored']],
		['a reply without text', reply({ id: 701, text: null, markupRef: null }), every('ignored')],
		['a reply to another message', reply({ id: 701, replyTo: 999, markupRef: null }), every('ignored')],
		['a reply in another chat', reply({ id: 701, chat: 333, markupRef: null }), every('ignored')],
		['a reply by a user outside allow', reply({ id: 701, user: 999, markupRef: null }), ['ignored', 'forbidden', 'forbidden', 'forbidden', 'forbidden', 'ignored', 'forbidden']],
		['a tap', tap({ button: 0 }), every('unknown')],
		['a message that replies to nothing', plain(), every('ignored')],
	];
	const texts = states(textSpec);
	for (const [name, update, expected] of textTable) {
		test(`text: ${name}`, () => {
			expect(STATUSES.map((status) => outcome(reduce(texts[status], input(update), { now: NOW }).handled))).toEqual(expected);
		});
	}

	test('a tap whose ref the store lacks is stale: unknown with its toast', () => {
		const result = reduce(undefined, input(tap({ button: 0 })), { now: NOW });
		expect(result).toEqual({ calls: [{ method: 'answerCallbackQuery', payload: { callback_query_id: '4333899942195903754', text: defaultLabels.unknown } }], handled: { kind: 'stale', reason: 'unknown' } });
		expect(reduce(undefined, input(reply()), { now: NOW })).toEqual({ calls: [], handled: { kind: 'ignored' } });
	});

	test('the first failing check wins: unknown, forbidden, closed, repeat', () => {
		const { closed, answered } = choices;
		expect(outcome(reduce(closed, input(tap({ button: 0, ref: 'other', user: 999 })), { now: NOW }).handled)).toBe('unknown');
		expect(outcome(reduce(closed, input(tap({ button: 0, user: 999 })), { now: NOW }).handled)).toBe('forbidden');
		expect(outcome(reduce(step(answered, { type: 'close' }), input(tap({ button: 0, id: 'a0' })), { now: NOW }).handled)).toBe('closed');
	});
});

describe('the effects of 4.6', () => {
	const toast = (text: string, id = '4333899942195903754') => ({ method: 'answerCallbackQuery', payload: { callback_query_id: id, text } });

	test('a tap on an open question answers it, toasts the label and owes the mark', () => {
		const { open } = states(choiceSpec);
		const result = reduce(open, input(tap({ button: 1 })), { now: NOW + 5 });
		expect(result.handled).toEqual({ kind: 'answered', ref: REF, seq: 1, answer: { kind: 'choice', index: 1, label: 'Merge' }, by: { id: USER, name: 'x' }, at: NOW + 5 });
		expect(result.calls).toEqual([toast('✓ Merge')]);
		const question = result.question;
		if (!question) throw new Error('no question');
		expect(question.shown.want).toBe(open.shown.want + 1);
		expect(buttons(question)).toEqual([['Rebase'], ['✓ Merge'], ['Close']]);
	});

	test('a tap on another button moves the mark and keeps the old answer as previous', () => {
		const { answered } = states(choiceSpec);
		const result = reduce(answered, input(tap({ button: 2, id: 'b2' })), { now: NOW });
		expect(result.handled).toMatchObject({ kind: 'answered', seq: 2, answer: { index: 2, label: 'Close' }, previous: { kind: 'choice', index: 0, label: 'Rebase' } });
		if (!result.question) throw new Error('no question');
		expect(buttons(result.question)).toEqual([['Rebase'], ['Merge'], ['✓ Close']]);
		expect(result.question.shown.want).toBe(answered.shown.want + 1);
	});

	test('a repeated or forbidden correction toasts and changes nothing', () => {
		const { answered, answeredOnce } = states(choiceSpec);
		const same = reduce(answered, input(tap({ button: 0, id: 'b0' })), { now: NOW });
		expect(same).toEqual({ question: answered, calls: [toast(defaultLabels.repeat, 'b0')], handled: { kind: 'stale', reason: 'repeat' } });
		const once = reduce(answeredOnce, input(tap({ button: 1, id: 'b1' })), { now: NOW });
		expect(once).toEqual({ question: answeredOnce, calls: [toast(defaultLabels.repeat, 'b1')], handled: { kind: 'stale', reason: 'repeat' } });
	});

	test('a tap on a closed question toasts, and the first on one without a message stores it', () => {
		const { closed, closedUnsent } = states(choiceSpec);
		expect(reduce(closed, input(tap({ button: 1 })), { now: NOW })).toEqual({ question: closed, calls: [toast(defaultLabels.closed)], handled: { kind: 'stale', reason: 'closed' } });
		const result = reduce(closedUnsent, input(tap({ button: 1, message: 640, inaccessible: true })), { now: NOW });
		expect(result.handled).toEqual({ kind: 'stale', reason: 'closed' });
		expect(result.question).toMatchObject({ status: 'closed', sent: { chat: CHAT, message: 640, files: [], ref: REF }, shown: { want: closedUnsent.shown.want + 1 } });
		if (!result.question) throw new Error('no question');
		expect(buttons(result.question)).toEqual([]);
	});

	test('unknown and forbidden taps toast their labels and change nothing', () => {
		const { open } = states(choiceSpec);
		expect(reduce(open, input(tap({ button: 0, message: 999 })), { now: NOW })).toEqual({ question: open, calls: [toast(defaultLabels.unknown)], handled: { kind: 'stale', reason: 'unknown' } });
		expect(reduce(open, input(tap({ button: 0, user: 999 })), { now: NOW })).toEqual({ question: open, calls: [toast(defaultLabels.forbidden)], handled: { kind: 'stale', reason: 'forbidden' } });
	});

	test('a reply answers a text question, reacts with labels.ack and corrects with previous', () => {
		const { open } = states(textSpec);
		const first = reduce(open, input(reply({ id: 700, text: 'first', markupRef: null })), { now: NOW });
		expect(first.handled).toMatchObject({ kind: 'answered', seq: 1, answer: { kind: 'text', text: 'first' } });
		expect(first.calls).toEqual([{ method: 'setMessageReaction', payload: { chat_id: CHAT, message_id: 700, reaction: [{ type: 'emoji', emoji: defaultLabels.ack }] } }]);
		const second = reduce(first.question, input(reply({ id: 701, text: 'second', markupRef: null })), { now: NOW });
		expect(second.handled).toMatchObject({ kind: 'answered', seq: 2, answer: { kind: 'text', text: 'second' }, previous: { kind: 'text', text: 'first' } });
	});

	test('ignored and repeated replies make no call', () => {
		const { answeredOnce } = states(textSpec);
		expect(reduce(answeredOnce, input(reply({ id: 701, text: 'again', markupRef: null })), { now: NOW })).toEqual({ question: answeredOnce, calls: [], handled: { kind: 'stale', reason: 'repeat' } });
		const { open } = states(choiceSpec);
		expect(reduce(open, input(reply({ id: 701, text: 'rebase it' })), { now: NOW })).toEqual({ question: open, calls: [], handled: { kind: 'ignored' } });
	});

	test('meta returns with the answer', () => {
		const question = asked(choiceSpec, { meta: { session: 's1', turn: 3 } });
		const answered = reduce(step(question, { type: 'sent', sent: sentFor(question) }), input(tap({ button: 0 })), { now: NOW });
		expect(answered.handled).toMatchObject({ kind: 'answered', meta: { session: 's1', turn: 3 } });
	});
});

describe('replays', () => {
	test('a replay of every applied input is stale: repeat with no call', () => {
		const taps = states(choiceSpec).answered;
		expect(reduce(taps, input(tap({ button: 0, id: 'a0' })), { now: NOW })).toEqual({ question: taps, calls: [], handled: { kind: 'stale', reason: 'repeat' } });
		const corrected = step(taps, input(tap({ button: 1, id: 'b1' })));
		expect(reduce(corrected, input(tap({ button: 1, id: 'b1' })), { now: NOW })).toEqual({ question: corrected, calls: [], handled: { kind: 'stale', reason: 'repeat' } });
		const replies = states(textSpec).answered;
		expect(reduce(replies, input(reply({ id: 700, text: 'first', markupRef: null })), { now: NOW })).toEqual({ question: replies, calls: [], handled: { kind: 'stale', reason: 'repeat' } });
	});

	test('a replay is found while its key is among the last 32 applied inputs', () => {
		let question = states(choiceSpec).answered;
		// 31 more corrections: the key a0 stays in the window of 32.
		for (let n = 1; n <= 31; n++) question = step(question, input(tap({ button: n % 2 === 1 ? 1 : 0, id: `c${n}` })));
		expect(question.applied).toHaveLength(32);
		expect(question.applied[0]).toBe('cq:a0');
		// The last correction picked button 1, so a fresh tap on 0 would answer; the replay does not.
		expect(outcome(reduce(question, input(tap({ button: 0, id: 'a0' })), { now: NOW }).handled)).toBe('repeat');
		question = step(question, input(tap({ button: 0, id: 'c32' })));
		expect(question.applied).not.toContain('cq:a0');
	});
});

describe('expiry', () => {
	const expiresAt = NOW + 60_000;
	const open = () => {
		const question = asked(choiceSpec, { expiresAt });
		return step(question, { type: 'sent', sent: sentFor(question) });
	};

	test('an input before expiresAt answers', () => {
		expect(outcome(reduce(open(), input(tap({ button: 0 })), { now: expiresAt - 1 }).handled)).toBe('answered');
	});

	for (const [name, now] of [
		['at', expiresAt],
		['past', expiresAt + 1],
	] as const) {
		test(`a tap ${name} expiresAt is stale: closed, and the question closes with labels.expired`, () => {
			const result = reduce(open(), input(tap({ button: 0 })), { now });
			expect(result.handled).toEqual({ kind: 'stale', reason: 'closed' });
			expect(result.calls).toEqual([{ method: 'answerCallbackQuery', payload: { callback_query_id: '4333899942195903754', text: defaultLabels.closed } }]);
			expect(result.question).toMatchObject({ status: 'closed', resolved: { markdown: defaultLabels.expired } });
		});
	}

	test('a text reply past expiresAt is ignored', () => {
		const question = asked(textSpec, { expiresAt });
		const sent = step(question, { type: 'sent', sent: sentFor(question) });
		expect(outcome(reduce(sent, input(reply({ text: 'late', markupRef: null })), { now: expiresAt }).handled)).toBe('ignored');
	});
});

describe('a question whose message is unknown', () => {
	const withView = choice({ markdown: 'Which diff?' }, [{ label: 'Small', tab: 'Small' }, { label: 'Large', tab: 'Large' }], { view: VIEW });

	test('a tap with an InaccessibleMessage gives a sending question its Sent and the full keyboard with the view row', () => {
		const question = asked(withView);
		const result = reduce(question, input(tap({ button: 1, message: 640, inaccessible: true })), { now: NOW });
		expect(result.handled).toMatchObject({ kind: 'answered', answer: { index: 1 } });
		if (!result.question || result.question.status !== 'answered') throw new Error('not answered');
		expect(result.question.sent).toEqual({ chat: CHAT, message: 640, files: [], ref: REF, view: { id: VIEW, origin: ORIGIN } });
		expect(renderEdit(result.question).payload).toEqual({
			chat_id: CHAT,
			message_id: 640,
			rich_message: { markdown: 'Which diff?' },
			reply_markup: {
				inline_keyboard: [
					[{ text: 'Small', callback_data: `q:${REF}:0` }],
					[{ text: '✓ Large', callback_data: `q:${REF}:1` }],
					[{ text: defaultLabels.view, web_app: { url: `${ORIGIN}/?v=${VIEW}&q=${REF}&t=Large` } }],
				],
			},
		});
	});

	test('the recorded reply is located by the ref in its replied-to markup', () => {
		expect(locate(reply())).toEqual({ chat: CHAT, replyTo: MESSAGE, ref: REF });
		expect(locate(reply({ markupRef: null }))).toEqual({ chat: CHAT, replyTo: MESSAGE });
		expect(locate(tap({ button: 1 }))).toEqual({ ref: REF, button: 1, message: MESSAGE });
		expect(locate(plain())).toBeUndefined();
	});

	test('a reply found by that ref gives a sending choice question its Sent and answers nothing', () => {
		const result = reduce(asked(choiceSpec), input(reply({ text: 'rebase' })), { now: NOW });
		expect(result.handled).toEqual({ kind: 'ignored' });
		expect(result.question).toMatchObject({ status: 'open', sent: { chat: CHAT, message: MESSAGE, ref: REF } });
	});

	test('a reply to a sending text question names no ref, so it stays sending', () => {
		// A text question has no answer buttons, so the replied-to message carries no callback data.
		const question = asked(textSpec);
		expect(reduce(question, input(reply({ text: 'ship it', markupRef: null })), { now: NOW })).toEqual({ question, calls: [], handled: { kind: 'ignored' } });
	});
});

describe('edit, close, shown and delivered', () => {
	test('an edit changes the body, keeps the answer and owes an edit; a closed question ignores it', () => {
		const { answered, closed } = states(choiceSpec);
		const edited = step(answered, { type: 'edit', body: { markdown: 'Which way now?' } });
		expect(edited).toMatchObject({ status: 'answered', spec: { body: { markdown: 'Which way now?' } }, shown: { want: answered.shown.want + 1 } });
		expect(buttons(edited)).toEqual([['✓ Rebase'], ['Merge'], ['Close']]);
		expect(step(closed, { type: 'edit', body: { markdown: 'x?' } })).toEqual(closed);
	});

	test('a close keeps the answer, and a second close replaces the resolved body', () => {
		const { answered } = states(choiceSpec);
		const first = step(answered, { type: 'close', body: { markdown: 'Rebased.' } });
		expect(first).toMatchObject({ status: 'closed', answer: { index: 0 }, resolved: { markdown: 'Rebased.' } });
		const second = step(first, { type: 'close', body: { markdown: 'Rebased and pushed.' } });
		expect(second).toMatchObject({ resolved: { markdown: 'Rebased and pushed.' }, shown: { want: first.shown.want + 1 } });
		expect(renderEdit(second).payload.rich_message).toEqual({ markdown: `Rebased and pushed.\n\n<details><summary>${defaultLabels.question}</summary>\n\nWhich way for \`fix/lock\`?\n\n</details>` });
		expect(renderEdit(second).payload.reply_markup).toBeUndefined();
	});

	test('a closed question without a resolved body keeps only its marked button, and a tap on it is stale: closed', () => {
		const { closedAnswered } = states(choiceSpec);
		expect(buttons(closedAnswered)).toEqual([['✓ Rebase']]);
		const markup = renderEdit(closedAnswered).payload.reply_markup as { inline_keyboard: { callback_data: string }[][] };
		const data = markup.inline_keyboard[0]?.[0]?.callback_data;
		expect(data).toBe(`q:${REF}:0`);
		// A fresh tap on the remaining button, by the user who answered.
		const result = reduce(closedAnswered, input(tap({ button: 0, id: 'after-close' })), { now: NOW });
		expect(result).toEqual({
			question: closedAnswered,
			calls: [{ method: 'answerCallbackQuery', payload: { callback_query_id: 'after-close', text: defaultLabels.closed } }],
			handled: { kind: 'stale', reason: 'closed' },
		});
	});

	test('a closed question with a view keeps its marked button above the view row', () => {
		const spec = choice({ markdown: 'Which diff?' }, [{ label: 'Small', tab: 'Small' }, { label: 'Large', tab: 'Large' }], { view: VIEW });
		const open = step(asked(spec), { type: 'sent', sent: sentFor(asked(spec)) });
		const closed = step(step(open, input(tap({ button: 1 }))), { type: 'close' });
		expect(renderEdit(closed).payload.reply_markup).toEqual({
			inline_keyboard: [[{ text: '✓ Large', callback_data: `q:${REF}:1` }], [{ text: defaultLabels.view, web_app: { url: `${ORIGIN}/?v=${VIEW}&q=${REF}&t=Large` } }]],
		});
		expect(outcome(reduce(closed, input(tap({ button: 1, id: 'later' })), { now: NOW }).handled)).toBe('closed');
	});

	test('shown applies the outcome of an edit to the want it was sent for', () => {
		const { answered } = states(choiceSpec);
		const want = answered.shown.want;
		expect(step(answered, { type: 'shown', want, outcome: { kind: 'ok', result: true } }).shown).toEqual({ want, done: want, failures: 0 });
		expect(step(answered, { type: 'shown', want, outcome: { kind: 'unchanged' } }).shown).toEqual({ want, done: want, failures: 0 });
		expect(step(answered, { type: 'shown', want, outcome: { kind: 'refused', code: 'server', reason: 'Bad Request' } }).shown).toEqual({ want, done: want, failures: 0, error: 'Bad Request' });
		expect(step(answered, { type: 'shown', want, outcome: { kind: 'refused', code: 'token', reason: 'Unauthorized' } })).toEqual(answered);
		expect(step(answered, { type: 'shown', want, outcome: { kind: 'retry', at: NOW + 3000 } }).shown).toEqual({ ...answered.shown, retryAt: NOW + 3000 });
		let uncertain = answered;
		for (let n = 1; n < 10; n++) uncertain = step(uncertain, { type: 'shown', want, outcome: { kind: 'uncertain' } });
		expect(uncertain.shown).toEqual({ want, done: answered.shown.done, failures: 9 });
		expect(step(uncertain, { type: 'shown', want, outcome: { kind: 'uncertain' } }).shown).toEqual({ want, done: want, failures: 10, error: '10 edits got no answer' });
	});

	test('delivered moves delivery.seq and counts rejected attempts', () => {
		const { answered } = states(choiceSpec);
		const failed = step(step(answered, { type: 'delivered', seq: 1, error: 'exit 1' }), { type: 'delivered', seq: 1, error: 'exit 1' });
		expect(failed.delivery).toEqual({ seq: 0, attempts: 2, error: 'exit 1' });
		expect(step(failed, { type: 'delivered', seq: 1 }).delivery).toEqual({ seq: 1, attempts: 0 });
		// A new answer starts the attempts again.
		expect(step(failed, input(tap({ button: 1, id: 'b1' }))).delivery).toEqual({ seq: 0, attempts: 0 });
	});

	test('sent adds the file ids of a known message', () => {
		const { open } = states(choiceSpec);
		const withFiles = step(open, { type: 'sent', sent: { ...sentFor(open), files: [633, 634, 635] } });
		expect(withFiles).toMatchObject({ status: 'open', sent: { files: [633, 634, 635] } });
		expect(() => step(open, { type: 'sent', sent: { ...sentFor(open), chat: 333 } })).toThrow();
	});
});

describe('the boundary of reduce', () => {
	const spec = text({ markdown: 'Proceed?' });
	type Ask = Extract<QuestionEvent, { type: 'ask' }>;
	const ask = (extra: Partial<Ask> = {}): Ask => ({ type: 'ask', spec, ref: 'r', chat: CHAT, allow: [USER], ...extra });

	test('values that break the stored types throw ShapeError instead of returning a question', () => {
		const open = states(choiceSpec).open;
		const edited = step(open, { type: 'edit', body: { markdown: 'Which way now?' } });
		const refusals: [string, Question | undefined, QuestionEvent, number][] = [
			['an ask with a negative expiresAt', undefined, ask({ expiresAt: -1 }), NOW],
			['an ask at a fractional now', undefined, ask(), 0.5],
			['an ask with meta NaN', undefined, ask({ meta: Number.NaN }), NOW],
			['an ask with meta that is a Date', undefined, { ...ask(), meta: new Date(0) as unknown as null }, NOW],
			['an ask with a fractional chat', undefined, ask({ chat: 1.5 }), NOW],
			['a sent with a fractional file id', open, { type: 'sent', sent: { ...sentFor(open), files: [0.5] } }, NOW],
			['a sent with message 0', open, { type: 'sent', sent: { ...sentFor(open), message: 0 } }, NOW],
			['a shown with a fractional want', edited, { type: 'shown', want: 0.5, outcome: { kind: 'ok', result: true } }, NOW],
			['a shown with a negative retry time', edited, { type: 'shown', want: 1, outcome: { kind: 'retry', at: -5 } }, NOW],
			['a delivered with a negative seq', open, { type: 'delivered', seq: -1 }, NOW],
			['an edit with a malformed block', open, { type: 'edit', body: { blocks: [{ type: 'paragraph', text: 123 as unknown as string }] } }, NOW],
			['a tap with a fractional message id', open, input(tap({ button: 0, message: 1.5, inaccessible: true })), NOW],
			['a reply with a text that is no string', states(textSpec).open, input(reply({ text: 7 as unknown as string, markupRef: null })), NOW],
		];
		for (const [name, question, event, now] of refusals) expect(() => reduce(question, event, { now }), name).toThrow(ShapeError);
	});

	test('an older successful delivery moves the mark and keeps the attempts of the newest answer', () => {
		let question = step(states(choiceSpec).answered, input(tap({ button: 1, id: 'b1' })));
		for (let n = 0; n < 5; n++) question = step(question, { type: 'delivered', seq: 2, error: 'failed' });
		expect(question.delivery).toEqual({ seq: 0, attempts: 5, error: 'failed' });
		const old = step(question, { type: 'delivered', seq: 1 });
		expect(old.delivery).toEqual({ seq: 1, attempts: 5, error: 'failed' });
		expect(step(old, { type: 'delivered', seq: 2 }).delivery).toEqual({ seq: 2, attempts: 0 });
	});

	test('an ask observes expiry like every other event', () => {
		const first = reduce(undefined, ask({ expiresAt: 100 }), { now: 99 }).question;
		expect(first?.status).toBe('sending');
		expect(reduce(first, ask({ expiresAt: 100 }), { now: 100 }).question).toMatchObject({ status: 'closed', resolved: { markdown: defaultLabels.expired } });
		expect(reduce(undefined, ask({ expiresAt: 100 }), { now: 100 }).question).toMatchObject({ status: 'closed', createdAt: 100, resolved: { markdown: defaultLabels.expired } });
	});
});
