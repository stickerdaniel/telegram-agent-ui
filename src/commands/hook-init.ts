import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { isRecord, isString } from '../core/check.ts';
import type { Json } from '../core/types.ts';
import type { Env } from './config.ts';
import { HOOK_CLIENTS, type HookClient, HOOK_SECONDS, NOTIFIED } from './hook.ts';
import { done, failed, type Result } from './result.ts';
import type { Context } from './session.ts';
import { canonical, parsedJson, readText, type UserConfig, writeKept, writeTarget } from './user-file.ts';

export const CLAUDE_ON_FAILURE = [2, 1, 295] as const;

export const TOOL_INPUT_WARNING = 'from now on the input of every tool call that asks for a permission, such as a whole shell command, goes to Telegram to be approved there';

const EVENTS = ['PermissionRequest', 'Notification'] as const;
type Event = (typeof EVENTS)[number];
type Group = { matcher?: string; hooks: { [key: string]: Json }[] };

const SUBCOMMAND: Record<Event, string> = { PermissionRequest: 'permission-request', Notification: 'notification' };

export type Launcher = { runtime: string; bin: string };

const OWN_BIN = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../cli/bin.ts' : '../cli/bin.js', import.meta.url));

const quoted = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;
const run = (event: Event, client: HookClient, launcher: Launcher) =>
	`${quoted(launcher.runtime)} ${quoted(launcher.bin)} hook ${SUBCOMMAND[event]} --client ${client}${event === 'PermissionRequest' ? ` --seconds ${HOOK_SECONDS.most}` : ''}`;

export function hookGroups(client: HookClient, launcher: Launcher): Partial<Record<Event, Group>> {
	const permission = { type: 'command', command: run('PermissionRequest', client, launcher), timeout: HOOK_SECONDS.timeout };
	if (client === 'codex') return { PermissionRequest: { hooks: [permission] } };
	return {
		PermissionRequest: { matcher: '^(?!(?:AskUserQuestion|ExitPlanMode)$).*', hooks: [{ ...permission, onFailure: 'block' }] },
		Notification: { matcher: NOTIFIED.join('|'), hooks: [{ type: 'command', command: run('Notification', client, launcher) }] },
	};
}

export function hookTarget(client: HookClient, env: Env): string {
	const home = env.HOME || homedir();
	if (client === 'claude') return join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json');
	return join(env.CODEX_HOME || join(home, '.codex'), 'hooks.json');
}

const EARLIER = { PermissionRequest: `npx telegram-agent-ui@latest hook permission-request --client (?:claude|codex) --seconds ${HOOK_SECONDS.most}`, Notification: 'npx telegram-agent-ui@latest hook notification --client claude' };

function ours(event: Event, handler: unknown, launcher: Launcher): boolean {
	if (!isRecord(handler) || !isString(handler.command)) return false;
	const { command } = handler;
	return HOOK_CLIENTS.some((client) => command === run(event, client, launcher)) || new RegExp(`^${EARLIER[event]}$`).test(command);
}

type Placed = { kind: 'ok'; next: UserConfig } | { kind: 'refused'; code: 'client-config' | 'other-hook'; reason: string };

function withGroups(config: UserConfig, groups: Partial<Record<Event, Group>>, launcher: Launcher): Placed {
	const hooks = config.hooks ?? {};
	if (!isRecord(hooks)) return { kind: 'refused', code: 'client-config', reason: 'its hooks is no object' };
	const next: Record<string, unknown> = { ...hooks };
	for (const event of EVENTS) {
		const group = groups[event];
		if (!group) continue;
		const list = hooks[event] ?? [];
		if (!Array.isArray(list)) return { kind: 'refused', code: 'client-config', reason: `its hooks.${event} is no list` };
		const kept: unknown[] = [];
		let at: number | undefined;
		for (const entry of list) {
			const handlers: unknown = isRecord(entry) ? entry.hooks : undefined;
			if (!isRecord(entry) || !Array.isArray(handlers)) {
				if (event === 'PermissionRequest') return { kind: 'refused', code: 'client-config', reason: `its hooks.${event} holds an entry without a hooks list` };
				kept.push(entry);
				continue;
			}
			const foreign = event === 'PermissionRequest' ? handlers.find((handler) => !ours(event, handler, launcher)) : undefined;
			if (foreign !== undefined) {
				return {
					kind: 'refused',
					code: 'other-hook',
					reason: `holds another PermissionRequest handler, ${JSON.stringify(foreign)}. The harness lets its allow stand when this hook gives no decision, so this hook gates only as the one handler that can allow: remove that handler, or keep it and do without this hook`,
				};
			}
			const rest = handlers.filter((handler) => !ours(event, handler, launcher));
			if (rest.length === handlers.length) kept.push(entry);
			else if (rest.length > 0) kept.push({ ...entry, hooks: rest });
			else at ??= kept.length;
		}
		kept.splice(at ?? kept.length, 0, group);
		next[event] = kept;
	}
	return { kind: 'ok', next: { ...config, hooks: next } };
}

function foreignHandler(config: UserConfig): unknown {
	const hooks = config.hooks;
	const list = isRecord(hooks) ? hooks.PermissionRequest : undefined;
	if (!Array.isArray(list)) return undefined;
	for (const entry of list) {
		const handlers: unknown = isRecord(entry) ? entry.hooks : undefined;
		if (!Array.isArray(handlers)) return entry;
		if (handlers.length > 0) return handlers[0];
	}
	return undefined;
}

type Layer = { path: string; format: 'json' | 'toml' };

const exists = (path: string) => stat(path).then(() => true, () => false);

async function repositoryRoot(cwd: string): Promise<string | undefined> {
	for (let dir = cwd; ; dir = dirname(dir)) {
		if (await exists(join(dir, '.git'))) return dir;
		if (dirname(dir) === dir) return undefined;
	}
}

async function otherLayers(client: HookClient, env: Env, cwd: string | undefined): Promise<Layer[]> {
	const home = env.HOME || homedir();
	const root = cwd === undefined ? undefined : await repositoryRoot(cwd);
	if (client === 'claude') {
		if (cwd === undefined) return [];
		const paths = [join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json'), ...(root !== undefined && root !== home ? [join(root, '.claude', 'settings.local.json')] : [])];
		return paths.map((path) => ({ path, format: 'json' }));
	}
	const codexHome = resolve(env.CODEX_HOME || join(home, '.codex'));
	const layers: Layer[] = [{ path: join(codexHome, 'config.toml'), format: 'toml' }];
	if (cwd === undefined) return layers;
	const dirs: string[] = [];
	for (let dir = cwd; ; dir = dirname(dir)) {
		dirs.unshift(dir);
		if (dir === (root ?? cwd) || dirname(dir) === dir) break;
	}
	for (const folder of dirs.map((dir) => join(dir, '.codex')).filter((folder) => resolve(folder) !== codexHome)) {
		layers.push({ path: join(folder, 'hooks.json'), format: 'json' }, { path: join(folder, 'config.toml'), format: 'toml' });
	}
	return layers;
}

function parsedLayer(layer: Layer, text: string): UserConfig | undefined {
	if (layer.format === 'json') return parsedJson(text);
	try {
		return parseToml(text);
	} catch {
		return undefined;
	}
}

async function claudeVersion(env: Env): Promise<number[] | undefined> {
	try {
		const { stdout } = await promisify(execFile)('claude', ['--version'], { env: { ...env }, timeout: 30_000 });
		const match = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
		return match ? match.slice(1).map(Number) : undefined;
	} catch {
		return undefined;
	}
}

function atLeast(version: readonly number[], least: readonly number[]): boolean {
	for (const [index, part] of least.entries()) {
		const own = version[index] ?? 0;
		if (own !== part) return own > part;
	}
	return true;
}

export async function hookInit(client: HookClient, context: Context): Promise<Result> {
	const { env, log } = context;
	const path = hookTarget(client, env);
	const bin = await realpath(OWN_BIN).catch(() => OWN_BIN);
	if (bin.split(sep).includes('_npx')) {
		return failed({
			error: 'refused',
			code: 'npx-cache',
			message: `hook init runs from the npx cache at ${bin}, which npx replaces and removes on its own: install the package with npm i -g telegram-agent-ui, or into a project of your own, and run hook init from that install. Nothing was written`,
		});
	}
	const launcher: Launcher = { runtime: process.execPath, bin };
	if (client === 'claude') {
		const version = await claudeVersion(env);
		const least = CLAUDE_ON_FAILURE.join('.');
		if (!version || !atLeast(version, CLAUDE_ON_FAILURE)) {
			const found = version ? `claude --version reports ${version.join('.')}` : 'claude --version names no version';
			return failed({ error: 'refused', code: 'client-version', message: `the hook needs Claude Code ${least} or later, for onFailure "block", and ${found}: nothing was written` });
		}
	}
	const layers = (await otherLayers(client, env, context.cwd)).filter((layer) => resolve(layer.path) !== resolve(path));
	for (const layer of layers) {
		const text = await readText(layer.path);
		if (text === undefined) continue;
		const parsed = parsedLayer(layer, text);
		if (!parsed) return failed({ error: 'refused', code: 'client-config', message: `${layer.path}, which the harness reads too, holds no ${layer.format === 'json' ? 'JSON object' : 'TOML'} that tells whether it has another PermissionRequest handler: nothing was written` });
		const foreign = foreignHandler(parsed);
		if (foreign !== undefined) {
			return failed({
				error: 'refused',
				code: 'other-hook',
				message: `${layer.path}, which the harness reads too, holds another PermissionRequest handler, ${JSON.stringify(foreign)}. The harness lets its allow stand when this hook gives no decision, so this hook gates only as the one handler that can allow: remove that handler, or keep it and do without this hook. Nothing was written`,
			});
		}
	}
	const destination = await writeTarget(path);
	if (destination.kind === 'refused') return failed({ error: 'refused', code: 'client-config', message: `${path} ${destination.reason}: nothing was written` });
	const before = await readText(destination.path);
	const config = parsedJson(before);
	const groups = hookGroups(client, launcher);
	const placed: Placed = config ? withGroups(config, groups, launcher) : { kind: 'refused', code: 'client-config', reason: 'holds no JSON object' };
	if (placed.kind === 'refused') {
		const byHand = placed.code === 'client-config' ? ` Add the hooks by hand: ${JSON.stringify({ hooks: groups })}` : '';
		return failed({ error: 'refused', code: placed.code, message: `${path} ${placed.reason}: nothing was written.${byHand}` });
	}
	log(`warning tool-input: ${TOOL_INPUT_WARNING}`);
	log(`hook init writes to ${path}, keeping every other entry: ${JSON.stringify({ hooks: groups })}`);
	const changed = canonical(config) !== canonical(placed.next);
	if (changed) await writeKept(destination.path, `${JSON.stringify(placed.next, null, 2)}\n`);
	const checked = [path, ...layers.map((layer) => layer.path)];
	return done({ client, path, hooks: groups, changed, checked, ...(client === 'codex' ? { next: 'Codex runs a new hook once you trust it: open /hooks in Codex' } : {}) });
}
