// Which local files may leave the machine, the rules of 4.7: only files below a root, never
// through a link that leaves the roots, and never a file whose name marks a secret. A root that
// is `/`, the home directory or a directory above it is refused, since it would allow every file.
// The checks run on the real path of the opened handle before and after the read, see
// `openInRoots` for what that boundary covers. `readPublishable` of `./files` builds on these.
import { constants } from 'node:fs';
import { type FileHandle, lstat, open, readlink, realpath } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';

/** Why a file may not leave the machine. */
export type FileRefusal = { kind: 'refused'; code: 'outside-roots' | 'secret-file' | 'publish-root' | 'shape'; reason: string };

// `.env` and `.env.*`, `.netrc`, `.npmrc`, `*.pem`, `*.key`, and private SSH keys.
const SECRET_NAME = /^(?:\.env(?:\..*)?|\.netrc|\.npmrc|.*\.pem|.*\.key|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?)$/i;
// Nothing below these directories leaves the machine.
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.config', '.git']);

const refused = (code: FileRefusal['code'], reason: string): FileRefusal => ({ kind: 'refused', code, reason });
const below = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/** Why `path` names a secret, or undefined: its file name, or a directory on its way such as `.ssh`. */
export function secretIssue(path: string): string | undefined {
	if (SECRET_NAME.test(basename(path))) return `${basename(path)} names a secret`;
	const dir = path.split(sep).slice(0, -1).find((part) => SECRET_DIRS.has(part));
	return dir === undefined ? undefined : `${path} lies below ${dir}, whose files are secret`;
}

/**
 * The real paths of `roots`, or the refusal `publish-root` when one of them is `/`, the home
 * directory or above it. A root that does not exist is left out, since it holds no file.
 */
export async function realRoots(roots: readonly string[], home: string): Promise<{ kind: 'ok'; roots: string[] } | FileRefusal> {
	const realHome = await realpath(home).catch(() => resolve(home));
	const found: string[] = [];
	for (const root of roots) {
		const real = await realpath(resolve(root)).catch(() => undefined);
		if (real === undefined) continue;
		if (real === sep || below(realHome, real)) return refused('publish-root', `the root ${root} is / or holds the home directory: every file would be allowed. Run from a project directory`);
		found.push(real);
	}
	return { kind: 'ok', roots: found };
}

/** Where a path leads, bound to an open handle: its real path, and the device and inode both name. */
type Binding = { real: string; dev: number; ino: number };

/**
 * The binding of `given` to `handle`, or undefined when they name different files. The real path
 * must name a regular file itself, no link, with the handle's device and inode, and on Linux
 * `/proc/self/fd` must give the same path for the handle. A path that is retargeted between
 * the resolution and the look at it shows as a link or as another inode there.
 */
async function bind(given: string, handle: FileHandle): Promise<Binding | undefined> {
	const opened = await handle.stat();
	const real = await realpath(given);
	const atReal = await lstat(real);
	if (!atReal.isFile() || atReal.dev !== opened.dev || atReal.ino !== opened.ino) return undefined;
	const viaFd = process.platform === 'linux' ? await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined) : undefined;
	if (viaFd !== undefined && viaFd !== real) return undefined;
	return { real, dev: opened.dev, ino: opened.ino };
}

/** An opened file below the roots: read it from `handle`, then call `confirm` before the content is used. */
export type Opened = { kind: 'ok'; handle: FileHandle; path: string; size: number; confirm(): Promise<FileRefusal | undefined> };

/**
 * Opens `path`, relative to `cwd`, when it is a regular file below one of `roots` and names no
 * secret, and returns the open handle; the caller reads from it, calls `confirm` and closes it.
 * A link is followed and judged by where it leads.
 *
 * The roots and names are judged on the real path of the opened file, bound to the handle by
 * device and inode before the read. `confirm` resolves the path once more after the read and
 * refuses the file when the real path, the device or the inode changed. This stops a path
 * argument, written by an agent or injected into its prompt, from naming a file outside the
 * roots or a secret. A process that rewrites links inside a root while the read runs is outside
 * this boundary: such a process could as well copy the file into the root.
 *
 *   const opened = await openInRoots('notes/plan.md', { roots: [process.cwd()], cwd: process.cwd(), home: os.homedir() });
 *   if (opened.kind === 'ok') {
 *     const text = await opened.handle.readFile('utf8');
 *     const refusal = await opened.confirm(); // undefined: the text may be used
 *   }
 */
export async function openInRoots(path: string, options: { roots: readonly string[]; cwd: string; home: string }): Promise<Opened | FileRefusal> {
	const allowed = await realRoots(options.roots, options.home);
	if (allowed.kind === 'refused') return allowed;
	const given = resolve(options.cwd, path);
	const named = secretIssue(given);
	if (named) return refused('secret-file', named);
	let handle: FileHandle;
	try {
		// Non-blocking, so a named pipe cannot hold the open; a regular file reads as usual.
		handle = await open(given, constants.O_RDONLY | constants.O_NONBLOCK);
	} catch (error) {
		return refused('shape', `cannot open ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const keep = async (result: FileRefusal) => {
		await handle.close();
		return result;
	};
	const changed = refused('outside-roots', `${path} changed while it was checked`);
	try {
		const opened = await handle.stat();
		if (!opened.isFile()) return keep(refused('shape', `${path} is no regular file`));
		const before = await bind(given, handle);
		if (!before) return keep(changed);
		const secret = secretIssue(before.real);
		if (secret) return keep(refused('secret-file', secret));
		if (!allowed.roots.some((root) => below(before.real, root))) {
			return keep(refused('outside-roots', `${path} lies outside the roots ${options.roots.join(', ')}. A person adds a directory to publishRoots in the config`));
		}
		const confirm = async (): Promise<FileRefusal | undefined> => {
			const after = await bind(given, handle).catch(() => undefined);
			return after && after.real === before.real && after.dev === before.dev && after.ino === before.ino ? undefined : changed;
		};
		return { kind: 'ok', handle, path: before.real, size: opened.size, confirm };
	} catch (error) {
		return keep(refused('shape', `cannot check ${path}: ${error instanceof Error ? error.message : String(error)}`));
	}
}

/** The text of `path` through `openInRoots` and its `confirm`, refused with `shape` above `limit` bytes. */
export async function readTextInRoots(path: string, options: { roots: readonly string[]; cwd: string; home: string; limit: number }): Promise<{ kind: 'ok'; text: string } | FileRefusal> {
	const opened = await openInRoots(path, options);
	if (opened.kind === 'refused') return opened;
	try {
		if (opened.size > options.limit) return refused('shape', `${path} has ${opened.size} bytes, more than ${options.limit}`);
		const text = await opened.handle.readFile('utf8');
		return (await opened.confirm()) ?? { kind: 'ok', text };
	} finally {
		await opened.handle.close();
	}
}
