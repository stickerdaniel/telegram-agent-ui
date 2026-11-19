import { type ChildProcess, spawn } from 'node:child_process';

const [deadlineText = '', ownerText = '', command = ''] = process.argv.slice(2);
const deadline = Number(deadlineText);
const owner = Number(ownerText);
const WATCH = 100;

let child: ChildProcess | undefined;
const killGroup = () => {
	if (child?.pid === undefined) return;
	try {
		process.kill(-child.pid, 'SIGKILL');
	} catch {
	}
};

let ended = false;
function end(status: { ended: 'exit'; code: number } | { ended: 'signal'; signal: string } | { ended: 'deadline' | 'orphaned' } | { ended: 'error'; message: string }): void {
	if (ended) return;
	ended = true;
	killGroup();
	process.stdout.write(`${JSON.stringify(status)}\n`, () => process.exit(0));
}

if (!Number.isSafeInteger(owner) || owner <= 1 || process.ppid !== owner) {
	end({ ended: 'orphaned' });
} else {
	const started = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 2, 2], detached: true });
	child = started;
	const timer = setTimeout(() => end({ ended: 'deadline' }), Number.isFinite(deadline) && deadline > 0 ? deadline : 30_000);
	const watch = setInterval(() => {
		if (process.ppid !== owner) end({ ended: 'orphaned' });
	}, WATCH);
	for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, () => end({ ended: 'signal', signal }));
	started.on('error', (error) => end({ ended: 'error', message: error.message }));
	started.on('exit', (code, signal) => {
		clearTimeout(timer);
		clearInterval(watch);
		end(code === null ? { ended: 'signal', signal: signal ?? 'unknown' } : { ended: 'exit', code });
	});
	started.stdin?.on('error', () => {});
	if (started.stdin) process.stdin.pipe(started.stdin);
}
