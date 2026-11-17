// Messages for `onMessage`, see 5.2: a message that answers no question is stored under
// `in:<chat>:<message id>` before the listener's cursor moves, and a courier delivers it like an
// answer: at least once, 5 attempts, then undelivered until a listener starts and renews them. A
// failing or hanging consumer therefore never loses a message and never holds up a tap. The key
// is the message's own id, since Telegram restarts update ids after a week of silence and keeps
// message ids: a new message never meets the entry of an old one.
import type { Message } from '@grammyjs/types';
import { arrayOf, isInt, isNat, isRecord, isString, optional } from '../core/check.ts';
import type { Store } from '../core/types.ts';
import { readRenewed, renew, spent } from '../chat/listener.ts';

/** What `onMessage` receives: a message that `handle` ignored. A forward's words sit under `forwarded`, apart from the human's own. */
export type Inbound = {
	message: number;
	text?: string;
	caption?: string;
	replyTo?: number;
	/** The question the replied-to message belongs to, read from the reply index. */
	ref?: string;
	forwarded?: { text?: string; caption?: string };
	files: { id: string; name?: string; bytes?: number }[];
};

/**
 * The stored value of `in:<chat>:<message id>`: the chat, the update the message arrived with,
 * the message, and its delivery attempts so far with the last error.
 */
export type StoredMessage = { v: 1; chat: number; update: number; message: Inbound; attempts: number; error?: string };

export const MESSAGE_PREFIX = 'in:';
export const messageKey = (at: { chat: number; message: number }) => `${MESSAGE_PREFIX}${at.chat}:${at.message}`;
/** The key of a stored message. */
export const storedKey = (stored: Pick<StoredMessage, 'chat' | 'message'>) => messageKey({ chat: stored.chat, message: stored.message.message });

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500) || 'no reason given';
const isWords = (value: unknown): value is { text?: string; caption?: string } => isRecord(value) && optional(isString)(value.text) && optional(isString)(value.caption);
const isFile = (value: unknown): value is Inbound['files'][number] => isRecord(value) && isString(value.id) && optional(isString)(value.name) && optional(isNat)(value.bytes);

/** A stored message, or undefined when any field breaks its type. */
export function parseStoredMessage(value: unknown): StoredMessage | undefined {
	if (!isRecord(value) || value.v !== 1 || !isInt(value.chat) || !isNat(value.update) || !isNat(value.attempts) || !optional(isString)(value.error)) return undefined;
	const found = value.message;
	if (!isRecord(found) || !isNat(found.message) || !optional(isString)(found.text) || !optional(isString)(found.caption) || !optional(isNat)(found.replyTo) || !optional(isString)(found.ref) || !optional(isWords)(found.forwarded) || !arrayOf(isFile)(found.files)) {
		return undefined;
	}
	const { message: id, text, caption, replyTo, ref, forwarded, files } = found;
	const message: Inbound = {
		message: id,
		...(text !== undefined ? { text } : {}),
		...(caption !== undefined ? { caption } : {}),
		...(replyTo !== undefined ? { replyTo } : {}),
		...(ref !== undefined ? { ref } : {}),
		...(forwarded !== undefined ? { forwarded: { ...forwarded } } : {}),
		files: files.map((file) => ({ ...file })),
	};
	return { v: 1, chat: value.chat, update: value.update, message, attempts: value.attempts, ...(value.error !== undefined ? { error: value.error } : {}) };
}

/** The files of a message, each by Telegram's file id: the largest size of a photo, any other kind as it is. */
function filesOf(message: Message): Inbound['files'] {
	const file = (found: { file_id: string; file_name?: string; file_size?: number }) => ({
		id: found.file_id,
		...(found.file_name !== undefined ? { name: found.file_name } : {}),
		...(found.file_size !== undefined ? { bytes: found.file_size } : {}),
	});
	const photo = message.photo?.at(-1);
	return [message.document, message.video, message.animation, message.audio, message.voice, message.video_note, photo].flatMap((found) => (found ? [file(found)] : []));
}

/** An ignored message as `onMessage` receives it, with the ref of the question it replies to. */
export function inbound(message: Message, ref: string | undefined): Inbound {
	const words = { ...(message.text !== undefined ? { text: message.text } : {}), ...(message.caption !== undefined ? { caption: message.caption } : {}) };
	return {
		message: message.message_id,
		...(message.forward_origin ? { forwarded: words } : words),
		...(message.reply_to_message ? { replyTo: message.reply_to_message.message_id } : {}),
		...(ref !== undefined ? { ref } : {}),
		files: filesOf(message),
	};
}

/** Orders keys `in:<chat>:<message id>` by chat, then by message id: the order the messages were sent in. */
function byMessage(a: string, b: string): number {
	const [chatA = 0, messageA = 0] = a.slice(MESSAGE_PREFIX.length).split(':').map(Number);
	const [chatB = 0, messageB = 0] = b.slice(MESSAGE_PREFIX.length).split(':').map(Number);
	return chatA - chatB || messageA - messageB;
}

/**
 * Delivers the stored messages to `onMessage` in the order they were sent, deleting each that it
 * took and counting the attempts of each that it rejected. A message with 5 rejected attempts
 * since its baseline in the listener record waits until `deliver({ restart: true })` renews it, as
 * the listener's start does. `deliver` is serial: a call during a pass requests one more pass.
 * Only the holder of the listener lease runs one.
 */
export function courier(store: Store, onMessage: (message: Inbound) => Promise<void>, log: (line: string) => void) {
	async function pass(restart: boolean): Promise<void> {
		const keys = (await store.list(MESSAGE_PREFIX)).sort(byMessage);
		const messages: { key: string; stored: StoredMessage }[] = [];
		for (const key of keys) {
			const stored = parseStoredMessage(await store.get(key));
			if (stored) messages.push({ key, stored });
			else log(`${key} breaks its type and stays in the store`);
		}
		// The baselines of the listener record, which `info` counts from too; a restart renews the spent ones first.
		const baseline = (restart ? await renew(store, 'messages', messages.map(({ key, stored }) => ({ key, attempts: stored.attempts }))) : await readRenewed(store)).messages;
		for (const { key, stored } of messages) {
			if (spent(stored.attempts, baseline[key])) continue;
			try {
				await onMessage(stored.message);
			} catch (error) {
				await store.set(key, { ...stored, attempts: stored.attempts + 1, error: describe(error) });
				continue;
			}
			await store.delete(key);
		}
	}

	let running: Promise<void> | undefined;
	let again = false;
	let restartNext = false;
	return {
		deliver(options: { restart?: boolean } = {}): Promise<void> {
			again = true;
			if (options.restart) restartNext = true;
			running ??= (async () => {
				try {
					while (again) {
						again = false;
						const restart = restartNext;
						restartNext = false;
						await pass(restart);
					}
				} finally {
					running = undefined;
				}
			})();
			return running;
		},
	};
}
