// The runtime predicates of the core's stored types. `parseQuestion` builds a question from
// them, and `reduce` checks every event and its context with the same ones, so a state that
// `reduce` returns always parses.
import { arrayOf, isBool, isInt, isNat, isRecord, isString, oneOf, optional, storable } from './check.ts';
import { isBlocks } from './rich.ts';
import type { Answer, AnswerSpec, Attachment, Body, CallClass, Option, Question, Sent, Spec, User } from './types.ts';

export function isBody(value: unknown): value is Body {
	if (!isRecord(value) || Object.keys(value).length !== 1) return false;
	if ('markdown' in value) return isString(value.markdown);
	if ('html' in value) return isString(value.html);
	// JSON first: the block checks recurse, and a cycle or a non-JSON extension field must fail before them.
	return storable(value.blocks) && isBlocks(value.blocks);
}

const isOption = (value: unknown): value is Option =>
	isRecord(value) && isString(value.label) && optional(isString)(value.value) && optional(oneOf('primary', 'danger'))(value.style) && optional(isString)(value.tab);

function isAnswerSpec(value: unknown): value is AnswerSpec {
	if (!isRecord(value) || !optional(isBool)(value.once)) return false;
	if (value.type === 'text') return true;
	return value.type === 'choice' && arrayOf(isOption)(value.options) && optional(oneOf('rows', 'row'))(value.layout);
}

const isAttachment = (value: unknown): value is Attachment =>
	isRecord(value) && isString(value.path) && optional(oneOf('photo', 'video', 'document'))(value.as) && optional(isString)(value.caption);

export const isSpec = (value: unknown): value is Spec =>
	isRecord(value) &&
	isBody(value.body) &&
	optional(isAnswerSpec)(value.answer) &&
	optional(arrayOf(isAttachment))(value.attach) &&
	optional(isString)(value.view) &&
	optional(isBool)(value.silent);

const isView = (value: unknown): value is { id: string; origin: string } => isRecord(value) && isString(value.id) && isString(value.origin);

export const isSent = (value: unknown): value is Sent =>
	isRecord(value) &&
	isInt(value.chat) &&
	optional(isInt)(value.topic) &&
	isInt(value.message) &&
	value.message > 0 &&
	arrayOf(isInt)(value.files) &&
	optional(isString)(value.ref) &&
	optional(isView)(value.view);

export function isAnswer(value: unknown): value is Answer {
	if (!isRecord(value)) return false;
	if (value.kind === 'text') return isString(value.text);
	return value.kind === 'choice' && isNat(value.index) && isString(value.label) && optional(isString)(value.value);
}

export const isUser = (value: unknown): value is User => isRecord(value) && isInt(value.id) && optional(isString)(value.name);

export const isShown = (value: unknown): value is Question['shown'] =>
	isRecord(value) && isNat(value.want) && isNat(value.done) && isNat(value.failures) && optional(isNat)(value.retryAt) && optional(isNat)(value.recheckAt) && optional(isString)(value.error);

export const isDelivery = (value: unknown): value is Question['delivery'] => isRecord(value) && isNat(value.seq) && isNat(value.attempts) && optional(isString)(value.error);

export function isCallClass(value: unknown): value is CallClass {
	if (!isRecord(value)) return false;
	switch (value.kind) {
		case 'ok':
			return 'result' in value;
		case 'unchanged':
		case 'uncertain':
			return true;
		case 'refused':
			return oneOf('server', 'token')(value.code) && isString(value.reason);
		case 'retry':
			return optional(isNat)(value.at);
		default:
			return false;
	}
}
