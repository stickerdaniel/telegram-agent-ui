import { arrayOf, isInt, isJson, isNat, isRecord, isString, optional, storable } from './check.ts';
import { isAnswer, isBody, isDelivery, isSent, isShown, isSpec, isUser } from './guards.ts';
import { APPLIED_WINDOW } from './reduce.ts';
import { isOrigin, metaIssue, questionBodyIssue, REF, sameForm, specIssue } from './shape.ts';
import type { Answer, Body, Question, Sent } from './types.ts';

type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & { [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined> };

function defined<T extends object>(from: T): Defined<T> {
	return Object.fromEntries(Object.entries(from).filter(([, value]) => value !== undefined)) as Defined<T>;
}

export function parseQuestion(value: unknown): Question | undefined {
	if (!storable(value) || !isRecord(value) || value.v !== 1) return undefined;
	const { ref, spec, chat, topic, viewOrigin, allow, expiresAt, seq, applied, shown, delivery, meta, createdAt, status, bindingOwed } = value;
	if (!isString(ref) || !REF.test(ref) || !isSpec(spec) || !isInt(chat) || !optional(isInt)(topic) || !optional(isString)(viewOrigin)) return undefined;
	if (!arrayOf(isInt)(allow) || !optional(isNat)(expiresAt) || !isNat(seq) || !isNat(createdAt) || !optional(isJson)(meta) || (meta !== undefined && metaIssue(meta) !== undefined)) return undefined;
	if (!arrayOf(isString)(applied) || applied.length > APPLIED_WINDOW) return undefined;
	if (!isShown(shown) || shown.done > shown.want || !isDelivery(delivery) || delivery.seq > seq) return undefined;
	const answerSpec = spec.answer;
	if (!answerSpec || specIssue(spec) !== undefined) return undefined;
	if ((viewOrigin !== undefined) !== (spec.view !== undefined) || (viewOrigin !== undefined && !isOrigin(viewOrigin))) return undefined;

	const isOwnSent = (value: unknown): value is Sent =>
		isSent(value) && value.chat === chat && value.ref === ref && value.message > 0 && value.view?.id === spec.view && value.view?.origin === viewOrigin;
	const isOwnAnswer = (value: unknown): value is Answer =>
		isAnswer(value) && (value.kind === 'text' ? answerSpec.type === 'text' : answerSpec.type === 'choice' && value.index < answerSpec.options.length);
	const { sent, answer, by, answeredAt, previous, resolved } = value;
	if (!optional(isOwnSent)(sent) || !optional(isOwnAnswer)(answer) || !optional(isOwnAnswer)(previous) || !optional(isUser)(by) || !optional(isNat)(answeredAt)) return undefined;
	if (!optional((body: unknown): body is Body => isBody(body) && sameForm(body, spec.body) && questionBodyIssue(body) === undefined)(resolved)) return undefined;
	if (answer !== undefined && sent === undefined) return undefined;
	if ((answer === undefined) !== (by === undefined) || (answer === undefined) !== (answeredAt === undefined)) return undefined;
	if (previous !== undefined && (answer === undefined || seq < 2)) return undefined;
	if (bindingOwed !== undefined && (bindingOwed !== true || status !== 'closed')) return undefined;

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
			return (answer !== undefined) === seq >= 1 ? { ...common, status, ...defined({ sent, resolved, answer, by, answeredAt, previous }), ...(bindingOwed === true ? { bindingOwed } : {}) } : undefined;
		default:
			return undefined;
	}
}
