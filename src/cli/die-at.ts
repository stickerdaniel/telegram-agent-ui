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
