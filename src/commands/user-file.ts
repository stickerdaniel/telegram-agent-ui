// The config files of other programs that `mcp init` and `hook init` edit, such as
// `~/.claude/settings.json`: read whole, written back whole through a temp file beside them. A
// linked file is written at its real path, and a link to a file that does not exist is refused.
import { chmod, lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isRecord } from '../core/check.ts';

/** A parsed config file: a JSON object, or a TOML document. */
export type UserConfig = Record<string, unknown>;

/** The text of a file, or undefined when it does not exist. */
export async function readText(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, 'utf8');
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
		throw error;
	}
}

/**
 * The file a write of `path` replaces, the one a read of `path` opens: the real path of an
 * existing file, or `path` itself when nothing is there. A link whose target does not exist is
 * refused, since only the operating system can tell where its target would be.
 */
export async function writeTarget(path: string): Promise<{ kind: 'ok'; path: string } | { kind: 'refused'; reason: string }> {
	const real = await realpath(path).catch(() => undefined);
	if (real !== undefined) return { kind: 'ok', path: real };
	const found = await lstat(path).catch(() => undefined);
	if (!found?.isSymbolicLink()) return { kind: 'ok', path };
	return { kind: 'refused', reason: `is a link to ${await readlink(path)}, which does not exist. Create the target or remove the link, then run the command again` };
}

/** Writes `text` to the file `real`, which `writeTarget` found, through a temp file beside it. The mode stays, a new file gets 0600. */
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

/** A parsed value as text with sorted keys, so two documents compare by meaning. Dates print through `toJSON`. */
export const canonical = (value: unknown) =>
	JSON.stringify(value, (_key, item: unknown) => (isRecord(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item));

/** A JSON text as a config object: empty for no text, undefined for anything but an object. */
export function parsedJson(text: string | undefined): UserConfig | undefined {
	if (text === undefined || text.trim() === '') return {};
	try {
		const value: unknown = JSON.parse(text);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}
