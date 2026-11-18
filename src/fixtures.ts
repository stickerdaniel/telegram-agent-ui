// Test fixtures derived from the records in facts/records/: a real tap and a real reply from
// Telegram for iOS, and real answers to sends and edits. Chat 111 is a private chat with user
// 111, the bot is 222, and the recorded question is `probe001` on message 632.
import type { Update } from '@grammyjs/types';
import send from '../facts/records/01-send-rich-with-keyboard.json';
import unchanged from '../facts/records/02-edit-unchanged.json';
import album from '../facts/records/06-album-reply-to-body.json';
import document from '../facts/records/07-document-reply-to-body.json';
import human from '../facts/records/09-human-updates.json';
import { reduce } from './core/reduce.ts';
import type { CallResponse, Json, Question, QuestionEvent, Sent } from './core/types.ts';

export const CHAT = 111;
export const USER = 111;
export const REF = 'probe001';
export const MESSAGE = 632;
export const ORIGIN = 'https://views.example.com';
export const VIEW = 'AAAAAAAAAAAAAAAAAAAAAA';

const [recordedTap, recordedReply] = human as Update[];
if (!recordedTap?.callback_query?.message || !recordedReply?.message?.reply_to_message) throw new Error('facts/records/09-human-updates.json lost its tap or reply');
const tapRecord = recordedTap;
const replyRecord = recordedReply;

/** A tap as Telegram for iOS sent it, with the given callback data, message, chat and user. */
export function tap(options: { button: number; ref?: string; id?: string; message?: number; chat?: number; user?: number; inaccessible?: boolean }): Update {
	const update = structuredClone(tapRecord);
	const callback = update.callback_query;
	const message = callback?.message;
	if (!callback || !message) throw new Error('unreachable: checked at load');
	const chat = { ...message.chat, id: options.chat ?? CHAT };
	const messageId = options.message ?? MESSAGE;
	callback.id = options.id ?? callback.id;
	callback.from = { ...callback.from, id: options.user ?? USER };
	callback.data = `q:${options.ref ?? REF}:${options.button}`;
	// An InaccessibleMessage holds only chat, message id and date 0.
	callback.message = options.inaccessible ? { chat, message_id: messageId, date: 0 } : { ...message, chat, message_id: messageId };
	return update;
}

/**
 * A reply as Telegram for iOS sent it. The replied-to message carries the recorded keyboard
 * with `markupRef` as its ref, or no keyboard when `markupRef` is null. `text: null` drops
 * the text, so `caption` alone or nothing remains. `forwarded` makes it a forward of a hidden
 * user's message.
 */
export function reply(options: { id?: number; replyTo?: number; markupRef?: string | null; text?: string | null; caption?: string; chat?: number; user?: number; forwarded?: boolean } = {}): Update {
	// The clone is edited in place: grammY's ReplyMessage type cannot be rebuilt by a spread.
	const update = structuredClone(replyRecord);
	const message = update.message;
	const replyTo = message?.reply_to_message;
	if (!message || !replyTo) throw new Error('unreachable: checked at load');
	const chat = { ...message.chat, id: options.chat ?? CHAT };
	const markupRef = options.markupRef === undefined ? REF : options.markupRef;
	message.message_id = options.id ?? message.message_id;
	message.chat = chat;
	message.from = { ...message.from, id: options.user ?? USER };
	replyTo.chat = chat;
	replyTo.message_id = options.replyTo ?? replyTo.message_id;
	if (markupRef === null) delete replyTo.reply_markup;
	for (const button of replyTo.reply_markup?.inline_keyboard.flat() ?? []) if ('callback_data' in button) button.callback_data = button.callback_data.replace(REF, markupRef ?? REF);
	if (options.text === null) delete message.text;
	else if (options.text !== undefined) message.text = options.text;
	if (options.caption !== undefined) message.caption = options.caption;
	if (options.forwarded) message.forward_origin = { type: 'hidden_user', sender_user_name: 'Someone', date: message.date - 60 };
	return update;
}

/** A message that replies to nothing. */
export function plain(text = 'hello'): Update {
	const update = reply({ text });
	delete update.message?.reply_to_message;
	return update;
}

/** The recorded answers of the cloud Bot API, as a transport reports them. */
export const responses = {
	send: send.body as CallResponse,
	album: album.body as CallResponse,
	document: document.body as CallResponse,
	notModified: { ok: false, status: unchanged.status, description: unchanged.body.description } satisfies CallResponse,
};

export const NOW = 1_794_908_513_000;

/** One event at `now`, returning the next question. Throws when the event leaves none. */
export function step(question: Question | undefined, event: QuestionEvent, now = NOW): Question {
	const next = reduce(question, event, { now }).question;
	if (!next) throw new Error(`${event.type} left no question`);
	return next;
}

export const input = (update: Update): QuestionEvent => ({ type: 'input', update });

/** A freshly asked question in chat 111, answerable by user 111. */
export function asked(spec: Question['spec'], extra: { expiresAt?: number; meta?: Json; topic?: number } = {}): Question {
	return step(undefined, { type: 'ask', spec, ref: REF, chat: CHAT, allow: [USER], ...(spec.view !== undefined ? { viewOrigin: ORIGIN } : {}), ...extra });
}

/** The `Sent` a body step on message 632 gives a question. */
export function sentFor(question: Question): Sent {
	return { chat: CHAT, message: MESSAGE, files: [], ref: REF, ...(question.spec.view !== undefined ? { view: { id: question.spec.view, origin: ORIGIN } } : {}) };
}

/**
 * The question of `spec` in every status: answered by a tap on button 0 with callback id
 * `a0`, or by reply 700, and closed from each of sending, open and answered.
 */
export function states(spec: Question['spec']) {
	const sending = asked(spec);
	const open = step(sending, { type: 'sent', sent: sentFor(sending) });
	const answering = spec.answer.type === 'choice' ? tap({ button: 0, id: 'a0' }) : reply({ id: 700, text: 'first', markupRef: null });
	const answered = step(open, input(answering));
	const onceSending = asked({ ...spec, answer: { ...spec.answer, once: true } });
	const answeredOnce = step(step(onceSending, { type: 'sent', sent: sentFor(onceSending) }), input(answering));
	return {
		sending,
		open,
		answered,
		answeredOnce,
		closed: step(open, { type: 'close' }),
		closedUnsent: step(sending, { type: 'close' }),
		closedAnswered: step(answered, { type: 'close' }),
	};
}
