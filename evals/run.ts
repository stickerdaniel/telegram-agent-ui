import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { grade, parseCalls, parseViewCalls } from './grade.ts';
import { claudeArgs, claudeRunner, type Eval, type Job, parseEvals, parseTranscripts, prepare, recordedRunner, type Runner, storedQuestions } from './runners.ts';

const REPO = join(import.meta.dir, '..');
const EVALS = join(REPO, 'skills', 'telegram-agent-ui', 'evals', 'evals.json');

export const loadEvals = (path = EVALS): Eval[] => parseEvals(JSON.parse(readFileSync(path, 'utf8')));

export type Graded = { id: number; name: string; skill: boolean; run: number; outcome: 'pass' | 'fail' | 'error'; failures: string[]; root: string };

export async function runAll(jobs: readonly Job[], runner: Runner, parallel: number, log: (line: string) => void): Promise<Graded[]> {
	const graded: Graded[] = [];
	let next = 0;
	const worker = async () => {
		for (let job = jobs[next++]; job; job = jobs[next++]) {
			const ran = await runner.run(job);
			writeFileSync(join(job.root, 'transcript.txt'), ran.transcript);
			const base = { id: job.eval.id, name: job.eval.name, skill: job.skill, run: job.run, root: job.root };
			if (ran.status !== 'done') {
				const failures = [ran.status === 'timeout' ? `the run hit its deadline of ${ran.seconds} s` : `the run exited ${ran.code}`];
				graded.push({ ...base, outcome: 'error', failures });
			} else {
				const calls = parseCalls(await Bun.file(join(job.fake, 'calls.jsonl')).text().catch(() => ''));
				const views = parseViewCalls(await Bun.file(join(job.fake, 'views.jsonl')).text().catch(() => ''));
				const { pass, failures } = grade(calls, job.eval.expectations, await storedQuestions(job.fake), views, job.eval.files);
				graded.push({ ...base, outcome: pass ? 'pass' : 'fail', failures });
			}
			const last = graded.at(-1);
			if (last) log(`${last.outcome} ${job.eval.id} ${job.eval.name} ${job.skill ? 'with' : 'without'} skill, run ${job.run}${last.failures.length ? `: ${last.failures.join('; ')}` : ''}`);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
	return graded;
}

export type Verdict = { pass: boolean; reasons: string[]; summary: string };

const label = (run: { name: string; skill: boolean; run: number }) => `${run.name} ${run.skill ? 'with' : 'without'} skill, run ${run.run}`;

const PHASES = { 1: [{ skill: true, run: 1 }, { skill: false, run: 1 }], 2: [{ skill: true, run: 2 }] } as const;

function matrixIssues(evals: readonly Eval[], graded: readonly Graded[], phase: 1 | 2): string[] {
	const slots = (phase === 1 ? PHASES[1] : [...PHASES[1], ...PHASES[2]]).flatMap((slot) => evals.map((evalCase) => ({ ...slot, id: evalCase.id, name: evalCase.name })));
	const key = (run: { id: number; skill: boolean; run: number }) => `${run.id}:${run.skill}:${run.run}`;
	const wanted = new Set(slots.map(key));
	const issues = slots.flatMap((slot) => {
		const count = graded.filter((run) => key(run) === key(slot)).length;
		return count === 1 ? [] : [`${label(slot)} is ${count === 0 ? 'missing' : `present ${count} times`}`];
	});
	return [...issues, ...graded.filter((run) => !wanted.has(key(run))).map((run) => `${label(run)} of eval ${run.id} belongs to no phase ${phase} run`)];
}

function hardReasons(evals: readonly Eval[], graded: readonly Graded[]): string[] {
	const guardrails = new Set(evals.filter((evalCase) => evalCase.guardrail).map((evalCase) => evalCase.id));
	return [
		...graded.filter((run) => run.outcome === 'error').map((run) => `${label(run)} did not complete: ${run.failures.join('; ')}`),
		...graded.filter((run) => run.outcome === 'fail' && guardrails.has(run.id)).map((run) => `guardrail ${label(run)} failed: ${run.failures.join('; ')}`),
		...graded.filter((run) => run.skill && run.outcome === 'fail' && !guardrails.has(run.id)).map((run) => `${label(run)} failed: ${run.failures.join('; ')}`),
	];
}

const passedPrompts = (evals: readonly Eval[], graded: readonly Graded[], skill: boolean) =>
	evals.filter((evalCase) => graded.filter((run) => run.id === evalCase.id && run.skill === skill).every((run) => run.outcome === 'pass')).length;

const gainOf = (evals: readonly Eval[], graded: readonly Graded[]) => passedPrompts(evals, graded, true) - passedPrompts(evals, graded, false);

export function phaseOneStop(evals: readonly Eval[], graded: readonly Graded[]): string[] {
	const reasons = [...matrixIssues(evals, graded, 1), ...hardReasons(evals, graded)];
	const gain = gainOf(evals, graded);
	if (gain < 2) reasons.push(`${passedPrompts(evals, graded, true)} prompts pass with the skill and ${passedPrompts(evals, graded, false)} without it: phase 2 cannot reach the gain of 2`);
	return reasons;
}

export function studyCriterion(evals: readonly Eval[], graded: readonly Graded[]): Verdict {
	const reasons = [...matrixIssues(evals, graded, 2), ...hardReasons(evals, graded)];
	const withSkill = passedPrompts(evals, graded, true);
	const without = passedPrompts(evals, graded, false);
	if (withSkill - without < 2) reasons.push(`${withSkill} prompts pass with the skill and ${without} without it, a gain of ${withSkill - without} of the 2 needed`);
	const runs = graded.filter((run) => run.skill);
	return { pass: reasons.length === 0, reasons, summary: `With the skill ${runs.filter((run) => run.outcome === 'pass').length} of ${runs.length} runs pass, ${withSkill} prompts; without it ${without} prompts.` };
}

export function report(evals: readonly Eval[], graded: readonly Graded[], verdict: Verdict | undefined): string {
	const cell = (id: number, skill: boolean) => {
		const runs = graded.filter((run) => run.id === id && run.skill === skill);
		return runs.length === 0 ? 'none' : `${runs.filter((run) => run.outcome === 'pass').length}/${runs.length}`;
	};
	const total = (skill: boolean) => `${graded.filter((run) => run.skill === skill && run.outcome === 'pass').length}/${graded.filter((run) => run.skill === skill).length}`;
	return [
		'| Eval | With skill | Without |',
		'| --- | --- | --- |',
		...evals.map((evalCase) => `| ${evalCase.id} ${evalCase.name}${evalCase.guardrail ? ' (guardrail)' : ''} | ${cell(evalCase.id, true)} | ${cell(evalCase.id, false)} |`),
		`| Total | ${total(true)} | ${total(false)} |`,
		'',
		...(verdict
			? [`Criterion: ${verdict.pass ? 'pass' : 'fail'}. ${verdict.summary}`, ...verdict.reasons.map((reason) => `- ${reason}`)]
			: ['Diagnostic run: no criterion. Only --study runs the study the criterion applies to.']),
	].join('\n');
}

function provenance() {
	const git = (...args: string[]) => Bun.spawnSync(['git', '-C', REPO, ...args]).stdout.toString().trim();
	return { commit: git('rev-parse', 'HEAD'), skill: git('rev-parse', 'HEAD:skills/telegram-agent-ui'), grader: git('rev-parse', 'HEAD:evals'), dirty: git('status', '--porcelain', '--', 'skills', 'evals', 'src') !== '' };
}

function claimOut(path: string | undefined): string {
	if (path === undefined) return mkdtempSync(join(tmpdir(), 'telegram-agent-ui-evals-'));
	mkdirSync(dirname(resolve(path)), { recursive: true });
	try {
		mkdirSync(path);
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Error(`--out ${path} exists: a run claims a directory that does not exist yet, so no other run's evidence is graded`);
		throw error;
	}
	return path;
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			model: { type: 'string' },
			runner: { type: 'string', default: 'claude' },
			transcripts: { type: 'string' },
			claude: { type: 'string', default: 'claude' },
			study: { type: 'boolean', default: false },
			with: { type: 'string' },
			without: { type: 'string' },
			only: { type: 'string' },
			jobs: { type: 'string', default: '3' },
			out: { type: 'string' },
			'dry-run': { type: 'boolean', default: false },
		},
	});
	const out = claimOut(values.out);
	const study = values.study;
	if (study && (values.with !== undefined || values.without !== undefined || values.only !== undefined)) throw new Error('--study runs the fixed study: --with, --without and --only pick the runs of a diagnostic run');
	const counts = { with: Number(values.with ?? 1), without: Number(values.without ?? 1) };
	if (!Number.isSafeInteger(counts.with) || !Number.isSafeInteger(counts.without) || counts.with < 0 || counts.without < 0) throw new Error('--with and --without take a count of runs');
	const only = values.only?.split(',').map(Number);
	const evals = loadEvals().filter((evalCase) => !only || only.includes(evalCase.id));

	let runner: Runner;
	if (values.runner === 'recorded') {
		if (!values.transcripts) throw new Error('--runner recorded needs --transcripts <file>');
		runner = recordedRunner(parseTranscripts(JSON.parse(readFileSync(values.transcripts, 'utf8'))));
	} else if (values.runner === 'claude') {
		if (!values.model) throw new Error('--model <id> names the model and its version, such as claude-opus-5-5');
		runner = claudeRunner({ model: values.model, claude: values.claude });
	} else throw new Error(`--runner is claude or recorded, not ${values.runner}`);

	const jobsOf = (slots: readonly { skill: boolean; run: number }[]) =>
		evals.flatMap((evalCase) =>
			slots.map(({ skill, run }) => {
				const root = join(out, `${evalCase.id}-${skill ? 'with' : 'without'}-${run}`);
				mkdirSync(root, { recursive: true });
				return prepare(evalCase, skill, run, root);
			}),
		);
	const diagnostic = [...Array.from({ length: counts.with }, (_, index) => ({ skill: true, run: index + 1 })), ...Array.from({ length: counts.without }, (_, index) => ({ skill: false, run: index + 1 }))];

	if (values['dry-run']) {
		const jobs = jobsOf(study ? PHASES[1] : diagnostic);
		const command = values.runner === 'claude' && values.model ? [values.claude, ...claudeArgs(values.model)] : [];
		console.log(`${jobs.length} runs of ${evals.length} prompts in ${out} with ${runner.name}${study ? `, then phase 2 with ${evals.length} more runs with the skill` : ', a diagnostic run'}`);
		for (const job of jobs) console.log(`${job.eval.id} ${job.eval.name} ${job.skill ? 'with' : 'without'} skill, run ${job.run}: ${job.work}`);
		if (command.length > 0) console.log(`each run: ${JSON.stringify(command)} with the prompt on stdin`);
	} else {
		const version = values.runner === 'claude' ? Bun.spawnSync([values.claude, '--version']).stdout.toString().trim() : runner.name;
		const log = (line: string) => console.error(line);
		console.error(`${study ? 'The study' : 'A diagnostic run'} with ${runner.name} (${version}) in ${out}`);
		let graded: Graded[];
		let verdict: Verdict | undefined;
		let phase: 1 | 2 | undefined;
		if (study) {
			graded = await runAll(jobsOf(PHASES[1]), runner, Number(values.jobs), log);
			const stop = phaseOneStop(evals, graded);
			phase = 1;
			if (stop.length > 0) verdict = { pass: false, reasons: stop, summary: 'The study stopped after phase 1.' };
			else {
				graded = [...graded, ...(await runAll(jobsOf(PHASES[2]), runner, Number(values.jobs), log))];
				phase = 2;
				verdict = studyCriterion(evals, graded);
			}
		} else graded = await runAll(jobsOf(diagnostic), runner, Number(values.jobs), log);
		const record = { runner: runner.name, model: values.runner === 'claude' ? (values.model ?? null) : null, version, ...provenance(), study, phase: phase ?? null, prompts: evals.map((evalCase) => evalCase.id), graded, verdict: verdict ?? null };
		writeFileSync(join(out, 'results.json'), `${JSON.stringify(record, null, 2)}\n`);
		console.log(report(evals, graded, verdict));
		process.exitCode = verdict && !verdict.pass ? 1 : 0;
	}
}
