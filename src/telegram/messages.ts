// Messages for `onMessage`, see 5.2: a message that answers no question is stored under
// `in:<chat>:<message id>` before the listener's cursor moves, and a courier delivers it like an
// answer: at least once, 5 attempts, then undelivered until a listener starts and renews them. A
// failing or hanging consumer therefore never loses a message and never holds up a tap. The key
// is the message's own id, since Telegram restarts update ids after a week of silence and keeps
// message ids: a new message never meets the entry of an old one.
import type { MessageOrigin } from '@grammyjs/types';
import { arrayOf, isInt, isNat, isRecord, isString, optional } from '../core/check.ts';
import type { Store } from '../core/types.ts';
import { readRenewed, renew, spent } from '../chat/listener.ts';
import { filesOf } from './inbound.ts';

/** A file of a message by Telegram's file id, which `fetch` takes, with its name and size as far as given. */
export type InboundFile = { id: string; name?: string; bytes?: number };

/**
 * What `onMessage` receives: a message that `handle` ignored. A message of the human's own
 * carries its words and files at the top level. A forward carries none there: its origin
 * (Telegram's MessageOrigin), words, links and files sit only under `forwarded`. `replyTo` is the
 * message it replies to, and `ref` the question that message belongs to, read from the reply index.
 * `origin` is absent only for a forward an earlier release queued, which stored no origin; every
 * forward the listener stores now has one.
 */
export type Inbound =
	| { kind: 'message'; message: number; text?: string; caption?: string; replyTo?: number; ref?: string; files: InboundFile[] }
	| { kind: 'forward'; message: number; replyTo?: number; ref?: string; forwarded: { origin?: MessageOrigin; text?: string; caption?: string; links: string[]; files: InboundFile[] } };

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
const isFile = (value: unknown): value is InboundFile => isRecord(value) && isString(value.id) && optional(isString)(value.name) && optional(isNat)(value.bytes);
/** A MessageOrigin as JSON holds one: an object with its `type`. Its other fields are Telegram's and pass as they came. */
const isOrigin = (value: unknown): value is MessageOrigin => isRecord(value) && isString(value.type);
const copyFiles = (files: InboundFile[]) => files.map((file) => ({ ...file }));
/** `text` and `caption` of a record, each only when it is a string. */
const wordsOf = (value: Record<string, unknown>) => ({ ...(isString(value.text) ? { text: value.text } : {}), ...(isString(value.caption) ? { caption: value.caption } : {}) });
/** `replyTo` and `ref` of a record, each only when it has its type. */
const contextOf = (value: Record<string, unknown>) => ({ ...(isNat(value.replyTo) ? { replyTo: value.replyTo } : {}), ...(isString(value.ref) ? { ref: value.ref } : {}) });

/**
 * A stored `Inbound`, or undefined when any field breaks its type. A record of an earlier
 * release has no `kind`, so a message queued before an upgrade is still delivered and listed.
 * That release stored a forward's words under `forwarded` without its origin, and every file at
 * the top level. Such a record with `forwarded` reads as `kind: 'forward'`, without `origin` and
 * links, with its words and files under `forwarded`; one without reads as `kind: 'message'`.
 */
function parseInbound(found: unknown): Inbound | undefined {
	if (!isRecord(found) || !isNat(found.message) || !optional(isNat)(found.replyTo) || !optional(isString)(found.ref)) return undefined;
	if (found.kind === undefined && found.forwarded !== undefined) {
		const old = found.forwarded;
		if (!isRecord(old) || !optional(isString)(old.text) || !optional(isString)(old.caption) || !arrayOf(isFile)(found.files)) return undefined;
		return { kind: 'forward', message: found.message, ...contextOf(found), forwarded: { ...wordsOf(old), links: [], files: copyFiles(found.files) } };
	}
	if (found.kind === 'message' || found.kind === undefined) {
		if (!optional(isString)(found.text) || !optional(isString)(found.caption) || !arrayOf(isFile)(found.files)) return undefined;
		return { kind: 'message', message: found.message, ...wordsOf(found), ...contextOf(found), files: copyFiles(found.files) };
	}
	const forwarded = found.forwarded;
	if (found.kind !== 'forward' || !isRecord(forwarded) || !isOrigin(forwarded.origin) || !optional(isString)(forwarded.text) || !optional(isString)(forwarded.caption)) return undefined;
	if (!arrayOf(isString)(forwarded.links) || !arrayOf(isFile)(forwarded.files)) return undefined;
	return {
		kind: 'forward',
		message: found.message,
		...contextOf(found),
		forwarded: { origin: structuredClone(forwarded.origin), ...wordsOf(forwarded), links: [...forwarded.links], files: copyFiles(forwarded.files) },
	};
}

/** A stored message, or undefined when any field breaks its type. */
export function parseStoredMessage(value: unknown): StoredMessage | undefined {
	if (!isRecord(value) || value.v !== 1 || !isInt(value.chat) || !isNat(value.update) || !isNat(value.attempts) || !optional(isString)(value.error)) return undefined;
	const message = parseInbound(value.message);
	if (!message) return undefined;
	return { v: 1, chat: value.chat, update: value.update, message, attempts: value.attempts, ...(value.error !== undefined ? { error: value.error } : {}) };
}

/**
 * The links of a text: the text of each `url` entity and the address of each `text_link`, in
 * the order they appear. Offsets count UTF-16 code units, as JavaScript strings do.
 */
function linksOf(text: unknown, entities: unknown): string[] {
	if (!isString(text) || !Array.isArray(entities)) return [];
	return entities.flatMap((entity): string[] => {
		if (!isRecord(entity) || !isNat(entity.offset) || !isNat(entity.length)) return [];
		if (entity.type === 'url') return [text.slice(entity.offset, entity.offset + entity.length)];
		return entity.type === 'text_link' && isString(entity.url) ? [entity.url] : [];
	});
}

/**
 * An ignored message as `onMessage` receives it, with the ref of the question it replies to, or
 * undefined when its id or its `forward_origin` breaks its type. A message with `forward_origin`
 * is a forward: its words, links and files go under `forwarded` alone. Words and files that break
 * their types are left out.
 */
export function inbound(message: unknown, ref: string | undefined): Inbound | undefined {
	if (!isRecord(message) || !isNat(message.message_id)) return undefined;
	const replyTo = isRecord(message.reply_to_message) && isNat(message.reply_to_message.message_id) ? message.reply_to_message.message_id : undefined;
	const context = { ...(replyTo !== undefined ? { replyTo } : {}), ...(ref !== undefined ? { ref } : {}) };
	const files = filesOf(message).map(({ id, name, bytes }) => ({ id, ...(name !== undefined ? { name } : {}), ...(bytes !== undefined ? { bytes } : {}) }));
	const origin = message.forward_origin;
	if (origin === undefined) return { kind: 'message', message: message.message_id, ...wordsOf(message), ...context, files };
	if (!isOrigin(origin)) return undefined;
	const links = [...linksOf(message.text, message.entities), ...linksOf(message.caption, message.caption_entities)];
	return { kind: 'forward', message: message.message_id, ...context, forwarded: { origin: structuredClone(origin), ...wordsOf(message), links, files } };
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
		// Each message with the value as stored: a failed attempt writes that value back with its
		// count, so a record of an earlier release keeps its form until it is delivered.
		const messages: { key: string; stored: StoredMessage; raw: Record<string, unknown> }[] = [];
		for (const key of keys) {
			const raw = await store.get(key);
			const stored = parseStoredMessage(raw);
			if (stored && isRecord(raw)) messages.push({ key, stored, raw });
			else log(`${key} breaks its type and stays in the store`);
		}
		// The baselines of the listener record, which `info` counts from too; a restart renews the spent ones first.
		const baseline = (restart ? await renew(store, 'messages', messages.map(({ key, stored }) => ({ key, attempts: stored.attempts }))) : await readRenewed(store)).messages;
		for (const { key, stored, raw } of messages) {
			if (spent(stored.attempts, baseline[key])) continue;
			try {
				await onMessage(stored.message);
			} catch (error) {
				await store.set(key, { ...raw, attempts: stored.attempts + 1, error: describe(error) });
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
