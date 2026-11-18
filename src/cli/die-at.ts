// Loaded with `bun --preload` by the CLI tests, not part of the package: it kills the listener
// with SIGKILL at a write of the file store, as a crash there would. The store writes each key
// to a temp file and renames it into place, so the kill comes before that rename and the key
// keeps its earlier value. TAU_DIE_AT picks the write:
// - `record`: the first receipt of an update, a key `up:...`.
// - `cursor`: the first cursor write after a receipt was stored.
import { mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import { basename } from 'node:path';

const actual = { ...fs };
const at = process.env.TAU_DIE_AT;
let recorded = false;

mock.module('node:fs/promises', () => ({
	...actual,
	async rename(from: string, to: string) {
		const name = basename(String(to));
		const receipt = name.startsWith(encodeURIComponent('up:'));
		if ((at === 'record' && receipt) || (at === 'cursor' && recorded && name === 'cursor')) process.kill(process.pid, 'SIGKILL');
		await actual.rename(from, to);
		if (receipt) recorded = true;
	},
}));
