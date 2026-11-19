import { homedir } from 'node:os';
import type { Readable } from '../core/types.ts';
import { openPublishable } from './roots.ts';

export { FileRefused, type FileRefusal, typeOf } from './roots.ts';

export function readPublishable(paths: string[], options: { roots: string[] }): Promise<Readable> {
	return openPublishable(paths, { roots: options.roots, cwd: process.cwd(), home: homedir() });
}
