import { chmod, lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isRecord } from '../core/check.ts';

export type UserConfig = Record<string, unknown>;

export async function readText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, 'utf8');
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
		throw error;
	}
}

export async function writeTarget(path: string): Promise<{ kind: 'ok'; path: string } | { kind: 'refused'; reason: string }> {
	const real = await realpath(path).catch(() => undefined);
	if (real !== undefined) return { kind: 'ok', path: real };
	const found = await lstat(path).catch(() => undefined);
	if (!found?.isSymbolicLink()) return { kind: 'ok', path };
	return { kind: 'refused', reason: `is a link to ${await readlink(path)}, which does not exist. Create the target or remove the link, then run the command again` };
}

export async function writeKept(real: string, text: string): Promise<void> {
	const mode = await stat(real).then((found) => found.mode & 0o777, () => 0o600);
	await mkdir(dirname(real), { recursive: true });
	const temp = `${real}.${process.pid}.tmp`;
	try {
		await writeFile(temp, text, { mode });
		await chmod(temp, mode);
		await rename(temp, real);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

export const canonical = (value: unknown) =>
	JSON.stringify(value, (_key, item: unknown) => (isRecord(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item));

export function parsedJson(text: string | undefined): UserConfig | undefined {
	if (text === undefined || text.trim() === '') return {};
	try {
		const value: unknown = JSON.parse(text);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}
