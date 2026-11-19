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

export const HOOK_SECONDS = { timeout: 600, most: 570 } as const;

export const NOTIFIED = ['agent_needs_input', 'permission_prompt'] as const;

type Fields = { [key: string]: Json };

export type ToolCall = { tool: string } & ({ kind: 'shell'; command: string; rest: Fields } | { kind: 'file'; paths: string[]; change: string; diff: boolean; rest: Fields } | { kind: 'other'; input: Json });

export const HOOK_REF_PREFIX = 'hook-';
export const isHookRef = (ref: string) => ref.toLowerCase().startsWith(HOOK_REF_PREFIX);

export type Decision = { hookSpecificOutput: { hookEventName: 'PermissionRequest'; decision: { behavior: 'allow' } | { behavior: 'deny'; message: string } } };

const ALLOW: Decision = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };

export const denial = (reason: string): Decision => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: `telegram-agent-ui: ${reason}` } } });

const without = (input: Fields, ...keys: string[]): Fields => Object.fromEntries(Object.entries(input).filter(([key]) => !keys.includes(key)));

const asDiff = (before: string, after: string) => [...before.split('\n').map((line) => `-${line}`), ...after.split('\n').map((line) => `+${line}`)].join('\n');

const PATCH_HEADER = /^\s*\*\*\*\s*(?:(?:Add|Update|Delete)\s+File|Move\s+to)\s*:\s*(.+?)\s*$/;

function claudeCall(tool: string, input: Fields): ToolCall {
	const { command, file_path: path, content, old_string: before, new_string: after } = input;
	if ((tool === 'Bash' || tool === 'PowerShell') && isString(command)) return { tool, kind: 'shell', command, rest: without(input, 'command') };
	if (tool === 'Write' && isString(path) && isString(content)) return { tool, kind: 'file', paths: [path], change: content, diff: false, rest: without(input, 'file_path', 'content') };
	if (tool === 'Edit' && isString(path) && isString(before) && isString(after)) {
		return { tool, kind: 'file', paths: [path], change: asDiff(before, after), diff: true, rest: without(input, 'file_path', 'old_string', 'new_string') };
	}
	return { tool, kind: 'other', input };
}

function codexCall(tool: string, input: Json): ToolCall {
	if (!isRecord(input) || !isString(input.command)) return { tool, kind: 'other', input };
	const { command } = input;
	const rest = without(input, 'command');
	if (tool === 'Bash') return { tool, kind: 'shell', command, rest };
	if (tool === 'apply_patch') return { tool, kind: 'file', paths: command.split('\n').flatMap((line) => PATCH_HEADER.exec(line)?.slice(1) ?? []), change: command, diff: true, rest };
	return { tool, kind: 'other', input };
}

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

const json = (value: Json) => ({ type: 'pre' as const, text: JSON.stringify(value, null, 2), language: 'json' });

export function approvalBody(call: ToolCall): Body {
	const head = { type: 'paragraph' as const, text: { type: 'bold' as const, text: call.tool } };
	if (call.kind === 'other') return { blocks: [head, json(call.input)] };
	const rest = Object.keys(call.rest).length > 0 ? [json(call.rest)] : [];
	if (call.kind === 'shell') return { blocks: [head, { type: 'pre', text: call.command }, ...rest] };
	const paths = call.paths.map((path) => ({ type: 'paragraph' as const, text: { type: 'code' as const, text: path } }));
	return { blocks: [head, ...paths, { type: 'pre', text: call.change, ...(call.diff ? { language: 'diff' } : {}) }, ...rest] };
}

const stdinOf = (context: Context) => context.stdin?.() ?? Promise.resolve('');

async function quietly(work: () => Promise<unknown>): Promise<void> {
	await work().catch(() => undefined);
}

const REF_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const hookRef = () => `${HOOK_REF_PREFIX}${[...crypto.getRandomValues(new Uint8Array(27))].map((byte) => REF_ALPHABET.charAt(byte % 32)).join('')}`;

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
		const waited = await chat.wait(ref, { seconds: Math.min(1, left / 1000) });
		if (waited.status === 'pending' && !waited.listener.alive) {
			await quietly(() => chat.close(ref));
			return denial('no listener is alive to receive the answer: start telegram-agent-ui listen');
		}
	}
}

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
