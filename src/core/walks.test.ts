// The 5 walks of section 14 of the plan, as projections of what `render`, `renderEdit`,
// `reduce` and `classify` return. No network: the answers of the server are the records in
// facts/records/ or plain response values.
import { expect, test } from 'bun:test';
import { asked, CHAT, input, MESSAGE, NOW, ORIGIN, REF, responses, sentFor, step, tap, VIEW } from '../fixtures.ts';
import { choice, message } from './builders.ts';
import { classify } from './classify.ts';
import { parseQuestion } from './parse.ts';
import { reduce } from './reduce.ts';
import { render, renderEdit } from './render.ts';
import { defaultLabels, type Question } from './types.ts';

test('walk 1: a status line edited 5 times', () => {
	const { steps } = render(message({ markdown: 'Step 0 of 5' }), { chat: CHAT });
	expect(steps.map((step) => step.call.method)).toEqual(['sendRichMessage']);
	const result = classify('sendRichMessage', responses.send);
	if (result.kind !== 'ok' || typeof result.result !== 'object' || result.result === null || !('message_id' in result.result)) throw new Error('no message');
	const sent = { chat: CHAT, message: Number(result.result.message_id), files: [] };
	const edits = [1, 2, 3, 4, 5].map((n) => renderEdit({ sent, body: { markdown: `Step ${n} of 5` } }));
	expect(edits).toEqual(
		[1, 2, 3, 4, 5].map((n) => ({ method: 'editMessageText', payload: { chat_id: CHAT, message_id: MESSAGE, rich_message: { markdown: `Step ${n} of 5` } } })),
	);
	// The same body again: the server answers 400 "message is not modified", which counts as done.
	expect(classify('editMessageText', responses.notModified)).toEqual({ kind: 'unchanged' });
});

test('walk 2: a question with 3 options and a view opens on the picked tab', () => {
	const spec = choice({ markdown: 'Which branch first?' }, [{ label: 'feat/views', tab: 'Views' }, { label: 'fix/lock', tab: 'Lock' }, { label: 'Neither' }], { view: VIEW });
	const { steps } = render(spec, { chat: CHAT, ref: REF, viewOrigin: ORIGIN });
	expect(steps[0]?.call.payload.reply_markup).toEqual({
		inline_keyboard: [
			[{ text: 'feat/views', callback_data: `q:${REF}:0` }],
			[{ text: 'fix/lock', callback_data: `q:${REF}:1` }],
			[{ text: 'Neither', callback_data: `q:${REF}:2` }],
			[{ text: defaultLabels.view, web_app: { url: `${ORIGIN}/?v=${VIEW}&q=${REF}` } }],
		],
	});
	let question = asked(spec);
	question = step(question, { type: 'sent', sent: sentFor(question) });
	const tapped = reduce(question, input(tap({ button: 1 })), { now: NOW });
	expect(tapped.handled).toMatchObject({ kind: 'answered', answer: { kind: 'choice', index: 1, label: 'fix/lock' } });
	if (!tapped.question) throw new Error('no question');
	expect(renderEdit(tapped.question).payload.reply_markup).toEqual({
		inline_keyboard: [
			[{ text: 'feat/views', callback_data: `q:${REF}:0` }],
			[{ text: '✓ fix/lock', callback_data: `q:${REF}:1` }],
			[{ text: 'Neither', callback_data: `q:${REF}:2` }],
			[{ text: defaultLabels.view, web_app: { url: `${ORIGIN}/?v=${VIEW}&q=${REF}&t=Lock` } }],
		],
	});
});

test('walk 3: a send that stays uncertain, then a close', () => {
	let question: Question = asked(choice({ markdown: 'Deploy now?' }, [{ label: 'Deploy' }, { label: 'Wait' }]));
	// The body's call got no answer: the question stays sending.
	expect(classify('sendRichMessage', { noAnswer: true })).toEqual({ kind: 'uncertain' });
	expect(classify('sendRichMessage', { ok: false, status: 502, description: 'Bad Gateway' })).toEqual({ kind: 'uncertain' });
	question = step(question, { type: 'close', body: { markdown: 'Deployed from the terminal.' } });
	expect(question).toMatchObject({ status: 'closed', resolved: { markdown: 'Deployed from the terminal.' } });
	expect('sent' in question).toBe(false);
	expect(() => renderEdit(question)).toThrow();
	// The first tap on the message that did arrive reveals it: the tap is stale and the edit is owed.
	const late = reduce(question, input(tap({ button: 0, message: 641, inaccessible: true })), { now: NOW });
	expect(late.handled).toEqual({ kind: 'stale', reason: 'closed' });
	if (!late.question) throw new Error('no question');
	expect(late.question.shown.want).toBeGreaterThan(late.question.shown.done);
	expect(renderEdit(late.question)).toEqual({
		method: 'editMessageText',
		payload: {
			chat_id: CHAT,
			message_id: 641,
			rich_message: { markdown: `Deployed from the terminal.\n\n<details><summary>${defaultLabels.question}</summary>\n\nDeploy now?\n\n</details>` },
		},
	});
	expect(parseQuestion(late.question)).toEqual(late.question);
});

test('walk 4: an album of 3 under a body of 1,500 characters', () => {
	const body = `${'The run changed 3 screens. '.repeat(60).slice(0, 1_499)}?`;
	expect(body).toHaveLength(1_500);
	const spec = choice({ markdown: body }, [{ label: 'Keep' }, { label: 'Revert' }], { attach: [{ path: '/p/1.png', caption: 'before' }, { path: '/p/2.png' }, { path: '/p/3.png' }] });
	const { steps } = render(spec, { chat: CHAT, ref: REF });
	expect(steps.map((step) => [step.role, step.call.method])).toEqual([
		['body', 'sendRichMessage'],
		['files', 'sendMediaGroup'],
	]);
	// The answer buttons sit on the body, since an album carries no keyboard.
	expect(steps[0]?.call.payload.reply_markup).toBeDefined();
	expect(steps[1]?.call.payload).not.toHaveProperty('reply_markup');
	expect(steps[1]?.call.payload).not.toHaveProperty('reply_parameters');
	expect(steps[1]?.call.files?.map((file) => file.path)).toEqual(['/p/1.png', '/p/2.png', '/p/3.png']);
	// The recorded album answer: 3 messages, whose ids join the question's Sent.
	const album = classify('sendMediaGroup', responses.album);
	if (album.kind !== 'ok') throw new Error('no album');
	const ids = (album.result as { message_id: number }[]).map((message) => message.message_id);
	let question = asked(spec);
	question = step(question, { type: 'sent', sent: sentFor(question) });
	question = step(question, { type: 'sent', sent: { ...sentFor(question), files: ids } });
	expect(question).toMatchObject({ status: 'open', sent: { message: MESSAGE, files: [633, 634, 635] } });
});

test('walk 5: a permission question that reaches expiresAt', () => {
	const spec = choice(
		{ markdown: 'Run `rm -rf build/`?' },
		[
			{ label: defaultLabels.allow, value: 'allow', style: 'primary' },
			{ label: defaultLabels.deny, value: 'deny', style: 'danger' },
		],
		{ layout: 'row', once: true },
	);
	const expiresAt = NOW + 570_000;
	let question = asked(spec, { expiresAt });
	question = step(question, { type: 'sent', sent: sentFor(question) });
	expect(renderEdit(question).payload.reply_markup).toEqual({
		inline_keyboard: [
			[
				{ text: 'Allow', callback_data: `q:${REF}:0`, style: 'primary' },
				{ text: 'Deny', callback_data: `q:${REF}:1`, style: 'danger' },
			],
		],
	});
	// No tap before the deadline. Any event at expiresAt closes the question first.
	question = step(question, { type: 'delivered', seq: 0 }, expiresAt);
	expect(question).toMatchObject({ status: 'closed', resolved: { markdown: defaultLabels.expired } });
	expect(renderEdit(question).payload).toEqual({
		chat_id: CHAT,
		message_id: MESSAGE,
		rich_message: { markdown: `${defaultLabels.expired}\n\n<details><summary>${defaultLabels.question}</summary>\n\nRun \`rm -rf build/\`?\n\n</details>` },
	});
	// A tap after the deadline changes nothing: no answer is ever stored.
	const late = reduce(question, input(tap({ button: 0 })), { now: expiresAt + 1_000 });
	expect(late.handled).toEqual({ kind: 'stale', reason: 'closed' });
	expect(late.question).toEqual(question);
	expect('answer' in question).toBe(false);
});
