// The types of the pure core: what a caller sends, what a question stores and what the
// functions of render.ts, reduce.ts and classify.ts take and return. Every time value is Unix
// time in milliseconds. Bot API types come from @grammyjs/types 5.0.0, which has
// InputRichMessage, InputRichBlock and InlineKeyboardButton.style.
import type { InputRichBlock, Update } from '@grammyjs/types';

export type { Update };

/** The three forms of InputRichMessage. `html` is Rich HTML, the dialect of sendRichMessage. */
export type Body = { markdown: string } | { html: string } | { blocks: InputRichBlock<never>[] };

/** Everything a caller can send. Plain JSON. */
export type Spec = {
	body: Body;
	/** With it, the message is a question. */
	answer?: AnswerSpec;
	/** 1 to 10 files, each sent as a reply to the body's message. */
	attach?: Attachment[];
	/** The id of a published view. */
	view?: string;
	silent?: boolean;
};

/** `choice`: 2 to 8 options, a tap is the answer. `text`: a reply is the answer. `once` forbids a correction. */
export type AnswerSpec = { type: 'choice'; options: Option[]; layout?: 'rows' | 'row'; once?: boolean } | { type: 'text'; once?: boolean };
/** `tab` names the tab of the view that the button opens once this option is picked. */
export type Option = { label: string; value?: string; style?: 'primary' | 'danger'; tab?: string };
export type Attachment = { path: string; as?: 'photo' | 'video' | 'document'; caption?: string };

/** What a send returns and what an edit takes. `ref` when the message is a question. */
export type Sent = { chat: number; topic?: number; message: number; files: number[]; ref?: string; view?: { id: string; origin: string } };

export type Answer = { kind: 'choice'; index: number; label: string; value?: string } | { kind: 'text'; text: string };
export type User = { id: number; name?: string };
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A question: a `Sent` plus what the answer protocol needs. Read from a store only through `parseQuestion`. */
export type Question = {
	v: 1;
	ref: string;
	spec: Spec & { answer: AnswerSpec };
	chat: number;
	topic?: number;
	/** The origin of the view button, fixed at send. Present exactly when the spec has a view. */
	viewOrigin?: string;
	/** User ids that may answer, fixed at send. */
	allow: number[];
	/** From this time on the question takes no answer. */
	expiresAt?: number;
	/** Answers so far. */
	seq: number;
	/** Keys of the last 32 applied inputs: `cq:<callback query id>` or `msg:<message id>`. */
	applied: string[];
	/**
	 * The message against the state: an edit is owed while `done < want`. `recheckAt` is set by an
	 * uncertain edit, which may still reach the server after a later one: from that time on the
	 * message is edited once more to confirm it.
	 */
	shown: { want: number; done: number; failures: number; retryAt?: number; recheckAt?: number; error?: string };
	/** The answer against the consumer: a delivery is owed while `seq < Question.seq`. */
	delivery: { seq: number; attempts: number; error?: string };
	/** Opaque JSON of the asker, returned with the answer. */
	meta?: Json;
	createdAt: number;
} & (
	| { status: 'sending' }
	| { status: 'open'; sent: Sent }
	| { status: 'answered'; sent: Sent; answer: Answer; by: User; answeredAt: number; previous?: Answer }
	| { status: 'closed'; sent?: Sent; resolved?: Body; answer?: Answer; by?: User; answeredAt?: number; previous?: Answer }
);

/** What a call answered, as a transport reports it. `retryAfter` is the time from which a retry is allowed. */
export type CallResponse = { ok: true; result: unknown } | { ok: false; status: number; description: string; retryAfter?: number } | { noAnswer: true };
/** What a server answer means, see `classify`. */
export type CallClass = { kind: 'ok'; result: unknown } | { kind: 'unchanged' } | { kind: 'refused'; code: 'server' | 'token'; reason: string } | { kind: 'retry'; at?: number } | { kind: 'uncertain' };

export type QuestionEvent =
	| { type: 'ask'; spec: Question['spec']; ref: string; chat: number; topic?: number; viewOrigin?: string; allow: number[]; expiresAt?: number; meta?: Json }
	| { type: 'sent'; sent: Sent }
	| { type: 'input'; update: Update }
	| { type: 'edit'; body: Body }
	| { type: 'close'; body?: Body }
	| { type: 'shown'; want: number; outcome: CallClass }
	| { type: 'delivered'; seq: number; error?: string };

export type Handled =
	| { kind: 'ignored' }
	| { kind: 'stale'; reason: 'unknown' | 'closed' | 'forbidden' | 'repeat' }
	| { kind: 'answered'; ref: string; seq: number; answer: Answer; by: User; at: number; previous?: Answer; meta?: Json };

/** One Bot API request. A `files` entry names the multipart field a transport fills with an opened file. */
export type Call = { method: string; payload: Record<string, unknown>; files?: { field: string; path: string }[] };
/** `body` sends the body. A `files` step is a template: its runner sets `reply_parameters.message_id` to the body's message. */
export type Step = { call: Call; role: 'body' | 'files' };

/**
 * A finding about a spec that refuses nothing without `strict`. The first three are computed
 * by `render`. `unconfirmed-message` and `not-shown` report a stored state after the fact.
 */
export type Warning = { code: 'no-question-mark' | 'table-candidate' | 'answer-hint' | 'unconfirmed-message' | 'not-shown'; message: string };

/**
 * What `createChat` returns for `send`, `edit` and `close`. `refused` means that no message was
 * sent and no question exists. `partial` means that the body arrived and a files step did not:
 * `sent` holds the body and every file whose answer arrived. `uncertain` means that a request
 * may have arrived; a question then stays as the store holds it.
 */
export type Outcome =
	| { kind: 'ok'; sent?: Sent; ref?: string; status?: 'pending' | 'answered' | 'closed'; warnings: Warning[] }
	| { kind: 'dry'; steps: Step[]; warnings: Warning[] }
	| { kind: 'partial'; sent: Sent; ref?: string; failed: { step: number; class: 'refused' | 'uncertain'; reason: string }; warnings: Warning[] }
	| {
			kind: 'refused';
			code: 'shape' | 'guard' | 'unknown-ref' | 'ref-conflict' | 'closed' | 'origin' | 'chat' | 'no-listener' | 'busy' | 'server' | 'token' | 'outside-roots' | 'secret-file' | 'publish-root';
			reason: string;
	  }
	| { kind: 'uncertain'; ref?: string; reason: string };

/** A file that may leave the machine: opened once, checked on the open handle, read from it afterwards. */
export type Publishable = { path: string; type: string; size: number; stream(): ReadableStream<Uint8Array>; bytes(): Promise<Uint8Array>; close(): Promise<void> };
/** What a file reader returns for a list of paths: every file opened, or the refusal of the first that failed. */
export type Readable = { kind: 'ok'; files: Publishable[] } | { kind: 'refused'; code: 'outside-roots' | 'secret-file' | 'publish-root' | 'shape'; reason: string };

/** A view as the host stores it: 1 to 8 tabs, media referenced by index. */
export type StoredView = { v: 1; title?: string; tabs: { label: string; content: StoredContent }[] };
export type StoredContent = { markdown: string } | { diff: string } | { page: string } | { gallery: { media: number; type: string; caption?: string }[] };
/** A view ready to publish: the stored view and its media bytes, in index order. */
export type PreparedView = { view: StoredView; media: { type: string; bytes: Uint8Array }[] };
/** A view host's answer that refuses a request, such as a wrong upload key or a limit. */
export type HostRefusal = { kind: 'refused'; reason: string };

/**
 * The client of a view host. `createChat` uses `context` alone: it stores a question's body under
 * the pair of view id and ref, so the view shows the question it was opened from.
 */
export type ViewClient = {
	put(prepared: PreparedView, options?: { id?: string; ttlDays?: number }): Promise<{ kind: 'ok'; id: string; url: string; expiresAt: number } | HostRefusal | { kind: 'uncertain'; id: string; reason: string }>;
	context(id: string, ref: string, body: Body): Promise<{ kind: 'ok' } | { kind: 'missing' } | HostRefusal>;
	has(id: string): Promise<{ kind: 'present'; tabs: string[] } | { kind: 'missing' } | HostRefusal>;
	delete(id: string): Promise<{ kind: 'ok' } | { kind: 'missing' } | HostRefusal>;
};

/** A spec or body that breaks a shape check of section 8. Every caller refuses it with code `shape`. */
export class ShapeError extends Error {
	override name = 'ShapeError';
}

/**
 * A call answered HTTP 401: the bot token is rejected. A method of `createChat` stores what it
 * already decided and then rejects with it; the listener stops on it.
 */
export class TokenRefused extends Error {
	override name = 'TokenRefused';
}

/** A `Store.lock` whose lock one holder kept for 10 s of its wait. */
export class LockTimeout extends Error {
	override name = 'LockTimeout';
}

export type Store = {
	get(key: string): Promise<unknown | undefined>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
	list(prefix: string): Promise<string[]>;
	/** Runs `fn` while no other process or task holds the lock of `key`. A held lock never expires while `fn` runs. Rejects with LockTimeout when one holder kept the lock for 10 s of the wait; a lock that is free or changes hands restarts the count. */
	lock<T>(key: string, fn: () => Promise<T>): Promise<T>;
};

/**
 * Every text the human sees, each plain text of 1 to 200 characters, not all white space:
 * `mergeLabels` checks them.
 * `ack` is the reaction on an accepted reply, `hintWords` the words of the `answer-hint` warning.
 */
export type Labels = {
	yes: string;
	no: string;
	repeat: string;
	closed: string;
	unknown: string;
	forbidden: string;
	question: string;
	ack: string;
	missed: string;
	view: string;
	viewHint: string;
	viewClose: string;
	viewGone: string;
	viewExpired: string;
	viewError: string;
	allow: string;
	deny: string;
	expired: string;
	tooLong: string;
	hintWords: readonly string[];
};

/** The English labels. Frozen, with its word list, so no caller changes the labels of every other one. */
export const defaultLabels: Readonly<Labels> = Object.freeze({
	yes: 'Yes',
	no: 'No',
	repeat: 'Already answered',
	closed: 'This question is closed',
	unknown: 'This question is unknown',
	forbidden: 'You may not answer this question',
	question: 'Question',
	ack: '👍',
	missed: 'The listener was away for more than 150 s. Taps from that time are lost, tap again.',
	view: 'Open view',
	viewHint: 'Close the view to answer in the chat.',
	viewClose: 'Close',
	viewGone: 'This view is gone.',
	viewExpired: 'This view expired. Open it again from the chat.',
	viewError: 'This view could not load.',
	allow: 'Allow',
	deny: 'Deny',
	expired: 'Expired without an answer.',
	tooLong: 'This request is too long for Telegram. Answer it in the terminal.',
	hintWords: Object.freeze(['tap', 'press', 'click', 'button', 'buttons', 'reply with']),
});
