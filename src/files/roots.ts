import { constants } from 'node:fs';
import { type FileHandle, lstat, open, readlink, realpath } from 'node:fs/promises';
import { basename, extname, resolve, sep } from 'node:path';
import type { Publishable, Readable } from '../core/types.ts';

export type FileRefusal = Extract<Readable, { kind: 'refused' }>;

const SECRET_NAME = /^(?:\.env(?:\..*)?|\.netrc|\.npmrc|.*\.pem|.*\.key|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?)$/i;
const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.config', '.git']);

const refused = (code: FileRefusal['code'], reason: string): FileRefusal => ({ kind: 'refused', code, reason });
const below = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

export function secretIssue(path: string): string | undefined {
	if (SECRET_NAME.test(basename(path))) return `${basename(path)} names a secret`;
	const dir = path.split(sep).slice(0, -1).find((part) => SECRET_DIRS.has(part));
	return dir === undefined ? undefined : `${path} lies below ${dir}, whose files are secret`;
}

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

type Binding = { real: string; dev: number; ino: number };

async function bind(given: string, handle: FileHandle): Promise<Binding | undefined> {
	const opened = await handle.stat();
	const real = await realpath(given);
	const atReal = await lstat(real);
	if (!atReal.isFile() || atReal.dev !== opened.dev || atReal.ino !== opened.ino) return undefined;
	const viaFd = process.platform === 'linux' ? await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined) : undefined;
	if (viaFd !== undefined && viaFd !== real) return undefined;
	return { real, dev: opened.dev, ino: opened.ino };
}

export type Opened = { kind: 'ok'; handle: FileHandle; path: string; size: number; confirm(): Promise<FileRefusal | undefined> };

export async function openInRoots(path: string, options: { roots: readonly string[]; cwd: string; home: string; secrets?: boolean }): Promise<Opened | FileRefusal> {
	const allowed = await realRoots(options.roots, options.home);
	if (allowed.kind === 'refused') return allowed;
	const given = resolve(options.cwd, path);
	const secretOf = options.secrets === false ? () => undefined : secretIssue;
	const named = secretOf(given);
	if (named) return refused('secret-file', named);
	let handle: FileHandle;
	try {
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

export class FileRefused extends Error {
	override name = 'FileRefused';
	constructor(readonly refusal: FileRefusal) {
		super(refusal.reason);
	}
}

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
export const typeOf = (path: string) => TYPES[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream';

const CHUNK = 64 * 1024;

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
