// What one eval run needs and the two ways to make one. `prepare` builds a run's directory: the
// project with the eval's files, a `telegram-agent-ui` on PATH that runs this checkout's bin in
// fake mode, and with `skill` the skill under `.claude/skills/`. A runner then works in the
// project and reports how its process ended: `claudeRunner` starts `claude -p` on a named model,
// and `recordedRunner` replays commands recorded beforehand, so the grader is tested without a
// model. `storedQuestions` reads the questions fake mode stored, for the grader.
import { chmodSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { arrayOf, isInt, isRecord, isString } from '../src/core/check.ts';
import { parseQuestion } from '../src/core/parse.ts';
import type { Question } from '../src/core/types.ts';
import { fileStore } from '../src/store/file.ts';
import type { Expectation } from './grade.ts';

const REPO = join(import.meta.dir, '..');
const SKILL = join(REPO, 'skills', 'telegram-agent-ui');

/**
 * One prompt of `evals.json`. `files` maps a path relative to the project to its text; `../`
 * reaches outside the project. A `guardrail` prompt tests a behaviour no run may break, such as
 * sending nothing or leaking no file: one failed run of it fails the criterion.
 */
export type Eval = { id: number; name: string; prompt: string; expected: string; files: Record<string, string>; expectations: Expectation[]; guardrail?: boolean };

const isExpectation = (value: unknown): value is Expectation =>
	isRecord(value) &&
	((value.kind === 'none' || value.kind === 'message') ||
		(value.kind === 'status' && isInt(value.edits)) ||
		(value.kind === 'never' && isString(value.text)) ||
		(value.kind === 'question' && (value.answer === 'choice' || value.answer === 'yesNo' || value.answer === 'text') && (value.options === undefined || isInt(value.options))));

const isEval = (value: unknown): value is Eval =>
	isRecord(value) &&
	isInt(value.id) &&
	isString(value.name) &&
	isString(value.prompt) &&
	isString(value.expected) &&
	isRecord(value.files) &&
	Object.values(value.files).every(isString) &&
	arrayOf(isExpectation)(value.expectations) &&
	(value.guardrail === undefined || typeof value.guardrail === 'boolean');

/** The evals of an `evals.json` value, or a thrown error that names the first one that breaks the format. */
export function parseEvals(value: unknown): Eval[] {
	const evals = isRecord(value) && Array.isArray(value.evals) ? value.evals : [];
	const broken = evals.findIndex((item) => !isEval(item));
	if (evals.length === 0 || broken !== -1) throw new Error(`evals.json: eval ${broken === -1 ? 'list' : broken} breaks the format`);
	return evals.filter(isEval);
}

/** One run of one eval: its directory, the project inside it, and the environment of every command. */
export type Job = { eval: Eval; skill: boolean; run: number; root: string; work: string; fake: string; env: Record<string, string> };

/**
 * How a run ended: `done` when the agent finished, else the process failure that makes its
 * calls no evidence of behaviour. `transcript` is for a person to read.
 */
export type Ran = { transcript: string } & ({ status: 'done' } | { status: 'failed'; code: number } | { status: 'timeout'; seconds: number });

/** A runner works through a prepared job. */
export type Runner = { name: string; run(job: Job): Promise<Ran> };

const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** Builds the directory of one run under `root` and returns the job. */
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
	// This checkout's bin under the published name, so the skill's commands and allowed tools match.
	const shim = join(bin, 'telegram-agent-ui');
	writeFileSync(shim, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(join(REPO, 'src', 'cli', 'bin.ts'))} "$@"\n`);
	chmodSync(shim, 0o755);
	// The skill without its evals, which hold the expectations.
	const evals = join(SKILL, 'evals');
	if (skill) cpSync(SKILL, join(work, '.claude', 'skills', 'telegram-agent-ui'), { recursive: true, filter: (path) => path !== evals && !path.startsWith(`${evals}${sep}`) });
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith('TELEGRAM_')) env[key] = value;
	return { eval: evalCase, skill, run, root, work, fake, env: { ...env, PATH: `${bin}:${env.PATH ?? '/usr/bin:/bin'}`, TELEGRAM_AGENT_UI_FAKE: fake } };
}

/** One recorded command: the arguments after `telegram-agent-ui`, and its stdin. */
export type Step = { args: string[]; stdin?: string };

const isStep = (value: unknown): value is Step => isRecord(value) && arrayOf(isString)(value.args) && (value.stdin === undefined || isString(value.stdin));

/** The transcripts of a recorded runner, by eval id and condition, or a thrown error for a value of another shape. */
export function parseTranscripts(value: unknown): Record<string, Step[]> {
	if (!isRecord(value) || !Object.values(value).every(arrayOf(isStep))) throw new Error('the transcripts are no object of eval ids to lists of { args, stdin? }');
	return Object.fromEntries(Object.entries(value).map(([id, steps]) => [id, arrayOf(isStep)(steps) ? steps : []]));
}

/**
 * Replays the transcript of a job in its project, one command after the other: the one keyed
 * `<eval id>:with` or `<eval id>:without` for the job's condition, else the one keyed by the eval
 * id. An eval without a transcript runs nothing.
 */
export function recordedRunner(transcripts: Readonly<Record<string, readonly Step[]>>): Runner {
	return {
		name: 'recorded',
		async run(job) {
			const lines: string[] = [];
			const id = String(job.eval.id);
			for (const step of transcripts[`${id}:${job.skill ? 'with' : 'without'}`] ?? transcripts[id] ?? []) {
				const child = Bun.spawn([join(job.root, 'bin', 'telegram-agent-ui'), ...step.args], { cwd: job.work, env: job.env, stdin: step.stdin === undefined ? 'ignore' : new Blob([step.stdin]), stdout: 'pipe', stderr: 'pipe' });
				const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
				lines.push(`$ telegram-agent-ui ${step.args.join(' ')}`, out.trim(), ...(err.trim() ? [err.trim()] : []));
			}
			return { status: 'done', transcript: lines.join('\n') };
		},
	};
}

// What both conditions know: the CLI exists and reaches the user. The skill adds the how.
export const CONTEXT = "The command telegram-agent-ui is installed on this machine: it sends to the user's Telegram chat and reads their answers. telegram-agent-ui help lists its commands.";

/** The arguments of `claude -p` for one job; the prompt goes on stdin. */
export function claudeArgs(model: string): string[] {
	return [
		'-p',
		'--model',
		model,
		'--output-format',
		'stream-json',
		'--verbose',
		'--no-session-persistence',
		// Only the run's project settings and skills load, and no MCP server.
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

/** Runs `claude -p` on `model` in the job's project, with a deadline of `seconds` per run. A nonzero exit or the deadline ends the run as a failure. */
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

/** The questions fake mode stored in `fake`, for the grader. */
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
