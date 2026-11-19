import type { MessageOrigin } from '@grammyjs/types';
import { arrayOf, isInt, isNat, isRecord, isString, optional } from '../core/check.ts';
import type { Store } from '../core/types.ts';
import { readRenewed, renew, spent } from '../chat/listener.ts';
import { filesOf } from './inbound.ts';

export type InboundFile = { id: string; name?: string; bytes?: number };

export type Inbound =
	| { kind: 'message'; message: number; text?: string; caption?: string; replyTo?: number; ref?: string; files: InboundFile[] }
	| { kind: 'forward'; message: number; replyTo?: number; ref?: string; forwarded: { origin?: MessageOrigin; text?: string; caption?: string; links: string[]; files: InboundFile[] } };

export type StoredMessage = { v: 1; chat: number; update: number; message: Inbound; attempts: number; error?: string };

export const MESSAGE_PREFIX = 'in:';
export const messageKey = (at: { chat: number; message: number }) => `${MESSAGE_PREFIX}${at.chat}:${at.message}`;
export const storedKey = (stored: Pick<StoredMessage, 'chat' | 'message'>) => messageKey({ chat: stored.chat, message: stored.message.message });

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500) || 'no reason given';
const isFile = (value: unknown): value is InboundFile => isRecord(value) && isString(value.id) && optional(isString)(value.name) && optional(isNat)(value.bytes);
const isOrigin = (value: unknown): value is MessageOrigin => isRecord(value) && isString(value.type);
const copyFiles = (files: InboundFile[]) => files.map((file) => ({ ...file }));
const wordsOf = (value: Record<string, unknown>) => ({ ...(isString(value.text) ? { text: value.text } : {}), ...(isString(value.caption) ? { caption: value.caption } : {}) });
const contextOf = (value: Record<string, unknown>) => ({ ...(isNat(value.replyTo) ? { replyTo: value.replyTo } : {}), ...(isString(value.ref) ? { ref: value.ref } : {}) });

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

export function parseStoredMessage(value: unknown): StoredMessage | undefined {
	if (!isRecord(value) || value.v !== 1 || !isInt(value.chat) || !isNat(value.update) || !isNat(value.attempts) || !optional(isString)(value.error)) return undefined;
	const message = parseInbound(value.message);
	if (!message) return undefined;
	return { v: 1, chat: value.chat, update: value.update, message, attempts: value.attempts, ...(value.error !== undefined ? { error: value.error } : {}) };
}

function linksOf(text: unknown, entities: unknown): string[] {
	if (!isString(text) || !Array.isArray(entities)) return [];
	return entities.flatMap((entity): string[] => {
		if (!isRecord(entity) || !isNat(entity.offset) || !isNat(entity.length)) return [];
		if (entity.type === 'url') return [text.slice(entity.offset, entity.offset + entity.length)];
		return entity.type === 'text_link' && isString(entity.url) ? [entity.url] : [];
	});
}

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

function byMessage(a: string, b: string): number {
	const [chatA = 0, messageA = 0] = a.slice(MESSAGE_PREFIX.length).split(':').map(Number);
	const [chatB = 0, messageB = 0] = b.slice(MESSAGE_PREFIX.length).split(':').map(Number);
	return chatA - chatB || messageA - messageB;
}

export function courier(store: Store, onMessage: (message: Inbound) => Promise<void>, log: (line: string) => void) {
	async function pass(restart: boolean): Promise<void> {
		const keys = (await store.list(MESSAGE_PREFIX)).sort(byMessage);
		const messages: { key: string; stored: StoredMessage; raw: Record<string, unknown> }[] = [];
		for (const key of keys) {
			const raw = await store.get(key);
			const stored = parseStoredMessage(raw);
			if (stored && isRecord(raw)) messages.push({ key, stored, raw });
			else log(`${key} breaks its type and stays in the store`);
		}
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
