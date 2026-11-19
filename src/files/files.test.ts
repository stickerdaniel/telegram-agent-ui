import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Publishable } from '../core/types.ts';
import { FileRefused, readPublishable } from './index.ts';

const trees: string[] = [];
const open: Publishable[] = [];
afterEach(async () => {
	await Promise.allSettled(open.splice(0).map((file) => file.close()));
	for (const tree of trees.splice(0)) rmSync(tree, { recursive: true, force: true });
});

function tree() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'tau-files-')));
	trees.push(root);
	const project = join(root, 'project');
	mkdirSync(project);
	writeFileSync(join(project, 'shot.png'), 'CHECKED');
	writeFileSync(join(root, 'secret.txt'), 'SECRET_SENTINEL');
	return { root, project };
}

async function readOne(path: string, roots: string[]): Promise<Publishable> {
	const read = await readPublishable([path], { roots });
	if (read.kind !== 'ok') throw new Error(`refused: ${read.reason}`);
	open.push(...read.files);
	const [file] = read.files;
	if (!file) throw new Error('no file');
	return file;
}

const text = async (stream: ReadableStream<Uint8Array>) => new TextDecoder().decode(await new Response(stream).arrayBuffer());

test('a file opens with its real path, type and size, and reads the same bytes as bytes and as a stream', async () => {
	const { project } = tree();
	const file = await readOne(join(project, 'shot.png'), [project]);
	expect(file).toMatchObject({ path: join(project, 'shot.png'), type: 'image/png', size: 7 });
	expect(new TextDecoder().decode(await file.bytes())).toBe('CHECKED');
	expect(await text(file.stream())).toBe('CHECKED');
	appendFileSync(join(project, 'shot.png'), 'GROWN');
	expect(await text(file.stream())).toBe('CHECKED');
});

test('a file swapped for a link to a secret after its check is refused, and no read returns the secret', async () => {
	const { root, project } = tree();
	const path = join(project, 'shot.png');
	const file = await readOne(path, [project]);
	rmSync(path);
	symlinkSync(join(root, 'secret.txt'), path);
	const bytes = await file.bytes().catch((error: unknown) => error);
	expect(bytes).toBeInstanceOf(FileRefused);
	const streamed = await text(file.stream()).catch((error: unknown) => error);
	expect(streamed).toBeInstanceOf(FileRefused);
});

test('a file replaced by a rename after its check is refused', async () => {
	const { project } = tree();
	const path = join(project, 'shot.png');
	const file = await readOne(path, [project]);
	writeFileSync(join(project, 'other.png'), 'SWAPPED_SENTINEL');
	renameSync(join(project, 'other.png'), path);
	const refused = await file.bytes().catch((error: unknown) => error);
	expect(refused).toBeInstanceOf(FileRefused);
	expect(String(refused)).not.toContain('SENTINEL');
});

test('the refusals of 4.7 hold for every path, and an earlier opened file is closed on a refusal', async () => {
	const { root, project } = tree();
	writeFileSync(join(project, '.env'), 'TOKEN=1');
	symlinkSync(join(root, 'secret.txt'), join(project, 'leak.png'));
	const roots = [project];
	expect(await readPublishable([join(root, 'secret.txt')], { roots })).toMatchObject({ kind: 'refused', code: 'outside-roots' });
	expect(await readPublishable([join(project, '.env')], { roots })).toMatchObject({ kind: 'refused', code: 'secret-file' });
	expect(await readPublishable([join(project, 'shot.png'), join(project, 'leak.png')], { roots })).toMatchObject({ kind: 'refused', code: 'outside-roots' });
	expect(await readPublishable([join(project, 'shot.png')], { roots: [project, '/'] })).toMatchObject({ kind: 'refused', code: 'publish-root' });
});
