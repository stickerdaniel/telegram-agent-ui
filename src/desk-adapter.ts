import records from './desk-ledger.json';
import { CHAT, reply, tap, USER } from './fixtures.ts';
import type { Option, Question, QuestionEvent, Sent, Update } from './core/types.ts';

type Keyboard = { inline_keyboard: { text: string; callback_data?: string }[][] };
type Envelope = { message_id: number; date: number; edit_date?: number; text: string; caption?: string; reply_to?: { message_id: number } };

export type DeskRecord = { at: string } & (
	| { type: 'msg_pending'; msg: number; parts: string[]; keyboard?: Keyboard; view?: string; topic?: number; silent?: true }
	| { type: 'msg_part_delivered'; msg: number; part: number; messageId: number; date: number }
	| { type: 'msg_failed'; msg: number; part: number; error: string; uncertain?: boolean }
	| { type: 'msg_edited'; messageId: number; html?: string; keyboard?: Keyboard; resolved?: true }
	| { type: 'update_received'; updateId: number; kind: 'callback_query'; callback: { id: string; data?: string; messageId?: number } }
	| { type: 'update_received'; updateId: number; kind: 'message' | 'edited_message'; envelope: Envelope }
	| { type: 'choice_received'; updateId: number; choice: { message_id: number; choice: number; label: string; corrects?: string } }
	| { type: 'callback_decided'; updateId: number; action: string; reason?: string; toast: string }
);

export const deskRecords = records as DeskRecord[];

const CHOICE = /^c:([0-9a-z]+):([0-9a-z]+)$/;
const QUOTE = '<blockquote expandable>';

export type Driven = { record: DeskRecord; ref: string; now: number; event: QuestionEvent };

export function deskEvents(ledger: DeskRecord[]): Driven[] {
	const asked = new Map<number, { ref: string; parts: number; placed: Pick<Sent, 'topic' | 'view'> }>();
	const messages = new Map<number, string>();
	return ledger.flatMap((record): Driven[] => {
		const now = Date.parse(record.at);
		const at = (ref: string, event: QuestionEvent): Driven[] => [{ record, ref, now, event }];
		switch (record.type) {
			case 'msg_pending': {
				const question = specOf(record);
				if (!question) return [];
				const { spec, ref, viewOrigin } = question;
				asked.set(record.msg, {
					ref,
					parts: record.parts.length,
					placed: { ...(record.topic !== undefined ? { topic: record.topic } : {}), ...(spec.view !== undefined && viewOrigin ? { view: { id: spec.view, origin: viewOrigin } } : {}) },
				});
				return at(ref, { type: 'ask', spec, ref, chat: CHAT, allow: [USER], ...(viewOrigin ? { viewOrigin } : {}), ...(record.topic !== undefined ? { topic: record.topic } : {}), meta: { msg: record.msg } });
			}
			case 'msg_part_delivered': {
				const question = asked.get(record.msg);
				if (!question || record.part !== question.parts - 1) return [];
				messages.set(record.messageId, question.ref);
				return at(question.ref, { type: 'sent', sent: { chat: CHAT, message: record.messageId, files: [], ref: question.ref, ...question.placed } });
			}
			case 'msg_edited': {
				const ref = messages.get(record.messageId);
				if (!ref || record.html === undefined) return [];
				const quote = record.html.indexOf(QUOTE);
				const removed = record.keyboard?.inline_keyboard.length === 0;
				if (quote >= 0 && (record.resolved || removed)) return at(ref, { type: 'close', body: { html: record.html.slice(0, quote).trimEnd() } });
				return at(ref, removed ? { type: 'close', body: { html: record.html } } : { type: 'edit', body: { html: record.html } });
			}
			case 'update_received': {
				if (record.kind === 'callback_query') {
					const choice = CHOICE.exec(record.callback.data ?? '');
					const message = record.callback.messageId;
					if (!choice?.[1] || !choice[2] || message === undefined) return [];
					return at(choice[1], { type: 'input', update: { ...tap({ ref: choice[1], button: Number.parseInt(choice[2], 36), id: record.callback.id, message, inaccessible: true }), update_id: record.updateId } });
				}
				const replyTo = record.envelope.reply_to?.message_id;
				const ref = replyTo === undefined ? undefined : messages.get(replyTo);
				return ref && replyTo !== undefined ? at(ref, { type: 'input', update: replyUpdate(record.updateId, record.kind, record.envelope, replyTo) }) : [];
			}
			default:
				return [];
		}
	});
}

function specOf(record: Extract<DeskRecord, { type: 'msg_pending' }>): { spec: Question['spec']; ref: string; viewOrigin?: string } | undefined {
	const body = { html: record.parts.at(-1) ?? '' };
	const view = record.view === undefined ? undefined : new URL(record.view);
	const viewId = view?.searchParams.get('v') ?? undefined;
	const extras = { ...(viewId ? { view: viewId } : {}), ...(record.silent ? { silent: true } : {}) };
	const buttons = record.keyboard?.inline_keyboard.flat() ?? [];
	const keyboard = buttons.map((button) => CHOICE.exec(button.callback_data ?? '')?.[1]).find((id) => id !== undefined);
	const at = { ...(view && viewId ? { viewOrigin: view.origin } : {}) };
	if (keyboard) {
		const options: Option[] = buttons.map((button) => ({ label: button.text }));
		return { spec: { body, ...extras, answer: { type: 'choice', options } }, ref: keyboard, ...at };
	}
	if (!body.html.trimEnd().endsWith('?')) return undefined;
	return { spec: { body, ...extras, answer: { type: 'text' } }, ref: `m${record.msg}`, ...at };
}

function replyUpdate(updateId: number, kind: 'message' | 'edited_message', envelope: Envelope, replyTo: number): Update {
	const update = reply({ id: envelope.message_id, replyTo, markupRef: null, text: envelope.text === '' ? null : envelope.text, ...(envelope.caption !== undefined ? { caption: envelope.caption } : {}) });
	const message = update.message;
	if (!message) throw new Error('unreachable: reply() has a message');
	message.date = envelope.date;
	if (kind === 'message') return { ...update, update_id: updateId };
	return { update_id: updateId, edited_message: { ...message, edit_date: envelope.edit_date ?? envelope.date } };
}

export function deskOutcome(ledger: DeskRecord[], updateId: number): string | undefined {
	if (ledger.some((record) => record.type === 'choice_received' && record.updateId === updateId)) return 'answered';
	const decided = ledger.find((record) => record.type === 'callback_decided' && record.updateId === updateId);
	const reasons: Record<string, string> = {
		'answer keyboard already tapped': 'repeat',
		'answer button no longer on the message': 'closed',
		'answer button on an unknown message': 'unknown',
	};
	return decided?.type === 'callback_decided' && decided.reason !== undefined ? reasons[decided.reason] : undefined;
}
