import { spawn } from 'node:child_process';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNat, isRecord, isString } from '../core/check.ts';

export const COMMANDS = { deadline: 30_000 };

const here = fileURLToPath(import.meta.url);
const SUPERVISOR = join(dirname(here), `supervise${extname(here)}`);

function failureOf(report: unknown, deadline: number): string | undefined {
	if (!isRecord(report)) return 'the supervisor reported nothing';
	if (report.ended === 'exit' && isNat(report.code)) return report.code === 0 ? undefined : `the command exited ${report.code}`;
	if (report.ended === 'deadline') return `the command did not exit within ${deadline / 1000} s`;
	if (report.ended === 'orphaned') return 'the supervisor lost its owner, so the command was ended or never started';
	if (report.ended === 'signal' && isString(report.signal)) return `the command ended by ${report.signal}`;
	if (report.ended === 'error' && isString(report.message)) return `the command did not start: ${report.message}`;
	return `the command ended as ${JSON.stringify(report)}`;
}

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
