import { chmodSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { arrayOf, isInt, isRecord, isString } from '../src/core/check.ts';
import { parseQuestion } from '../src/core/parse.ts';
import type { Question } from '../src/core/types.ts';
import { fileStore } from '../src/store/file.ts';
import type { Expectation } from './grade.ts';

const REPO = join(import.meta.dir, '..');
const SKILL = join(REPO, 'skills', 'telegram-agent-ui');

export type Eval = { id: number; name: string; prompt: string; expected: string; files: Record<string, string>; expectations: Expectation[]; guardrail?: boolean; scenario?: string };

const isExpectation = (value: unknown): value is Expectation =>
	isRecord(value) &&
	((value.kind === 'none' || value.kind === 'message') ||
		(value.kind === 'status' && isInt(value.edits)) ||
		(value.kind === 'view' && isInt(value.tabs) && (value.sources === undefined || arrayOf(isString)(value.sources))) ||
		(value.kind === 'never' && isString(value.text)) ||
		(value.kind === 'question' &&
			(value.answer === 'choice' || value.answer === 'yesNo' || value.answer === 'text') &&
			(value.options === undefined || isInt(value.options)) &&
			(value.tabs === undefined || typeof value.tabs === 'boolean')));

const isEval = (value: unknown): value is Eval =>
	isRecord(value) &&
	isInt(value.id) &&
	isString(value.name) &&
	isString(value.prompt) &&
	isString(value.expected) &&
	isRecord(value.files) &&
	Object.values(value.files).every(isString) &&
	arrayOf(isExpectation)(value.expectations) &&
	(value.guardrail === undefined || typeof value.guardrail === 'boolean') &&
	(value.scenario === undefined || isString(value.scenario));

export function parseEvals(value: unknown): Eval[] {
	const evals = isRecord(value) && Array.isArray(value.evals) ? value.evals : [];
	const broken = evals.findIndex((item) => !isEval(item));
	if (evals.length === 0 || broken !== -1) throw new Error(`evals.json: eval ${broken === -1 ? 'list' : broken} breaks the format`);
	return evals.filter(isEval);
}

export type Job = { eval: Eval; skill: boolean; run: number; root: string; work: string; fake: string; env: Record<string, string> };

export type Ran = { transcript: string } & ({ status: 'done' } | { status: 'failed'; code: number } | { status: 'timeout'; seconds: number });

export type Runner = { name: string; run(job: Job, signal?: AbortSignal): Promise<Ran> };

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

export function prepare(evalCase: Eval, skill: boolean, run: number, root: string): Job {
	const work = join(root, 'project');
	const fake = join(root, 'fake');
	const bin = join(root, 'bin');
	mkdirSync(work, { recursive: true });
	mkdirSync(bin, { recursive: true });
	for (const [path, text] of Object.entries(evalCase.files)) {
		const target = resolve(work, path);
		if (!target.startsWith(`${root}${sep}`)) throw new Error(`eval ${evalCase.id}: ${path} leaves the run directory`);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, text);
	}
	const shim = join(bin, 'telegram-agent-ui');
	writeFileSync(shim, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(REPO, 'src', 'cli', 'bin.ts'))} "$@"\n`);
	chmodSync(shim, 0o755);
	const evals = join(SKILL, 'evals');
	if (skill) cpSync(SKILL, join(work, '.claude', 'skills', 'telegram-agent-ui'), { recursive: true, filter: (path) => path !== evals && !path.startsWith(`${evals}${sep}`) });
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('TELEGRAM_')) env[key] = value;
	const scenario = evalCase.scenario !== undefined ? { TELEGRAM_AGENT_UI_FAKE_SCENARIO: evalCase.scenario } : {};
	return { eval: evalCase, skill, run, root, work, fake, env: { ...env, PATH: `${bin}:${env.PATH ?? '/usr/bin:/bin'}`, TELEGRAM_AGENT_UI_FAKE: fake, ...scenario } };
}

export type Step = { args: string[]; stdin?: string };

const isStep = (value: unknown): value is Step => isRecord(value) && arrayOf(isString)(value.args) && (value.stdin === undefined || isString(value.stdin));

export function parseTranscripts(value: unknown): Record<string, Step[]> {
	if (!isRecord(value) || !Object.values(value).every(arrayOf(isStep))) throw new Error('the transcripts are no object of eval ids to lists of { args, stdin? }');
	return Object.fromEntries(Object.entries(value).map(([id, steps]) => [id, arrayOf(isStep)(steps) ? steps : []]));
}

export function recordedRunner(transcripts: Readonly<Record<string, readonly Step[]>>): Runner {
	return {
		name: 'recorded',
		async run(job, signal) {
			const lines: string[] = [];
			const id = String(job.eval.id);
			for (const step of transcripts[`${id}:${job.skill ? 'with' : 'without'}`] ?? transcripts[id] ?? []) {
				if (signal?.aborted) return { status: 'failed', code: 130, transcript: lines.join('\n') };
				const child = Bun.spawn([join(job.root, 'bin', 'telegram-agent-ui'), ...step.args], {
					cwd: job.work,
					env: job.env,
					stdin: step.stdin === undefined ? 'ignore' : new Blob([step.stdin]),
					stdout: 'pipe',
					stderr: 'pipe',
					...(signal ? { signal, killSignal: 'SIGKILL' as const } : {}),
				});
				const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
				lines.push(`$ telegram-agent-ui ${step.args.join(' ')}`, out.trim(), ...(err.trim() ? [err.trim()] : []));
			}
			if (signal?.aborted) return { status: 'failed', code: 130, transcript: lines.join('\n') };
			return { status: 'done', transcript: lines.join('\n') };
		},
	};
}

export const CONTEXT = "The command telegram-agent-ui is installed on this machine: it sends to the user's Telegram chat and reads their answers. telegram-agent-ui help lists its commands.";

export function claudeArgs(model: string): string[] {
	return [
		'-p',
		'--model',
		model,
		'--output-format',
		'stream-json',
		'--verbose',
		'--no-session-persistence',
		'--setting-sources',
		'project',
		'--strict-mcp-config',
		'--permission-mode',
		'dontAsk',
		'--tools',
		'Bash,Read,Write,Edit,Glob,Grep,Skill',
		'--allowedTools',
		'Bash(telegram-agent-ui *),Read,Glob,Grep,Skill,Edit(./**),Write(./**)',
		'--append-system-prompt',
		CONTEXT,
	];
}

export function claudeRunner(options: { model: string; claude?: string; seconds?: number }): Runner {
	const { model, claude = 'claude', seconds = 600 } = options;
	return {
		name: `claude ${model}`,
		async run(job) {
			const started = Date.now();
			const child = Bun.spawn([claude, ...claudeArgs(model)], { cwd: job.work, env: job.env, stdin: new Blob([job.eval.prompt]), stdout: 'pipe', stderr: 'pipe', timeout: seconds * 1000, killSignal: 'SIGKILL' });
			const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
			const transcript = err.trim() ? `${out}\n${err}` : out;
			if (child.signalCode === 'SIGKILL' && Date.now() - started >= seconds * 1000) return { status: 'timeout', seconds, transcript };
			return code === 0 ? { status: 'done', transcript } : { status: 'failed', code, transcript };
		},
	};
}

export async function storedQuestions(fake: string): Promise<Question[]> {
	const dir = join(fake, 'store');
	if (!existsSync(dir)) return [];
	const store = fileStore(dir);
	const questions: Question[] = [];
	for (const key of await store.list('q:')) {
		const question = parseQuestion(await store.get(key));
		if (question) questions.push(question);
	}
	return questions;
}
