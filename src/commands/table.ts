// The command table of section 5. Each entry has a name, a description, its input schema, the
// MCP tool that serves it, and a handler over `createChat`. The CLI parser reads the schema
// to parse arguments, and a handler gets its input typed after `inputIssue` checked it.
import { isAbsolute, join, resolve } from 'node:path';
import { within } from '../chat/calls.ts';
import { deliveryKey } from '../chat/create.ts';
import { attemptsSince, LISTENER_KEY, listenerStatus, parseListener, spent } from '../chat/listener.ts';
import { choice, message, text, yesNo } from '../core/builders.ts';
import { isRecord, isString, optional } from '../core/check.ts';
import { isSent } from '../core/guards.ts';
import { mergeLabels } from '../core/labels.ts';
import { parseQuestion } from '../core/parse.ts';
import { bindingOf } from '../core/render.ts';
import { REF, VIEW_ID } from '../core/shape.ts';
import type { Attachment, Option, Outcome, Question, ViewClient, Warning } from '../core/types.ts';
import { typeOf } from '../files/roots.ts';
import { fetchFile, type FileSource } from '../telegram/fetch-file.ts';
import { CURSOR_KEY, listen, parseCursor } from '../telegram/listen.ts';
import { MESSAGE_PREFIX, parseStoredMessage, type StoredMessage, storedKey } from '../telegram/messages.ts';
import { createTopic, setTopicIcon, type TopicRefused, type TopicUncertain, topicIcons, topicMode } from '../telegram/topics.ts';
import { parseStoredUpdate, type StoredUpdate, UPDATE_ATTEMPTS, UPDATE_PREFIX } from '../telegram/updates.ts';
import { VIEW_TTL } from '../view/client.ts';
import { prepareView, type TabInput } from '../view/prepare.ts';
import { isMediaType } from '../view/stored.ts';
import { apiUrlOf, KEY_NAMES, localFilesOf } from './config.ts';
import { viewDeploy } from './deploy.ts';
import { denial, HOOK_CLIENTS, HOOK_REF_PREFIX, HOOK_SECONDS, isHookRef, notification, permissionRequest } from './hook.ts';
import { hookInit } from './hook-init.ts';
import { init } from './init.ts';
import { MCP_CLIENTS, mcpInit } from './mcp-init.ts';
import { type InputOf, inputIssue, isInput, type Param, usage } from './params.ts';
import { done, Failed, type Failure, failed, failureOf, fromOutcome, type Result } from './result.ts';
import { type Context, openSession, type Session } from './session.ts';
import { runShell } from './shell.ts';

/** One command of the table. `invoke` checks `raw` against `params` and runs the handler. */
export type Command = {
	/** One word, or two for a group such as `view put`. */
	name: string;
	description: string;
	/** The MCP tool that serves this command; a command without one has no tool. */
	tool?: string;
	params: readonly Param[];
	/** Runs the command on an input as JSON. A thrown error becomes its failure, so it always resolves. */
	invoke(raw: unknown, context: Context): Promise<Result>;
	/**
	 * What the CLI prints with exit 0 in place of any failure of this command, a usage error
	 * included: a harness that reads the output then never reads a failure as a decision.
	 */
	failClosed?: (failure: Failure) => Record<string, unknown>;
};

/** A command whose handler receives the input typed by its own params. */
function command<const Ps extends readonly Param[]>(spec: {
	name: string;
	description: string;
	tool?: string;
	params: Ps;
	run(input: InputOf<Ps>, context: Context): Promise<Result>;
	failClosed?: (failure: Failure) => Record<string, unknown>;
}): Command {
	const { name, description, tool, params, failClosed } = spec;
	return {
		name,
		description,
		...(tool !== undefined ? { tool } : {}),
		...(failClosed ? { failClosed } : {}),
		params,
		async invoke(raw, context) {
			if (!isInput(params, raw)) return failed({ error: 'usage', message: `${inputIssue(params, raw) ?? 'the input breaks its schema'}. Usage: ${usage(name, params)}` });
			try {
				return await spec.run(raw, { ...context, command: name });
			} catch (error) {
				return failed(failureOf(error));
			}
		},
	};
}

const BODY = { name: 'body', type: 'string', required: true, description: 'The message in Markdown.', cli: { positional: true, file: true } } as const;
const VIEW = {
	name: 'view',
	type: 'string',
	description: 'The id that view put printed: the message gets a button that opens the view. An option whose label equals a tab label opens that tab once it is picked.',
} as const;
const ANSWER_IN = {
	name: 'answerIn',
	type: ['chat', 'view'],
	description: 'Where the user picks: chat, by buttons on the message (the default), or view, by the button at the bottom of the view, on the tab whose label equals the option. view needs --view and a tab for each option.',
	cli: { label: 'chat|view' },
} as const;
const TABS = {
	name: 'tabs',
	type: 'json',
	many: true,
	required: true,
	description:
		'The tabs in order, 1 to 8, each { label, file, caption? }: a label of 1 to 46 characters, and a file below the roots, as an absolute path for an MCP client. A .md, .diff, .patch or .html file is a tab of its own. A png, jpg, jpeg, webp, gif or mp4 file is one picture of a gallery tab: the entries of one label form one gallery in order, and caption is the text below its picture.',
	schema: { type: 'object', properties: { label: { type: 'string' }, file: { type: 'string' }, caption: { type: 'string' } }, required: ['label', 'file'], additionalProperties: false },
	cli: { flag: 'tab', pair: ['label', 'file'], more: true },
} as const;
const TOPIC = {
	name: 'topic',
	type: 'integer',
	description: 'The id of a topic of the private chat, as topic create printed it: the message goes into that topic. Needs topic mode, which info shows.',
	cli: { label: 'id' },
} as const;
const FILES = {
	name: 'files',
	type: 'string',
	many: true,
	description:
		'A file below the roots that goes out as a reply to the message, 1 to 10 of them, as an absolute path for an MCP client: png, jpg, jpeg and webp as photos, mp4 as videos, any other file as a document. 2 or more photos and videos form one album, 2 or more documents another.',
	cli: { flag: 'file', label: 'path' },
} as const;
const STRICT = { name: 'strict', type: 'boolean', description: 'Turns every warning into a refusal before anything is sent.' } as const;
const DRY_RUN = { name: 'dryRun', type: 'boolean', description: 'Prints what would be sent and the roots files would come from, and sends nothing.' } as const;

const DAY = 86_400_000;
/** How long `info` waits for getMe to tell topic mode. */
const TOPIC_MODE_WAIT = 5_000;

/** Writes each warning as a line of progress. */
const report = (context: Context, warnings: Warning[]) => {
	for (const warning of warnings) context.log(`warning ${warning.code}: ${warning.message}`);
};

/** The client of the view host, or a thrown `no-view-host`: `view deploy` records the origin and writes the upload key. */
function viewsOf(session: Session): ViewClient {
	if (session.views) return session.views;
	if (session.config.views.origin === undefined) throw new Failed({ error: 'no-view-host', message: 'no view host is deployed: a message cannot open a view yet. A person runs telegram-agent-ui view deploy' });
	throw new Failed({ error: 'no-view-host', message: `the upload key ${KEY_NAMES.upload} of the view host is missing: a person runs telegram-agent-ui view deploy` });
}

/** Refuses `--view` without a deployed view host. */
function viewHost(session: Session, view: string | undefined): { view?: string } {
	if (view === undefined) return {};
	viewsOf(session);
	return { view };
}

/** The tab labels of a view, or none when the host has no such view or gives no answer. */
async function tabsOf(views: ViewClient, view: string): Promise<string[]> {
	const found = await views.has(view).catch(() => undefined);
	return found?.kind === 'present' ? found.tabs : [];
}

/** The labels of a stored question's options that `ask` bound to the tab of the same label. */
const boundTabs = (question: Question): string[] => (question.spec.answer.type === 'choice' ? question.spec.answer.options.flatMap((option) => (option.tab === option.label ? [option.label] : [])) : []);

/**
 * The questions answered in view `id` that are not closed, each with the tabs it binds and its
 * `expiresAt`. A replacement that drops one of those tabs, or expires before that time, leaves
 * the question without a way to be answered while it is open.
 */
async function openBindings(store: Session['store'], id: string): Promise<{ ref: string; tabs: string[]; expiresAt?: number }[]> {
	const found: { ref: string; tabs: string[]; expiresAt?: number }[] = [];
	for (const key of await store.list('q:')) {
		const question = parseQuestion(await store.get(key));
		const binding = question && question.status !== 'closed' && question.spec.view === id ? bindingOf(question) : undefined;
		if (!question || !binding) continue;
		found.push({ ref: question.ref, tabs: binding.options.map((option) => option.tab), ...(question.expiresAt !== undefined ? { expiresAt: question.expiresAt } : {}) });
	}
	return found;
}

/**
 * The refusal of a hook question's ref. Only the hook that asked the question reads its answer
 * and changes it, so the agent it gates cannot edit what the human approves.
 */
const hookRefused = (ref: string) => failed({ error: 'refused', code: 'shape', message: `the ref ${ref} belongs to a permission hook, which alone reads and changes its question` });

/** True when message `at` is the message of a stored hook question, found by its `sent`, whatever the reply index holds. */
async function isHookMessage(store: Session['store'], at: { chat: number; message: number }): Promise<boolean> {
	for (const key of await store.list(`q:${HOOK_REF_PREFIX}`)) {
		const question = parseQuestion(await store.get(key));
		const sent = question && 'sent' in question ? question.sent : undefined;
		if (sent && sent.chat === at.chat && sent.message === at.message) return true;
	}
	return false;
}

/** An option of `ask` as the input names it: a label, or a label with the tab it binds. */
type OptionInput = string | { label: string; tab?: string };
const isOptionInput = (value: unknown): value is OptionInput =>
	isString(value) || (isRecord(value) && Object.keys(value).every((key) => key === 'label' || key === 'tab') && isString(value.label) && optional(isString)(value.tab));

/** A tab entry of `view put`: the label and the file as the input names them, and the caption of a gallery picture. */
type TabEntry = { label: string; file: string; caption?: string };
const isTab = (value: unknown): value is TabEntry =>
	isRecord(value) && isString(value.label) && isString(value.file) && optional(isString)(value.caption) && Object.keys(value).every((key) => key === 'label' || key === 'file' || key === 'caption');

/**
 * The tabs of `view put` from its entries, in the order of each label's first entry. A media
 * file, by its ending, is one picture of the gallery of its label; any other file is a tab of
 * its own, whose kind `prepareView` reads from its ending. A path resolves against the CLI's
 * working directory. A failure: a relative path without one, or a caption on a file that is no
 * picture. A label of a gallery and of another tab is refused by `prepareView` as used twice.
 */
function tabInputs(entries: readonly TabEntry[], context: Context): { ok: true; tabs: TabInput[] } | { ok: false; failure: Failure } {
	const tabs: TabInput[] = [];
	const galleries = new Map<string, { path: string; caption?: string }[]>();
	for (const { label, file, caption } of entries) {
		if (!isAbsolute(file) && context.cwd === undefined) return { ok: false, failure: { error: 'usage', message: `the file of tab "${label}" needs an absolute path` } };
		const path = resolve(context.cwd ?? '/', file);
		if (!isMediaType(typeOf(path))) {
			if (caption !== undefined) return { ok: false, failure: { error: 'usage', message: `tab "${label}": a caption belongs to a png, jpg, jpeg, webp, gif or mp4 file of a gallery, and ${file} is none` } };
			tabs.push({ label, content: { file: path } });
			continue;
		}
		let gallery = galleries.get(label);
		if (!gallery) {
			gallery = [];
			galleries.set(label, gallery);
			tabs.push({ label, content: { gallery } });
		}
		gallery.push({ path, ...(caption !== undefined ? { caption } : {}) });
	}
	return { ok: true, tabs };
}

/**
 * The attachments of `--file`, each resolved against the CLI's working directory. A relative
 * path without one, as from an MCP client, is a usage failure: it would resolve against the
 * server's own directory. `createChat` opens each through the roots before the body is sent.
 */
function attachOf(paths: readonly string[] | undefined, context: Context): { attach?: Attachment[] } {
	if (paths === undefined) return {};
	return {
		attach: paths.map((path) => {
			if (!isAbsolute(path) && context.cwd === undefined) throw new Failed({ error: 'usage', message: `the file ${path} needs an absolute path` });
			return { path: resolve(context.cwd ?? '/', path) };
		}),
	};
}

/** What a dry run prints: the calls it would make, the roots files would come from and the files it would upload. */
const dry = (outcome: Extract<Outcome, { kind: 'dry' }>, session: Session) => ({
	dryRun: true,
	steps: outcome.steps,
	warnings: outcome.warnings,
	roots: session.roots,
	files: outcome.steps.flatMap((step) => (step.call.files ?? []).map((file) => file.path)),
});

/**
 * `push` when the listener runs an answer command and the meta of the stored question, which
 * the answer carries, holds every key it declared as its own property, else `wait`. A held ref
 * keeps the meta of its first ask, so the meta of a repeated ask decides nothing.
 */
async function nextOf(session: Session, ref: string | undefined): Promise<'push' | 'wait'> {
	const value = await session.store.get(LISTENER_KEY);
	const record = parseListener(value);
	if (!record?.push || !listenerStatus(value, Date.now()).alive || ref === undefined) return 'wait';
	const meta = (await session.chat.get(ref))?.meta;
	const keys = isRecord(meta) ? meta : {};
	return record.push.metaKeys.every((key) => Object.hasOwn(keys, key)) ? 'push' : 'wait';
}

const info = command({
	name: 'info',
	description:
		'Prints the config, the bot, the roots, the listener, the open, unconfirmed and undelivered questions, the undelivered messages, the refused and undelivered updates, topic mode and the view host.',
	tool: 'get_status',
	params: [{ name: 'json', type: 'boolean', description: 'Prints JSON, which every command does.', cli: { only: true } }],
	async run(_input, context) {
		const session = await openSession(context);
		const { config, store, where } = session;
		const raw = await store.get(LISTENER_KEY);
		const record = parseListener(raw);
		const questions: Question[] = [];
		for (const key of await store.list('q:')) {
			const question = parseQuestion(await store.get(key));
			// A hook question belongs to its hook alone.
			if (question && !isHookRef(question.ref)) questions.push(question);
		}
		const messages: StoredMessage[] = [];
		for (const key of await store.list(MESSAGE_PREFIX)) {
			const stored = parseStoredMessage(await store.get(key));
			if (stored) messages.push(stored);
		}
		const receipts: StoredUpdate[] = [];
		for (const key of await store.list(UPDATE_PREFIX)) {
			const stored = parseStoredUpdate(await store.get(key));
			if (stored) receipts.push(stored);
		}
		const cursor = parseCursor(await store.get(CURSOR_KEY));
		// Topic mode comes from getMe alone; a server without an answer leaves it unknown.
		const topics = await within(
			topicMode(session.call).catch(() => undefined),
			TOPIC_MODE_WAIT,
			undefined,
		);
		const localFiles = context.env.TELEGRAM_AGENT_UI_FAKE ? undefined : context.env.TELEGRAM_AGENT_UI_LOCAL_FILES || config.localFiles;
		const refs = (keep: (question: Question) => boolean) => questions.filter(keep).map((question) => question.ref);
		// The baselines the delivery workers count from: only the attempts after them count.
		const answerBase = (question: Question) => record?.renewed?.answers[deliveryKey(question)];
		const messageBase = (stored: StoredMessage) => record?.renewed?.messages[storedKey(stored)];
		const apiUrl = context.env.TELEGRAM_AGENT_UI_FAKE ? undefined : apiUrlOf(context.env, config);
		return done({
			config: where.config,
			bot: config.bot,
			chat: config.chat,
			users: config.users,
			...(apiUrl !== undefined ? { apiUrl } : {}),
			...(localFiles !== undefined ? { localFiles } : {}),
			topics: topics ?? null,
			store: where.store,
			roots: session.roots,
			listener: { ...listenerStatus(raw, Date.now()), ...(record ? { heartbeat: record.heartbeat } : {}), ...(record?.push ? { answerCommand: record.push } : {}) },
			questions: {
				open: refs((question) => question.status === 'open' || question.status === 'answered'),
				sending: refs((question) => question.status === 'sending'),
				// No message is known: a tap on its buttons reveals it, and a text question stays here until it is closed.
				unconfirmed: refs((question) => !('sent' in question && question.sent)),
				undelivered: questions
					.filter((question) => question.delivery.seq < question.seq && spent(question.delivery.attempts, answerBase(question)))
					.map((question) => ({ ref: question.ref, seq: question.seq, attempts: attemptsSince(question.delivery.attempts, answerBase(question)), ...(question.delivery.error !== undefined ? { error: question.delivery.error } : {}) })),
				notShown: questions.flatMap(({ ref, shown }) => (shown.error !== undefined ? [{ ref, error: shown.error }] : [])),
			},
			messages: {
				pending: messages.length,
				undelivered: messages
					.filter((stored) => spent(stored.attempts, messageBase(stored)))
					.map((stored) => ({ chat: stored.chat, message: stored.message.message, update: stored.update, attempts: attemptsSince(stored.attempts, messageBase(stored)), ...(stored.error !== undefined ? { error: stored.error } : {}) })),
			},
			// The updates for an update command: those the gate refused, and the receipts still owed.
			// A receipt with 5 failed deliveries is listed; the listener retries it all the same.
			updates: {
				refused: cursor?.refused ?? 0,
				pending: receipts.length,
				undelivered: receipts
					.filter((stored) => stored.attempts >= UPDATE_ATTEMPTS)
					.map(({ key, epoch, updateId, attempts, retryAt, error }) => ({ key, epoch, updateId, attempts, ...(retryAt !== undefined ? { retryAt } : {}), ...(error !== undefined ? { error: session.scrub(error) } : {}) })),
			},
			viewHost: config.views.origin !== undefined ? { origin: config.views.origin } : null,
		});
	},
});

const send = command({
	name: 'send',
	description: 'Sends a message that asks nothing, from Markdown, with its files as replies. Prints its Sent, which edit takes.',
	tool: 'send_message',
	params: [FILES, VIEW, TOPIC, { name: 'silent', type: 'boolean', description: 'Sends without a notification sound.' }, STRICT, DRY_RUN, BODY],
	async run(input, context) {
		const attach = attachOf(input.files, context);
		const session = await openSession(context);
		const spec = message({ markdown: input.body }, { ...attach, ...viewHost(session, input.view), ...(input.silent ? { silent: true } : {}) });
		const outcome = await session.chat.send(spec, { ...(input.topic !== undefined ? { topic: input.topic } : {}), ...(input.strict ? { strict: true } : {}), ...(input.dryRun ? { dryRun: true } : {}) });
		if (outcome.kind === 'ok' || outcome.kind === 'dry') report(context, outcome.warnings);
		return fromOutcome(outcome, (result) => (result.kind === 'dry' ? dry(result, session) : { ...result.sent }));
	},
});

const edit = command({
	name: 'edit',
	description: 'Gives a sent message a new body: by the Sent that send printed, or by the ref of a question.',
	tool: 'edit_message',
	params: [
		{ name: 'sent', type: 'json', description: 'The Sent of the message, as send printed it.', cli: { positional: true, label: 'sent json' } },
		{ name: 'ref', type: 'string', description: 'The ref of a question, in place of a Sent.' },
		BODY,
	],
	async run(input, context) {
		if ((input.sent === undefined) === (input.ref === undefined)) return failed({ error: 'usage', message: 'edit takes a Sent or --ref, exactly one of them' });
		if (input.ref !== undefined && isHookRef(input.ref)) return hookRefused(input.ref);
		const session = await openSession(context);
		let sent = input.sent;
		if (input.ref !== undefined) {
			const question = await session.chat.get(input.ref);
			if (!question) return failed({ error: 'refused', code: 'unknown-ref', message: `no question ${input.ref} is stored` });
			if (!('sent' in question && question.sent)) return failed({ error: 'refused', code: 'unconfirmed-message', message: `no message of question ${input.ref} is known yet` });
			sent = question.sent;
		}
		if (!isSent(sent)) return failed({ error: 'refused', code: 'shape', message: 'the Sent breaks its type: pass the JSON that send printed' });
		if (sent.ref !== undefined && isHookRef(sent.ref)) return hookRefused(sent.ref);
		if (await isHookMessage(session.store, sent)) return failed({ error: 'refused', code: 'shape', message: `message ${sent.message} belongs to a permission hook, which alone changes it` });
		const outcome = await session.chat.edit(sent, { markdown: input.body });
		return fromOutcome(outcome, ({ kind: _kind, ...result }) => result);
	},
});

const ask = command({
	name: 'ask',
	description: 'Asks a question with options, yes or no, or a text answer, with its files as replies. Prints its ref, its status and next: push when the answer command receives it, else wait.',
	tool: 'ask_question',
	params: [
		{ name: 'answer', type: ['choice', 'yesNo', 'text'], description: 'How the question is answered: a tap on an option, a tap on yes or no, or a reply.', cli: { switches: { 'yes-no': 'yesNo', text: 'text' } } },
		{
			name: 'options',
			type: 'json',
			many: true,
			description: 'The 2 to 8 options: each a label of 1 to 46 characters, or { label, tab } to bind the option to the tab of that label, as a pick in the view needs when the two differ. On the CLI each -o is a label.',
			schema: { anyOf: [{ type: 'string' }, { type: 'object', properties: { label: { type: 'string' }, tab: { type: 'string' } }, required: ['label'], additionalProperties: false }] },
			cli: { short: 'o', flag: 'option', label: 'option', text: true },
		},
		{ name: 'once', type: 'boolean', description: 'Forbids a correction after the first answer.' },
		FILES,
		VIEW,
		ANSWER_IN,
		TOPIC,
		{ name: 'meta', type: 'json', description: 'JSON that comes back with the answer, such as the session that asked.' },
		{ name: 'ref', type: 'string', description: 'The question id: 1 to 32 characters of [A-Za-z0-9_-]. Asking again with it sends nothing.' },
		STRICT,
		DRY_RUN,
		BODY,
	],
	async run(input, context) {
		const kind = input.answer ?? (input.options ? 'choice' : undefined);
		if (kind === undefined) return failed({ error: 'usage', message: 'ask needs -o <option> for each option, --yes-no or --text' });
		if (kind !== 'choice' && input.options) return failed({ error: 'usage', message: `options belong to a choice, and this question is ${kind}` });
		const given = input.options ?? [];
		if (!given.every(isOptionInput)) return failed({ error: 'usage', message: 'each option is a label, or { label, tab }' });
		const inView = input.answerIn === 'view';
		if (inView && kind === 'text') return failed({ error: 'refused', code: 'shape', message: 'a text question is answered by a reply in the chat, never in a view' });
		if (inView && input.view === undefined) return failed({ error: 'refused', code: 'shape', message: '--answer-in view needs --view with the view whose tabs the options name' });
		if (input.ref !== undefined && isHookRef(input.ref)) return hookRefused(input.ref);
		const attach = attachOf(input.files, context);
		const session = await openSession(context);
		const body = { markdown: input.body };
		const extras = { ...attach, ...viewHost(session, input.view), ...(input.once ? { once: true } : {}) };
		// An option named like a tab of the view opens that tab once picked. A held ref keeps the tabs
		// its first ask bound, so an identical retry equals the stored spec whatever the view holds
		// now. Only a new question reads the view's tabs; a dry run makes no request, so it reads none.
		// A question answered in the view binds every option to the tab of its label, and the send
		// checks those tabs on the view host. An option given with its own tab keeps that tab.
		const held = input.ref !== undefined ? await session.chat.get(input.ref) : undefined;
		const labels = kind === 'yesNo' ? mergeLabels(session.config.labels) : undefined;
		const entries: Option[] = labels
			? [
					{ label: labels.yes, value: 'yes' },
					{ label: labels.no, value: 'no' },
				]
			: given.filter(isOptionInput).map((item) => (isString(item) ? { label: item } : { label: item.label, ...(item.tab !== undefined ? { tab: item.tab } : {}) }));
		const named = entries.map((entry) => entry.label);
		const tabs = held
			? boundTabs(held)
			: inView
				? named
				: kind === 'choice' && input.view !== undefined && !input.dryRun
					? await tabsOf(viewsOf(session), input.view)
					: [];
		const options = entries.map((entry) => (entry.tab === undefined && tabs.includes(entry.label) ? { ...entry, tab: entry.label } : entry));
		const spec =
			kind === 'text'
				? text(body, extras)
				: choice(body, options, { ...extras, ...(labels ? { layout: 'row' as const } : {}), ...(inView ? { in: 'view' as const } : {}) });
		const outcome = await session.chat.send(spec, {
			needsListener: true,
			...(input.topic !== undefined ? { topic: input.topic } : {}),
			...(input.ref !== undefined ? { ref: input.ref } : {}),
			...(input.meta !== undefined ? { meta: input.meta } : {}),
			...(input.strict ? { strict: true } : {}),
			...(input.dryRun ? { dryRun: true } : {}),
		});
		if (outcome.kind === 'ok' || outcome.kind === 'dry') report(context, outcome.warnings);
		const next = outcome.kind === 'ok' ? await nextOf(session, outcome.ref) : 'wait';
		return fromOutcome(outcome, (result) => (result.kind === 'dry' ? dry(result, session) : { ref: result.ref ?? null, status: result.status ?? 'pending', next }));
	},
});

const wait = command({
	name: 'wait',
	description: 'Waits for the answer of a question: 10 s by default, at most 50. Prints pending at the deadline, and whether a listener is alive.',
	tool: 'get_answer',
	params: [
		{ name: 'ref', type: 'string', required: true, description: 'The ref that ask printed.', cli: { positional: true } },
		{ name: 'seconds', type: 'integer', description: 'How long to wait: 10 by default, at most 50.', cli: { label: 'n' } },
	],
	async run(input, context) {
		if (!REF.test(input.ref)) return failed({ error: 'usage', message: `the ref "${input.ref}" is not 1 to 32 characters of [A-Za-z0-9_-]` });
		if (isHookRef(input.ref)) return hookRefused(input.ref);
		const session = await openSession(context);
		await session.fake?.answer(input.ref);
		const waited = await session.chat.wait(input.ref, input.seconds !== undefined ? { seconds: input.seconds } : {});
		return done({ ...waited });
	},
});

const close = command({
	name: 'close',
	description: 'Ends a question. With a body the message shows it, with the question folded below.',
	tool: 'close_question',
	params: [
		{ name: 'ref', type: 'string', required: true, description: 'The ref of the question.', cli: { positional: true } },
		{ ...BODY, required: false, description: 'The resolved form of the question, in Markdown.' },
	],
	async run(input, context) {
		if (isHookRef(input.ref)) return hookRefused(input.ref);
		const session = await openSession(context);
		const outcome = await session.chat.close(input.ref, ...(input.body !== undefined ? [{ markdown: input.body }] : []));
		return fromOutcome(outcome, ({ kind: _kind, ...result }) => result);
	},
});

const listenCommand = command({
	name: 'listen',
	description: 'The one process that polls getUpdates: it takes taps and replies, repairs messages and hands every answer to the answer command.',
	params: [
		{ name: 'onAnswer', type: 'string', description: 'A shell command that gets each answer as JSON on stdin and exits 0 within 30 s.', cli: { label: 'cmd' } },
		{ name: 'metaKey', type: 'string', many: true, description: 'A key of meta the answer command needs to route an answer. ask prints next: push only for a meta with all of them.', cli: { label: 'key' } },
		{ name: 'onMessage', type: 'string', description: 'A shell command that gets each message that answers nothing as JSON on stdin and exits 0 within 30 s.', cli: { label: 'cmd' } },
		{
			name: 'onUpdate',
			type: 'string',
			description: 'A shell command that gets each update of your chat as JSON on stdin, { key, epoch, updateId, update, handled }, and exits 0 once it stored it: within 10 s for a tap, 30 s for anything else.',
			cli: { label: 'cmd' },
		},
	],
	async run(input, context) {
		const { onAnswer, onMessage, onUpdate } = input;
		if (input.metaKey && onAnswer === undefined) return failed({ error: 'usage', message: '--meta-key belongs to --on-answer' });
		if (context.env.TELEGRAM_AGENT_UI_FAKE) return failed({ error: 'usage', message: 'fake mode has a built-in listener' });
		const session = await openSession(context, onAnswer !== undefined ? { onAnswer: (answer) => runShell(onAnswer, answer) } : {});
		const { chat, call, store, config } = session;
		context.log(`listening for @${config.bot.username}`);
		const stopped = await listen({
			chat,
			target: config.chat,
			origin: session.origin,
			allow: config.users,
			call,
			store,
			signal: context.signal,
			labels: config.labels,
			log: context.log,
			...(onAnswer !== undefined ? { push: { metaKeys: input.metaKey ?? [] } } : {}),
			...(session.views ? { views: session.views } : {}),
			...(onMessage !== undefined ? { onMessage: (inbound: unknown) => runShell(onMessage, inbound) } : {}),
			...(onUpdate !== undefined ? { onUpdate: (update: unknown, deadline: number) => runShell(onUpdate, update, deadline) } : {}),
		});
		if (stopped.reason === 'signal') return done({ stopped: 'signal' });
		return failed({ error: 'stopped', code: stopped.reason, message: stopped.message });
	},
});

/** The file a fake session reads nothing from: fake mode has no Bot API server. */
const NO_DOWNLOAD: FileSource = {
	download: () => Promise.reject(new Error('fake mode downloads no file')),
};

const fetchCommand = command({
	name: 'fetch',
	description:
		'Downloads a file the user sent in the chat into a cache on this machine, by the file id that a message or update command received. Prints { id, path, bytes, cached }. A file id that no message of an allowed user carried is refused.',
	tool: 'fetch_file',
	params: [{ name: 'id', type: 'string', required: true, description: "Telegram's file id of the file, as a message or update command received it.", cli: { positional: true, label: 'file id' } }],
	async run(input, context) {
		const session = await openSession(context);
		const { config, store, call } = session;
		const localFiles = context.env.TELEGRAM_AGENT_UI_FAKE ? undefined : await localFilesOf(context.env, config);
		const from: FileSource = localFiles !== undefined ? { localFiles } : session.download ? { download: session.download } : NO_DOWNLOAD;
		const fetched = await fetchFile({ id: input.id, store, call, cache: join(session.where.store, 'media'), chat: config.chat, allow: config.users, from, scrub: session.scrub });
		if (fetched.kind === 'ok') return done({ id: fetched.id, path: fetched.path, bytes: fetched.bytes, cached: fetched.cached });
		if (fetched.code === 'token') return failed({ error: 'no-config', message: `${fetched.reason}. Run init with a new token` });
		return failed({ error: 'refused', code: fetched.code, message: fetched.reason });
	},
});

/** A topic call that did nothing, as a failure: a rejected token is a config to fix, a lost answer is uncertain. */
function topicFailure(result: TopicRefused | TopicUncertain, uncertain: string): Result {
	if (result.kind === 'uncertain') return failed({ error: 'uncertain', message: `${result.reason}: ${uncertain}` });
	if (result.code === 'token') return failed({ error: 'no-config', message: `${result.reason}. Run init with a new token` });
	return failed({ error: 'refused', code: result.code, message: result.reason });
}

const topicCreate = command({
	name: 'topic create',
	description: 'Makes a topic in the private chat and prints its id, which send and ask take as --topic. Needs topic mode.',
	params: [{ name: 'name', type: 'string', required: true, description: 'The name of the topic: 1 to 128 characters.', cli: { positional: true } }],
	async run(input, context) {
		const session = await openSession(context);
		const made = await createTopic(session.call, session.config.chat, input.name);
		if (made.kind === 'ok') return done({ topic: made.topic, name: made.name });
		return topicFailure(made, 'the topic may exist; it is not made again, since a second call could make a second one');
	},
});

const topicIconsCommand = command({
	name: 'topic icons',
	description: 'Lists the icons a topic may have, each { id, emoji }, which topic icon takes. Needs topic mode.',
	params: [],
	async run(_input, context) {
		const session = await openSession(context);
		const listed = await topicIcons(session.call);
		return listed.kind === 'ok' ? done({ icons: listed.icons }) : topicFailure(listed, 'run topic icons again');
	},
});

const topicIcon = command({
	name: 'topic icon',
	description: 'Sets the icon of a topic, one of topic icons. Needs topic mode. A client may draw the new icon later.',
	params: [
		{ name: 'id', type: 'integer', required: true, description: 'The id of the topic, as topic create printed it.', cli: { positional: true } },
		{ name: 'icon', type: 'string', required: true, description: 'The custom emoji id of the icon, as topic icons lists it.', cli: { positional: true, label: 'custom emoji id' } },
	],
	async run(input, context) {
		const session = await openSession(context);
		const set = await setTopicIcon(session.call, session.config.chat, input.id, input.icon);
		return set.kind === 'ok' ? done({ topic: input.id, icon: input.icon, changed: set.changed }) : topicFailure(set, 'the icon may be set: run topic icon again, which changes nothing then');
	},
});

/** Warns for each tab label of the earlier view `id` that `labels` lacks: a sent button that names it opens the first tab. */
async function warnReplaced(views: ViewClient, id: string, labels: readonly string[], context: Context): Promise<void> {
	const earlier = await views.has(id).catch(() => undefined);
	if (!earlier) return context.log(`warning replace: the view host gave no answer about the view ${id}, so its tab labels went unchecked`);
	if (earlier.kind === 'missing') return context.log(`warning replace: no view ${id} is on the view host, so this one is new`);
	if (earlier.kind === 'refused') return context.log(`warning replace: the view host refused to read the view ${id}: ${earlier.reason}`);
	for (const label of earlier.tabs.filter((tab) => !labels.includes(tab))) {
		context.log(`warning missing-tab: the view ${id} had the tab "${label}", and this one has none of that label: a button that names it opens the first tab`);
	}
}

const viewPut = command({
	name: 'view put',
	description:
		'Publishes a view: uploads each file below the roots as a tab, with the local images it names, and images and mp4 videos as a gallery tab, to the view host in your Cloudflare account. Prints its id, its url, its files and its expiry. send and ask open it with --view <id>.',
	tool: 'publish_view',
	params: [
		{ name: 'title', type: 'string', description: 'The title above the tabs.', cli: { label: 'text' } },
		TABS,
		{ name: 'ttl', type: 'integer', description: 'The days the view lives: 7 by default, at most 365.', cli: { label: 'days' } },
		{ name: 'replace', type: 'string', description: 'The id of a view to replace. It keeps its id, so a button sent before opens the new view.', cli: { label: 'id' } },
		DRY_RUN,
	],
	async run(input, context) {
		if (!input.tabs.every(isTab)) return failed({ error: 'usage', message: 'each tab is { label, file, caption? }' });
		const read = tabInputs(input.tabs.filter(isTab), context);
		if (!read.ok) return failed(read.failure);
		if (input.ttl !== undefined && (input.ttl < 1 || input.ttl > VIEW_TTL.most)) return failed({ error: 'usage', message: `--ttl takes 1 to ${VIEW_TTL.most} days` });
		if (input.replace !== undefined && !VIEW_ID.test(input.replace)) return failed({ error: 'usage', message: `the view id "${input.replace}" is not 22 base64url characters` });
		const session = await openSession(context);
		if (input.replace !== undefined) {
			// The store holds the questions answered in this view: a tab one of them binds stays, and
			// the view lives at least as long as each of them. The put takes its expiry a moment
			// later than this one, so a check that passes here holds for it too.
			const labels = new Set(read.tabs.map((tab) => tab.label));
			const bound = await openBindings(session.store, input.replace);
			const dropped = bound.flatMap(({ ref, tabs }) => tabs.filter((tab) => !labels.has(tab)).map((tab) => `"${tab}" of question ${ref}`));
			if (dropped.length > 0) {
				return failed({ error: 'refused', code: 'shape', message: `the view ${input.replace} keeps every tab that an open question answered in it binds, and this one lacks ${dropped.join(', ')}: keep those tabs, or close the questions first` });
			}
			const expiresAt = Date.now() + (input.ttl ?? VIEW_TTL.default) * DAY;
			const outlived = bound.filter((question) => question.expiresAt === undefined || question.expiresAt > expiresAt).map((question) => question.ref);
			if (outlived.length > 0) {
				return failed({ error: 'refused', code: 'shape', message: `the view ${input.replace} would expire before the open questions ${outlived.join(', ')} answered in it: give it a longer --ttl, or close those questions first` });
			}
		}
		// A dry run makes no request and needs no view host.
		const views = input.dryRun ? undefined : viewsOf(session);
		const ready = await prepareView({ ...(input.title !== undefined ? { title: input.title } : {}), tabs: read.tabs }, { roots: session.roots });
		if (ready.kind === 'refused') return failed({ error: 'refused', code: ready.code, message: ready.reason });
		report(context, ready.warnings);
		const labels = read.tabs.map((tab) => tab.label);
		if (!views) return done({ dryRun: true, roots: session.roots, tabs: labels, files: ready.files, media: ready.prepared.media.length, warnings: ready.warnings });
		if (input.replace !== undefined) await warnReplaced(views, input.replace, labels, context);
		const put = await views.put(ready.prepared, { ...(input.replace !== undefined ? { id: input.replace } : {}), ...(input.ttl !== undefined ? { ttlDays: input.ttl } : {}) });
		if (put.kind === 'ok') return done({ id: put.id, url: put.url, expiresAt: put.expiresAt, files: ready.files });
		if (put.kind === 'uncertain') return failed({ error: 'uncertain', message: `${put.reason}. The view may be stored: run view put --replace ${put.id} with the same tabs`, id: put.id });
		if (put.status === 409) return failed({ error: 'no-view-host', message: `${put.reason}. The view host is of another release: a person runs telegram-agent-ui view deploy` });
		return failed({ error: 'refused', code: 'view-host', message: put.reason });
	},
});

const viewDelete = command({
	name: 'view delete',
	description: 'Deletes a view and its media from the view host. A button that opens it shows that the view is gone.',
	params: [{ name: 'id', type: 'string', required: true, description: 'The id that view put printed.', cli: { positional: true } }],
	async run(input, context) {
		if (!VIEW_ID.test(input.id)) return failed({ error: 'usage', message: `the view id "${input.id}" is not 22 base64url characters` });
		const session = await openSession(context);
		const deleted = await viewsOf(session).delete(input.id);
		if (deleted.kind === 'ok') return done({ id: input.id, deleted: true });
		if (deleted.kind === 'missing') return failed({ error: 'refused', code: 'unknown-view', message: `no view ${input.id} is on the view host` });
		return failed({ error: 'refused', code: 'view-host', message: deleted.reason });
	},
});

const viewDeployCommand = command({
	name: 'view deploy',
	description: 'Deploys the view host to your Cloudflare account with your wrangler login, and stores its origin in the config.',
	params: [
		{ name: 'theme', type: 'string', description: 'A shadcn cssVars theme as JSON, below the roots. It stays for later deploys.', cli: { label: 'file' } },
		{ name: 'noTheme', type: 'boolean', description: 'Drops the stored theme.' },
		{ name: 'route', type: 'string', description: 'A whole host of your own domain, such as views.example.com/*, in place of workers.dev. It stays for later deploys.', cli: { label: 'pattern' } },
		{ name: 'account', type: 'string', description: 'The Cloudflare account id, for a login with several accounts; CLOUDFLARE_ACCOUNT_ID by default. It stays for later deploys.', cli: { label: 'id' } },
		{ name: 'rotateKeys', type: 'boolean', description: 'Replaces the upload key and the media key: every media URL signed before ends.' },
	],
	run: (input, context) => viewDeploy(input, context),
});

const mcpInitCommand = command({
	name: 'mcp init',
	description: 'Writes the MCP server entry npx telegram-agent-ui@latest mcp into the user config of an MCP client. Installs nothing.',
	params: [{ name: 'client', type: MCP_CLIENTS, required: true, description: 'The MCP client whose config gets the entry.', cli: { label: MCP_CLIENTS.join('|') } }],
	run: (input, context) => mcpInit(input.client, context.env),
});

const HOOK_CLIENT = { name: 'client', type: HOOK_CLIENTS, required: true, description: 'The harness that runs the hook: Claude Code or Codex.', cli: { label: HOOK_CLIENTS.join('|') } } as const;

const hookPermissionRequest = command({
	name: 'hook permission-request',
	description:
		"The PermissionRequest hook of Claude Code and Codex: reads the tool call on stdin, asks on Telegram with Allow and Deny, and prints the decision. Any failure prints a denial. An input too long for a question prints {} for Claude Code, which then asks at its terminal, and a denial for Codex.",
	params: [HOOK_CLIENT, { name: 'seconds', type: 'integer', description: `How long the question takes answers: ${HOOK_SECONDS.most} by default and at most, 30 s inside the hook timeout of ${HOOK_SECONDS.timeout}.`, cli: { label: 'n' } }],
	run: (input, context) => permissionRequest(input, context),
	failClosed: (failure) => denial(failure.message),
});

const hookNotification = command({
	name: 'hook notification',
	description: 'The Notification hook of Claude Code: sends its text to Telegram when an agent waits for input or a permission, and nothing for other notifications.',
	params: [{ name: 'client', type: ['claude'], required: true, description: 'The harness that runs the hook: Codex has no notification hook.', cli: { label: 'claude' } }],
	run: (_input, context) => notification(context),
});

const hookInitCommand = command({
	name: 'hook init',
	description: "Writes the hook entries into the harness's user settings, keeping every other entry. Tool input then leaves the machine for Telegram.",
	params: [HOOK_CLIENT],
	run: (input, context) => hookInit(input.client, context),
});

/** The commands of this stage, in the order of section 5. */
export const commands: readonly Command[] = [
	command({ name: 'init', description: 'Pairs a bot with your private chat and writes the config.', params: [], run: (_input, context) => init(context) }),
	info,
	send,
	edit,
	ask,
	wait,
	close,
	viewPut,
	viewDelete,
	viewDeployCommand,
	listenCommand,
	fetchCommand,
	topicCreate,
	topicIconsCommand,
	topicIcon,
	hookPermissionRequest,
	hookNotification,
	hookInitCommand,
	mcpInitCommand,
];

/** The command `args` names, one word or two, with the arguments after its name. */
export function findCommand(args: readonly string[]): { command: Command; rest: string[] } | undefined {
	for (const words of [2, 1]) {
		const name = args.slice(0, words).join(' ');
		const found = commands.find((entry) => entry.name === name);
		if (found && args.length >= words) return { command: found, rest: args.slice(words) };
	}
	return undefined;
}

