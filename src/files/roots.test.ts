import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openInRoots, readTextInRoots, secretIssue } from './roots.ts';

const trees: string[] = [];
afterEach(() => {
	for (const tree of trees.splice(0)) rmSync(tree, { recursive: true, force: true });
});

function tree() {
	const home = mkdtempSync(join(tmpdir(), 'tau-roots-'));
	trees.push(home);
	const project = join(home, 'project');
	mkdirSync(join(project, 'docs'), { recursive: true });
	writeFileSync(join(project, 'docs', 'plan.md'), 'the plan');
	writeFileSync(join(home, 'outside.md'), 'outside');
	return { home, project, options: { roots: [project], cwd: project, home, limit: 1_000 } };
}

test('every secret name and directory of 4.7 is refused, and plain names pass', () => {
	for (const path of ['/p/.env', '/p/.env.local', '/p/.netrc', '/p/.npmrc', '/p/cert.pem', '/p/server.KEY', '/p/id_rsa', '/p/id_ed25519', '/p/.ssh/config', '/p/.aws/credentials', '/p/.gnupg/x', '/p/.config/gh/hosts.yml', '/p/.git/HEAD']) {
		expect(secretIssue(path), path).toBeString();
	}
	for (const path of ['/p/notes.md', '/p/environment.md', '/p/id_rsa.pub', '/p/keys.md', '/p/git/notes.md']) expect(secretIssue(path), path).toBeUndefined();
});

test('a file below a root is read through its handle', async () => {
	const { options } = tree();
	expect(await readTextInRoots('docs/plan.md', options)).toEqual({ kind: 'ok', text: 'the plan' });
	expect(await readTextInRoots('docs/plan.md', { ...options, limit: 3 })).toMatchObject({ kind: 'refused', code: 'shape' });
});

test('a path outside the roots, a link that leaves them and a secret name are refused', async () => {
	const { home, project, options } = tree();
	symlinkSync(join(home, 'outside.md'), join(project, 'link.md'));
	writeFileSync(join(project, '.env'), 'TOKEN=1');
	symlinkSync(join(project, '.env'), join(project, 'innocent.md'));
	expect(await readTextInRoots('../outside.md', options)).toMatchObject({ kind: 'refused', code: 'outside-roots' });
	expect(await readTextInRoots(join(home, 'outside.md'), options)).toMatchObject({ kind: 'refused', code: 'outside-roots' });
	expect(await readTextInRoots('link.md', options)).toMatchObject({ kind: 'refused', code: 'outside-roots' });
	expect(await readTextInRoots('.env', options)).toMatchObject({ kind: 'refused', code: 'secret-file' });
	expect(await readTextInRoots('innocent.md', options)).toMatchObject({ kind: 'refused', code: 'secret-file' });
	expect(await readTextInRoots('../outside.md', { ...options, roots: [project, home] })).toMatchObject({ kind: 'refused', code: 'publish-root' });
});

test('a root that is /, the home directory or above it refuses every file', async () => {
	const { home, project, options } = tree();
	for (const root of ['/', home, join(home, '..')]) expect(await readTextInRoots('docs/plan.md', { ...options, roots: [project, root] }), root).toMatchObject({ kind: 'refused', code: 'publish-root' });
});

test('a directory and a named pipe are no regular files, and the pipe does not hold the open', async () => {
	const { project, options } = tree();
	execFileSync('mkfifo', [join(project, 'pipe.md')]);
	expect(await openInRoots('docs', options)).toMatchObject({ kind: 'refused', code: 'shape' });
	expect(await openInRoots('pipe.md', options)).toMatchObject({ kind: 'refused', code: 'shape' });
	expect(await openInRoots('missing.md', options)).toMatchObject({ kind: 'refused', code: 'shape' });
});
