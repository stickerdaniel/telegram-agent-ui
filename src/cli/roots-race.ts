// Loaded with `bun --preload` by the CLI tests, not part of the package: it schedules real link
// swaps between the filesystem calls of the body file reader, as a process racing the reader
// would. TAU_RACE_GIVEN is the path argument, a link; TAU_RACE_SAFE a file in the root;
// TAU_RACE_TARGET the file that must not leave. TAU_RACE_MODE picks the schedule:
// - `retarget`: after the open, the link turns to the safe file; after its resolution, the safe
//   file turns into a link to the target. The opened file stays the target throughout.
// - `read`: the link leads to the safe file until the read starts, and to the target after it.
import { mock } from 'bun:test';
import * as fs from 'node:fs/promises';

const actual = { ...fs };
const { TAU_RACE_GIVEN: given, TAU_RACE_SAFE: safe = '', TAU_RACE_TARGET: target = '', TAU_RACE_MODE: mode } = process.env;
let phase = 0;

mock.module('node:fs/promises', () => ({
	...actual,
	async open(path: string, ...rest: Parameters<typeof fs.open> extends [unknown, ...infer R] ? R : never) {
		const handle = await actual.open(path, ...rest);
		if (path !== given || phase !== 0) return handle;
		phase = 1;
		if (mode === 'retarget') {
			await actual.unlink(path);
			await actual.symlink(safe, path);
		}
		if (mode === 'read') {
			const read = handle.readFile.bind(handle);
			Object.assign(handle, {
				async readFile(...args: Parameters<typeof read>) {
					await actual.unlink(path);
					await actual.symlink(target, path);
					return read(...args);
				},
			});
		}
		return handle;
	},
	async realpath(path: string, ...rest: Parameters<typeof fs.realpath> extends [unknown, ...infer R] ? R : never) {
		const real = await actual.realpath(path, ...rest);
		if (path === given && phase === 1 && mode === 'retarget') {
			phase = 2;
			await actual.unlink(safe);
			await actual.symlink(target, safe);
		}
		return real;
	},
}));
