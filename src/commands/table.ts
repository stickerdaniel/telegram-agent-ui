// The command table of section 5. Each entry has a name, a description, its input schema, the
// MCP tool that serves it, and a handler over `createChat`. The CLI parser reads the schema
// to parse arguments, and a handler gets its input typed after `inputIssue` checked it.
import { deliveryKey } from '../chat/create.ts';
import { attemptsSince, LISTENER_KEY, listenerStatus, parseListener, spent } from '../chat/listener.ts';
import { choice, message, text, yesNo } from '../core/builders.ts';
import { isRecord } from '../core/check.ts';
import { isSent } from '../core/guards.ts';
import { mergeLabels } from '../core/labels.ts';
import { parseQuestion } from '../core/parse.ts';
import { REF } from '../core/shape.ts';
import type { Outcome, Question, Warning } from '../core/types.ts';
import { listen } from '../telegram/listen.ts';
import { MESSAGE_PREFIX, parseStoredMessage, type StoredMessage, storedKey } from '../telegram/messages.ts';
import { apiUrlOf } from './config.ts';
import { init } from './init.ts';
import { MCP_CLIENTS, mcpInit } from './mcp-init.ts';
import { type InputOf, inputIssue, isInput, type Param, usage } from './params.ts';
import { done, Failed, failed, failureOf, fromOutcome, type Result } from './result.ts';
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
};

/** A command whose handler receives the input typed by its own params. */
function command<const Ps extends readonly Param[]>(spec: { name: string; description: string; tool?: string; params: Ps; run(input: InputOf<Ps>, context: Context): Promise<Result> }): Command {
	const { name, description, tool, params } = spec;
	return {
		name,
		description,
		...(tool !== undefined ? { tool } : {}),
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
const VIEW = { name: 'view', type: 'string', description: 'The id of a published view: the message gets a button that opens it.' } as const;
const STRICT = { name: 'strict', type: 'boolean', description: 'Turns every warning into a refusal before anything is sent.' } as const;
const DRY_RUN = { name: 'dryRun', type: 'boolean', description: 'Prints what would be sent and the roots files would come from, and sends nothing.' } as const;

/** Writes each warning as a line of progress. */
const report = (context: Context, warnings: Warning[]) => {
	for (const warning of warnings) context.log(`warning ${warning.code}: ${warning.message}`);
};

/** Refuses `--view` without a deployed view host, which only `view deploy` records. */
function viewHost(session: Session, view: string | undefined): { view?: string } {
	if (view === undefined) return {};
	if (session.config.views.origin === undefined) throw new Failed({ error: 'no-view-host', message: 'no view host is deployed: a message cannot open a view yet' });
	return { view };
}

/** What a dry run prints: the calls it would make, the roots files would come from and the files it would upload. */
const dry = (outcome: Extract<Outcome, { kind: 'dry' }>, session: Session) => ({ dryRun: true, steps: outcome.steps, warnings: outcome.warnings, roots: session.roots, files: [] });

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
	description: 'Prints the config, the bot, the roots, the listener, the open, unconfirmed and undelivered questions, the undelivered messages and the view host.',
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
			if (question) questions.push(question);
		}
		const messages: StoredMessage[] = [];
		for (const key of await store.list(MESSAGE_PREFIX)) {
			const stored = parseStoredMessage(await store.get(key));
			if (stored) messages.push(stored);
		}
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
			viewHost: config.views.origin !== undefined ? { origin: config.views.origin } : null,
		});
	},
});

const send = command({
	name: 'send',
	description: 'Sends a message that asks nothing, from Markdown. Prints its Sent, which edit takes.',
	tool: 'send_message',
	params: [VIEW, { name: 'silent', type: 'boolean', description: 'Sends without a notification sound.' }, STRICT, DRY_RUN, BODY],
	async run(input, context) {
		const session = await openSession(context);
		const spec = message({ markdown: input.body }, { ...viewHost(session, input.view), ...(input.silent ? { silent: true } : {}) });
		const outcome = await session.chat.send(spec, { ...(input.strict ? { strict: true } : {}), ...(input.dryRun ? { dryRun: true } : {}) });
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
		const session = await openSession(context);
		let sent = input.sent;
		if (input.ref !== undefined) {
			const question = await session.chat.get(input.ref);
			if (!question) return failed({ error: 'refused', code: 'unknown-ref', message: `no question ${input.ref} is stored` });
			if (!('sent' in question && question.sent)) return failed({ error: 'refused', code: 'unconfirmed-message', message: `no message of question ${input.ref} is known yet` });
			sent = question.sent;
		}
		if (!isSent(sent)) return failed({ error: 'refused', code: 'shape', message: 'the Sent breaks its type: pass the JSON that send printed' });
		const outcome = await session.chat.edit(sent, { markdown: input.body });
		return fromOutcome(outcome, ({ kind: _kind, ...result }) => result);
	},
});

const ask = command({
	name: 'ask',
	description: 'Asks a question with options, yes or no, or a text answer. Prints its ref, its status and next: push when the answer command receives it, else wait.',
	tool: 'ask_question',
	params: [
		{ name: 'answer', type: ['choice', 'yesNo', 'text'], description: 'How the question is answered: a tap on an option, a tap on yes or no, or a reply.', cli: { switches: { 'yes-no': 'yesNo', text: 'text' } } },
		{ name: 'options', type: 'string', many: true, description: 'The labels of 2 to 8 options, each 1 to 46 characters.', cli: { short: 'o', flag: 'option', label: 'option' } },
		{ name: 'once', type: 'boolean', description: 'Forbids a correction after the first answer.' },
		VIEW,
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
		const session = await openSession(context);
		const body = { markdown: input.body };
		const extras = { ...viewHost(session, input.view), ...(input.once ? { once: true } : {}) };
		const spec =
			kind === 'yesNo'
				? yesNo(body, { ...extras, labels: mergeLabels(session.config.labels) })
				: kind === 'text'
					? text(body, extras)
					: choice(
							body,
							(input.options ?? []).map((label) => ({ label })),
							extras,
						);
		const outcome = await session.chat.send(spec, {
			needsListener: true,
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
	],
	async run(input, context) {
		const { onAnswer, onMessage } = input;
		if (input.metaKey && onAnswer === undefined) return failed({ error: 'usage', message: '--meta-key belongs to --on-answer' });
		if (context.env.TELEGRAM_AGENT_UI_FAKE) return failed({ error: 'usage', message: 'fake mode has a built-in listener' });
		const session = await openSession(context, onAnswer !== undefined ? { onAnswer: (answer) => runShell(onAnswer, answer) } : {});
		const { chat, call, store, config } = session;
		const base = {
			chat,
			call,
			store,
			signal: context.signal,
			labels: config.labels,
			log: context.log,
			...(onAnswer !== undefined ? { push: { metaKeys: input.metaKey ?? [] } } : {}),
		};
		const messages = onMessage === undefined ? {} : { allow: config.users, onMessage: (inbound: unknown) => runShell(onMessage, inbound) };
		context.log(`listening for @${config.bot.username}`);
		const stopped = await listen({ ...base, ...messages });
		if (stopped.reason === 'signal') return done({ stopped: 'signal' });
		return failed({ error: 'stopped', code: stopped.reason, message: stopped.message });
	},
});

const mcpInitCommand = command({
	name: 'mcp init',
	description: 'Writes the MCP server entry npx telegram-agent-ui@latest mcp into the user config of an MCP client. Installs nothing.',
	params: [{ name: 'client', type: MCP_CLIENTS, required: true, description: 'The MCP client whose config gets the entry.', cli: { label: MCP_CLIENTS.join('|') } }],
	run: (input, context) => mcpInit(input.client, context.env),
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
	listenCommand,
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

