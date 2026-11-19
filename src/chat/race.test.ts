import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseQuestion } from '../core/parse.ts';
import { renderEdit } from '../core/render.ts';
import type { Handled, Outcome } from '../core/types.ts';
import { CHAT, REF } from '../fixtures.ts';
import { fileStore } from '../store/file.ts';
import { createChat } from './create.ts';
import { shownOf } from './harness.ts';
import { BODY, logged, type Op, SPEC } from './race-child.ts';

const CHILD = join(import.meta.dir, 'race-child.ts');
const PAIRS: [Op, Op][] = [
	['send', 'send'],
	['tap0', 'tap1'],
	['tap0', 'close'],
	['edit', 'close'],
];

function traces(log: string): string {
	const lines = [0, 1].flatMap((id) => (existsSync(`${log}.trace-${id}`) ? readFileSync(`${log}.trace-${id}`, 'utf8').trim().split('\n') : [`no trace from child ${id}`]));
	return lines.sort().join('\n');
}

async function race(run: number, a: Op, b: Op) {
	const root = mkdtempSync(join(tmpdir(), 'tau-race-'));
	const dir = join(root, 'store');
	const log = join(root, 'calls');
	writeFileSync(log, '');
	if (a !== 'send') expect(await createChat({ call: logged(log), store: fileStore(dir), chat: CHAT }).send(SPEC, { ref: REF })).toMatchObject({ kind: 'ok' });
	const children = [a, b].map((op, id) => Bun.spawn([process.execPath, CHILD, dir, log, op, String(id), String(run)], { stdout: 'pipe', stderr: 'inherit' }));
	let results: (Outcome | Handled)[];
	try {
		const deadline = Date.now() + 180_000;
		while (!existsSync(`${log}.ready-0`) || !existsSync(`${log}.ready-1`)) {
			if (Date.now() > deadline) throw new Error('the children did not start');
			await Bun.sleep(2);
		}
		writeFileSync(`${log}.go`, '');
		const ended = await Promise.all(children.map(async (child) => ({ pid: child.pid, out: await new Response(child.stdout).text(), code: await child.exited })));
		const failed = ended.filter((child) => child.code !== 0);
		if (failed.length > 0) throw new Error(`run ${run}, ${a} and ${b}: ${failed.map((child) => `child ${child.pid} exited ${child.code}`).join(', ')}. Traces:\n${traces(log)}`);
		results = ended.map((child) => JSON.parse(child.out) as Outcome | Handled);
	} finally {
		for (const child of children) child.kill('SIGKILL');
	}
	const calls = readFileSync(log, 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line) as { method: string; payload: Record<string, unknown> });
	const question = parseQuestion(await fileStore(dir).get(`q:${REF}`));
	rmSync(root, { recursive: true, force: true });
	return { question, results, calls };
}

test('two processes on one question end consistent in 100 runs', async () => {
	for (let run = 0; run < 100; run++) {
		const pair = PAIRS[run % PAIRS.length];
		if (!pair) throw new Error('unreachable: the index wraps');
		const [a, b] = pair;
		const { question, results, calls } = await race(run, a, b);
		const label = `run ${run}, ${a} and ${b}: ${JSON.stringify(results)}`;
		if (!question) throw new Error(`${label}: the question does not read back`);
		expect(question.shown.done, label).toBe(question.shown.want);
		expect(calls.filter((call) => call.method === 'sendRichMessage'), label).toHaveLength(1);
		const last = calls.findLast((call) => call.method === 'editMessageText' || call.method === 'sendRichMessage');
		expect(last && shownOf(last.payload), label).toEqual(shownOf(renderEdit(question).payload));

		const [first, second] = results;
		if (a === 'send') {
			expect(results, label).toMatchObject([
				{ kind: 'ok', sent: { message: BODY } },
				{ kind: 'ok', sent: { message: BODY } },
			]);
			expect(question.status, label).toBe('open');
		}
		if (a === 'tap0') {
			const answers = results.filter((result): result is Extract<Handled, { kind: 'answered' }> => result.kind === 'answered');
			if (b === 'tap1') {
				expect(answers.map((answer) => answer.seq).sort(), label).toEqual([1, 2]);
				const newest = answers.find((answer) => answer.seq === 2);
				expect(question, label).toMatchObject({ status: 'answered', seq: 2, answer: newest?.answer ?? {}, previous: answers.find((answer) => answer.seq === 1)?.answer ?? {} });
			} else {
				expect(question.status, label).toBe('closed');
				expect(question.seq, label).toBe(first?.kind === 'answered' ? 1 : 0);
				expect(second, label).toMatchObject({ kind: 'ok', status: 'closed' });
			}
		}
		if (a === 'edit') {
			expect(question.status, label).toBe('closed');
			expect(question.spec.body, label).toEqual(first?.kind === 'ok' ? { markdown: 'Deploy at 18:00?' } : SPEC.body);
			if (first?.kind !== 'ok') expect(first, label).toMatchObject({ kind: 'refused', code: 'closed' });
		}
	}
}, 3_600_000);
