// Runs a consumer's shell command, such as `--on-answer`, with one JSON value on stdin. The
// command runs under the supervisor of supervise.ts, a process of its own that enforces the
// deadline and ends the command when this process dies. The command's stdout and stderr go to
// this process's stderr, since stdout carries the one JSON object.
import { spawn } from 'node:child_process';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNat, isRecord, isString } from '../core/check.ts';

/** How long an answer or message command may run, in ms. The tests of this package shorten it. */
export const COMMANDS = { deadline: 30_000 };

// supervise.ts beside this file in the sources, supervise.js in the build.
const here = fileURLToPath(import.meta.url);
const SUPERVISOR = join(dirname(here), `supervise${extname(here)}`);

/** Why the supervisor's report means a failure, or undefined for an exit 0. */
function failureOf(report: unknown, deadline: number): string | undefined {
	if (!isRecord(report)) return 'the supervisor reported nothing';
	if (report.ended === 'exit' && isNat(report.code)) return report.code === 0 ? undefined : `the command exited ${report.code}`;
	if (report.ended === 'deadline') return `the command did not exit within ${deadline / 1000} s`;
	if (report.ended === 'orphaned') return 'the supervisor lost its owner, so the command was ended or never started';
	if (report.ended === 'signal' && isString(report.signal)) return `the command ended by ${report.signal}`;
	if (report.ended === 'error' && isString(report.message)) return `the command did not start: ${report.message}`;
	return `the command ended as ${JSON.stringify(report)}`;
}

/**
 * Runs `command` with `sh -c` under a supervisor, writes `input` as JSON and a newline on its
 * stdin, and resolves once it exits 0 within `deadline` ms. Rejects with its exit code, or once
 * the deadline passed and the supervisor killed its process group.
 *
 *   await runShell('tee -a answers.jsonl', { ref: 'k7q2m4xa' });
 */
export function runShell(command: string, input: unknown, deadline = COMMANDS.deadline): Promise<void> {
	return new Promise((resolve, reject) => {
		const supervisor = spawn(process.execPath, [SUPERVISOR, String(deadline), String(process.pid), command], { stdio: ['pipe', 'pipe', 2] });
		let out = '';
		supervisor.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
			out += chunk;
		});
		supervisor.on('error', reject);
		supervisor.on('close', () => {
			let report: unknown;
			try {
				report = JSON.parse(out.trim().split('\n').at(-1) ?? '');
			} catch {
				report = undefined;
			}
			const failure = failureOf(report, deadline);
			if (failure === undefined) resolve();
			else reject(new Error(failure));
		});
		supervisor.stdin?.on('error', () => {});
		supervisor.stdin?.end(`${JSON.stringify(input)}\n`);
	});
}
