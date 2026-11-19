import type { InputRichBlock, Update } from '@grammyjs/types';

export type { Update };

export type Body = { markdown: string } | { html: string } | { blocks: InputRichBlock<never>[] };

export type Spec = {
	body: Body;
	answer?: AnswerSpec;
	attach?: Attachment[];
	view?: string;
	silent?: boolean;
};

export type AnswerSpec = { type: 'choice'; options: Option[]; layout?: 'rows' | 'row'; once?: boolean; in?: 'chat' | 'view' } | { type: 'text'; once?: boolean };
export type Option = { label: string; value?: string; style?: 'primary' | 'danger'; tab?: string };
export type Attachment = { path: string; as?: 'photo' | 'video' | 'document'; caption?: string };

export type Sent = { chat: number; topic?: number; message: number; files: number[]; ref?: string; view?: { id: string; origin: string } };

export type Answer = { kind: 'choice'; index: number; label: string; value?: string } | { kind: 'text'; text: string };
export type User = { id: number; name?: string };
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Question = {
	v: 1;
	ref: string;
	spec: Spec & { answer: AnswerSpec };
	chat: number;
	topic?: number;
	viewOrigin?: string;
	allow: number[];
	expiresAt?: number;
	seq: number;
	applied: string[];
	shown: { want: number; done: number; failures: number; retryAt?: number; recheckAt?: number; error?: string };
	delivery: { seq: number; attempts: number; error?: string };
	meta?: Json;
	bindingOwed?: true;
	createdAt: number;
} & (
	| { status: 'sending' }
	| { status: 'open'; sent: Sent }
	| { status: 'answered'; sent: Sent; answer: Answer; by: User; answeredAt: number; previous?: Answer }
	| { status: 'closed'; sent?: Sent; resolved?: Body; answer?: Answer; by?: User; answeredAt?: number; previous?: Answer }
);

export type CallResponse = { ok: true; result: unknown } | { ok: false; status: number; description: string; retryAfter?: number } | { noAnswer: true };
export type CallClass = { kind: 'ok'; result: unknown } | { kind: 'unchanged' } | { kind: 'refused'; code: 'server' | 'token'; reason: string } | { kind: 'retry'; at?: number } | { kind: 'uncertain' };

export type QuestionEvent =
	| { type: 'ask'; spec: Question['spec']; ref: string; chat: number; topic?: number; viewOrigin?: string; allow: number[]; expiresAt?: number; meta?: Json }
	| { type: 'sent'; sent: Sent }
	| { type: 'input'; update: Update }
	| { type: 'edit'; body: Body }
	| { type: 'close'; body?: Body }
	| { type: 'shown'; want: number; outcome: CallClass }
	| { type: 'delivered'; seq: number; error?: string }
	| { type: 'choice'; id: string; user: User; index: number; at: number };

export type ChoiceBinding = { options: { index: number; label: string; tab: string }[]; once: boolean; expiresAt?: number; closed?: boolean };
export type StoredChoice = { key: string; view: string; ref: string; id: string; index: number; user: User; at: number };

export type Handled =
	| { kind: 'ignored' }
	| { kind: 'stale'; reason: 'unknown' | 'closed' | 'forbidden' | 'repeat' }
	| { kind: 'answered'; ref: string; seq: number; answer: Answer; by: User; at: number; previous?: Answer; meta?: Json };

export type Call = { method: string; payload: Record<string, unknown>; files?: { field: string; path: string }[] };
export type Step = { call: Call; role: 'body' | 'files' };

export type Warning = {
	code: 'no-question-mark' | 'table-candidate' | 'answer-hint' | 'unconfirmed-message' | 'not-shown' | 'event-handler' | 'link' | 'remote-image';
	message: string;
};

export type Outcome =
	| { kind: 'ok'; sent?: Sent; ref?: string; status?: 'pending' | 'answered' | 'closed'; warnings: Warning[] }
	| { kind: 'dry'; steps: Step[]; warnings: Warning[] }
	| { kind: 'partial'; sent: Sent; ref?: string; failed: { step: number; class: 'refused' | 'uncertain'; reason: string }; warnings: Warning[] }
	| {
			kind: 'refused';
			code: 'shape' | 'guard' | 'unknown-ref' | 'ref-conflict' | 'closed' | 'origin' | 'chat' | 'no-listener' | 'busy' | 'server' | 'token' | 'outside-roots' | 'secret-file' | 'publish-root' | 'view-host';
			reason: string;
	  }
	| { kind: 'uncertain'; ref?: string; reason: string };

export type Publishable = { path: string; type: string; size: number; stream(): ReadableStream<Uint8Array>; bytes(): Promise<Uint8Array>; close(): Promise<void> };
export type Readable = { kind: 'ok'; files: Publishable[] } | { kind: 'refused'; code: 'outside-roots' | 'secret-file' | 'publish-root' | 'shape'; reason: string };

export type StoredView = { v: 1; title?: string; tabs: { label: string; content: StoredContent }[] };
export type StoredContent = { markdown: string; media?: Record<string, number> } | { diff: string } | { page: string } | { gallery: { media: number; type: string; caption?: string }[] };
export type PreparedView = { view: StoredView; media: { type: string; bytes: Uint8Array }[] };
export type HostRefusal = { kind: 'refused'; reason: string; status?: number };

export type ViewClient = {
	put(prepared: PreparedView, options?: { id?: string; ttlDays?: number }): Promise<{ kind: 'ok'; id: string; url: string; expiresAt: number } | HostRefusal | { kind: 'uncertain'; id: string; reason: string }>;
	context(id: string, ref: string, body: Body, choice?: ChoiceBinding): Promise<{ kind: 'ok' } | { kind: 'missing' } | HostRefusal>;
	has(id: string): Promise<{ kind: 'present'; tabs: string[]; expiresAt: number } | { kind: 'missing' } | HostRefusal>;
	delete(id: string): Promise<{ kind: 'ok' } | { kind: 'missing' } | HostRefusal>;
	version(): Promise<{ kind: 'ok'; formats: string[] } | HostRefusal>;
	choices(): Promise<{ kind: 'ok'; choices: StoredChoice[] } | HostRefusal>;
	removeChoice(key: string): Promise<{ kind: 'ok' } | HostRefusal>;
};

export class ShapeError extends Error {
	override name = 'ShapeError';
}

export class TokenRefused extends Error {
	override name = 'TokenRefused';
}

export class LockTimeout extends Error {
	override name = 'LockTimeout';
}

export type Store = {
	get(key: string): Promise<unknown | undefined>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
	list(prefix: string): Promise<string[]>;
	lock<T>(key: string, fn: () => Promise<T>, options?: { wait?: number }): Promise<T>;
};

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
	viewGone: string;
	viewExpired: string;
	viewError: string;
	allow: string;
	deny: string;
	expired: string;
	tooLong: string;
	choose: string;
	chosen: string;
	viewLate: string;
	hintWords: readonly string[];
};

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
	viewGone: 'This view is gone.',
	viewExpired: 'This view expired. Open it again from the chat.',
	viewError: 'This view could not load.',
	allow: 'Allow',
	deny: 'Deny',
	expired: 'Expired without an answer.',
	tooLong: 'This request is too long for Telegram. Answer it in the terminal.',
	choose: 'Choose',
	chosen: 'Sent. It shows on the message once applied.',
	viewLate: 'This question is not on the view yet. Close the view and open it again in a moment.',
	hintWords: Object.freeze(['tap', 'press', 'click', 'button', 'buttons', 'reply with']),
});
