// The answer protocol of 4.6 as one pure function. `reduce` takes a question and one event and
// returns the next question, the calls that are safe to lose (a toast, a reaction) and what
// the event meant. Whatever must survive a crash lives in the question: `shown.want` above
// `shown.done` owes an edit, `seq` above `delivery.seq` owes a delivery.
import type { CallbackQuery, InlineKeyboardMarkup, Message, Update } from '@grammyjs/types';
import { arrayOf, isInt, isNat, isRecord, isString, optional, storable } from './check.ts';
import { isBody, isCallClass, isSent, isSpec } from './guards.ts';
import { checkLabels } from './labels.ts';
import { bodyLike } from './render.ts';
import { checkQuestionBody, checkSpec, metaIssue, sameForm } from './shape.ts';
import { type Answer, type Body, type Call, type CallClass, defaultLabels, type Handled, type Labels, type Question, type QuestionEvent, type Sent, ShapeError, type User } from './types.ts';

/** How many input keys a question keeps to find replays. */
export const APPLIED_WINDOW = 32;
/** How many edits without an answer turn into `shown.error`. */
export const EDIT_FAILURES = 10;
/** How long after an uncertain edit ended the message is edited once more: the edit may still reach the server after a later one. */
export const RECHECK_DELAY = 60_000;

// Callback data `q:<ref>:<n>`, with the ref pattern of shape.ts.
const DATA = /^q:([A-Za-z0-9_-]{1,32}):(\d{1,2})$/;

/** The ref and button index of callback data `q:<ref>:<n>`. */
function parseData(data: string | undefined): { ref: string; button: number } | undefined {
	const match = data === undefined ? null : DATA.exec(data);
	return match?.[1] !== undefined && match[2] !== undefined ? { ref: match[1], button: Number(match[2]) } : undefined;
}

/** The ref named by the first answer button of a keyboard. */
function refOf(markup: InlineKeyboardMarkup | undefined): string | undefined {
	for (const button of markup?.inline_keyboard.flat() ?? []) {
		const parsed = 'callback_data' in button ? parseData(button.callback_data) : undefined;
		if (parsed) return parsed.ref;
	}
	return undefined;
}

/**
 * Which question an update belongs to, without a store. A tap names its ref, button and
 * message. A reply names its chat and the replied-to message, plus the ref of that message's
 * answer buttons when it has some: a reply from a phone carries the replied-to markup.
 */
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

/** The `Sent` of a question whose message an input revealed: the message id is all a tap or a reply adds. */
const revealed = (question: Question, message: number): Sent => ({
	chat: question.chat,
	...(question.topic !== undefined ? { topic: question.topic } : {}),
	message,
	files: [],
	ref: question.ref,
	...viewOf(question),
});

/**
 * Gives a question without a message the one an input revealed. A `sending` question opens. A
 * closed one stores it and owes the edit that removes its answer buttons.
 */
function reveal(question: Question, message: number): Question {
	if (question.status === 'sending') return { ...question, status: 'open', sent: revealed(question, message) };
	if (question.status === 'closed' && !question.sent) return { ...question, sent: revealed(question, message), shown: raise(question.shown) };
	return question;
}

/** The question closed, with `resolved` as the body it shows. Closing raises `shown.want`. */
function close(question: Question, resolved: Body | undefined): Question {
	return { ...question, status: 'closed', ...(resolved ? { resolved } : {}), shown: raise(question.shown) };
}

/** Closes a question whose `expiresAt` has come, with `labels.expired` as its resolved body. */
function expire(question: Question, now: number, labels: Labels): Question {
	if (question.status === 'closed' || question.expiresAt === undefined || now < question.expiresAt) return question;
	return close(question, bodyLike(question.spec.body, labels.expired));
}

/** An answer on an open or answered question: `seq` rises, the old answer becomes `previous`. */
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

/**
 * A tap. It counts only on the question's own message in the question's chat, on a button
 * that exists. The first failing check wins: unknown, forbidden, closed, repeat.
 */
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

/**
 * A reply. It belongs to the question when it is in the question's chat and replies to the
 * question's message, or, while that message is unknown, to a message whose buttons name the
 * question. Only a text question takes it as an answer; any other reply is `ignored`.
 */
function reply(question: Question, message: Message, now: number, labels: Labels): Result {
	const replyTo = message.reply_to_message;
	const sent = sentOf(question);
	if (!replyTo || message.chat.id !== question.chat || (sent ? sent.message !== replyTo.message_id : refOf(replyTo.reply_markup) !== question.ref)) return ignored(question);
	if (!message.from || !question.allow.includes(message.from.id)) return stale(question, 'forbidden', []);
	const current = reveal(question, replyTo.message_id);
	const text = message.text ?? message.caption;
	if (current.status === 'closed' || current.status === 'sending' || current.spec.answer.type !== 'text' || text === undefined) return ignored(current);
	const key = `msg:${message.message_id}`;
	if (current.applied.includes(key) || (current.status === 'answered' && current.spec.answer.once)) return stale(current, 'repeat', []);
	const next = answered(current, { kind: 'text', text }, userOf(message.from), now, key);
	const reaction: Call = { method: 'setMessageReaction', payload: { chat_id: message.chat.id, message_id: message.message_id, reaction: [{ type: 'emoji', emoji: labels.ack }] } };
	return { question: next, calls: [reaction], handled: handledAnswer(next) };
}

/** An input for a ref the store lacks: a tap gets the toast `labels.unknown`, anything else is ignored. */
function orphan(update: Update, labels: Labels): Result {
	return update.callback_query ? stale(undefined, 'unknown', toast(update.callback_query, labels.unknown)) : ignored(undefined);
}

/**
 * The answer to an edit of `want`. `now` is the time the edit ended: its answer or its deadline.
 * An uncertain edit sets `recheckAt`, and a later success keeps it, since the uncertain edit may
 * still reach the server after the later one.
 */
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
			// A rejected token stops the listener and leaves the question as it was.
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

/**
 * The answer to the edit that confirms a message already shown, sent once `recheckAt` has come.
 * A success or "message is not modified" confirms the message: it clears `recheckAt`, the
 * failures and the error. An uncertain answer counts as a failed edit, 10 of them set the error,
 * and it moves `recheckAt`, so the recheck goes on.
 */
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
	// An older answer's success moves the mark; the attempts and error belong to the newest answer.
	return { ...question, delivery: event.seq === question.seq ? { seq: event.seq, attempts: 0 } : { ...delivery, seq: event.seq } };
}

/** Applies the `Sent` of a send: a `sending` question opens, a known message takes its file ids. */
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

/** Throws ShapeError for an update whose fields that `reduce` stores break their types. */
function checkUpdate(update: Update): void {
	// Read as unknown: grammY's interfaces carry no index signature, so a plain-object check would narrow them to never.
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

/**
 * Throws ShapeError for an event whose values break the types a question stores, with the
 * predicates `parseQuestion` uses: integers, non-negative counters and times, JSON meta and
 * typed bodies, also where TypeScript lets them through.
 */
function checkEvent(event: QuestionEvent): void {
	// JSON first: a cycle, a hole, a BigInt or any other value JSON cannot store fails here. An
	// input is an update from Telegram, which `checkUpdate` reads field by field: only its
	// scalars reach the question.
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
	}
}

/**
 * One event against one question. `now` at or past `expiresAt` closes the question first, for
 * every event, `ask` included, so a late input is `stale: closed`. Throws ShapeError for an
 * event, a `now` or labels that break their types, and for an `ask`, `edit` or `close` whose
 * spec or body breaks a check of section 8, so every question it returns passes `parseQuestion`.
 *
 *   let { question } = reduce(undefined, { type: 'ask', spec, ref, chat, allow: [chat] }, { now });
 *   ({ question } = reduce(question, { type: 'sent', sent }, { now }));
 *   const { question: next, calls, handled } = reduce(question, { type: 'input', update }, { now });
 */
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
	if (!question) return event.type === 'input' ? orphan(event.update, labels) : { calls: [] };
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
	}
}
