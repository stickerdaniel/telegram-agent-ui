// `./files`: the one door for files that leave the machine, attachments and views alike, for
// Node and Bun on macOS and Linux. The rules and the handle checks live in roots.ts.
import { homedir } from 'node:os';
import type { Readable } from '../core/types.ts';
import { openPublishable } from './roots.ts';

export { FileRefused, type FileRefusal, typeOf } from './roots.ts';

/**
 * Opens every path below one of `roots` as a Publishable, in order, or returns the refusal of
 * the first path that fails: `outside-roots` for a path or link that leaves the roots,
 * `secret-file` for a name such as `.env`, `publish-root` for a root that is `/` or holds the
 * home directory, `shape` for a missing file or no regular file. Each file is opened once and
 * checked on its handle; its reads come from that handle and fail with FileRefused when the
 * path changed meanwhile. A relative path resolves against the working directory. The caller
 * closes every file it gets.
 *
 *   const read = await readPublishable(['/work/shot.png'], { roots: ['/work'] });
 *   if (read.kind === 'ok') {
 *     try { await upload(read.files[0].stream()); } finally { await Promise.all(read.files.map((file) => file.close())); }
 *   }
 */
export function readPublishable(paths: string[], options: { roots: string[] }): Promise<Readable> {
	return openPublishable(paths, { roots: options.roots, cwd: process.cwd(), home: homedir() });
}
