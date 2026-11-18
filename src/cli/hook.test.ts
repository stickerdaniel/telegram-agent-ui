// The hooks of section 9 as a harness runs them: the bin as a subprocess with the hook input on
// stdin, its stdout read as the harness reads it, against a local Bot API server and a listener
// of the bin. The inputs are Claude Code's documented examples (facts/harness/claude-*.json,
// from https://code.claude.com/docs/en/hooks) and a Codex input that passes Codex's input
// schema; every decision is checked against Codex's output schema (facts/harness/codex-*.json,
// openai/codex at 59ac39add).
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createChat } from '../chat/create.ts';
import { type Config, paths, writeConfig } from '../commands/config.ts';
import { isRecord, isString } from '../core/check.ts';
import { parseQuestion } from '../core/parse.ts';
import { defaultLabels } from '../core/types.ts';
import { fileStore } from '../store/file.ts';
import { fetchCall } from '../telegram/fetch.ts';
import { type FakeBotApi, fakeBotApi, TOKEN } from '../telegram/fake-server.ts';

setDefaultTimeout(240_000);

const BIN = join(import.meta.dir, 'bin.ts');
const FAST = join(import.meta.dir, 'fast-clock.ts');
const FACTS = join(import.meta.dir, '..', '..', 'facts', 'harness');
const CONFIG: Config = { v: 1, bot: { id: 222, username: 'probe_bot' }, chat: 111, users: [111], labels: {}, publishRoots: [], views: {} };

const fact = (name: string): unknown => JSON.parse(readFileSync(join(FACTS, name), 'utf8'));
/** Claude Code's documented PermissionRequest input: Bash with `rm -rf node_modules`. */
const CLAUDE_INPUT = fact('claude-permission-request.json');
/** Claude Code's documented Notification input, of type `permission_prompt`. */
const CLAUDE_NOTIFICATION = fact('claude-notification.json');
const CODEX_INPUT_SCHEMA = fact('codex-permission-request.command.input.schema.json');
const CODEX_OUTPUT_SCHEMA = fact('codex-permission-request.command.output.schema.json');
/** A Codex PermissionRequest input with every field its input schema requires. */
const CODEX_INPUT = { session_id: '0199a213-81c0-7800-8aa1-bbab2a035a53', turn_id: 'turn-1', transcript_path: null, cwd: '/repo', hook_event_name: 'PermissionRequest', model: 'gpt-5.5', permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'git push origin main' } };
const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };

/**
 * True when `value` passes `schema`, for the draft-07 keywords Codex's hook schemas use:
 * `type`, `const`, `enum`, `properties`, `required`, `additionalProperties`, `allOf` and
 * `$ref` into `definitions`. `default` and `description` assert nothing.
 */
function passes(schema: unknown, value: unknown, root: unknown = schema): boolean {
	if (schema === true) return true;
	if (!isRecord(schema)) return false;
	if (isString(schema.$ref)) {
		const definitions = isRecord(root) && isRecord(root.definitions) ? root.definitions : {};
		return passes(definitions[schema.$ref.replace('#/definitions/', '')], value, root);
	}
	if (Array.isArray(schema.allOf) && !schema.allOf.every((part) => passes(part, value, root))) return false;
	if ('const' in schema && value !== schema.const) return false;
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
	if (schema.type !== undefined) {
		const types: unknown[] = Array.isArray(schema.type) ? schema.type : [schema.type];
		const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value;
		if (!types.includes(kind)) return false;
	}
	if (isRecord(value)) {
		const properties = isRecord(schema.properties) ? schema.properties : {};
		if (Array.isArray(schema.required) && !schema.required.every((key) => isString(key) && Object.hasOwn(value, key))) return false;
		for (const [key, item] of Object.entries(value)) {
			if (Object.hasOwn(properties, key)) {
				if (!passes(properties[key], item, root)) return false;
			} else if (schema.additionalProperties === false) return false;
		}
	}
	return true;
}

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Machine = { env: Record<string, string>; server: FakeBotApi; work: string };

/** A machine with its own HOME, config and Bot API server, unconfigured when `fresh`. */
async function machine(options: { fresh?: boolean } = {}): Promise<Machine> {
	const server = fakeBotApi();
	const root = mkdtempSync(join(tmpdir(), 'tau-hook-'));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	cleanups.push(() => server.stop());
	const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), TELEGRAM_AGENT_UI_API_URL: server.url };
	if (!options.fresh) await writeConfig(env, { ...CONFIG, apiUrl: server.url }, TOKEN);
	const work = join(root, 'work');
	mkdirSync(work);
	return { env, server, work };
}

/** Starts the bin with `args` and `stdin`. `result()` is its exit code and its stdout as text. */
function spawn(at: Machine, args: string[], stdin?: string) {
	const child = Bun.spawn([process.execPath, '--preload', FAST, BIN, ...args], { cwd: at.work, env: at.env, stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' });
	cleanups.push(() => child.kill('SIGKILL'));
	return {
		child,
		async result(): Promise<{ code: number; out: string; err: string }> {
			const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			return { code, out, err };
		},
	};
}

/** Runs `hook permission-request` for `client` on `input` to its end. */
function hook(at: Machine, client: 'claude' | 'codex', input: unknown, seconds?: number) {
	return spawn(at, ['hook', 'permission-request', '--client', client, ...(seconds !== undefined ? ['--seconds', String(seconds)] : [])], typeof input === 'string' ? input : JSON.stringify(input));
}

/** Resolves once `check` holds, polling every 50 ms; throws after `ms`. */
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 120_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(50);
	}
}

/** A listener of the bin, started once its first poll reached the server. */
async function listener(at: Machine) {
	const polls = at.server.calls('getUpdates').length;
	const process = spawn(at, ['listen']);
	await until(() => at.server.calls('getUpdates').length > polls, "the listener's first poll");
	return process;
}

/** The decision a hook printed: one JSON object on one line, and nothing else. */
function decision(out: string): unknown {
	expect(out.endsWith('\n')).toBe(true);
	expect(out.trimEnd().split('\n')).toHaveLength(1);
	const value: unknown = JSON.parse(out);
	expect(passes(CODEX_OUTPUT_SCHEMA, value)).toBe(true);
	return value;
}

/** A denial whose message holds `reason`. */
const denied = (reason: RegExp) => ({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: expect.stringMatching(reason) } } });

/** The question message the `index`th send created, with the ref its buttons name. */
async function question(at: Machine, index = 0) {
	const questions = () => at.server.calls('sendRichMessage').filter((call) => call.payload.reply_markup !== undefined);
	await until(() => questions().length > index, `question ${index}`);
	const message = [...at.server.messages.values()].filter((stored) => stored.reply_markup !== undefined)[index];
	if (!message) throw new Error(`no question ${index}`);
	const data = JSON.stringify(message.reply_markup);
	const ref = /"q:([A-Za-z0-9_-]+):0"/.exec(data)?.[1];
	if (ref === undefined) throw new Error('the question has no buttons');
	return { id: message.message_id, ref, sent: message };
}

const stored = (at: Machine, ref: string) => fileStore(paths(at.env).store(222)).get(`q:${ref}`).then(parseQuestion);

test('the validator of these tests rejects what the Codex output schema rejects', () => {
	expect(passes(CODEX_OUTPUT_SCHEMA, ALLOW)).toBe(true);
	expect(passes(CODEX_OUTPUT_SCHEMA, {})).toBe(true);
	expect(passes(CODEX_OUTPUT_SCHEMA, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', note: 'x' } } })).toBe(false);
	expect(passes(CODEX_OUTPUT_SCHEMA, { hookSpecificOutput: { decision: { behavior: 'allow' } } })).toBe(false);
	expect(passes(CODEX_OUTPUT_SCHEMA, { decision: 'allow' })).toBe(false);
	expect(passes(CODEX_INPUT_SCHEMA, CODEX_INPUT)).toBe(true);
	expect(passes(CODEX_INPUT_SCHEMA, { ...CODEX_INPUT, turn_id: undefined })).toBe(false);
});

test('an Allow tap prints the allow decision alone, and a Deny tap a denial with a message', async () => {
	const at = await machine();
	await listener(at);
	const allowing = hook(at, 'claude', CLAUDE_INPUT);
	const first = await question(at);
	// The tool's name, its whole command and its other field, with Allow and Deny in one row.
	expect(first.ref.startsWith('hook-')).toBe(true);
	expect(first.sent.rich_message).toEqual({
		blocks: [{ type: 'paragraph', text: { type: 'bold', text: 'Bash' } }, { type: 'pre', text: 'rm -rf node_modules' }, { type: 'pre', text: '{\n  "description": "Remove node_modules directory"\n}', language: 'json' }],
	});
	expect(first.sent.reply_markup).toEqual({
		inline_keyboard: [
			[
				{ text: 'Allow', callback_data: `q:${first.ref}:0`, style: 'primary' },
				{ text: 'Deny', callback_data: `q:${first.ref}:1`, style: 'danger' },
			],
		],
	});
	at.server.tap(first.id, 0);
	const allowed = await allowing.result();
	expect(allowed.code).toBe(0);
	expect(allowed.out).toBe(`${JSON.stringify(ALLOW)}\n`);
	expect(decision(allowed.out)).toEqual(ALLOW);
	// The question is closed with its mark, so it takes no other tap.
	expect(await stored(at, first.ref)).toMatchObject({ status: 'closed', answer: { kind: 'choice', index: 0, value: 'allow' } });

	expect(passes(CODEX_INPUT_SCHEMA, CODEX_INPUT)).toBe(true);
	const denying = hook(at, 'codex', CODEX_INPUT);
	const second = await question(at, 1);
	expect(second.sent.rich_message).toEqual({ blocks: [{ type: 'paragraph', text: { type: 'bold', text: 'Bash' } }, { type: 'pre', text: 'git push origin main' }] });
	at.server.tap(second.id, 1);
	const refused = await denying.result();
	expect(refused.code).toBe(0);
	expect(decision(refused.out)).toEqual(denied(/Dana denied this on Telegram/));
});

test('a passed deadline closes the question and prints a denial, and a tap after it changes nothing', async () => {
	const at = await machine();
	await listener(at);
	const started = Date.now();
	const waiting = hook(at, 'claude', CLAUDE_INPUT, 2);
	const asked = await question(at);
	expect((await stored(at, asked.ref))?.expiresAt).toBeLessThanOrEqual(Date.now() + 2000);
	// A tap once the deadline has passed, on the button the message showed.
	await Bun.sleep(Math.max(0, started + 3500 - Date.now()));
	at.server.push({ callback_query: { id: 'late-tap', from: { id: 111, is_bot: false, first_name: 'Dana' }, message: structuredClone(asked.sent), chat_instance: '1', data: `q:${asked.ref}:0` } });
	const late = await at.server.waitFor('answerCallbackQuery', (call) => call.payload.callback_query_id === 'late-tap');
	expect(late.payload.text).toBe(defaultLabels.closed);
	const result = await waiting.result();
	expect(result.code).toBe(0);
	expect(decision(result.out)).toEqual(denied(/deadline/));
	const closed = await stored(at, asked.ref);
	expect(closed).toMatchObject({ status: 'closed', seq: 0, resolved: { blocks: [{ type: 'paragraph', text: defaultLabels.expired }] } });
	expect(closed && 'answer' in closed ? closed.answer : undefined).toBeUndefined();
});

test('a killed hook prints nothing, and a later hook never takes the answer of its question', async () => {
	const at = await machine();
	await listener(at);
	const killed = hook(at, 'claude', CLAUDE_INPUT, 60);
	const first = await question(at);
	killed.child.kill('SIGKILL');
	const dead = await killed.result();
	expect(dead.out).toBe('');
	// The human allows the question of the dead hook.
	at.server.tap(first.id, 0);
	await until(async () => (await stored(at, first.ref))?.status === 'answered', 'the allow on the first question');
	// The same tool call again asks its own question and waits for its own answer.
	const result = await hook(at, 'claude', CLAUDE_INPUT, 2).result();
	expect(decision(result.out)).toEqual(denied(/deadline/));
	const refs = at.server.calls('sendRichMessage').flatMap((call) => /"q:([A-Za-z0-9_-]+):0"/.exec(JSON.stringify(call.payload.reply_markup) ?? '')?.slice(1) ?? []);
	expect(refs).toHaveLength(2);
	expect(refs[1]).not.toBe(first.ref);
});

test('malformed stdin, no config, no listener and a refused send each print a denial', async () => {
	const at = await machine();
	for (const input of ['not json', JSON.stringify({ ...(isRecord(CLAUDE_INPUT) ? CLAUDE_INPUT : {}), hook_event_name: 'PreToolUse' }), JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' })]) {
		const malformed = await hook(at, 'claude', input).result();
		expect(malformed.code).toBe(0);
		expect(decision(malformed.out)).toEqual(denied(/no PermissionRequest hook input of Claude Code/));
	}
	const unlistened = await hook(at, 'codex', CODEX_INPUT).result();
	expect(decision(unlistened.out)).toEqual(denied(/no listener is alive/));
	expect(at.server.calls('sendRichMessage')).toHaveLength(0);

	await listener(at);
	at.server.fail('sendRichMessage', { status: 400, description: 'Bad Request: chat not found' });
	const refused = await hook(at, 'claude', CLAUDE_INPUT).result();
	expect(decision(refused.out)).toEqual(denied(/chat not found/));

	const fresh = await machine({ fresh: true });
	const unconfigured = await hook(fresh, 'claude', CLAUDE_INPUT).result();
	expect(unconfigured.code).toBe(0);
	expect(decision(unconfigured.out)).toEqual(denied(/no config/));
});

test('an input over the body limit gets no decision and sends labels.tooLong, and one that fits goes out whole', async () => {
	const at = await machine();
	await listener(at);
	const input = (command: string) => ({ ...(isRecord(CLAUDE_INPUT) ? CLAUDE_INPUT : {}), tool_input: { command } });
	const long = `echo ${'x'.repeat(3_600)}`;
	// A short deadline: a question that went out ends in a denial within seconds.
	const tooLong = await hook(at, 'claude', input(long), 2).result();
	expect(tooLong.code).toBe(0);
	expect(tooLong.out).toBe('{}\n');
	expect(decision(tooLong.out)).toEqual({});
	const sent = at.server.calls('sendRichMessage');
	expect(sent).toHaveLength(1);
	expect(sent[0]?.payload).toMatchObject({ rich_message: { blocks: [{ type: 'paragraph', text: { type: 'bold', text: 'Bash' } }, { type: 'paragraph', text: defaultLabels.tooLong }] } });
	expect(sent[0]?.payload.reply_markup).toBeUndefined();
	expect(await fileStore(paths(at.env).store(222)).list('q:')).toEqual([]);

	// A file change is shown whole too, so one over the limit gets no decision either.
	const write = { ...(isRecord(CLAUDE_INPUT) ? CLAUDE_INPUT : {}), tool_name: 'Write', tool_input: { file_path: '/repo/big.txt', content: 'z\n'.repeat(1_800) } };
	expect((await hook(at, 'claude', write, 2).result()).out).toBe('{}\n');
	expect(at.server.calls('sendRichMessage')).toHaveLength(2);
	expect(await fileStore(paths(at.env).store(222)).list('q:')).toEqual([]);

	// Codex lets another handler's allow stand when this one gives no decision, so it gets a denial.
	const codex = await hook(at, 'codex', { ...CODEX_INPUT, tool_input: { command: long } }, 2).result();
	expect(codex.code).toBe(0);
	expect(decision(codex.out)).toEqual(denied(/the input was too long to approve on Telegram/));
	expect(at.server.calls('sendRichMessage')).toHaveLength(3);
	expect(await fileStore(paths(at.env).store(222)).list('q:')).toEqual([]);

	const fits = `echo ${'y'.repeat(3_000)}`;
	const asking = hook(at, 'claude', input(fits));
	const asked = await question(at);
	expect(asked.sent.rich_message).toEqual({ blocks: [{ type: 'paragraph', text: { type: 'bold', text: 'Bash' } }, { type: 'pre', text: fits }] });
	at.server.tap(asked.id, 1);
	expect(decision((await asking.result()).out)).toEqual(denied(/denied this on Telegram/));
});

test('the agent-facing commands and tools refuse a hook question, and an edit of its stored body denies', async () => {
	const at = await machine();
	await listener(at);
	const asking = hook(at, 'claude', CLAUDE_INPUT);
	const asked = await question(at);
	const sent = JSON.stringify({ chat: 111, message: asked.id, files: [] });
	const refused = { code: 1, out: expect.stringContaining('"code":"shape"') };
	// The prefix in another letter case names the same file on a case-insensitive volume.
	const upper = asked.ref.replace('hook-', 'HOOK-');
	const title = asked.ref.replace('hook-', 'Hook-');
	for (const args of [
		['edit', '--ref', asked.ref, '-'],
		['edit', sent, '-'],
		['edit', JSON.stringify({ chat: 111, message: asked.id, files: [], ref: asked.ref }), '-'],
		['close', asked.ref],
		['wait', asked.ref],
		['ask', '--yes-no', '--ref', asked.ref, '-'],
		['edit', '--ref', upper, '-'],
		['close', title],
		['wait', upper, '--seconds', '0'],
		['ask', '--yes-no', '--ref', title, '-'],
	]) {
		expect(await spawn(at, args, 'Allow `rm -rf /`?').result()).toMatchObject(refused);
	}
	const info = await spawn(at, ['info']).result();
	expect(info.out).not.toContain(asked.ref);

	// The same through the MCP tools.
	const client = new Client({ name: 'test', version: '1.0.0' });
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], cwd: at.work, env: at.env, stderr: 'pipe' }));
	cleanups.push(() => client.close());
	const calls: [string, Record<string, unknown>][] = [
		['edit_message', { ref: asked.ref, body: 'Allow `ls`?' }],
		['edit_message', { sent: { chat: 111, message: asked.id, files: [] }, body: 'Allow `ls`?' }],
		['edit_message', { sent: { chat: 111, message: asked.id, files: [], ref: asked.ref }, body: 'Allow `ls`?' }],
		['close_question', { ref: asked.ref }],
		['get_answer', { ref: asked.ref, seconds: 0 }],
		['ask_question', { body: 'Allow?', answer: 'yesNo', ref: asked.ref }],
		['get_answer', { ref: upper, seconds: 0 }],
		['close_question', { ref: title }],
	];
	for (const [name, args] of calls) {
		const result = await client.callTool({ name, arguments: args });
		expect(result).toMatchObject({ isError: true, structuredContent: { error: 'refused', code: 'shape' } });
	}
	expect(JSON.stringify(await client.callTool({ name: 'get_status', arguments: {} }))).not.toContain(asked.ref);

	// A writer that goes around the commands, through the library on the same store, changes
	// the body; an Allow on the message that shows it is no allow.
	const chat = createChat({ call: fetchCall({ token: TOKEN, apiUrl: at.server.url }), store: fileStore(paths(at.env).store(222)), chat: 111 });
	expect(await chat.edit({ chat: 111, message: asked.id, files: [], ref: asked.ref }, { blocks: [{ type: 'pre', text: 'ls' }] })).toMatchObject({ kind: 'ok' });
	at.server.tap(asked.id, 0);
	const result = await asking.result();
	expect(decision(result.out)).toEqual(denied(/changed after it was sent/));
});

test('hook notification sends one message for agent_needs_input and for permission_prompt, and none for other types', async () => {
	const at = await machine();
	const base = isRecord(CLAUDE_NOTIFICATION) ? CLAUDE_NOTIFICATION : {};
	for (const type of ['permission_prompt', 'idle_prompt', 'agent_needs_input', 'auth_success']) {
		const result = await spawn(at, ['hook', 'notification', '--client', 'claude'], JSON.stringify({ ...base, notification_type: type })).result();
		expect(result).toMatchObject({ code: 0, out: '{}\n' });
	}
	const sent = at.server.calls('sendRichMessage');
	expect(sent).toHaveLength(2);
	for (const call of sent) expect(call.payload).toMatchObject({ rich_message: { blocks: [{ type: 'paragraph', text: 'Claude needs your permission' }] } });
});
