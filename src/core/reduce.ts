import type { CallbackQuery, InlineKeyboardMarkup, Message, Update } from '@grammyjs/types';
import { arrayOf, isInt, isNat, isRecord, isString, optional, storable } from './check.ts';
import { isBody, isCallClass, isSent, isSpec, isUser } from './guards.ts';
import { checkLabels } from './labels.ts';
import { bodyLike, inView } from './render.ts';
import { CHOICE_ID, checkQuestionBody, checkSpec, metaIssue, sameForm } from './shape.ts';
import { type Answer, type Body, type Call, type CallClass, defaultLabels, type Handled, type Labels, type Question, type QuestionEvent, type Sent, ShapeError, type User } from './types.ts';

export const APPLIED_WINDOW = 32;
export const EDIT_FAILURES = 10;
export const RECHECK_DELAY = 60_000;

const DATA = /^q:([A-Za-z0-9_-]{1,32}):(\d{1,2})$/;

function parseData(data: string | undefined): { ref: string; button: number } | undefined {
	const match = data === undefined ? null : DATA.exec(data);
	return match?.[1] !== undefined && match[2] !== undefined ? { ref: match[1], button: Number(match[2]) } : undefined;
}

function refOf(markup: InlineKeyboardMarkup | undefined): string | undefined {
	for (const button of markup?.inline_keyboard.flat() ?? []) {
		const parsed = 'callback_data' in button ? parseData(button.callback_data) : undefined;
		if (parsed) return parsed.ref;
	}
	return undefined;
}

export function locate(update: Update): { ref: string; button: number; message: number } | { chat: number; replyTo: number; ref?: string } | undefined {
	const callback = update.callback_query;
	if (callback) {
		const parsed = parseData(callback.data);
		return parsed && callback.message ? { ...parsed, message: callback.message.message_id } : undefined;
	}
	const reply = update.message?.reply_to_message;
	if (!update.message || !reply) return undefined;
	const ref = refOf(reply.reply_markup);
	return { chat: update.message.chat.id, replyTo: reply.message_id, ...(ref !== undefined ? { ref } : {}) };
}

type Result = { question?: Question; calls: Call[]; handled?: Handled };

const sentOf = (question: Question) => ('sent' in question ? question.sent : undefined);
const raise = (shown: Question['shown']): Question['shown'] => ({ ...shown, want: shown.want + 1 });
const remember = (applied: string[], key: string) => [...applied, key].slice(-APPLIED_WINDOW);
const userOf = (from: { id: number; first_name: string; last_name?: string }): User => ({ id: from.id, name: from.last_name ? `${from.first_name} ${from.last_name}` : from.first_name });
const viewOf = (question: Question) => (question.spec.view !== undefined && question.viewOrigin !== undefined ? { view: { id: question.spec.view, origin: question.viewOrigin } } : {});

const revealed = (question: Question, message: number): Sent => ({
	chat: question.chat,
	...(question.topic !== undefined ? { topic: question.topic } : {}),
	message,
	files: [],
	ref: question.ref,
	...viewOf(question),
});

function reveal(question: Question, message: number): Question {
	if (question.status === 'sending') return { ...question, status: 'open', sent: revealed(question, message) };
	if (question.status === 'closed' && !question.sent) return { ...question, sent: revealed(question, message), shown: raise(question.shown) };
	return question;
}

function close(question: Question, resolved: Body | undefined): Question {
	return { ...question, status: 'closed', ...(resolved ? { resolved } : {}), shown: raise(question.shown), ...(inView(question.spec.answer) ? { bindingOwed: true as const } : {}) };
}

function expire(question: Question, now: number, labels: Labels): Question {
	if (question.status === 'closed' || question.expiresAt === undefined || now < question.expiresAt) return question;
	return close(question, bodyLike(question.spec.body, labels.expired));
}

function answered(question: Extract<Question, { status: 'open' | 'answered' }>, answer: Answer, by: User, now: number, key: string): Extract<Question, { status: 'answered' }> {
	const { status, ...rest } = question;
	const previous = status === 'answered' ? question.answer : undefined;
	return {
		...rest,
		status: 'answered',
		answer,
		by,
		answeredAt: now,
		...(previous ? { previous } : {}),
		seq: question.seq + 1,
		applied: remember(question.applied, key),
		delivery: { seq: question.delivery.seq, attempts: 0 },
	};
}

function handledAnswer(question: Extract<Question, { status: 'answered' }>): Handled {
	return {
		kind: 'answered',
		ref: question.ref,
		seq: question.seq,
		answer: question.answer,
		by: question.by,
		at: question.answeredAt,
		...(question.previous ? { previous: question.previous } : {}),
		...(question.meta !== undefined ? { meta: question.meta } : {}),
	};
}

const stale = (question: Question | undefined, reason: Extract<Handled, { kind: 'stale' }>['reason'], calls: Call[]): Result => ({
	...(question ? { question } : {}),
	calls,
	handled: { kind: 'stale', reason },
});
const ignored = (question: Question | undefined): Result => ({ ...(question ? { question } : {}), calls: [], handled: { kind: 'ignored' } });
const toast = (callback: CallbackQuery, text: string): Call[] => [{ method: 'answerCallbackQuery', payload: { callback_query_id: callback.id, text } }];

function tap(question: Question, callback: CallbackQuery, now: number, labels: Labels): Result {
	const at = parseData(callback.data);
	const message = callback.message;
	const sent = sentOf(question);
	const options = question.spec.answer.type === 'choice' ? question.spec.answer.options : [];
	const option = at ? options[at.button] : undefined;
	if (!at || !message || !option || at.ref !== question.ref || message.chat.id !== question.chat || (sent && sent.message !== message.message_id)) {
		return stale(question, 'unknown', toast(callback, labels.unknown));
	}
	if (!question.allow.includes(callback.from.id)) return stale(question, 'forbidden', toast(callback, labels.forbidden));
	const current = reveal(question, message.message_id);
	if (current.status === 'closed' || current.status === 'sending') return stale(current, 'closed', toast(callback, labels.closed));
	const key = `cq:${callback.id}`;
	if (current.applied.includes(key)) return stale(current, 'repeat', []);
	if (current.status === 'answered' && (current.spec.answer.once || (current.answer.kind === 'choice' && current.answer.index === at.button))) {
		return stale(current, 'repeat', toast(callback, labels.repeat));
	}
	const answer: Answer = { kind: 'choice', index: at.button, label: option.label, ...(option.value !== undefined ? { value: option.value } : {}) };
	const next = { ...answered(current, answer, userOf(callback.from), now, key), shown: raise(current.shown) };
	return { question: next, calls: toast(callback, `✓ ${option.label}`), handled: handledAnswer(next) };
}

function reply(question: Question, message: Message, now: number, labels: Labels): Result {
	const replyTo = message.reply_to_message;
	const sent = sentOf(question);
	if (!replyTo || message.chat.id !== question.chat || (sent ? sent.message !== replyTo.message_id : refOf(replyTo.reply_markup) !== question.ref)) return ignored(question);
	if (!message.from || !question.allow.includes(message.from.id)) return stale(question, 'forbidden', []);
	const current = reveal(question, replyTo.message_id);
	const text = message.text ?? message.caption;
	const forwarded = message.forward_origin !== undefined;
	if (current.status === 'closed' || current.status === 'sending' || current.spec.answer.type !== 'text' || text === undefined || forwarded) return ignored(current);
	const key = `msg:${message.message_id}`;
	if (current.applied.includes(key) || (current.status === 'answered' && current.spec.answer.once)) return stale(current, 'repeat', []);
	const next = answered(current, { kind: 'text', text }, userOf(message.from), now, key);
	const reaction: Call = { method: 'setMessageReaction', payload: { chat_id: message.chat.id, message_id: message.message_id, reaction: [{ type: 'emoji', emoji: labels.ack }] } };
	return { question: next, calls: [reaction], handled: handledAnswer(next) };
}

function choose(question: Question, event: Extract<QuestionEvent, { type: 'choice' }>, now: number): Result {
	const { answer } = question.spec;
	const option = answer.type === 'choice' && answer.in === 'view' ? answer.options[event.index] : undefined;
	if (!option) return stale(question, 'unknown', []);
	if (!question.allow.includes(event.user.id)) return stale(question, 'forbidden', []);
	if (question.status === 'closed' || question.status === 'sending') return stale(question, 'closed', []);
	const key = `view:${event.id}`;
	if (question.applied.includes(key)) return stale(question, 'repeat', []);
	if (question.status === 'answered' && (answer.once || (question.answer.kind === 'choice' && question.answer.index === event.index))) return stale(question, 'repeat', []);
	const picked: Answer = { kind: 'choice', index: event.index, label: option.label, ...(option.value !== undefined ? { value: option.value } : {}) };
	const user: User = { id: event.user.id, ...(event.user.name !== undefined ? { name: event.user.name } : {}) };
	const next = { ...answered(question, picked, user, now, key), shown: raise(question.shown) };
	return { question: next, calls: [], handled: handledAnswer(next) };
}

function orphan(update: Update, labels: Labels): Result {
	return update.callback_query ? stale(undefined, 'unknown', toast(update.callback_query, labels.unknown)) : ignored(undefined);
}

function shown(question: Question, event: Extract<QuestionEvent, { type: 'shown' }>, now: number): Question {
	const { want, outcome } = event;
	if (want > question.shown.want) return question;
	if (want <= question.shown.done) return recheck(question, want, outcome, now);
	const { retryAt: _retryAt, error: _error, ...rest } = question.shown;
	switch (outcome.kind) {
		case 'ok':
		case 'unchanged':
			return { ...question, shown: { ...rest, done: want, failures: 0 } };
		case 'refused':
			return outcome.code === 'token' ? question : { ...question, shown: { ...rest, done: want, error: outcome.reason } };
		case 'retry':
			return { ...question, shown: { ...question.shown, retryAt: outcome.at ?? now } };
		case 'uncertain': {
			const failures = question.shown.failures + 1;
			const recheckAt = now + RECHECK_DELAY;
			if (failures < EDIT_FAILURES) return { ...question, shown: { ...question.shown, failures, recheckAt } };
			return { ...question, shown: { ...rest, failures, done: want, recheckAt, error: `${EDIT_FAILURES} edits got no answer` } };
		}
	}
}

function recheck(question: Question, want: number, outcome: CallClass, now: number): Question {
	const { recheckAt, retryAt: _retryAt, error: _error, ...rest } = question.shown;
	if (recheckAt === undefined || want !== question.shown.want) return question;
	switch (outcome.kind) {
		case 'ok':
		case 'unchanged':
			return { ...question, shown: { ...rest, failures: 0 } };
		case 'refused':
			return outcome.code === 'token' ? question : { ...question, shown: { ...rest, error: outcome.reason } };
		case 'retry':
			return { ...question, shown: { ...question.shown, retryAt: outcome.at ?? now } };
		case 'uncertain': {
			const failures = question.shown.failures + 1;
			const next = { ...question.shown, failures, recheckAt: now + RECHECK_DELAY };
			return { ...question, shown: failures < EDIT_FAILURES ? next : { ...next, error: `${EDIT_FAILURES} edits got no answer` } };
		}
	}
}

function delivered(question: Question, event: Extract<QuestionEvent, { type: 'delivered' }>): Question {
	const { delivery } = question;
	if (event.error !== undefined) {
		return event.seq === question.seq && delivery.seq < question.seq ? { ...question, delivery: { ...delivery, attempts: delivery.attempts + 1, error: event.error } } : question;
	}
	if (event.seq <= delivery.seq || event.seq > question.seq) return question;
	return { ...question, delivery: event.seq === question.seq ? { seq: event.seq, attempts: 0 } : { ...delivery, seq: event.seq } };
}

function applySent(question: Question, sent: Sent): Question {
	const view = viewOf(question).view;
	if (sent.chat !== question.chat || sent.ref !== question.ref || sent.view?.id !== view?.id || sent.view?.origin !== view?.origin) {
		throw new ShapeError(`the sent message does not belong to question ${question.ref}`);
	}
	if (question.status === 'sending') return { ...question, status: 'open', sent };
	const known = sentOf(question);
	if (!known && question.status === 'closed') return { ...question, sent, shown: raise(question.shown) };
	if (known?.message === sent.message) return { ...question, sent };
	return question;
}

function refuse(reason: string): never {
	throw new ShapeError(reason);
}

const isFrom = (value: unknown): value is Record<string, unknown> => isRecord(value) && isInt(value.id) && isString(value.first_name) && optional(isString)(value.last_name);
const isMessageId = (value: unknown): value is number => isInt(value) && value > 0;

function checkUpdate(update: Update): void {
	const callback = update.callback_query;
	if (callback) {
		const message: unknown = callback.message;
		if (!isString(callback.id) || !isFrom(callback.from) || !optional(isString)(callback.data)) refuse('the callback query breaks its type');
		if (message !== undefined && (!isRecord(message) || !isMessageId(message.message_id) || !isRecord(message.chat) || !isInt(message.chat.id))) refuse('the tapped message breaks its type');
		return;
	}
	const message: unknown = update.message;
	if (message === undefined) return;
	if (!isRecord(message) || !isMessageId(message.message_id) || !isRecord(message.chat) || !isInt(message.chat.id) || !optional(isFrom)(message.from)) refuse('the message breaks its type');
	if (!optional(isString)(message.text) || !optional(isString)(message.caption)) refuse('the text of the message breaks its type');
	const replyTo: unknown = message.reply_to_message;
	if (replyTo !== undefined && (!isRecord(replyTo) || !isMessageId(replyTo.message_id))) refuse('the replied-to message breaks its type');
}

function checkEvent(event: QuestionEvent): void {
	if (event.type !== 'input' && !storable(event)) refuse(`the ${String(event.type)} event is not JSON`);
	switch (event.type) {
		case 'ask': {
			const { spec, ref, chat, topic, viewOrigin, allow, expiresAt, meta } = event;
			if (!isString(ref)) refuse('the ref of the ask is not a string');
			if (!isSpec(spec) || !spec.answer) refuse('the spec of the ask breaks its type');
			if (!isInt(chat) || !optional(isInt)(topic) || !optional(isString)(viewOrigin) || !arrayOf(isInt)(allow)) refuse('the chat, topic, view origin or allow list of the ask breaks its type');
			if (!optional(isNat)(expiresAt)) refuse('expiresAt is not a non-negative integer');
			const issue = meta === undefined ? undefined : metaIssue(meta);
			if (issue) refuse(issue);
			return;
		}
		case 'sent':
			if (!isSent(event.sent)) refuse('the sent message breaks its type');
			return;
		case 'input':
			return checkUpdate(event.update);
		case 'edit':
			if (!isBody(event.body)) refuse('the body of the edit breaks its type');
			return;
		case 'close':
			if (!optional(isBody)(event.body)) refuse('the body of the close breaks its type');
			return;
		case 'shown':
			if (!isNat(event.want) || !isCallClass(event.outcome)) refuse('the shown event breaks its type');
			return;
		case 'delivered':
			if (!isNat(event.seq) || !optional(isString)(event.error)) refuse('the delivered event breaks its type');
			return;
		case 'choice':
			if (!isString(event.id) || !CHOICE_ID.test(event.id)) refuse('a choice id is 22 base64url characters');
			if (!isUser(event.user) || !isNat(event.index) || !isNat(event.at)) refuse('the choice event breaks its type');
			return;
	}
}

export function reduce(question: Question | undefined, event: QuestionEvent, ctx: { now: number; labels?: Labels }): Result {
	if (!isNat(ctx.now)) refuse('now is not a non-negative integer');
	const labels = ctx.labels ? checkLabels(ctx.labels) : defaultLabels;
	checkEvent(event);
	if (event.type === 'ask') {
		if (question) return { question: expire(question, ctx.now, labels), calls: [] };
		const { spec, ref, chat, topic, viewOrigin, allow, expiresAt, meta } = event;
		checkSpec(spec, { ref, viewOrigin: spec.view !== undefined ? viewOrigin : undefined });
		const asked: Question = {
			v: 1,
			ref,
			spec,
			chat,
			...(topic !== undefined ? { topic } : {}),
			...(spec.view !== undefined && viewOrigin !== undefined ? { viewOrigin } : {}),
			allow,
			...(expiresAt !== undefined ? { expiresAt } : {}),
			seq: 0,
			applied: [],
			shown: { want: 0, done: 0, failures: 0 },
			delivery: { seq: 0, attempts: 0 },
			...(meta !== undefined ? { meta } : {}),
			createdAt: ctx.now,
			status: 'sending',
		};
		return { question: expire(asked, ctx.now, labels), calls: [] };
	}
	if (!question) {
		if (event.type === 'input') return orphan(event.update, labels);
		return event.type === 'choice' ? stale(undefined, 'unknown', []) : { calls: [] };
	}
	const current = expire(question, ctx.now, labels);
	switch (event.type) {
		case 'sent':
			return { question: applySent(current, event.sent), calls: [] };
		case 'input': {
			const { callback_query, message } = event.update;
			if (callback_query) return tap(current, callback_query, ctx.now, labels);
			return message ? reply(current, message, ctx.now, labels) : ignored(current);
		}
		case 'edit':
			if (current.status === 'closed') return { question: current, calls: [] };
			checkQuestionBody(event.body);
			return { question: { ...current, spec: { ...current.spec, body: event.body }, shown: raise(current.shown) }, calls: [] };
		case 'close': {
			const { body } = event;
			if (body) {
				checkQuestionBody(body);
				if (!sameForm(body, current.spec.body)) throw new ShapeError('a resolved body needs the form of the question body');
			}
			if (current.status === 'closed') return { question: body ? { ...current, resolved: body, shown: raise(current.shown) } : current, calls: [] };
			return { question: close(current, body), calls: [] };
		}
		case 'shown':
			return { question: shown(current, event, ctx.now), calls: [] };
		case 'delivered':
			return { question: delivered(current, event), calls: [] };
		case 'choice':
			return choose(current, event, ctx.now);
	}
}
