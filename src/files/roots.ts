// Which local files may leave the machine, the rules of 4.7: only files below a root, never
// through a link that leaves the roots, and never a file whose name marks a secret. A root that
// is `/`, the home directory or a directory above it is refused, since it would allow every file.
// The checks run on the real path of the opened handle before and after the read, see
// `openInRoots` for what that boundary covers. `openPublishable` turns the opened handles into
// the Publishable files of 4.7, which `readPublishable` of `./files`, the body file reader of
// the CLI and `prepareView` all read through.
import { constants } from 'node:fs';
import { type FileHandle, lstat, open, readlink, realpath } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import type { Publishable, Readable } from '../core/types.ts';

/** Why a file may not leave the machine. */
export type FileRefusal = Extract<Readable, { kind: 'refused' }>;

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
 * A link is followed and judged by where it leads. `secrets: false` drops the secret-name rules,
 * for a file that comes in rather than leaves, such as one a local Bot API server holds.
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
export async function openInRoots(path: string, options: { roots: readonly string[]; cwd: string; home: string; secrets?: boolean }): Promise<Opened | FileRefusal> {
	const allowed = await realRoots(options.roots, options.home);
	if (allowed.kind === 'refused') return allowed;
	const given = resolve(options.cwd, path);
	const secretOf = options.secrets === false ? () => undefined : secretIssue;
	const named = secretOf(given);
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
		const secret = secretOf(before.real);
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

/** A read of a Publishable whose path changed while it was read: `refusal` says why, and the content must not be used. */
export class FileRefused extends Error {
	override name = 'FileRefused';
	constructor(readonly refusal: FileRefusal) {
		super(refusal.reason);
	}
}

// The content types by ending: the media types of 4.8, the view files and a few documents.
const TYPES: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	gif: 'image/gif',
	mp4: 'video/mp4',
	md: 'text/markdown; charset=utf-8',
	diff: 'text/x-diff; charset=utf-8',
	patch: 'text/x-diff; charset=utf-8',
	html: 'text/html; charset=utf-8',
	txt: 'text/plain; charset=utf-8',
	json: 'application/json',
	pdf: 'application/pdf',
};
/** The content type of a path by its ending, `application/octet-stream` for any other. */
export const typeOf = (path: string) => TYPES[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream';

const CHUNK = 64 * 1024;

/**
 * An opened file as a Publishable. Every read starts at byte 0 and stops at the size the handle
 * had when it was checked, so a file that grows later is never sent past its checked size, and
 * a second read, such as a retried upload, sends the same bytes. Each read ends with `confirm`:
 * `bytes` rejects and `stream` errors with FileRefused when the path changed meanwhile.
 */
function publishable(opened: Opened): Publishable {
	const { handle, path, size, confirm } = opened;
	let closing: Promise<void> | undefined;
	const settled = async () => {
		const refusal = await confirm();
		if (refusal) throw new FileRefused(refusal);
	};
	return {
		path,
		type: typeOf(path),
		size,
		async bytes() {
			const buffer = new Uint8Array(size);
			let offset = 0;
			while (offset < size) {
				const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
				if (bytesRead === 0) break;
				offset += bytesRead;
			}
			await settled();
			return offset === size ? buffer : buffer.slice(0, offset);
		},
		stream() {
			let offset = 0;
			return new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						if (offset < size) {
							const buffer = new Uint8Array(Math.min(CHUNK, size - offset));
							const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
							if (bytesRead > 0) {
								offset += bytesRead;
								return controller.enqueue(bytesRead === buffer.length ? buffer : buffer.slice(0, bytesRead));
							}
						}
						await settled();
						controller.close();
					} catch (error) {
						controller.error(error);
					}
				},
			});
		},
		close() {
			closing ??= handle.close();
			return closing;
		},
	};
}

/**
 * Opens every path of `paths`, relative to `cwd`, through `openInRoots`, as Publishable files in
 * the same order, or returns the refusal of the first that fails and closes the ones opened
 * before it. A path given twice is opened twice. The caller closes every file it gets.
 */
export async function openPublishable(paths: readonly string[], options: { roots: readonly string[]; cwd: string; home: string }): Promise<Readable> {
	const files: Publishable[] = [];
	for (const path of paths) {
		const opened = await openInRoots(path, options);
		if (opened.kind === 'refused') {
			await Promise.allSettled(files.map((file) => file.close()));
			return opened;
		}
		files.push(publishable(opened));
	}
	return { kind: 'ok', files };
}

/** The text of `path` through `openPublishable`, refused with `shape` above `limit` bytes. */
export async function readTextInRoots(path: string, options: { roots: readonly string[]; cwd: string; home: string; limit: number }): Promise<{ kind: 'ok'; text: string } | FileRefusal> {
	const read = await openPublishable([path], options);
	if (read.kind === 'refused') return read;
	const [file] = read.files;
	if (!file) return refused('shape', `cannot open ${path}`);
	try {
		if (file.size > options.limit) return refused('shape', `${path} has ${file.size} bytes, more than ${options.limit}`);
		return { kind: 'ok', text: new TextDecoder().decode(await file.bytes()) };
	} catch (error) {
		if (error instanceof FileRefused) return error.refusal;
		return refused('shape', `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		await file.close();
	}
}
