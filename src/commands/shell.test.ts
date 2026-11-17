// A command under its supervisor: the input on stdin, the exit code, and a deadline that ends
// the whole process group.
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

test('a supervisor whose owner died before it came up starts no command', async () => {
	const at = dir();
	const started = join(at, 'started');
	// A deadline nobody else uses names this supervisor among the machine's processes.
	const deadline = 30_000 + (process.pid % 1_000);
	const shell = join(import.meta.dir, 'shell.ts');
	// The owner starts the supervisor and dies at once, before the new runtime has run a line.
	const owner = spawnSync(process.execPath, ['-e', `import { runShell } from ${JSON.stringify(shell)}; void runShell(${JSON.stringify(`echo started > ${started}; sleep 59`)}, {}, ${deadline}); process.kill(process.pid, 'SIGKILL');`]);
	expect(owner.signal).toBe('SIGKILL');
	const supervisor = `supervise.ts ${deadline}`;
	const deadlineAt = Date.now() + 60_000;
	while (spawnSync('pgrep', ['-f', supervisor]).status === 0 && !existsSync(started) && Date.now() < deadlineAt) await Bun.sleep(50);
	expect(spawnSync('pgrep', ['-f', supervisor]).status).toBe(1);
	expect(existsSync(started)).toBe(false);
});
