import type { Update } from '@grammyjs/types';
import { arrayOf, isInt, isNat, isRecord, isString, oneOf, optional } from '../core/check.ts';
import type { Store } from '../core/types.ts';

export type UpdateKind = 'message' | 'edited_message' | 'callback_query' | 'message_reaction';

export type Source = { kind: UpdateKind; chat?: number; user?: number };

const idOf = (value: unknown): number | undefined => (isRecord(value) && isInt(value.id) ? value.id : undefined);

export function sourceOf(update: Update): Source | undefined {
	const raw: unknown = update;
	if (!isRecord(raw)) return undefined;
	for (const kind of ['message', 'edited_message'] as const) {
		const message = raw[kind];
		if (message !== undefined) return { kind, ...defined({ chat: isRecord(message) ? idOf(message.chat) : undefined, user: isRecord(message) ? idOf(message.from) : undefined }) };
	}
	const callback = raw.callback_query;
	if (callback !== undefined) {
		const message = isRecord(callback) ? callback.message : undefined;
		return { kind: 'callback_query', ...defined({ chat: isRecord(message) ? idOf(message.chat) : undefined, user: isRecord(callback) ? idOf(callback.from) : undefined }) };
	}
	const reaction = raw.message_reaction;
	if (reaction !== undefined) return { kind: 'message_reaction', ...defined({ chat: isRecord(reaction) ? idOf(reaction.chat) : undefined, user: isRecord(reaction) ? idOf(reaction.user) : undefined }) };
	return undefined;
}

const defined = (found: { chat: number | undefined; user: number | undefined }) => ({
	...(found.chat !== undefined ? { chat: found.chat } : {}),
	...(found.user !== undefined ? { user: found.user } : {}),
});

export function admitted(update: Update, target: number, allow: readonly number[]): boolean {
	const source = sourceOf(update);
	return source !== undefined && source.chat === target && source.user !== undefined && allow.includes(source.user);
}

export const FILE_KINDS = ['photo', 'animation', 'document', 'video', 'audio', 'voice', 'video_note', 'sticker'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export type MessageFile = { kind: FileKind; id: string; unique: string; name?: string; type?: string; bytes?: number };

function fileOf(kind: FileKind, value: unknown): MessageFile | undefined {
	if (!isRecord(value) || !isString(value.file_id) || !isString(value.file_unique_id)) return undefined;
	const { file_id: id, file_unique_id: unique, file_name: name, mime_type: type, file_size: bytes } = value;
	return { kind, id, unique, ...(isString(name) ? { name } : {}), ...(isString(type) ? { type } : {}), ...(isNat(bytes) ? { bytes } : {}) };
}

export function filesOf(message: unknown): MessageFile[] {
	if (!isRecord(message)) return [];
	const photo = Array.isArray(message.photo) ? message.photo.at(-1) : undefined;
	const found: (MessageFile | undefined)[] = [
		fileOf('photo', photo),
		fileOf('animation', message.animation),
		message.animation === undefined ? fileOf('document', message.document) : undefined,
		fileOf('video', message.video),
		fileOf('audio', message.audio),
		fileOf('voice', message.voice),
		fileOf('video_note', message.video_note),
		fileOf('sticker', message.sticker),
	];
	return found.filter((file) => file !== undefined);
}

export type Occurrence = { chat: number; sender: number; message: number; edit: number; position: number; name?: string; type?: string; bytes?: number };

export type FileRecord = { v: 1; id: string; unique: string; kind: FileKind; occurrences: Occurrence[] };

const isOccurrence = (value: unknown): value is Occurrence =>
	isRecord(value) &&
	isInt(value.chat) &&
	isInt(value.sender) &&
	isNat(value.message) &&
	isNat(value.edit) &&
	isNat(value.position) &&
	optional(isString)(value.name) &&
	optional(isString)(value.type) &&
	optional(isNat)(value.bytes);

export function parseFileRecord(value: unknown): FileRecord | undefined {
	if (!isRecord(value) || value.v !== 1 || !isString(value.id) || !isString(value.unique) || !oneOf(...FILE_KINDS)(value.kind) || !arrayOf(isOccurrence)(value.occurrences)) return undefined;
	return { v: 1, id: value.id, unique: value.unique, kind: value.kind, occurrences: value.occurrences.map((occurrence) => ({ ...occurrence })) };
}

export async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const FILE_PREFIX = 'fa:';
export const fileKey = async (id: string) => `${FILE_PREFIX}${await sha256(id)}`;

export const authorizes = (record: FileRecord, chat: number, allow: readonly number[]) => record.occurrences.some((occurrence) => occurrence.chat === chat && allow.includes(occurrence.sender));

const sameOccurrence = (a: Occurrence, b: Occurrence) => a.chat === b.chat && a.message === b.message && a.edit === b.edit && a.position === b.position;

export async function recordFiles(store: Store, update: Update): Promise<void> {
	const raw: unknown = update;
	const message = isRecord(raw) ? (raw.message ?? raw.edited_message) : undefined;
	if (!isRecord(message) || !isNat(message.message_id)) return;
	const chat = idOf(message.chat);
	const sender = idOf(message.from);
	if (chat === undefined || sender === undefined) return;
	const edit = isNat(message.edit_date) ? message.edit_date : 0;
	for (const [position, file] of filesOf(message).entries()) {
		const occurrence: Occurrence = {
			chat,
			sender,
			message: message.message_id,
			edit,
			position,
			...(file.name !== undefined ? { name: file.name } : {}),
			...(file.type !== undefined ? { type: file.type } : {}),
			...(file.bytes !== undefined ? { bytes: file.bytes } : {}),
		};
		const key = await fileKey(file.id);
		await store.lock(key, async () => {
			const stored = parseFileRecord(await store.get(key));
			if (stored?.occurrences.some((known) => sameOccurrence(known, occurrence))) return;
			const record: FileRecord = stored ? { ...stored, occurrences: [...stored.occurrences, occurrence] } : { v: 1, id: file.id, unique: file.unique, kind: file.kind, occurrences: [occurrence] };
			await store.set(key, record);
		});
	}
}
