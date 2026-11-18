// The shape checks and warnings of section 8. `specIssue` and `questionBodyIssue` need no
// configuration, so `parseQuestion` runs them on stored questions too. `checkSpec` adds the
// checks that need the send's context and throws ShapeError.
import { isRecord, isString, storable } from './check.ts';
import { type Body, type Labels, type Spec, ShapeError, type Warning } from './types.ts';

/** A caller's `ref`. The library's own refs, 8 characters of `[a-z2-7]`, match it too. */
export const REF = /^[A-Za-z0-9_-]{1,32}$/;
/** A view id: 128 random bits as 22 base64url characters. */
export const VIEW_ID = /^[A-Za-z0-9_-]{22}$/;
/** A choice id: 128 random bits as 22 base64url characters, made by the shell for one tap. */
export const CHOICE_ID = /^[A-Za-z0-9_-]{22}$/;

// `levels`: objects and arrays on any path of a body or a meta, counted from the body or meta itself.
export const LIMITS = { body: 32_768, blocks: 500, questionBody: 3_500, caption: 1_024, label: 46, options: [2, 8], files: 10, levels: 48 } as const;

// Block types whose text is code or a quotation: the warnings skip them.
const QUOTED = new Set(['pre', 'blockquote', 'expandable_blockquote', 'pullquote']);

/** The elements of an array, or none. The walkers below read blocks as unknown JSON. */
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

/** The plain words of a RichText, without its code spans. */
function richText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return list(value).map(richText).join('');
	if (isRecord(value) && value.type !== 'code') return richText(value.text);
	return '';
}

/** One line per text-bearing block, depth first, without code and quotation blocks. */
function blockLines(blocks: unknown): string[] {
	return list(blocks).flatMap((block): string[] => {
		if (!isRecord(block) || QUOTED.has(String(block.type))) return [];
		return [
			...('summary' in block ? [richText(block.summary)] : []),
			...('text' in block ? [richText(block.text)] : []),
			...list(block.cells).map((row) => list(row).map((cell) => (isRecord(cell) ? richText(cell.text) : '')).join(' ')),
			...blockLines(block.blocks),
			...list(block.items).flatMap((item) => (isRecord(item) ? blockLines(item.blocks) : [])),
		];
	});
}

/** Every block object at any depth, list items' blocks included. */
function countBlocks(blocks: unknown): number {
	return sum(list(blocks).map((block) => (isRecord(block) ? 1 + countBlocks(block.blocks) + sum(list(block.items).map((item) => (isRecord(item) ? countBlocks(item.blocks) : 0))) : 1)));
}

/** The characters of a blocks body: every string leaf except the `type` tags. */
function blocksLength(value: unknown, key = ''): number {
	if (typeof value === 'string') return key === 'type' ? 0 : value.length;
	if (Array.isArray(value)) return sum(list(value).map((item) => blocksLength(item)));
	if (isRecord(value)) return sum(Object.entries(value).map(([k, v]) => blocksLength(v, k)));
	return 0;
}

const decode = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** The lines a human reads, without code and quotation blocks: what the warnings look at. */
export function plainLines(body: Body): string[] {
	if ('blocks' in body) return blockLines(body.blocks).flatMap((line) => line.split('\n'));
	if ('html' in body) {
		const text = body.html
			.replace(/<(pre|code|blockquote)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
			.replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|summary|details)>/gi, '\n')
			.replace(/<[^>]*>/g, '');
		return decode(text).split('\n');
	}
	// A link shows its label: `[Ready?](https://example.com)` reads as `Ready?`, and a link definition shows nothing.
	const text = body.markdown
		.replace(/^ {0,3}```[\s\S]*?^ {0,3}```.*$/gm, '')
		.replace(/`[^`\n]*`/g, '')
		.replace(/^ {0,3}\[[^\]]+\]:\s*\S.*$/gm, '')
		.replace(/!?\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g, '$1')
		.replace(/<[^>]*>/g, '');
	return text.split('\n').filter((line) => !/^\s*>/.test(line));
}

/**
 * True when a blocks body holds a button of its own, as a `buttons` block or an inline button
 * node, at any depth. Every button of a message comes from its `answer` and its `view`.
 */
function hasButton(value: unknown): boolean {
	if (Array.isArray(value)) return list(value).some(hasButton);
	if (!isRecord(value)) return false;
	return value.type === 'buttons' || value.type === 'button' || Object.values(value).some(hasButton);
}

const BUTTON_REFUSAL = 'a body may hold no button of its own: buttons come from answer and view';
// Rich Markdown and Rich HTML both turn `<tg-button>` and `<tg-button-row>` into buttons (recorded
// 2026-11-17). The check reads the whole string, code spans included, which keeps it simple.
const BUTTON_TAG = /<tg-button(?:-row)?/i;

/** Why a body is refused, or undefined. `limit` is the character limit of its role. */
function bodyIssue(body: Body, limit: number): string | undefined {
	// JSON first: the walkers below recurse, so a cycle must fail before them.
	if (!storable(body)) return 'the body is not JSON';
	if (!storable(body, LIMITS.levels)) return `the body nests objects and arrays deeper than ${LIMITS.levels} levels`;
	if ('blocks' in body) {
		if (hasButton(body.blocks)) return BUTTON_REFUSAL;
		if (body.blocks.length === 0) return 'the body is empty';
		if (countBlocks(body.blocks) > LIMITS.blocks) return `the body has more than ${LIMITS.blocks} blocks`;
		if (blocksLength(body.blocks) > limit) return `the body has more than ${limit} characters`;
		return undefined;
	}
	const text = 'html' in body ? body.html : body.markdown;
	if (BUTTON_TAG.test(text)) return BUTTON_REFUSAL;
	if (text.trim() === '') return 'the body is empty';
	if (text.length > limit) return `the body has more than ${limit} characters`;
	return undefined;
}

/** Why a meta is refused, or undefined: it is JSON of at most 48 levels. */
export function metaIssue(meta: unknown): string | undefined {
	if (!storable(meta)) return 'meta is not JSON';
	return storable(meta, LIMITS.levels) ? undefined : `meta nests objects and arrays deeper than ${LIMITS.levels} levels`;
}

/** Why a body cannot go out as a message at all: empty, over 32,768 characters or over 500 blocks. */
export const messageBodyIssue = (body: Body) => bodyIssue(body, LIMITS.body);

/** True when both bodies are Markdown, both HTML or both blocks. */
export const sameForm = (a: Body, b: Body) => ('blocks' in a && 'blocks' in b) || ('html' in a && 'html' in b) || ('markdown' in a && 'markdown' in b);

/**
 * Why a question body or a resolved body is refused, or undefined. A Markdown or HTML body
 * sits inside a details block once the question is resolved, so it may not close one, and an
 * odd number of code fences would swallow what follows.
 */
export function questionBodyIssue(body: Body): string | undefined {
	const issue = bodyIssue(body, LIMITS.questionBody);
	if (issue || 'blocks' in body) return issue;
	const text = 'html' in body ? body.html : body.markdown;
	if (/<\/details\s*>/i.test(text)) return 'a question body may not contain </details>';
	if ((text.match(/^ {0,3}```/gm)?.length ?? 0) % 2 === 1) return 'a question body has an odd number of code fences';
	return undefined;
}

/** Why a spec is refused by the checks that need no configuration, or undefined. */
export function specIssue(spec: Spec): string | undefined {
	const issue = spec.answer ? questionBodyIssue(spec.body) : messageBodyIssue(spec.body);
	if (issue) return issue;
	// A reply answers a text question in the chat: only a choice is answered in a view.
	if (spec.answer?.type === 'text' && 'in' in spec.answer) return 'a text question is answered by a reply in the chat, and takes no in';
	if (spec.answer?.type === 'choice') {
		const { options } = spec.answer;
		if (options.length < LIMITS.options[0] || options.length > LIMITS.options[1]) return `a choice needs ${LIMITS.options[0]} to ${LIMITS.options[1]} options, it has ${options.length}`;
		const long = options.find((option) => option.label.length < 1 || option.label.length > LIMITS.label);
		if (long) return `an option label needs 1 to ${LIMITS.label} characters: "${long.label}"`;
		if (options.some((option) => option.tab !== undefined) && spec.view === undefined) return 'an option names a tab, and the spec has no view';
		if (spec.answer.in === 'view') {
			if (spec.view === undefined) return 'a question answered in its view needs a view';
			const tabs = options.map((option) => option.tab);
			const unbound = options.find((option) => option.tab === undefined);
			if (unbound) return `a question answered in its view binds every option to a tab, and "${unbound.label}" names none`;
			const shared = tabs.find((tab, index) => tabs.indexOf(tab) !== index);
			if (shared !== undefined) return `a question answered in its view binds each option to its own tab, and the tab "${shared}" is named twice`;
		}
	}
	if (spec.attach) {
		if (spec.attach.length < 1 || spec.attach.length > LIMITS.files) return `attach needs 1 to ${LIMITS.files} files, it has ${spec.attach.length}`;
		if (spec.attach.some((file) => (file.caption?.length ?? 0) > LIMITS.caption)) return `a caption has more than ${LIMITS.caption} characters`;
	}
	if (spec.view !== undefined && !VIEW_ID.test(spec.view)) return `the view id "${spec.view}" is not 22 base64url characters`;
	return undefined;
}

/** True when `origin` is the origin of an https URL, such as `https://views.example.com`. */
export function isOrigin(origin: string): boolean {
	return URL.canParse(origin) && new URL(origin).protocol === 'https:' && new URL(origin).origin === origin;
}

/** Throws ShapeError when `spec` cannot be sent with this `ref` and view origin. */
export function checkSpec(spec: Spec, at: { ref?: string | undefined; viewOrigin?: string | undefined }): void {
	if (!storable(spec)) throw new ShapeError('the spec is not JSON');
	const issue = specIssue(spec);
	if (issue) throw new ShapeError(issue);
	if (at.ref !== undefined && (!isString(at.ref) || !REF.test(at.ref))) throw new ShapeError(`the ref "${at.ref}" is not 1 to 32 characters of [A-Za-z0-9_-]`);
	if (spec.answer && at.ref === undefined) throw new ShapeError('a question needs a ref');
	if (spec.view !== undefined && at.viewOrigin === undefined) throw new ShapeError('the spec has a view, and no view origin is given');
	if (at.viewOrigin !== undefined && !isOrigin(at.viewOrigin)) throw new ShapeError(`the view origin "${at.viewOrigin}" is not an https origin`);
}

/** Throws ShapeError when `body` cannot be a question's body or its resolved body. */
export function checkQuestionBody(body: Body): void {
	const issue = questionBodyIssue(body);
	if (issue) throw new ShapeError(issue);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// `word(s): value`: 1 to 4 words, a colon, a value.
const FIELD = /^\s*(?:[-*]\s+)?[\p{L}\p{N}][\p{L}\p{N}'_-]*(?: [\p{L}\p{N}'_-]+){0,3}:\s+\S/u;

/** The warnings of section 8 for a spec. None of them refuses a send without `strict`. */
export function specWarnings(spec: Spec, labels: Labels): Warning[] {
	const lines = plainLines(spec.body);
	const warnings: Warning[] = [];
	if (spec.answer) {
		const last = lines.map((line) => line.trim().replace(/[*_~]+$/, '')).filter(Boolean).at(-1) ?? '';
		if (!/[?？؟]$/.test(last)) warnings.push({ code: 'no-question-mark', message: 'the last line of the question does not end with a question mark' });
	}
	let run = 0;
	for (const line of lines) {
		run = FIELD.test(line) ? run + 1 : 0;
		if (run === 3) {
			warnings.push({ code: 'table-candidate', message: '3 or more lines of the form "name: value" read better as a table' });
			break;
		}
	}
	if (spec.answer) {
		const text = lines.join('\n');
		const hint = labels.hintWords.find((word) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, 'iu').test(text));
		if (hint !== undefined) warnings.push({ code: 'answer-hint', message: `the question explains how to answer: "${hint}"` });
	}
	return warnings;
}
