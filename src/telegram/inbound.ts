// What the listener reads from an update before a consumer sees it, see 5.2: who sent it to
// which chat, the gate that lets only the target chat and an allowed user through, and the files
// of a message with the authorization records `fa:<sha256 of file_id>` that `fetchFile` checks.
// An update arrives as JSON and is read field by field here, so a field that breaks its type
// refuses the update or drops the file instead of throwing.
import type { Update } from '@grammyjs/types';
import { arrayOf, isInt, isNat, isRecord, isString, oneOf, optional } from '../core/check.ts';
import type { Store } from '../core/types.ts';

/** The update types the listener asks for: `edited_message` and `message_reaction` only with `onUpdate`. */
export type UpdateKind = 'message' | 'edited_message' | 'callback_query' | 'message_reaction';

/**
 * Who sent an update to which chat, per kind: a message and an edit by `from.id` in `chat.id`, a
 * tap by `from.id` on a message of `message.chat.id`, a reaction by `user.id` in `chat.id`. A
 * field that is missing or breaks its type is left out: an inline tap has no chat, a reaction
 * made as a chat has no user.
 */
export type Source = { kind: UpdateKind; chat?: number; user?: number };

const idOf = (value: unknown): number | undefined => (isRecord(value) && isInt(value.id) ? value.id : undefined);

/** The source of an update, or undefined for an update of no kind the listener asks for. */
export function sourceOf(update: Update): Source | undefined {
	// Read as unknown: the fields come from JSON, whatever grammY's types say.
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

/** `{ chat, user }` without the fields that are undefined. */
const defined = (found: { chat: number | undefined; user: number | undefined }) => ({
	...(found.chat !== undefined ? { chat: found.chat } : {}),
	...(found.user !== undefined ? { user: found.user } : {}),
});

/**
 * Whether a consumer and the file records may see an update: it is of a kind the listener asks
 * for, in the chat `target`, from a user in `allow`. Any other update is refused.
 */
export function admitted(update: Update, target: number, allow: readonly number[]): boolean {
	const source = sourceOf(update);
	return source !== undefined && source.chat === target && source.user !== undefined && allow.includes(source.user);
}

/** The kinds of file a message carries. */
export const FILE_KINDS = ['photo', 'animation', 'document', 'video', 'audio', 'voice', 'video_note', 'sticker'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** A file of a message as Telegram describes it: its ids, kind, name, type and size, as far as given. */
export type MessageFile = { kind: FileKind; id: string; unique: string; name?: string; type?: string; bytes?: number };

/** A Telegram file object as a MessageFile of `kind`, or undefined when its ids break their types. */
function fileOf(kind: FileKind, value: unknown): MessageFile | undefined {
	if (!isRecord(value) || !isString(value.file_id) || !isString(value.file_unique_id)) return undefined;
	const { file_id: id, file_unique_id: unique, file_name: name, mime_type: type, file_size: bytes } = value;
	return { kind, id, unique, ...(isString(name) ? { name } : {}), ...(isString(type) ? { type } : {}), ...(isNat(bytes) ? { bytes } : {}) };
}

/**
 * The files of a message, in a fixed order: the largest size of a photo, an animation without
 * the document copy Telegram adds to it, then a document, a video, an audio, a voice note, a
 * video note and a sticker. A file whose ids break their types is left out. Its index in this
 * list is its position in the message.
 */
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

/**
 * One message that carried a file: its chat, sender and message id, its `edit_date` or 0 for the
 * message as first sent, the file's position in it, and Telegram's name, type and size there.
 */
export type Occurrence = { chat: number; sender: number; message: number; edit: number; position: number; name?: string; type?: string; bytes?: number };

/**
 * The value of `fa:<sha256 of file_id>`: the file's ids and kind, and every allowed message that
 * carried it. A fetch of `id` is authorized while one occurrence lies in the target chat and has
 * a sender in `allow`.
 */
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

/** A stored file record, or undefined when a field breaks its type. */
export function parseFileRecord(value: unknown): FileRecord | undefined {
	if (!isRecord(value) || value.v !== 1 || !isString(value.id) || !isString(value.unique) || !oneOf(...FILE_KINDS)(value.kind) || !arrayOf(isOccurrence)(value.occurrences)) return undefined;
	return { v: 1, id: value.id, unique: value.unique, kind: value.kind, occurrences: value.occurrences.map((occurrence) => ({ ...occurrence })) };
}

/** The SHA-256 of a text, as 64 hex digits. */
export async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export const FILE_PREFIX = 'fa:';
/** The key of the file record of `id`, a Telegram file_id. */
export const fileKey = async (id: string) => `${FILE_PREFIX}${await sha256(id)}`;

/** Whether a file record allows a fetch now: one occurrence lies in `chat` and has a sender in `allow`. */
export const authorizes = (record: FileRecord, chat: number, allow: readonly number[]) => record.occurrences.some((occurrence) => occurrence.chat === chat && allow.includes(occurrence.sender));

const sameOccurrence = (a: Occurrence, b: Occurrence) => a.chat === b.chat && a.message === b.message && a.edit === b.edit && a.position === b.position;

/**
 * Adds an occurrence of every file of an admitted `message` or `edited_message` to its file
 * record, each under the store's lock of its key. An occurrence already recorded, by chat,
 * message, edit date and position, adds nothing, so a replayed update changes no record. A
 * message whose chat, sender or id breaks its type records nothing.
 *
 *   await recordFiles(store, update); // before the cursor moves past the update
 */
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
