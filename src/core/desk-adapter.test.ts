import { describe, expect, test } from 'bun:test';
import { type DeskRecord, deskEvents, deskOutcome, deskRecords, type Driven } from '../desk-adapter.ts';
import { ORIGIN } from '../fixtures.ts';
import { parseQuestion } from './parse.ts';
import { reduce } from './reduce.ts';
import { renderEdit } from './render.ts';
import { type Handled, type Question, ShapeError } from './types.ts';

function lifecycle(msg: number): DeskRecord[] {
	const messages = new Set(deskRecords.flatMap((record) => (record.type === 'msg_part_delivered' && record.msg === msg ? [record.messageId] : [])));
	const taps = new Set(deskRecords.flatMap((record) => (record.type === 'update_received' && record.kind === 'callback_query' && messages.has(record.callback.messageId ?? 0) ? [record.updateId] : [])));
	return deskRecords.filter((record) => {
		switch (record.type) {
			case 'msg_pending':
			case 'msg_part_delivered':
			case 'msg_failed':
				return record.msg === msg;
			case 'msg_edited':
				return messages.has(record.messageId);
			case 'update_received':
				return record.kind === 'callback_query' ? taps.has(record.updateId) : messages.has(record.envelope.reply_to?.message_id ?? 0);
			case 'choice_received':
			case 'callback_decided':
				return taps.has(record.updateId);
		}
	});
}

const outcome = (handled: Handled | undefined) => (handled?.kind === 'stale' ? handled.reason : handled?.kind);

function drive(ledger: DeskRecord[]) {
	const questions = new Map<string, Question>();
	const steps = deskEvents(ledger).map((driven: Driven) => {
		const result = reduce(questions.get(driven.ref), driven.event, { now: driven.now });
		if (result.question) {
			expect(parseQuestion(JSON.parse(JSON.stringify(result.question)))).toEqual(result.question);
			questions.set(driven.ref, result.question);
		}
		return { ...driven, ...result };
	});
	const taps = steps.filter((step) => step.record.type === 'update_received' && step.record.kind === 'callback_query');
	return { questions, steps, taps };
}

const updateOf = (record: DeskRecord) => (record.type === 'update_received' ? record.updateId : 0);
const only = (questions: Map<string, Question>) => {
	const [question] = [...questions.values()];
	if (!question || questions.size !== 1) throw new Error(`expected one question, got ${questions.size}`);
	return question;
};

describe('the desk lifecycle through reduce', () => {
	test('send, tap, reply and 3 resolves of a choice with a view (desk msg 1382)', () => {
		const ledger = lifecycle(1382);
		const { questions, steps, taps } = drive(ledger);
		expect(steps.map((step) => step.event.type)).toEqual(['ask', 'sent', 'input', 'close', 'input', 'close', 'close']);
		expect(taps.map((step) => [outcome(step.handled), deskOutcome(ledger, updateOf(step.record))])).toEqual([['answered', 'answered']]);
		const decided = ledger.find((record) => record.type === 'callback_decided');
		expect(taps[0]?.calls).toEqual([{ method: 'answerCallbackQuery', payload: { callback_query_id: '4333899945803487409', text: decided?.type === 'callback_decided' ? decided.toast : '' } }]);
		expect(outcome(steps[4]?.handled)).toBe('ignored');
		const question = only(questions);
		expect(question).toMatchObject({
			ref: 'eqbe',
			status: 'closed',
			seq: 1,
			answer: { kind: 'choice', index: 0, label: 'A: Gap opens' },
			resolved: { html: '<b>Decision 3 on question 1382. State: placeholder.</b>' },
			viewOrigin: ORIGIN,
		});
		expect(renderEdit(question).payload.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Open view', web_app: { url: `${ORIGIN}/?v=UIDbZdFHAVxhNRS_1nBn9w&q=eqbe` } }]] });
	});

	test('a correction and a repeat, as the desk listener decides them today (desk msg 1382 with 2 more taps)', () => {
		const ledger = lifecycle(1382);
		const firstTap = ledger.findIndex((record) => record.type === 'update_received' && record.kind === 'callback_query');
		const tapRecord = ledger[firstTap];
		if (tapRecord?.type !== 'update_received' || tapRecord.kind !== 'callback_query') throw new Error('no tap');
		const again = (updateId: number, id: string): DeskRecord => ({ ...tapRecord, updateId, callback: { ...tapRecord.callback, id, data: 'c:eqbe:1' } });
		const corrected: DeskRecord[] = [
			again(221266600, 'corr-1'),
			{ type: 'choice_received', updateId: 221266600, choice: { message_id: 2513, choice: 1, label: 'B: Line with plus', corrects: 'A: Gap opens' }, at: tapRecord.at },
			again(221266601, 'corr-2'),
			{ type: 'callback_decided', updateId: 221266601, action: 'refused', reason: 'answer keyboard already tapped', toast: 'Schon beantwortet: B: Line with plus', at: tapRecord.at },
		];
		const extended = [...ledger.slice(0, firstTap + 3), ...corrected, ...ledger.slice(firstTap + 3)];
		const { taps } = drive(extended);
		expect(taps.map((step) => [outcome(step.handled), deskOutcome(extended, updateOf(step.record))])).toEqual([
			['answered', 'answered'],
			['answered', 'answered'],
			['repeat', 'repeat'],
		]);
		expect(taps[1]?.handled).toMatchObject({ kind: 'answered', seq: 2, answer: { label: 'B: Line with plus' }, previous: { label: 'A: Gap opens' } });
	});

	test('repeated taps on another button (desk msg 1453): the desk of 2026-11-16 refused the correction, reduce takes it', () => {
		const ledger = lifecycle(1453);
		const { questions, taps } = drive(ledger);
		expect(taps.map((step) => deskOutcome(ledger, updateOf(step.record)))).toEqual(['answered', 'repeat', 'repeat', 'repeat']);
		expect(taps.map((step) => outcome(step.handled))).toEqual(['answered', 'answered', 'repeat', 'repeat']);
		expect(only(questions)).toMatchObject({ status: 'closed', seq: 2, answer: { index: 0, label: 'A3 for runs without context' }, previous: { index: 2, label: 'Change nothing' }, resolved: { html: 'Decision 4 on question 1453. State: placeholder.' } });
	});

	test('two replies and a resolve of a text question (desk msg 1522)', () => {
		const { questions, steps } = drive(lifecycle(1522));
		expect(steps.map((step) => [step.event.type, outcome(step.handled)])).toEqual([
			['ask', undefined],
			['sent', undefined],
			['input', 'answered'],
			['input', 'answered'],
			['close', undefined],
		]);
		expect(steps[2]?.calls).toEqual([{ method: 'setMessageReaction', payload: { chat_id: 111, message_id: 2772, reaction: [{ type: 'emoji', emoji: '👍' }] } }]);
		expect(only(questions)).toMatchObject({ ref: 'm1522', status: 'closed', seq: 2, answer: { kind: 'text', text: 'Reply placeholder 2774' }, previous: { kind: 'text', text: 'Reply placeholder 2772' } });
	});

	test('an edited reply, and replays after a move of the bot (desk msg 1328)', () => {
		const { questions, steps } = drive(lifecycle(1328));
		const inputs = steps.filter((step) => step.event.type === 'input');
		expect(inputs.map((step) => [updateOf(step.record), outcome(step.handled)])).toEqual([
			[275634110, 'answered'],
			[275634111, 'ignored'],
			[221266488, 'ignored'],
			[221266489, 'ignored'],
		]);
		expect(only(questions)).toMatchObject({ status: 'closed', seq: 1, answer: { kind: 'text', text: 'Reply placeholder 2415' }, resolved: { html: '<b>Decision 1 on question 1328. State: placeholder.</b>' } });
	});

	test('a desk keyboard with 1 answer button breaks the shape check of 2 to 8 options (desk msg 1038)', () => {
		const [ask] = deskEvents(lifecycle(1038));
		if (!ask) throw new Error('no ask');
		expect(ask.event).toMatchObject({ type: 'ask', ref: '31lx', spec: { answer: { type: 'choice', options: [{ label: 'Send' }] } } });
		expect(() => reduce(undefined, ask.event, { now: ask.now })).toThrow(ShapeError);
	});
});
