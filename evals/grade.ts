import { isInt, isRecord, isString } from '../src/core/check.ts';
import { isBody } from '../src/core/guards.ts';
import { bodyLike, renderEdit } from '../src/core/render.ts';
import { plainLines, specWarnings } from '../src/core/shape.ts';
import { type AnswerSpec, type Body, defaultLabels, type Question } from '../src/core/types.ts';

export type Expectation =
	| { kind: 'none' }
	| { kind: 'message' }
	| { kind: 'status'; edits: number }
	| { kind: 'question'; answer: 'choice' | 'yesNo' | 'text'; options?: number; tabs?: boolean }
	| { kind: 'view'; tabs: number; sources?: string[] }
	| { kind: 'never'; text: string };

export type Recorded = { method: string; payload: Record<string, unknown>; files: string[]; response: unknown; command?: string };

export type RecordedView = { method: string; path: string; status: number; body?: unknown };

type Published = { id: string; tabs: { label: string; text?: string }[]; deleted: boolean };

type Message = { index: number; id: number; body: Body; buttons: string[]; opens: string[]; silent: boolean; question?: Question };

export function parseCalls(text: string): Recorded[] {
	return text
		.split('\n')
		.filter((line) => line.trim() !== '')
		.flatMap((line): Recorded[] => {
			const value: unknown = JSON.parse(line);
			if (!isRecord(value) || !isString(value.method) || !isRecord(value.payload)) return [];
			const files = Array.isArray(value.files) ? value.files.filter(isString) : [];
			return [{ method: value.method, payload: value.payload, files, response: value.response, ...(isString(value.command) ? { command: value.command } : {}) }];
		});
}

export function parseViewCalls(text: string): RecordedView[] {
	return text
		.split('\n')
		.filter((line) => line.trim() !== '')
		.flatMap((line): RecordedView[] => {
			const value: unknown = JSON.parse(line);
			if (!isRecord(value) || !isString(value.method) || !isString(value.path) || !isInt(value.status)) return [];
			return [{ method: value.method, path: value.path, status: value.status, ...('body' in value ? { body: value.body } : {}) }];
		});
}

function textOf(content: unknown): string | undefined {
	if (!isRecord(content)) return undefined;
	const text = content.markdown ?? content.page ?? content.diff;
	return isString(text) ? text : undefined;
}

function publishedOf(views: readonly RecordedView[]): Published[] {
	const byId = new Map<string, Published>();
	for (const request of views) {
		const id = /^\/api\/view\/([A-Za-z0-9_-]{22})$/.exec(request.path)?.[1];
		if (id === undefined || request.status !== 200) continue;
		const known = byId.get(id);
		if (request.method === 'DELETE' && known) known.deleted = true;
		const view = isRecord(request.body) && isRecord(request.body.view) ? request.body.view : undefined;
		if (request.method !== 'PUT' || !view || !Array.isArray(view.tabs)) continue;
		const tabs = view.tabs.flatMap((tab: unknown) => {
			const text = isRecord(tab) ? textOf(tab.content) : undefined;
			return isRecord(tab) && isString(tab.label) ? [{ label: tab.label, ...(text !== undefined ? { text } : {}) }] : [];
		});
		byId.set(id, { id, tabs, deleted: false });
	}
	return [...byId.values()];
}

const labelsOf = (view: Published) => view.tabs.map((tab) => tab.label);

function missingSources(view: Published, sources: readonly string[], files: Readonly<Record<string, string>>): string[] {
	const free = [...view.tabs];
	return sources.filter((source) => {
		const at = free.findIndex((tab) => tab.text !== undefined && tab.text === files[source]);
		if (at === -1) return true;
		free.splice(at, 1);
		return false;
	});
}

const buttonsOf = (markup: unknown): unknown[] => (isRecord(markup) && Array.isArray(markup.inline_keyboard) ? markup.inline_keyboard.flatMap((row: unknown) => (Array.isArray(row) ? row : [])) : []);

const answerButtons = (markup: unknown): string[] => buttonsOf(markup).flatMap((button) => (isRecord(button) && isString(button.callback_data) && isString(button.text) ? [button.text] : []));

const viewUrls = (markup: unknown): URL[] =>
	buttonsOf(markup).flatMap((button) => (isRecord(button) && isRecord(button.web_app) && isString(button.web_app.url) && URL.canParse(button.web_app.url) ? [new URL(button.web_app.url)] : []));

const viewsOpened = (markup: unknown): string[] => viewUrls(markup).flatMap((url) => url.searchParams.get('v') ?? []);

const took = (call: Recorded) => isRecord(call.response) && call.response.ok === true;

function messagesOf(calls: readonly Recorded[], questions: readonly Question[]): Message[] {
	return calls.flatMap((call, index): Message[] => {
		const { method, payload, response } = call;
		if (method !== 'sendRichMessage' || !isBody(payload.rich_message) || !took(call)) return [];
		const result = isRecord(response) && isRecord(response.result) ? response.result : undefined;
		if (!result || !isInt(result.message_id)) return [];
		const id = result.message_id;
		const question = questions.find((stored) => 'sent' in stored && stored.sent?.message === id);
		return [{ index, id, body: payload.rich_message, buttons: answerButtons(payload.reply_markup), opens: viewsOpened(payload.reply_markup), silent: payload.disable_notification === true, ...(question ? { question } : {}) }];
	});
}

const editsOf = (calls: readonly Recorded[], message: Message) =>
	calls.flatMap((call) =>
		call.method === 'editMessageText' && call.payload.message_id === message.id && took(call) && isBody(call.payload.rich_message) ? [{ body: call.payload.rich_message, markup: call.payload.reply_markup, command: call.command }] : [],
	);

const isYesNo = (message: Message) => message.buttons.length === 2 && message.buttons[0] === defaultLabels.yes && message.buttons[1] === defaultLabels.no;
const plain = (message: Message) => message.buttons.length === 0 && !message.silent && !message.question;

const preview = (body: Body) => ('markdown' in body ? body.markdown : 'html' in body ? body.html : plainLines(body).join(' ')).replace(/\s+/g, ' ').slice(0, 60);

const MARK = 'telegram-agent-ui resolved line';

function resolvedLine(body: Body, question: Question): Body {
	if (question.status !== 'closed') return body;
	const marked = renderEdit({ ...question, resolved: bodyLike(question.spec.body, MARK) }).payload.rich_message;
	if (!isBody(marked)) return body;
	if ('blocks' in marked && 'blocks' in body) {
		const fold = JSON.stringify(marked.blocks.slice(1));
		const kept = body.blocks.slice(0, body.blocks.length - (marked.blocks.length - 1));
		return marked.blocks.length > 1 && JSON.stringify(body.blocks.slice(kept.length)) === fold ? { blocks: kept } : body;
	}
	const text = (value: Body) => ('markdown' in value ? value.markdown : 'html' in value ? value.html : undefined);
	const [shown, folded] = [text(body), text(marked)];
	if (shown === undefined || folded === undefined || !folded.startsWith(MARK)) return body;
	const fold = folded.slice(MARK.length);
	if (fold === '' || !shown.endsWith(fold)) return body;
	const line = shown.slice(0, shown.length - fold.length);
	return 'markdown' in body ? { markdown: line } : { html: line };
}

function questionIssue(message: Message): string | undefined {
	const { question } = message;
	if (!question) return `no stored question belongs to "${preview(message.body)}"`;
	if (question.seq === 0) return `the question "${preview(message.body)}" got no answer: nothing waited for it`;
	return question.status === 'closed' ? undefined : `the question "${preview(message.body)}" was never closed`;
}

const answerOf = (message: Message): AnswerSpec | undefined => message.question?.spec.answer ?? (message.buttons.length > 0 ? { type: 'choice', options: message.buttons.map((label) => ({ label })) } : undefined);

const warningsOf = (body: Body, answer: AnswerSpec | undefined) => specWarnings({ body, ...(answer ? { answer } : {}) }, defaultLabels).map((warning) => `"${preview(body)}" has the warning ${warning.code}`);

function tabsIssue(message: Message, published: readonly Published[], edits: readonly { markup: unknown }[]): string | undefined {
	const question = message.question;
	const view = published.find((candidate) => candidate.id === question?.spec.view);
	if (!question || !view) return `the question "${preview(message.body)}" opens no published view`;
	const options = question.spec.answer.type === 'choice' ? question.spec.answer.options : [];
	const lost = options.find((option) => option.tab !== option.label || !labelsOf(view).includes(option.label));
	if (lost) return `the option "${lost.label}" opens no tab of its label`;
	const answer = 'answer' in question ? question.answer : undefined;
	const picked = answer?.kind === 'choice' ? options[answer.index] : undefined;
	const url = viewUrls(edits.at(-1)?.markup).at(0);
	const shown = url && { v: url.searchParams.get('v'), q: url.searchParams.get('q'), t: url.searchParams.get('t') };
	if (picked && !(shown?.v === view.id && shown.q === question.ref && shown.t === picked.tab)) return `the message after the answer does not open the view on the tab "${picked.tab ?? ''}"`;
	return undefined;
}

export function grade(
	calls: readonly Recorded[],
	expectations: readonly Expectation[],
	questions: readonly Question[] = [],
	views: readonly RecordedView[] = [],
	files: Readonly<Record<string, string>> = {},
): { pass: boolean; failures: string[] } {
	const messages = messagesOf(calls, questions);
	const published = publishedOf(views);
	const claimed = new Set<Message>();
	const claimedViews = new Set<Published>();
	const failures: string[] = [];
	const claim = (find: (message: Message) => boolean) => {
		const found = messages.find((message) => !claimed.has(message) && find(message));
		if (found) claimed.add(found);
		return found;
	};
	const order = { never: 0, none: 0, view: 0, status: 1, question: 2, message: 3 } as const;
	for (const expectation of [...expectations].sort((a, b) => order[a.kind] - order[b.kind])) {
		switch (expectation.kind) {
			case 'none': {
				const changes = calls.filter((call) => !call.method.startsWith('get')).length;
				if (changes > 0) failures.push(`${changes} ${changes === 1 ? 'call' : 'calls'} changed the chat, and none was expected`);
				break;
			}
			case 'never': {
				const { text } = expectation;
				if (calls.some((call) => JSON.stringify(call.payload).includes(text) || call.files.some((path) => path.includes(text)))) failures.push(`a call carried "${text}"`);
				if (views.some((request) => JSON.stringify(request.body ?? null).includes(text))) failures.push(`a view upload carried "${text}"`);
				break;
			}
			case 'view': {
				const candidates = published.filter((candidate) => !claimedViews.has(candidate) && candidate.tabs.length === expectation.tabs);
				const view = candidates.find((candidate) => !candidate.deleted) ?? candidates[0];
				if (!view) {
					failures.push(`no view with ${expectation.tabs} ${expectation.tabs === 1 ? 'tab' : 'tabs'} was published`);
					break;
				}
				claimedViews.add(view);
				const labels = labelsOf(view).join(', ');
				if (view.deleted) failures.push(`the view with the tabs ${labels} was deleted`);
				if (!messages.some((message) => message.opens.includes(view.id))) failures.push(`no message opens the view with the tabs ${labels}`);
				for (const source of missingSources(view, expectation.sources ?? [], files)) failures.push(`no tab of the view with the tabs ${labels} holds ${source}`);
				break;
			}
			case 'status': {
				const line = claim((message) => message.silent && message.buttons.length === 0 && !message.question && editsOf(calls, message).length >= expectation.edits);
				if (!line) {
					failures.push(`no silent message was edited ${expectation.edits} times`);
					break;
				}
				if (!claim((message) => plain(message) && message.index > line.index)) failures.push('no result message followed the status line');
				break;
			}
			case 'question': {
				const { answer, options } = expectation;
				const found = claim((message) => {
					const type = message.question?.spec.answer.type;
					if (answer === 'text') return type === 'text';
					if (type !== 'choice') return false;
					return answer === 'yesNo' ? isYesNo(message) : !isYesNo(message) && (options === undefined || message.buttons.length === options);
				});
				if (!found) {
					failures.push(`no ${answer} question${options !== undefined ? ` with ${options} options` : ''} was asked`);
					break;
				}
				const issue = questionIssue(found) ?? (expectation.tabs ? tabsIssue(found, published, editsOf(calls, found)) : undefined);
				if (issue) failures.push(issue);
				break;
			}
			case 'message':
				if (!claim(plain)) failures.push('no message that asks nothing was sent');
				break;
		}
	}
	for (const view of published) if (!claimedViews.has(view)) failures.push(`an extra view with the tabs ${labelsOf(view).join(', ')}`);
	for (const message of messages) {
		if (!claimed.has(message)) failures.push(`an extra message: "${preview(message.body)}"`);
		failures.push(...warningsOf(message.body, answerOf(message)));
		const original = JSON.stringify(message.body);
		for (const edit of editsOf(calls, message)) {
			if (JSON.stringify(edit.body) === original) continue;
			if (edit.command === 'close' && message.question) failures.push(...warningsOf(resolvedLine(edit.body, message.question), undefined));
			else failures.push(...warningsOf(edit.body, answerOf(message)));
		}
	}
	const unique = [...new Set(failures)];
	return { pass: unique.length === 0, failures: unique };
}
