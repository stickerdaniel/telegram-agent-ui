import type { InlineKeyboardButton } from '@grammyjs/types';
import { checkLabels } from './labels.ts';
import { checkSpec, messageBodyIssue, specWarnings } from './shape.ts';
import { type AnswerSpec, type Attachment, type Body, type Call, type ChoiceBinding, defaultLabels, type Labels, type Question, type Sent, ShapeError, type Spec, type Step, type Warning } from './types.ts';

export const callbackData = (ref: string, index: number) => `q:${ref}:${index}`;

export function viewUrl(view: { id: string; origin: string }, ref?: string, tab?: string): string {
	const url = new URL('/', view.origin);
	url.searchParams.set('v', view.id);
	if (ref !== undefined) url.searchParams.set('q', ref);
	if (tab !== undefined) url.searchParams.set('t', tab);
	return url.href;
}

export const inView = (answer: AnswerSpec | undefined) => answer?.type === 'choice' && answer.in === 'view';

export function bindingOf(question: Pick<Question, 'spec' | 'expiresAt' | 'status'>): ChoiceBinding | undefined {
	const { answer } = question.spec;
	if (answer.type !== 'choice' || answer.in !== 'view') return undefined;
	const options = answer.options.flatMap((option, index) => (option.tab !== undefined ? [{ index, label: option.label, tab: option.tab }] : []));
	return {
		options,
		once: answer.once === true,
		...(question.expiresAt !== undefined ? { expiresAt: question.expiresAt } : {}),
		...(question.status === 'closed' ? { closed: true } : {}),
	};
}

function answerRows(ref: string, answer: AnswerSpec, picked: number | undefined, onlyPicked: boolean): InlineKeyboardButton[][] {
	if (answer.type !== 'choice' || answer.in === 'view') return [];
	const buttons = answer.options.flatMap((option, index): InlineKeyboardButton[] => {
		if (onlyPicked && index !== picked) return [];
		const text = index === picked ? `✓ ${option.label}` : option.label;
		return [{ text, callback_data: callbackData(ref, index), ...(option.style ? { style: option.style } : {}) }];
	});
	if (buttons.length === 0) return [];
	return answer.layout === 'row' ? [buttons] : buttons.map((button) => [button]);
}

const viewRow = (view: { id: string; origin: string }, labels: Labels, ref?: string, tab?: string, text = labels.view): InlineKeyboardButton[] => [{ text, web_app: { url: viewUrl(view, ref, tab) } }];

const markup = (rows: InlineKeyboardButton[][]) => (rows.length > 0 ? { reply_markup: { inline_keyboard: rows } } : {});

type Kind = 'photo' | 'video' | 'document';
const PHOTO = /\.(png|jpe?g|webp)$/i;
const VIDEO = /\.mp4$/i;
export const kindOf = (file: Attachment): Kind => file.as ?? (PHOTO.test(file.path) ? 'photo' : VIDEO.test(file.path) ? 'video' : 'document');

const METHOD = { photo: 'sendPhoto', video: 'sendVideo', document: 'sendDocument' } as const;

function filesCall(group: { file: Attachment; kind: Kind }[], base: Record<string, unknown>): Call {
	const [only] = group;
	if (group.length === 1 && only) {
		const { file, kind } = only;
		return {
			method: METHOD[kind],
			payload: { ...base, ...(file.caption !== undefined ? { caption: file.caption } : {}), ...(kind === 'video' ? { supports_streaming: true } : {}) },
			files: [{ field: kind, path: file.path }],
		};
	}
	const media = group.map(({ file, kind }, index) => ({
		type: kind,
		media: `attach://file${index}`,
		...(file.caption !== undefined ? { caption: file.caption } : {}),
		...(kind === 'video' ? { supports_streaming: true } : {}),
	}));
	return { method: 'sendMediaGroup', payload: { ...base, media }, files: group.map(({ file }, index) => ({ field: `file${index}`, path: file.path })) };
}

export function render(spec: Spec, at: { chat: number; topic?: number; ref?: string; viewOrigin?: string; labels?: Labels }): { steps: Step[]; warnings: Warning[] } {
	checkSpec(spec, at);
	const labels = at.labels ? checkLabels(at.labels) : defaultLabels;
	const base = { chat_id: at.chat, ...(at.topic !== undefined ? { message_thread_id: at.topic } : {}), ...(spec.silent ? { disable_notification: true } : {}) };
	const rows = [
		...(spec.answer && at.ref !== undefined ? answerRows(at.ref, spec.answer, undefined, false) : []),
		...(spec.view !== undefined && at.viewOrigin !== undefined ? [viewRow({ id: spec.view, origin: at.viewOrigin }, labels, at.ref)] : []),
	];
	const steps: Step[] = [{ role: 'body', call: { method: 'sendRichMessage', payload: { ...base, rich_message: spec.body, ...markup(rows) } } }];
	const files = (spec.attach ?? []).map((file) => ({ file, kind: kindOf(file) }));
	for (const group of [files.filter(({ kind }) => kind !== 'document'), files.filter(({ kind }) => kind === 'document')]) {
		if (group.length > 0) steps.push({ role: 'files', call: filesCall(group, base) });
	}
	return { steps, warnings: specWarnings(spec, labels) };
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const escapeMarkdown = (text: string) => text.replace(/[&<>\\`*_[\]()#|~!]/g, (char) => ENTITIES[char] ?? `\\${char}`);

export function bodyLike(like: Body, text: string): Body {
	if ('blocks' in like) return { blocks: [{ type: 'paragraph', text }] };
	if ('html' in like) return { html: escapeHtml(text) };
	return { markdown: escapeMarkdown(text) };
}

function resolvedBody(original: Body, resolved: Body, labels: Labels): Body {
	const summary = escapeHtml(labels.question);
	const composed = (): Body => {
		if ('blocks' in original && 'blocks' in resolved) return { blocks: [...resolved.blocks, { type: 'details', summary: labels.question, blocks: original.blocks }] };
		if ('html' in original && 'html' in resolved) return { html: `${resolved.html}\n\n<details><summary>${summary}</summary>${original.html}</details>` };
		if ('markdown' in original && 'markdown' in resolved) return { markdown: `${resolved.markdown}\n\n<details><summary>${summary}</summary>\n\n${original.markdown}\n\n</details>` };
		throw new ShapeError('a resolved body needs the form of the question body');
	};
	const whole = composed();
	return messageBodyIssue(whole) ? resolved : whole;
}

export function renderEdit(target: { sent: Sent; body: Body } | Question, labels: Labels = defaultLabels): Call {
	if (labels !== defaultLabels) checkLabels(labels);
	if (!('v' in target)) {
		const { sent, body } = target;
		const issue = messageBodyIssue(body);
		if (issue) throw new ShapeError(issue);
		const rows = sent.view ? [viewRow(sent.view, labels, sent.ref)] : [];
		return { method: 'editMessageText', payload: { chat_id: sent.chat, message_id: sent.message, rich_message: body, ...markup(rows) } };
	}
	const question = target;
	const sent = 'sent' in question ? question.sent : undefined;
	if (!sent) throw new Error(`question ${question.ref} has no known message yet`);
	const { spec } = question;
	const answer = 'answer' in question ? question.answer : undefined;
	const picked = answer?.kind === 'choice' ? answer.index : undefined;
	const option = picked !== undefined && spec.answer.type === 'choice' ? spec.answer.options[picked] : undefined;
	const closed = question.status === 'closed';
	const resolved = question.status === 'closed' ? question.resolved : undefined;
	const viewText = option && inView(spec.answer) ? `✓ ${option.label}` : labels.view;
	const rows = [
		...(resolved || (closed && picked === undefined) ? [] : answerRows(question.ref, spec.answer, picked, closed)),
		...(sent.view ? [viewRow(sent.view, labels, question.ref, option?.tab, viewText)] : []),
	];
	const body = resolved ? resolvedBody(spec.body, resolved, labels) : spec.body;
	const issue = messageBodyIssue(body);
	if (issue) throw new ShapeError(issue);
	return { method: 'editMessageText', payload: { chat_id: sent.chat, message_id: sent.message, rich_message: body, ...markup(rows) } };
}
