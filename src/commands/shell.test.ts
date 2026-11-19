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
	const marker = `sleep 59.${process.pid}${Date.now() % 100_000}`;
	const started = Date.now();
	await expect(runShell(`${marker} & wait`, {}, 3_000)).rejects.toThrow('did not exit within 3 s');
	expect(Date.now() - started).toBeLessThan(30_000);
	expect(spawnSync('pgrep', ['-f', marker]).status).toBe(1);
});

function owner(command: string, then: string, env: NodeJS.ProcessEnv = process.env) {
	const shell = JSON.stringify(join(import.meta.dir, 'shell.ts'));
	return spawnSync(process.execPath, ['-e', `import { existsSync } from 'node:fs'; import { runShell } from ${shell}; void runShell(${JSON.stringify(command)}, {}); ${then} process.kill(process.pid, 'SIGKILL');`], { env, timeout: 20_000 });
}
function marker() {
	return `sleep 59.${process.pid}${Date.now() % 100_000}`;
}
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
	const died = owner(`echo started > ${started}; ${sleep}`, `while (!existsSync(${JSON.stringify(started)})) await Bun.sleep(10);`);
	expect(died.signal).toBe('SIGKILL');
	expect(await goneWithin(10_000, sleep)).toBe(true);
}, 40_000);

test('a supervisor whose owner died before its check starts no command', async () => {
	const at = dir();
	const started = join(at, 'started');
	const held = join(at, 'held');
	const sleep = marker();
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
