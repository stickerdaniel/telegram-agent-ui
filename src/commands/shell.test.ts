// A command under its supervisor: the input on stdin, the exit code, a deadline that ends the
// whole process group, and an owner whose death ends the command or keeps it from starting.
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShell } from './shell.ts';

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function dir() {
	const made = mkdtempSync(join(tmpdir(), 'tau-shell-'));
	dirs.push(made);
	return made;
}

test('the command gets the input as JSON on stdin, and an exit other than 0 rejects', async () => {
	const at = dir();
	await runShell(`cat > ${join(at, 'got.json')}`, { ref: 'k7q2m4xa', seq: 1 });
	expect(JSON.parse(readFileSync(join(at, 'got.json'), 'utf8'))).toEqual({ ref: 'k7q2m4xa', seq: 1 });
	await expect(runShell('exit 3', {})).rejects.toThrow('the command exited 3');
	await runShell('true', { ignored: 'stdin' });
});

test('the deadline ends the command and everything it started', async () => {
	// A unique sleep marks the command's child. On a loaded machine the command may not start
	// before its deadline; then it started nothing, and the check below holds as well.
	const marker = `sleep 59.${process.pid}${Date.now() % 100_000}`;
	const started = Date.now();
	await expect(runShell(`${marker} & wait`, {}, 3_000)).rejects.toThrow('did not exit within 3 s');
	expect(Date.now() - started).toBeLessThan(30_000);
	expect(spawnSync('pgrep', ['-f', marker]).status).toBe(1);
});

// An owner is a runtime of its own that calls runShell with `command`, runs `then`, and kills
// itself. A unique sleep in the command names the supervisor, whose arguments hold the command,
// and the command's child among the machine's processes.
function owner(command: string, then: string, env: NodeJS.ProcessEnv = process.env) {
	const shell = JSON.stringify(join(import.meta.dir, 'shell.ts'));
	return spawnSync(process.execPath, ['-e', `import { existsSync } from 'node:fs'; import { runShell } from ${shell}; void runShell(${JSON.stringify(command)}, {}); ${then} process.kill(process.pid, 'SIGKILL');`], { env, timeout: 20_000 });
}
function marker() {
	return `sleep 59.${process.pid}${Date.now() % 100_000}`;
}
/** Waits up to `ms` until no process matches `pattern`, and says whether none does. */
async function goneWithin(ms: number, pattern: string): Promise<boolean> {
	const until = Date.now() + ms;
	while (spawnSync('pgrep', ['-f', pattern]).status === 0) {
		if (Date.now() >= until) return false;
		await Bun.sleep(50);
	}
	return true;
}

test('a supervisor whose owner dies ends the command and everything it started', async () => {
	const started = join(dir(), 'started');
	const sleep = marker();
	// The owner dies only once the command runs, so the supervisor found it alive and started the
	// command. On a loaded machine an owner that kills itself at once can still be alive then.
	const died = owner(`echo started > ${started}; ${sleep}`, `while (!existsSync(${JSON.stringify(started)})) await Bun.sleep(10);`);
	expect(died.signal).toBe('SIGKILL');
	// The supervisor looks for its owner every 100 ms. 10 s leaves room for a loaded machine and
	// stays below the 30 s deadline, which would end the command as well.
	expect(await goneWithin(10_000, sleep)).toBe(true);
}, 40_000);

test('a supervisor whose owner died before its check starts no command', async () => {
	const at = dir();
	const started = join(at, 'started');
	const held = join(at, 'held');
	const sleep = marker();
	// A preload holds the supervisor back until the owner is no longer its parent, so its check
	// certainly comes after the owner died. The file `held` shows that the hold ran.
	const hold = join(at, 'hold.ts');
	writeFileSync(
		hold,
		`import { writeFileSync } from 'node:fs';
		const [, script = '', , owner = ''] = process.argv;
		if (script.endsWith('supervise.ts')) {
			while (process.ppid === Number(owner)) Bun.sleepSync(5);
			writeFileSync(${JSON.stringify(held)}, '');
		}`,
	);
	const died = owner(`echo started > ${started}; ${sleep}`, '', { ...process.env, BUN_OPTIONS: `--preload ${hold}` });
	expect(died.signal).toBe('SIGKILL');
	expect(await goneWithin(10_000, sleep)).toBe(true);
	expect(existsSync(held)).toBe(true);
	expect(existsSync(started)).toBe(false);
}, 30_000);
