// Grades one eval run on what fake mode recorded: the Bot API calls in `calls.jsonl`, which is
// what reached the human in order, and the questions in its store, which tell an answered or
// closed question from one that was only edited. Fake mode records the command beside each
// call, so a `close` edit is told from an `edit`. Each expectation claims the messages it
// describes. A run fails on an expectation it misses, on a message that no expectation claims,
// and on any delivered body, sent or edited, with a warning of section 8.
import { isInt, isRecord, isString } from '../src/core/check.ts';
import { isBody } from '../src/core/guards.ts';
import { bodyLike, renderEdit } from '../src/core/render.ts';
import { plainLines, specWarnings } from '../src/core/shape.ts';
import { type AnswerSpec, type Body, defaultLabels, type Question } from '../src/core/types.ts';

/** What one eval expects of a run. Every message of the run belongs to one of them. */
export type Expectation =
	/** Nothing reaches Telegram. */
	| { kind: 'none' }
	/** One message that asks nothing and notifies. */
	| { kind: 'message' }
	/** One silent message, edited at least `edits` times, then a result message that notifies. */
	| { kind: 'status'; edits: number }
	/** One question of this kind, answered, then closed. `options` counts the buttons of a choice. */
	| { kind: 'question'; answer: 'choice' | 'yesNo' | 'text'; options?: number }
	/** No call carries `text`: a body, a caption, a file path. */
	| { kind: 'never'; text: string };

/** One line of `calls.jsonl`. `command` names the CLI command that made the call, such as `edit` or `close`. */
export type Recorded = { method: string; payload: Record<string, unknown>; files: string[]; response: unknown; command?: string };

/** A body that went out, with the texts of its answer buttons and the stored question it carries, if any. */
type Message = { index: number; id: number; body: Body; buttons: string[]; silent: boolean; question?: Question };

/** The lines of a `calls.jsonl` text as records; a line that is no call is left out. */
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

/** The texts of the callback buttons of a reply markup: the answer buttons, without a view row. */
function answerButtons(markup: unknown): string[] {
	if (!isRecord(markup) || !Array.isArray(markup.inline_keyboard)) return [];
	return markup.inline_keyboard.flatMap((row: unknown) => (Array.isArray(row) ? row : [])).flatMap((button: unknown) => (isRecord(button) && isString(button.callback_data) && isString(button.text) ? [button.text] : []));
}

/** Whether the server took a call. */
const took = (call: Recorded) => isRecord(call.response) && call.response.ok === true;

/** Every body the server took, with the message id it got and the stored question of that message. */
function messagesOf(calls: readonly Recorded[], questions: readonly Question[]): Message[] {
	return calls.flatMap((call, index): Message[] => {
		const { method, payload, response } = call;
		if (method !== 'sendRichMessage' || !isBody(payload.rich_message) || !took(call)) return [];
		const result = isRecord(response) && isRecord(response.result) ? response.result : undefined;
		if (!result || !isInt(result.message_id)) return [];
		const id = result.message_id;
		const question = questions.find((stored) => 'sent' in stored && stored.sent?.message === id);
		return [{ index, id, body: payload.rich_message, buttons: answerButtons(payload.reply_markup), silent: payload.disable_notification === true, ...(question ? { question } : {}) }];
	});
}

/** The edits of one message the server took, in order, with their bodies and the commands that made them. */
const editsOf = (calls: readonly Recorded[], message: Message) =>
	calls.flatMap((call) => (call.method === 'editMessageText' && call.payload.message_id === message.id && took(call) && isBody(call.payload.rich_message) ? [{ body: call.payload.rich_message, command: call.command }] : []));

const isYesNo = (message: Message) => message.buttons.length === 2 && message.buttons[0] === defaultLabels.yes && message.buttons[1] === defaultLabels.no;
const plain = (message: Message) => message.buttons.length === 0 && !message.silent && !message.question;

/** The start of a body as its author wrote it, to name the message in a failure. */
const preview = (body: Body) => ('markdown' in body ? body.markdown : 'html' in body ? body.html : plainLines(body).join(' ')).replace(/\s+/g, ' ').slice(0, 60);

// A resolved line that the renderer folds the question below, to learn the fold it appends.
const MARK = 'telegram-agent-ui resolved line';

/**
 * The resolved line of a body that a `close` showed: the body without the folded question the
 * renderer appends below it. A body without that fold, such as a resolved form over a limit,
 * is the resolved line whole, and a details block the author wrote stays.
 */
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

/** What the question in `message` lacks: its stored state, its answer, or its close. */
function questionIssue(message: Message): string | undefined {
	const { question } = message;
	if (!question) return `no stored question belongs to "${preview(message.body)}"`;
	if (question.seq === 0) return `the question "${preview(message.body)}" got no answer: nothing waited for it`;
	return question.status === 'closed' ? undefined : `the question "${preview(message.body)}" was never closed`;
}

/** The answer spec of a recorded question, for its warnings. */
const answerOf = (message: Message): AnswerSpec | undefined => message.question?.spec.answer ?? (message.buttons.length > 0 ? { type: 'choice', options: message.buttons.map((label) => ({ label })) } : undefined);

/** The warnings of one delivered body, as failures. */
const warningsOf = (body: Body, answer: AnswerSpec | undefined) => specWarnings({ body, ...(answer ? { answer } : {}) }, defaultLabels).map((warning) => `"${preview(body)}" has the warning ${warning.code}`);

/**
 * Grades a run: `pass` when every expectation holds and every message is claimed by one, else
 * the reasons in `failures`. `questions` are the questions of fake mode's store.
 *
 *   grade(parseCalls(readFileSync(`${fake}/calls.jsonl`, 'utf8')), [{ kind: 'question', answer: 'yesNo' }], questions);
 */
export function grade(calls: readonly Recorded[], expectations: readonly Expectation[], questions: readonly Question[] = []): { pass: boolean; failures: string[] } {
	const messages = messagesOf(calls, questions);
	const claimed = new Set<Message>();
	const failures: string[] = [];
	const claim = (find: (message: Message) => boolean) => {
		const found = messages.find((message) => !claimed.has(message) && find(message));
		if (found) claimed.add(found);
		return found;
	};
	// The most specific expectations claim first.
	const order = { never: 0, none: 0, status: 1, question: 2, message: 3 } as const;
	for (const expectation of [...expectations].sort((a, b) => order[a.kind] - order[b.kind])) {
		switch (expectation.kind) {
			case 'none':
				if (calls.length > 0) failures.push(`${calls.length} ${calls.length === 1 ? 'call' : 'calls'} reached Telegram, and none was expected`);
				break;
			case 'never':
				if (calls.some((call) => JSON.stringify(call.payload).includes(expectation.text) || call.files.some((path) => path.includes(expectation.text)))) failures.push(`a call carried "${expectation.text}"`);
				break;
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
				const issue = questionIssue(found);
				if (issue) failures.push(issue);
				break;
			}
			case 'message':
				if (!claim(plain)) failures.push('no message that asks nothing was sent');
				break;
		}
	}
	for (const message of messages) {
		if (!claimed.has(message)) failures.push(`an extra message: "${preview(message.body)}"`);
		failures.push(...warningsOf(message.body, answerOf(message)));
		// An edit that shows new text, judged by the command that made it: a `close` shows a
		// resolved line, which asks nothing, and any other edit of a question shows the question.
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
