// The bin as a subprocess against a local Bot API server, on a fresh machine of its own: temp
// HOME and XDG directories, the token in the config's .env, and every call to the server's URL.
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Config, paths, writeConfig } from '../commands/config.ts';
import { EXIT } from '../commands/result.ts';
import { isRecord } from '../core/check.ts';
import { parseQuestion } from '../core/parse.ts';
import type { Store } from '../core/types.ts';
import { fileStore } from '../store/file.ts';
import { type FakeBotApi, fakeBotApi, TOKEN } from '../telegram/fake-server.ts';

// A loaded machine starts a Bun process in seconds; every wait below has its own deadline.
setDefaultTimeout(240_000);

const BIN = join(import.meta.dir, 'bin.ts');
const FAST = join(import.meta.dir, 'fast-clock.ts');
const RACE = join(import.meta.dir, 'roots-race.ts');
const CONFIG: Config = { v: 1, bot: { id: 222, username: 'probe_bot' }, chat: 111, users: [111], labels: {}, publishRoots: [], views: {} };

// Run last first: a process ends before its directory and its server go.
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Machine = { root: string; work: string; env: Record<string, string>; server: FakeBotApi; store: Store; question: (ref: string) => Promise<ReturnType<typeof parseQuestion>> };

/** A machine with its own HOME and XDG directories and its own Bot API server, configured unless `fresh`. */
async function machine(options: { fresh?: boolean } = {}): Promise<Machine> {
	const server = fakeBotApi();
	const root = mkdtempSync(join(tmpdir(), 'tau-cli-'));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	cleanups.push(() => server.stop());
	const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root, XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), TELEGRAM_AGENT_UI_API_URL: server.url };
	if (!options.fresh) await writeConfig(env, { ...CONFIG, apiUrl: server.url }, TOKEN);
	const store = fileStore(paths(env).store(222));
	// The working directory lies below HOME: HOME itself is no root files may come from.
	const work = join(root, 'work');
	mkdirSync(work);
	return { root, work, env, server, store, question: async (ref) => parseQuestion(await store.get(`q:${ref}`)) };
}

/** Starts the bin with `args` in the machine's directory. */
function spawn(at: Machine, args: string[], options: { stdin?: string; env?: Record<string, string>; cwd?: string; preload?: string } = {}) {
	const child = Bun.spawn([process.execPath, '--preload', FAST, ...(options.preload ? ['--preload', options.preload] : []), BIN, ...args], {
		cwd: options.cwd ?? at.work,
		env: { ...at.env, ...options.env },
		stdin: options.stdin === undefined ? 'ignore' : new Blob([options.stdin]),
		stdout: 'pipe',
		stderr: 'pipe',
	});
	let err = '';
	const reading = (async () => {
		for await (const chunk of child.stderr.pipeThrough(new TextDecoderStream())) err += chunk;
	})();
	cleanups.push(() => child.kill('SIGKILL'));
	return {
		child,
		/** What the child wrote on stderr so far. */
		err: () => err,
		/** The exit code and the one JSON object on stdout. */
		async result(): Promise<{ code: number; out: Record<string, unknown>; err: string }> {
			const text = await new Response(child.stdout).text();
			const code = await child.exited;
			await reading;
			let out: Record<string, unknown>;
			try {
				out = JSON.parse(text);
			} catch {
				throw new Error(`exit ${code}, stdout is no JSON: ${text}\nstderr: ${err}`);
			}
			return { code, out, err };
		},
	};
}

/** Runs the bin to its end. */
const run = (at: Machine, args: string[], options: { stdin?: string; env?: Record<string, string>; cwd?: string; preload?: string } = {}) => spawn(at, args, options).result();

/** Resolves once `check` holds, polling every 50 ms; throws after `ms`. */
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 120_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(50);
	}
}

/** A listener of the bin, started once its first poll reached the server. */
async function listener(at: Machine, args: string[] = []) {
	const polls = at.server.calls('getUpdates').length;
	const process = spawn(at, ['listen', ...args]);
	await until(() => at.server.calls('getUpdates').length > polls, `the listener's first poll; stderr: ${process.err()}`);
	return process;
}

/** Writes `text` to a file in the machine's working directory and returns its name. */
function file(at: Machine, name: string, text: string): string {
	writeFileSync(join(at.work, name), text);
	return name;
}

/** The id of the message the last send created. */
const lastMessage = (at: Machine) => [...at.server.messages.keys()].at(-1) ?? 0;
/** The lines of a JSON lines file the machine's commands wrote, once it has `count`. */
async function lines(at: Machine, name: string, count: number): Promise<Record<string, unknown>[]> {
	const path = join(at.work, name);
	const read = () => (existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : []);
	await until(() => read().length >= count, `${count} lines in ${name}`);
	return read().map((line) => JSON.parse(line));
}

test('init, listen, ask, a tap and wait return the answer, and a text reply answers a text question', async () => {
	const at = await machine({ fresh: true });
	// The token is typed on stdin; init pairs through /start <code>.
	const pairing = spawn(at, ['init'], { stdin: `${TOKEN}\n` });
	await until(() => /start=([a-z2-7]{12})/.test(pairing.err()), 'the pairing link');
	const code = /https:\/\/t\.me\/probe_bot\?start=([a-z2-7]{12})/.exec(pairing.err())?.[1];
	at.server.say(`/start ${code}`);
	const paired = await pairing.result();
	expect(paired).toMatchObject({ code: 0, out: { bot: { id: 222, username: 'probe_bot' }, chat: 111, users: [111] } });
	const where = paths(at.env);
	expect(statSync(where.envFile).mode & 0o777).toBe(0o600);
	expect(statSync(where.config).mode & 0o777).toBe(0o700);
	expect(readFileSync(where.envFile, 'utf8')).toBe(`TELEGRAM_BOT_TOKEN=${TOKEN}\n`);
	expect(JSON.parse(readFileSync(where.configFile, 'utf8'))).toEqual({ ...CONFIG, apiUrl: at.server.url });

	const listening = await listener(at);
	const asked = await run(at, ['ask', '-o', 'Merge', '-o', 'Wait', file(at, 'q.md', 'Merge `fix/lock` now?')]);
	expect(asked).toMatchObject({ code: 0, out: { status: 'pending', next: 'wait' } });
	const ref = String(asked.out.ref);
	at.server.tap(lastMessage(at), 1);
	expect(await run(at, ['wait', ref, '--seconds', '50'])).toMatchObject({ code: 0, out: { status: 'answered', answer: { kind: 'choice', index: 1, label: 'Wait' }, by: { id: 111 }, listener: { alive: true } } });

	const textual = await run(at, ['ask', '--text', '-'], { stdin: 'Which branch?' });
	expect(textual).toMatchObject({ code: 0, out: { status: 'pending' } });
	at.server.reply(lastMessage(at), 'fix/lock');
	expect(await run(at, ['wait', String(textual.out.ref), '--seconds', '50'])).toMatchObject({ code: 0, out: { status: 'answered', answer: { kind: 'text', text: 'fix/lock' } } });

	listening.child.kill('SIGTERM');
	expect(await listening.result()).toMatchObject({ code: 0, out: { stopped: 'signal' } });
});

test('a listener killed after an answer was stored shows the mark and delivers after its restart', async () => {
	const at = await machine();
	const first = await listener(at, ['--on-answer', 'cat >> answers.jsonl']);
	const asked = await run(at, ['ask', '-o', 'Merge', '-o', 'Wait', file(at, 'q.md', 'Merge now?')]);
	const ref = String(asked.out.ref);
	const message = lastMessage(at);
	// The toast is the first call after the answer's set: it hangs, and the listener dies there.
	const release = at.server.stall('answerCallbackQuery');
	at.server.tap(message, 0);
	await until(async () => (await at.question(ref))?.status === 'answered', 'the stored answer');
	first.child.kill('SIGKILL');
	await first.child.exited;
	release();
	expect(at.server.calls('editMessageText')).toHaveLength(0);
	expect(existsSync(join(at.work, 'answers.jsonl'))).toBe(false);

	const second = await listener(at, ['--on-answer', 'cat >> answers.jsonl']);
	const [delivered] = await lines(at, 'answers.jsonl', 1);
	expect(delivered).toMatchObject({ kind: 'answered', ref, seq: 1, answer: { label: 'Merge' }, delivery: `${ref}:1` });
	await until(() => at.server.calls('editMessageText').length > 0, 'the edit with the mark');
	expect(at.server.messages.get(message)?.reply_markup).toMatchObject({ inline_keyboard: [[{ text: '✓ Merge' }], [{ text: 'Wait' }]] });
	// The listener stores the delivery once the command exited. The tap comes again with the
	// restart's first poll and changes nothing.
	await until(async () => (await at.question(ref))?.delivery.seq === 1, 'the stored delivery');
	expect(await at.question(ref)).toMatchObject({ seq: 1, applied: [expect.stringMatching(/^cq:/)] });
	second.child.kill('SIGTERM');
	await second.result();
});

test('two listen starts leave one lease holder, and the second exits 5', async () => {
	const at = await machine();
	const first = await listener(at);
	const second = await spawn(at, ['listen']).result();
	expect(second).toMatchObject({ code: EXIT.stopped, out: { error: 'stopped', code: 'lease' } });
	// The second never held the lease, so it made no call at all.
	expect(at.server.calls('getWebhookInfo')).toHaveLength(1);
	expect(first.child.exitCode).toBeNull();
	first.child.kill('SIGTERM');
	expect(await first.result()).toMatchObject({ code: 0 });
});

test('an answer command that fails 5 times shows as undelivered in info, and a restart renews it', async () => {
	const at = await machine();
	const failing = await listener(at, ['--on-answer', 'cat >> attempts.jsonl; exit 1']);
	const asked = await run(at, ['ask', '--yes-no', file(at, 'q.md', 'Deploy now?')]);
	const ref = String(asked.out.ref);
	at.server.tap(lastMessage(at), 0);
	await lines(at, 'attempts.jsonl', 5);
	// The listener stores each failure once the command exited.
	await until(async () => (await at.question(ref))?.delivery.attempts === 5, 'the fifth stored failure');
	// The listener flushes every 200 ms here: 10 more flushes try no sixth time.
	await Bun.sleep(2_000);
	expect((await lines(at, 'attempts.jsonl', 5)).length).toBe(5);
	const info = await run(at, ['info', '--json']);
	expect(info).toMatchObject({ code: 0, out: { questions: { undelivered: [{ ref, seq: 1, attempts: 5, error: 'the command exited 1' }] } } });
	failing.child.kill('SIGTERM');
	await failing.result();

	// A restart renews the budget: one more failure leaves 4 attempts, and the next one runs. It
	// hangs, so the stored count stays at 6 while info reads it.
	const renewed = await listener(at, ['--on-answer', 'cat >> attempts.jsonl; [ "$(wc -l < attempts.jsonl)" -ge 7 ] && sleep 60; exit 1']);
	await until(async () => (await at.question(ref))?.delivery.attempts === 6, 'the renewed failure');
	await lines(at, 'attempts.jsonl', 7);
	expect(await run(at, ['info'])).toMatchObject({ code: 0, out: { listener: { alive: true }, questions: { undelivered: [] } } });
	renewed.child.kill('SIGKILL');
	await renewed.child.exited;

	const working = await listener(at, ['--on-answer', 'cat >> answers.jsonl']);
	const [delivered] = await lines(at, 'answers.jsonl', 1);
	expect(delivered).toMatchObject({ ref, answer: { value: 'yes' }, delivery: `${ref}:1` });
	await until(async () => (await at.question(ref))?.delivery.seq === 1, 'the stored delivery');
	expect(await run(at, ['info'])).toMatchObject({ out: { questions: { undelivered: [] } } });
	working.child.kill('SIGTERM');
	await working.result();
});

test('a reply to a choice question reaches --on-message with the ref read from the index', async () => {
	const at = await machine();
	const listening = await listener(at, ['--on-message', 'cat >> messages.jsonl']);
	const asked = await run(at, ['ask', '-o', 'Merge', '-o', 'Wait', file(at, 'q.md', 'Merge now?')]);
	const message = lastMessage(at);
	at.server.reply(message, 'Merge after the release');
	const [received] = await lines(at, 'messages.jsonl', 1);
	expect(received).toEqual({ message: message + 1, text: 'Merge after the release', replyTo: message, ref: asked.out.ref, files: [] });
	listening.child.kill('SIGTERM');
	await listening.result();
});

test('a rejected token stops the listener with exit 5, and any other command with exit 6', async () => {
	const at = await machine();
	const listening = await listener(at);
	await run(at, ['ask', '--yes-no', file(at, 'q.md', 'Deploy now?')]);
	at.server.revoke();
	// The toast of this tap meets the 401 inside handle, which rejects with TokenRefused.
	at.server.tap(lastMessage(at), 0);
	expect(await listening.result()).toMatchObject({ code: EXIT.stopped, out: { error: 'stopped', code: 'token' } });
	expect(await run(at, ['send', file(at, 'm.md', 'Build passed.')])).toMatchObject({ code: EXIT['no-config'], out: { error: 'no-config' } });
});

test('every exit code of section 5', async () => {
	const at = await machine();
	const message = file(at, 'm.md', 'Build passed.');
	const seen = new Map<number, unknown>();
	const expectExit = async (code: number, args: string[], out: Record<string, unknown>, at2 = at) => {
		const result = await run(at2, args);
		expect(result, args.join(' ')).toMatchObject({ code, out });
		seen.set(code, result.out);
	};
	await expectExit(0, ['send', message], { chat: 111, message: 1001, files: [] });
	await expectExit(EXIT.refused, ['close', 'nosuch'], { error: 'refused', code: 'unknown-ref' });
	await expectExit(EXIT.usage, ['send', '--loud', message], { error: 'usage' });
	await expectExit(EXIT['no-listener'], ['ask', '--yes-no', file(at, 'q.md', 'Deploy now?')], { error: 'no-listener' });
	at.server.fail('sendRichMessage', { status: 502, description: 'Bad Gateway' });
	await expectExit(EXIT.uncertain, ['send', message], { error: 'uncertain' });
	await expectExit(EXIT['no-view-host'], ['send', '--view', 'AAAAAAAAAAAAAAAAAAAAAA', message], { error: 'no-view-host' });
	await expectExit(EXIT['no-config'], ['info'], { error: 'no-config' }, await machine({ fresh: true }));
	const revoked = await machine();
	revoked.server.revoke();
	await expectExit(EXIT.stopped, ['listen'], { error: 'stopped', code: 'token' }, revoked);
	expect([...seen.keys()].sort()).toEqual([0, ...Object.values(EXIT)].sort());
});

test('send prints the Sent that edit takes, and edit --ref and close change a question', async () => {
	const at = await machine();
	const sent = await run(at, ['send', file(at, 'm.md', 'Build running.')]);
	expect(sent).toMatchObject({ code: 0, out: { chat: 111, message: 1001, files: [] } });
	expect(await run(at, ['edit', JSON.stringify(sent.out), '-'], { stdin: 'Build passed.' })).toMatchObject({ code: 0, out: { sent: sent.out } });
	expect(at.server.messages.get(1001)?.rich_message).toEqual({ markdown: 'Build passed.' });

	// A heartbeat in the store stands for a live listener.
	await fileStore(paths(at.env).store(222)).set('listener', { v: 1, heartbeat: Date.now() });
	const asked = await run(at, ['ask', '-o', 'Merge', '-o', 'Wait', file(at, 'q.md', 'Merge now?')]);
	const ref = String(asked.out.ref);
	expect(await run(at, ['edit', '--ref', ref, '-'], { stdin: 'Merge `fix/lock` now?' })).toMatchObject({ code: 0, out: { ref, status: 'pending' } });
	expect(at.server.messages.get(1002)).toMatchObject({ rich_message: { markdown: 'Merge `fix/lock` now?' }, reply_markup: { inline_keyboard: [[{ text: 'Merge' }], [{ text: 'Wait' }]] } });
	expect(await run(at, ['close', ref, '-'], { stdin: 'Merged.' })).toMatchObject({ code: 0, out: { ref, status: 'closed' } });
	expect(at.server.messages.get(1002)?.reply_markup).toBeUndefined();
	expect(await run(at, ['edit', '--ref', ref, '-'], { stdin: 'Again?' })).toMatchObject({ code: EXIT.refused, out: { code: 'closed' } });
	expect(await run(at, ['edit', '--ref', 'nosuch', 'q.md'])).toMatchObject({ code: EXIT.refused, out: { code: 'unknown-ref' } });
	expect(await run(at, ['edit', 'q.md'])).toMatchObject({ code: EXIT.usage });
});

test('fake mode records every call, has a live listener and answers on the first wait', async () => {
	const at = await machine({ fresh: true });
	const fake = join(at.work, 'fake');
	const env = { TELEGRAM_AGENT_UI_FAKE: fake };
	const asked = await run(at, ['ask', '-o', 'Merge', '-o', 'Wait', file(at, 'q.md', 'Merge now?')], { env });
	expect(asked).toMatchObject({ code: 0, out: { status: 'pending', next: 'wait' } });
	expect(await run(at, ['wait', String(asked.out.ref)], { env })).toMatchObject({ code: 0, out: { status: 'answered', answer: { label: 'Merge' } } });
	const textual = await run(at, ['ask', '--text', file(at, 't.md', 'Which branch?')], { env });
	expect(await run(at, ['wait', String(textual.out.ref)], { env })).toMatchObject({ out: { status: 'answered', answer: { kind: 'text', text: 'fake answer' } } });
	const recorded = (await lines(at, 'fake/calls.jsonl', 5)).map((call) => call.method);
	expect(recorded).toEqual(['sendRichMessage', 'answerCallbackQuery', 'editMessageText', 'sendRichMessage', 'setMessageReaction']);
	expect(await run(at, ['send', 'q.md'], { env: { ...env, TELEGRAM_AGENT_UI_FAKE_SCENARIO: 'uncertain' } })).toMatchObject({ code: EXIT.uncertain });
	expect(await run(at, ['ask', '--yes-no', 'q.md'], { env: { ...env, TELEGRAM_AGENT_UI_FAKE_SCENARIO: 'no-listener' } })).toMatchObject({ code: EXIT['no-listener'] });
	expect(await run(at, ['send', 'q.md'], { env: { ...env, TELEGRAM_AGENT_UI_FAKE_SCENARIO: 'token' } })).toMatchObject({ code: EXIT['no-config'] });
	expect(await run(at, ['send', 'q.md'], { env: { ...env, TELEGRAM_AGENT_UI_FAKE_SCENARIO: 'refused' } })).toMatchObject({ code: EXIT.refused, out: { code: 'server' } });
	expect(await run(at, ['send', 'q.md'], { env: { ...env, TELEGRAM_AGENT_UI_FAKE_SCENARIO: 'flaky' } })).toMatchObject({ code: EXIT.usage });
});

test('fake mode gives every message its own id, across parallel processes and between two text questions', async () => {
	const at = await machine({ fresh: true });
	const fake = join(at.work, 'fake');
	const env = { TELEGRAM_AGENT_UI_FAKE: fake };
	const body = file(at, 'm.md', 'Build passed.');
	const sends = await Promise.all(Array.from({ length: 6 }, () => run(at, ['send', body], { env })));
	expect(new Set(sends.map((sent) => sent.out.message)).size).toBe(6);
	const first = await run(at, ['ask', '--text', file(at, 'a.md', 'Which branch?')], { env });
	const second = await run(at, ['ask', '--text', file(at, 'b.md', 'Which tag?')], { env });
	const store = fileStore(join(fake, 'store'));
	const messageOf = async (ref: unknown) => parseQuestion(await store.get(`q:${String(ref)}`));
	const [one, two] = [await messageOf(first.out.ref), await messageOf(second.out.ref)];
	expect(one && 'sent' in one && two && 'sent' in two && one.sent?.message !== two.sent?.message).toBe(true);
	for (const asked of [first, second]) expect(await run(at, ['wait', String(asked.out.ref)], { env })).toMatchObject({ out: { status: 'answered', answer: { kind: 'text', text: 'fake answer' } } });
});

test('a body file outside the roots, through a link that leaves them or with a secret name is refused, and nothing reaches the server', async () => {
	const at = await machine();
	writeFileSync(join(at.root, 'outside.md'), 'a sentinel outside the roots');
	writeFileSync(join(at.work, '.env'), 'SECRET=sentinel');
	symlinkSync(join(at.root, 'outside.md'), join(at.work, 'link.md'));
	const cases: [string[], string][] = [
		[['send', '../outside.md'], 'outside-roots'],
		[['send', join(at.root, 'outside.md')], 'outside-roots'],
		[['send', 'link.md'], 'outside-roots'],
		[['send', '.env'], 'secret-file'],
		[['ask', '--yes-no', '../outside.md'], 'outside-roots'],
		[['close', 'merge1', '.env'], 'secret-file'],
	];
	for (const [args, code] of cases) expect(await run(at, args), args.join(' ')).toMatchObject({ code: EXIT.refused, out: { error: 'refused', code } });
	// Run from HOME, every file of the home directory would be allowed.
	expect(await run(at, ['send', 'outside.md'], { cwd: at.root })).toMatchObject({ code: EXIT.refused, out: { code: 'publish-root' } });
	expect(at.server.received).toEqual([]);
	// A root from publishRoots widens the set.
	const extra = join(at.root, 'shared');
	mkdirSync(extra);
	writeFileSync(join(extra, 'note.md'), 'a shared note');
	await writeConfig(at.env, { ...CONFIG, apiUrl: at.server.url, publishRoots: [extra] }, TOKEN);
	expect(await run(at, ['send', join(extra, 'note.md')])).toMatchObject({ code: 0 });
	expect(at.server.calls('sendRichMessage')[0]?.payload.rich_message).toEqual({ markdown: 'a shared note' });
});

test('a link retargeted between the checks of a body file, or during its read, refuses the file', async () => {
	const at = await machine();
	// The real path of the work directory, as realpath gives it: the preload compares exact paths.
	const work = realpathSync(at.work);
	writeFileSync(join(at.root, 'outside.md'), 'OUTSIDE_SENTINEL');
	writeFileSync(join(work, '.env'), 'SECRET_SENTINEL');
	const cases = [
		{ mode: 'retarget', target: join(realpathSync(at.root), 'outside.md') },
		{ mode: 'retarget', target: join(work, '.env') },
		{ mode: 'read', target: join(realpathSync(at.root), 'outside.md') },
	];
	for (const [index, { mode, target }] of cases.entries()) {
		const given = join(work, `link${index}.md`);
		const safe = join(work, `safe${index}.md`);
		writeFileSync(safe, 'a safe note');
		// `retarget` starts from a link to the target, `read` from a link to the safe file.
		symlinkSync(mode === 'retarget' ? target : safe, given);
		const env = { TAU_RACE_GIVEN: given, TAU_RACE_SAFE: safe, TAU_RACE_TARGET: target, TAU_RACE_MODE: mode };
		const result = await run(at, ['send', given], { env, preload: RACE });
		expect(result, `${mode} to ${target}`).toMatchObject({ code: EXIT.refused, out: { error: 'refused' } });
		expect(JSON.stringify(result)).not.toContain('SENTINEL');
	}
	expect(at.server.received).toEqual([]);
});

test('a message command that passes its deadline keeps the message, and a restart delivers it', async () => {
	const at = await machine();
	const env = { TAU_TEST_COMMAND_DEADLINE: '1000' };
	const hanging = spawn(at, ['listen', '--on-message', 'sleep 10'], { env });
	await until(() => at.server.calls('getUpdates').length > 0, 'the first poll');
	at.server.say('release notes');
	const stored = async () => (await at.store.list('in:'))[0];
	await until(async () => {
		const key = await stored();
		const value = key === undefined ? undefined : await at.store.get(key);
		return isRecord(value) && value.attempts === 5;
	}, 'the fifth stored timeout');
	expect(await run(at, ['info'])).toMatchObject({ out: { messages: { pending: 1, undelivered: [{ attempts: 5, error: 'the command did not exit within 1 s' }] } } });
	hanging.child.kill('SIGTERM');
	expect(await hanging.result()).toMatchObject({ code: 0 });

	const working = await listener(at, ['--on-message', 'cat >> messages.jsonl']);
	const [received] = await lines(at, 'messages.jsonl', 1);
	expect(received).toMatchObject({ text: 'release notes', files: [] });
	await until(async () => (await stored()) === undefined, 'the delivered message to leave the store');
	expect(await run(at, ['info'])).toMatchObject({ out: { messages: { pending: 0, undelivered: [] } } });
	working.child.kill('SIGTERM');
	await working.result();
});

test('a listener killed while its answer command runs leaves no command running', async () => {
	const at = await machine();
	const pidFile = join(at.work, 'cmd.pid');
	const listening = await listener(at, ['--on-answer', `sleep 60 & echo $! > ${pidFile}; wait`]);
	await run(at, ['ask', '--yes-no', file(at, 'q.md', 'Deploy now?')]);
	at.server.tap(lastMessage(at), 0);
	await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 'the started command');
	const pid = Number(readFileSync(pidFile, 'utf8'));
	const alive = () => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	expect(alive()).toBe(true);
	listening.child.kill('SIGKILL');
	await listening.child.exited;
	// Well before the command's deadline of 30 s.
	await until(() => !alive(), 'the end of the orphaned command', 15_000);
});

test('init refuses while a listener of the bot runs, and holds the lease while it pairs', async () => {
	const at = await machine();
	const listening = await listener(at);
	const polls = at.server.calls('getUpdates').length;
	expect(await run(at, ['init'])).toMatchObject({ code: EXIT.refused, out: { error: 'refused', code: 'conflict' } });
	expect(at.server.calls('getUpdates')).toHaveLength(polls);
	expect(listening.child.exitCode).toBeNull();
	// A killed listener leaves a fresh heartbeat and a lease of a dead process: init takes it over.
	listening.child.kill('SIGKILL');
	await listening.child.exited;

	const pairing = spawn(at, ['init']);
	await until(() => /start=([a-z2-7]{12})/.test(pairing.err()), 'the pairing link');
	expect(await run(at, ['listen'])).toMatchObject({ code: EXIT.stopped, out: { code: 'lease' } });
	at.server.say(`/start ${/start=([a-z2-7]{12})/.exec(pairing.err())?.[1]}`);
	expect(await pairing.result()).toMatchObject({ code: 0, out: { chat: 111 } });
});

test('init pairs again through the configured apiUrl and keeps it with the labels and roots', async () => {
	const at = await machine();
	const kept = { ...CONFIG, apiUrl: at.server.url, labels: { yes: 'Ja' }, publishRoots: [join(at.root, 'shared')] };
	await writeConfig(at.env, kept, TOKEN);
	// No TELEGRAM_AGENT_UI_API_URL: the config alone names the server.
	const pairing = spawn(at, ['init'], { env: { TELEGRAM_AGENT_UI_API_URL: '' } });
	await until(() => /start=([a-z2-7]{12})/.test(pairing.err()), 'the pairing link');
	at.server.say(`/start ${/start=([a-z2-7]{12})/.exec(pairing.err())?.[1]}`);
	expect(await pairing.result()).toMatchObject({ code: 0 });
	expect(at.server.calls('getMe')).toHaveLength(1);
	expect(JSON.parse(readFileSync(paths(at.env).configFile, 'utf8'))).toEqual(kept);
});

test('a description that quotes the token is printed without it', async () => {
	const at = await machine();
	at.server.fail('sendRichMessage', { status: 400, description: `Proxy route /bot${TOKEN}/sendRichMessage is unavailable` });
	const sent = spawn(at, ['send', file(at, 'm.md', 'Build passed.')]);
	const result = await sent.result();
	expect(result).toMatchObject({ code: EXIT.refused, out: { code: 'server', message: 'Proxy route /bot<token>/sendRichMessage is unavailable' } });
	expect(JSON.stringify(result)).not.toContain(TOKEN.slice(TOKEN.indexOf(':') + 1));
});

test('next is push only when the stored question carries every meta key as its own', async () => {
	const at = await machine();
	const pushing = (metaKeys: string[]) => at.store.set('listener', { v: 1, heartbeat: Date.now(), push: { metaKeys } });
	const body = file(at, 'q.md', 'Deploy now?');
	await pushing(['session']);
	expect(await run(at, ['ask', '--yes-no', '--meta', '{"session":"s1"}', body])).toMatchObject({ code: 0, out: { next: 'push' } });
	expect(await run(at, ['ask', '--yes-no', '--ref', 'held1', body])).toMatchObject({ out: { next: 'wait' } });
	// The held ref keeps the meta of its first ask, which the answer carries.
	expect(await run(at, ['ask', '--yes-no', '--ref', 'held1', '--meta', '{"session":"s2"}', body])).toMatchObject({ code: 0, out: { ref: 'held1', next: 'wait' } });
	expect((await at.question('held1'))?.meta).toBeUndefined();
	// An inherited property is no key of the meta.
	await pushing(['toString']);
	expect(await run(at, ['ask', '--yes-no', body])).toMatchObject({ out: { next: 'wait' } });
});
