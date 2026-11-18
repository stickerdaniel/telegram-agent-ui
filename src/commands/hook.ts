// The harness integration of section 9. Claude Code and Codex both run a `PermissionRequest`
// hook for a tool call that needs a permission: it gets the call as JSON on stdin and prints a
// decision on stdout. `hook permission-request` reads that JSON through a thin adapter per
// client, asks on Telegram with an Allow and a Deny button, and prints the answer as the one
// JSON object both harnesses read, with exit 0. Every way to fail prints a denial: no listener,
// no config, stdin it cannot read, a refused send and any error, also a deadline 30 s before the
// harness cancels the hook. The message shows the whole call: a shell command, a file change
// with its whole text, every other field. An input too long for a question body gets no
// approval: the command sends `labels.tooLong`, and for Claude Code prints `{}`, no decision, so
// Claude Code asks at its terminal. For Codex it prints a denial, since Codex lets another
// handler's allow stand when this one gives no decision. A hook question's ref starts with
// `hook-`, which the agent-facing commands refuse in any letter case.
//
// Claude Code: https://code.claude.com/docs/en/hooks, "PermissionRequest input" and
// "PermissionRequest decision control". Codex: codex-rs/hooks/schema/generated/
// permission-request.command.{input,output}.schema.json and events/permission_request.rs of
// openai/codex at 59ac39add; the output schema rejects unknown fields, and `updatedInput`,
// `updatedPermissions` and `interrupt` fail closed, so the decision carries none of them.
import { choice, message } from '../core/builders.ts';
import { isJson, isRecord, isString, sameJson } from '../core/check.ts';
import { mergeLabels } from '../core/labels.ts';
import { bodyLike } from '../core/render.ts';
import { questionBodyIssue } from '../core/shape.ts';
import type { Body, Json, Labels, Question } from '../core/types.ts';
import type { Chat } from '../chat/create.ts';
import { done, failed, fromOutcome, type Result } from './result.ts';
import { type Context, openSession } from './session.ts';

export const HOOK_CLIENTS = ['claude', 'codex'] as const;
export type HookClient = (typeof HOOK_CLIENTS)[number];

/**
 * The hook timeout that `hook init` writes, and the most `--seconds` a hook under it may ask
 * for, which is also the default: the question closes 30 s before the harness cancels the hook.
 */
export const HOOK_SECONDS = { timeout: 600, most: 570 } as const;

/** The notification types of Claude Code that `hook notification` passes on: an agent waits for the human. */
export const NOTIFIED = ['agent_needs_input', 'permission_prompt'] as const;

type Fields = { [key: string]: Json };

/**
 * One tool call as the human reads it, with nothing of its input left out: a shell command, a
 * file change with the paths it names and its whole text, each with `rest`, every other field
 * of the input; or the whole input.
 */
export type ToolCall = { tool: string } & ({ kind: 'shell'; command: string; rest: Fields } | { kind: 'file'; paths: string[]; change: string; diff: boolean; rest: Fields } | { kind: 'other'; input: Json });

/**
 * The prefix of every hook question's ref. The agent-facing commands and tools refuse such a
 * ref and leave such questions out of `info`, so the agent a hook gates cannot read, edit,
 * close or ask again the question that decides its own call. The prefix is reserved in any
 * letter case, since a store on a case-insensitive volume reads `HOOK-x` from the file of `hook-x`.
 */
export const HOOK_REF_PREFIX = 'hook-';
export const isHookRef = (ref: string) => ref.toLowerCase().startsWith(HOOK_REF_PREFIX);

/** What the harness reads: the decision alone, with no other field. */
export type Decision = { hookSpecificOutput: { hookEventName: 'PermissionRequest'; decision: { behavior: 'allow' } | { behavior: 'deny'; message: string } } };

const ALLOW: Decision = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };

/** A denial with the reason the agent reads. */
export const denial = (reason: string): Decision => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: `telegram-agent-ui: ${reason}` } } });

/** `input` without the fields `keys` names. */
const without = (input: Fields, ...keys: string[]): Fields => Object.fromEntries(Object.entries(input).filter(([key]) => !keys.includes(key)));

/** An edit as one diff: every line of `before` behind `-`, then every line of `after` behind `+`. */
const asDiff = (before: string, after: string) => [...before.split('\n').map((line) => `-${line}`), ...after.split('\n').map((line) => `+${line}`)].join('\n');

// A file header of an apply_patch patch. Leading white space and spacing around the colon pass,
// so no header that Codex might read hides its file from the list.
const PATCH_HEADER = /^\s*\*\*\*\s*(?:(?:Add|Update|Delete)\s+File|Move\s+to)\s*:\s*(.+?)\s*$/;

/**
 * Claude Code's tools: `Bash` and `PowerShell` run `command`, `Write` writes `content` to
 * `file_path`, `Edit` replaces `old_string` with `new_string` in it. Any other tool, or one
 * whose fields break those types, shows its whole input.
 */
function claudeCall(tool: string, input: Fields): ToolCall {
	const { command, file_path: path, content, old_string: before, new_string: after } = input;
	if ((tool === 'Bash' || tool === 'PowerShell') && isString(command)) return { tool, kind: 'shell', command, rest: without(input, 'command') };
	if (tool === 'Write' && isString(path) && isString(content)) return { tool, kind: 'file', paths: [path], change: content, diff: false, rest: without(input, 'file_path', 'content') };
	if (tool === 'Edit' && isString(path) && isString(before) && isString(after)) {
		return { tool, kind: 'file', paths: [path], change: asDiff(before, after), diff: true, rest: without(input, 'file_path', 'old_string', 'new_string') };
	}
	return { tool, kind: 'other', input };
}

/**
 * Codex's tools: `Bash` runs `command`, with `description` for the reason or the network
 * target, and `apply_patch` carries its whole patch in `command` (core/src/tools/approvals.rs
 * and sandboxing.rs at 59ac39add). Any other tool shows its whole input.
 */
function codexCall(tool: string, input: Json): ToolCall {
	if (!isRecord(input) || !isString(input.command)) return { tool, kind: 'other', input };
	const { command } = input;
	const rest = without(input, 'command');
	if (tool === 'Bash') return { tool, kind: 'shell', command, rest };
	if (tool === 'apply_patch') return { tool, kind: 'file', paths: command.split('\n').flatMap((line) => PATCH_HEADER.exec(line)?.slice(1) ?? []), change: command, diff: true, rest };
	return { tool, kind: 'other', input };
}

/**
 * The tool call of a PermissionRequest hook's stdin, or undefined for anything else: no JSON
 * object, another `hook_event_name`, no `tool_name`, or a `tool_input` that the client never
 * sends. Claude Code sends an object, Codex any JSON value.
 *
 *   readToolCall('claude', '{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"ls"}}');
 *   // { tool: 'Bash', kind: 'shell', command: 'ls' }
 */
export function readToolCall(client: HookClient, stdin: string): ToolCall | undefined {
	let value: unknown;
	try {
		value = JSON.parse(stdin);
	} catch {
		return undefined;
	}
	if (!isRecord(value) || value.hook_event_name !== 'PermissionRequest' || !isString(value.tool_name) || value.tool_name === '') return undefined;
	const { tool_name: tool, tool_input: input } = value;
	if (!isJson(input)) return undefined;
	if (client === 'claude') return isRecord(input) ? claudeCall(tool, input) : undefined;
	return codexCall(tool, input);
}

/** A code block of JSON. */
const json = (value: Json) => ({ type: 'pre' as const, text: JSON.stringify(value, null, 2), language: 'json' });

/**
 * The approval's body: the tool's name in bold, then the whole call. A shell command in a code
 * block, a file change as its paths and its whole text in a code block, and every other field
 * as JSON below; any other tool's input as JSON.
 */
export function approvalBody(call: ToolCall): Body {
	const head = { type: 'paragraph' as const, text: { type: 'bold' as const, text: call.tool } };
	if (call.kind === 'other') return { blocks: [head, json(call.input)] };
	const rest = Object.keys(call.rest).length > 0 ? [json(call.rest)] : [];
	if (call.kind === 'shell') return { blocks: [head, { type: 'pre', text: call.command }, ...rest] };
	const paths = call.paths.map((path) => ({ type: 'paragraph' as const, text: { type: 'code' as const, text: path } }));
	return { blocks: [head, ...paths, { type: 'pre', text: call.change, ...(call.diff ? { language: 'diff' } : {}) }, ...rest] };
}

/** All of stdin, or nothing for a caller without one. */
const stdinOf = (context: Context) => context.stdin?.() ?? Promise.resolve('');

/** Runs a call whose outcome changes no decision, such as the close after an answer. */
async function quietly(work: () => Promise<unknown>): Promise<void> {
	await work().catch(() => undefined);
}

// The prefix and 27 characters of [a-z2-7]: 135 random bits, so no two invocations share a question.
const REF_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const hookRef = () => `${HOOK_REF_PREFIX}${[...crypto.getRandomValues(new Uint8Array(27))].map((byte) => REF_ALPHABET.charAt(byte % 32)).join('')}`;

/**
 * Waits for the answer of question `ref` until `expiresAt`, and decides. The answer the store
 * holds for this ref is the only one read: an Allow tap allows, any other answer denies. A
 * stored spec other than `spec`, the one this hook sent, denies before any answer is read, so
 * an edit of the question after the send never turns into an allow of what the human did not
 * see. At `expiresAt`, on `signal`, or once no listener is alive, the question closes and the
 * call is denied. A tap applied before `expiresAt` is stored before it, so the last read sees it.
 */
async function decide(chat: Chat, ref: string, spec: Question['spec'], expiresAt: number, expired: Body, signal: AbortSignal): Promise<Decision> {
	for (;;) {
		const question = await chat.get(ref);
		if (!question) return denial(`the question ${ref} is gone from the store`);
		if (!sameJson(question.spec, spec)) {
			await quietly(() => chat.close(ref, expired));
			return denial(`the question ${ref} changed after it was sent`);
		}
		if ('answer' in question && question.answer) {
			await quietly(() => chat.close(ref));
			const { answer, by } = question;
			if (answer.kind === 'choice' && answer.value === 'allow') return ALLOW;
			return denial(`${by?.name ?? 'the user'} denied this on Telegram`);
		}
		if (question.status === 'closed') return denial(`the question ${ref} was closed without an answer`);
		const left = expiresAt - Date.now();
		if (left <= 0 || signal.aborted) {
			await quietly(() => chat.close(ref, expired));
			return denial(left <= 0 ? 'no answer on Telegram before the deadline' : 'the hook was stopped before an answer');
		}
		// Short waits, so a stop signal ends the hook within a second.
		const waited = await chat.wait(ref, { seconds: Math.min(1, left / 1000) });
		if (waited.status === 'pending' && !waited.listener.alive) {
			await quietly(() => chat.close(ref));
			return denial('no listener is alive to receive the answer: start telegram-agent-ui listen');
		}
	}
}

/**
 * `hook permission-request`: asks on Telegram whether the tool call on stdin may run, and
 * returns the decision for the harness. An input too long for a question body gets `{}` from
 * Claude Code's hook and a denial from Codex's. A
 * thrown error is the table's to turn into a denial. The question is a choice of `labels.allow`
 * and `labels.deny` with `once`, under a ref of its own, with `expiresAt` `seconds` ahead.
 *
 *   echo "$PERMISSION_REQUEST_JSON" | telegram-agent-ui hook permission-request --client claude
 */
export async function permissionRequest(input: { client: HookClient; seconds?: number }, context: Context): Promise<Result> {
	const seconds = input.seconds ?? HOOK_SECONDS.most;
	if (seconds < 1 || seconds > HOOK_SECONDS.most) return done(denial(`--seconds takes 1 to ${HOOK_SECONDS.most}, ${HOOK_SECONDS.timeout - HOOK_SECONDS.most} s inside the hook timeout of ${HOOK_SECONDS.timeout}`));
	const call = readToolCall(input.client, await stdinOf(context));
	if (!call) return done(denial(`stdin holds no PermissionRequest hook input of ${input.client === 'claude' ? 'Claude Code' : 'Codex'}`));
	const session = await openSession(context);
	const { chat } = session;
	const labels: Labels = mergeLabels(session.config.labels);
	const body = approvalBody(call);
	if (questionBodyIssue(body) !== undefined) {
		// No cut: the human reads the whole input or none. Claude Code asks at its terminal when
		// the hook gives no decision. Codex may let another reviewer decide then, so it gets a denial.
		await quietly(() => chat.send(message({ blocks: [{ type: 'paragraph', text: { type: 'bold', text: call.tool } }, { type: 'paragraph', text: labels.tooLong }] })));
		return done(input.client === 'codex' ? denial('the input was too long to approve on Telegram') : {});
	}
	const ref = hookRef();
	const expiresAt = Date.now() + seconds * 1000;
	const spec = choice(
		body,
		[
			{ label: labels.allow, value: 'allow', style: 'primary' },
			{ label: labels.deny, value: 'deny', style: 'danger' },
		],
		{ layout: 'row', once: true },
	);
	const meta = { hook: 'permission-request', client: input.client, tool: call.tool };
	const outcome = await chat.send(spec, { ref, expiresAt, meta, needsListener: true });
	if (outcome.kind === 'refused') return done(denial(outcome.code === 'no-listener' ? 'no listener is alive to receive the answer: start telegram-agent-ui listen' : `the question was refused (${outcome.code}): ${outcome.reason}`));
	if (outcome.kind !== 'ok') {
		// The body may have arrived: closed, it takes no tap.
		await quietly(() => chat.close(ref));
		return done(denial(`the question may not have arrived: ${outcome.kind === 'uncertain' ? outcome.reason : outcome.kind}`));
	}
	const expired = bodyLike(body, labels.expired);
	try {
		return done(await decide(chat, ref, spec, expiresAt, expired, context.signal));
	} catch (error) {
		await quietly(() => chat.close(ref, expired));
		throw error;
	}
}

/**
 * `hook notification --client claude`: sends Claude Code's notification text to Telegram when
 * an agent waits for the human, `agent_needs_input` or `permission_prompt`, and nothing for
 * any other type. Prints `{}`, which Claude Code reads as no output.
 */
export async function notification(context: Context): Promise<Result> {
	let value: unknown;
	try {
		value = JSON.parse(await stdinOf(context));
	} catch {
		value = undefined;
	}
	if (!isRecord(value) || value.hook_event_name !== 'Notification' || !isString(value.notification_type) || !isString(value.message)) {
		return failed({ error: 'usage', message: 'stdin holds no Notification hook input of Claude Code' });
	}
	const { notification_type: type, message: text, title } = value;
	if (!NOTIFIED.some((kind) => kind === type)) return done({});
	const session = await openSession(context);
	const head = isString(title) && title !== '' ? [{ type: 'paragraph' as const, text: { type: 'bold' as const, text: title } }] : [];
	const outcome = await session.chat.send(message({ blocks: [...head, { type: 'paragraph', text: text }] }));
	return fromOutcome(outcome, () => ({}));
}
