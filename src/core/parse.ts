// `parseQuestion` is the one door from a store to a question. It checks the type field by
// field and then the rules of 4.2 that the type cannot say, and returns a fresh object that
// holds the known fields only.
import { arrayOf, isInt, isJson, isNat, isRecord, isString, optional, storable } from './check.ts';
import { isAnswer, isBody, isDelivery, isSent, isShown, isSpec, isUser } from './guards.ts';
import { APPLIED_WINDOW } from './reduce.ts';
import { isOrigin, metaIssue, questionBodyIssue, REF, sameForm, specIssue } from './shape.ts';
import type { Answer, Body, Question, Sent } from './types.ts';

/** `T` with every field that may be undefined made optional and never undefined, as stored JSON holds it. */
type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & { [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined> };

/** Drops the fields of `from` that are undefined. */
function defined<T extends object>(from: T): Defined<T> {
	return Object.fromEntries(Object.entries(from).filter(([, value]) => value !== undefined)) as Defined<T>;
}

/**
 * A stored value to a question. Undefined for anything that breaks the type or one of the
 * rules of 4.2: the spec passes the shape checks, `viewOrigin` exactly with a view, an answer
 * of the question's kind on an existing option, an answer only on a known message, `seq` and
 * the answer fields in step, bounded counters, and a `Sent` that names this question.
 *
 *   const question = parseQuestion(await store.get(`q:${ref}`));
 */
export function parseQuestion(value: unknown): Question | undefined {
	// JSON first: a cycle, a hole or a non-JSON value fails here, before any check recurses.
	if (!storable(value) || !isRecord(value) || value.v !== 1) return undefined;
	const { ref, spec, chat, topic, viewOrigin, allow, expiresAt, seq, applied, shown, delivery, meta, createdAt, status } = value;
	if (!isString(ref) || !REF.test(ref) || !isSpec(spec) || !isInt(chat) || !optional(isInt)(topic) || !optional(isString)(viewOrigin)) return undefined;
	if (!arrayOf(isInt)(allow) || !optional(isNat)(expiresAt) || !isNat(seq) || !isNat(createdAt) || !optional(isJson)(meta) || (meta !== undefined && metaIssue(meta) !== undefined)) return undefined;
	if (!arrayOf(isString)(applied) || applied.length > APPLIED_WINDOW) return undefined;
	if (!isShown(shown) || shown.done > shown.want || !isDelivery(delivery) || delivery.seq > seq) return undefined;
	const answerSpec = spec.answer;
	if (!answerSpec || specIssue(spec) !== undefined) return undefined;
	if ((viewOrigin !== undefined) !== (spec.view !== undefined) || (viewOrigin !== undefined && !isOrigin(viewOrigin))) return undefined;

	// A `Sent` names this question's chat, ref and view. An answer is of the question's kind and names an option.
	const isOwnSent = (value: unknown): value is Sent =>
		isSent(value) && value.chat === chat && value.ref === ref && value.message > 0 && value.view?.id === spec.view && value.view?.origin === viewOrigin;
	const isOwnAnswer = (value: unknown): value is Answer =>
		isAnswer(value) && (value.kind === 'text' ? answerSpec.type === 'text' : answerSpec.type === 'choice' && value.index < answerSpec.options.length);
	const { sent, answer, by, answeredAt, previous, resolved } = value;
	if (!optional(isOwnSent)(sent) || !optional(isOwnAnswer)(answer) || !optional(isOwnAnswer)(previous) || !optional(isUser)(by) || !optional(isNat)(answeredAt)) return undefined;
	// A resolved body has the form of the question body, so the edit that shows it can be composed.
	if (!optional((body: unknown): body is Body => isBody(body) && sameForm(body, spec.body) && questionBodyIssue(body) === undefined)(resolved)) return undefined;
	// An answer arrives on a message and comes with its user and time. `previous` needs a correction.
	if (answer !== undefined && sent === undefined) return undefined;
	if ((answer === undefined) !== (by === undefined) || (answer === undefined) !== (answeredAt === undefined)) return undefined;
	if (previous !== undefined && (answer === undefined || seq < 2)) return undefined;

	const common = { v: 1 as const, ref, spec: { ...spec, answer: answerSpec }, chat, allow, seq, applied, shown, delivery, createdAt, ...defined({ topic, viewOrigin, expiresAt, meta }) };
	switch (status) {
		case 'sending':
			return sent === undefined && answer === undefined && resolved === undefined && seq === 0 ? { ...common, status } : undefined;
		case 'open':
			return sent !== undefined && answer === undefined && resolved === undefined && seq === 0 ? { ...common, status, sent } : undefined;
		case 'answered':
			return sent !== undefined && answer !== undefined && by !== undefined && answeredAt !== undefined && resolved === undefined && seq >= 1
				? { ...common, status, sent, answer, by, answeredAt, ...defined({ previous }) }
				: undefined;
		case 'closed':
			return (answer !== undefined) === seq >= 1 ? { ...common, status, ...defined({ sent, resolved, answer, by, answeredAt, previous }) } : undefined;
		default:
			return undefined;
	}
}
