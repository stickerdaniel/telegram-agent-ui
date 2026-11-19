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
			const read = handle.read.bind(handle);
			let swapped = false;
			Object.assign(handle, {
				async read(...args: Parameters<typeof read>) {
					if (!swapped) {
						swapped = true;
						await actual.unlink(path);
						await actual.symlink(target, path);
					}
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
