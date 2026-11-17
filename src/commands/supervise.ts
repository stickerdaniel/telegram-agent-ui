// The supervisor of an answer or message command, a process of its own that `runShell` starts
// as `<runtime> supervise.js <deadline ms> <owner pid> <command>`. The owner is the process that
// started it. The supervisor starts nothing unless the owner is still its parent: an owner that
// died before the supervisor came up leaves it adopted by another process, and then no command
// runs. Afterwards it runs the command with `sh -c` in a process group of its own and passes its
// stdin on, and ends the whole group once the deadline passes, once the owner is no longer its
// parent, or once it is signalled. So the deadline holds and a killed listener leaves no command
// behind, whatever became of the listener's own timers. Its one line on stdout says how the
// command ended.
import { type ChildProcess, spawn } from 'node:child_process';

const [deadlineText = '', ownerText = '', command = ''] = process.argv.slice(2);
const deadline = Number(deadlineText);
const owner = Number(ownerText);
// How often the owner is looked for, in ms.
const WATCH = 100;

let child: ChildProcess | undefined;
/** Kills the command's process group, which also ends what it started. */
const killGroup = () => {
	if (child?.pid === undefined) return;
	try {
		process.kill(-child.pid, 'SIGKILL');
	} catch {
		// The group is gone already.
	}
};

let ended = false;
/** Ends the group, prints how the command ended, and exits. */
function end(status: { ended: 'exit'; code: number } | { ended: 'signal'; signal: string } | { ended: 'deadline' | 'orphaned' } | { ended: 'error'; message: string }): void {
	if (ended) return;
	ended = true;
	killGroup();
	process.stdout.write(`${JSON.stringify(status)}\n`, () => process.exit(0));
}

if (!Number.isSafeInteger(owner) || owner <= 1 || process.ppid !== owner) {
	// The owner is gone or was never named: the command does not start.
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
	// A command that reads no stdin closes it early: that is no failure.
	started.stdin?.on('error', () => {});
	if (started.stdin) process.stdin.pipe(started.stdin);
}
