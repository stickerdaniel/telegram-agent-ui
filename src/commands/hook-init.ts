// `hook init --client <claude|codex>`: writes the hook entries of section 9 into the harness's
// user settings, for every project. Claude Code reads hooks from `~/.claude/settings.json`, or
// `settings.json` in $CLAUDE_CONFIG_DIR; Codex from `hooks.json` in $CODEX_HOME, default
// `~/.codex`. Both files hold `hooks: { <event>: [{ matcher?, hooks: [handler] }] }`. Each
// entry runs the absolute paths of the runtime and of this installation's bin, never npx, and
// `hook init` refuses to run from an npx cache. The
// permission hook gets a timeout of 600 s and `--seconds 570`, written together, so the
// question closes 30 s before the harness cancels the hook. Claude Code also gets
// `onFailure: "block"`, so a hook that fails or times out denies, and the Notification hook.
//
// The hook gates only as the one PermissionRequest handler that can allow, so `hook init` refuses
// while the file it writes, or another layer the harness loads for the working directory it runs
// in, holds another one: Claude Code's project and local settings, Codex's `config.toml` and the
// hook files of its project layers.
//
// The edit keeps every other key and every other handler of the file. A handler of this package
// is recognized only by the exact command it writes, removed and written again in its group's
// place, so a second run changes nothing. Sources: https://code.claude.com/docs/en/hooks ("Hook locations", "Matcher
// patterns", "Command hook fields", "Block the action when a hook fails"); for Codex,
// codex-rs/hooks/src/engine/discovery.rs, codex-rs/config/src/hook_config.rs and
// codex-rs/protocol/src/hooks.rs of openai/codex at 59ac39add.
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

/** The first Claude Code whose command hooks take `onFailure`, CHANGELOG.md of anthropics/claude-code. */
export const CLAUDE_ON_FAILURE = [2, 1, 295] as const;

/** What `hook init` says before it writes anything. */
export const TOOL_INPUT_WARNING = 'from now on the input of every tool call that asks for a permission, such as a whole shell command, goes to Telegram to be approved there';

const EVENTS = ['PermissionRequest', 'Notification'] as const;
type Event = (typeof EVENTS)[number];
type Group = { matcher?: string; hooks: { [key: string]: Json }[] };

// The subcommand of each event: a handler whose command runs it is this package's.
const SUBCOMMAND: Record<Event, string> = { PermissionRequest: 'permission-request', Notification: 'notification' };

/**
 * What a hook entry starts: the runtime that runs `hook init` and the bin of the installation
 * it runs from, both absolute. A release changes the gate only once the user installs it, and
 * no npm resolution or project npm config runs on the permission path.
 */
export type Launcher = { runtime: string; bin: string };

// The bin of this installation, beside this module: `cli/bin.js` under dist, `cli/bin.ts` when Bun runs the source.
const OWN_BIN = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../cli/bin.ts' : '../cli/bin.js', import.meta.url));

/** A word in single quotes for a POSIX shell, which Claude Code (`sh -c`) and Codex (`$SHELL -lc`) run the command with. */
const quoted = (word: string) => `'${word.replace(/'/g, `'\\''`)}'`;
const run = (event: Event, client: HookClient, launcher: Launcher) =>
	`${quoted(launcher.runtime)} ${quoted(launcher.bin)} hook ${SUBCOMMAND[event]} --client ${client}${event === 'PermissionRequest' ? ` --seconds ${HOOK_SECONDS.most}` : ''}`;

/**
 * The groups `hook init` writes per event. Claude Code allows `AskUserQuestion` and
 * `ExitPlanMode` only with `updatedInput`, so its matcher leaves them out: a matcher with other
 * characters than letters, digits, `_`, `-`, spaces, `,` and `|` is a JavaScript regular
 * expression, tested unanchored. Codex runs a group without a matcher for every tool.
 */
export function hookGroups(client: HookClient, launcher: Launcher): Partial<Record<Event, Group>> {
	const permission = { type: 'command', command: run('PermissionRequest', client, launcher), timeout: HOOK_SECONDS.timeout };
	if (client === 'codex') return { PermissionRequest: { hooks: [permission] } };
	return {
		PermissionRequest: { matcher: '^(?!(?:AskUserQuestion|ExitPlanMode)$).*', hooks: [{ ...permission, onFailure: 'block' }] },
		Notification: { matcher: NOTIFIED.join('|'), hooks: [{ type: 'command', command: run('Notification', client, launcher) }] },
	};
}

/** The user settings file of `client` that holds its hooks. */
export function hookTarget(client: HookClient, env: Env): string {
	const home = env.HOME || homedir();
	if (client === 'claude') return join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json');
	return join(env.CODEX_HOME || join(home, '.codex'), 'hooks.json');
}

// The form the first `hook init` of this package wrote, before entries were pinned.
const EARLIER = { PermissionRequest: `npx telegram-agent-ui@latest hook permission-request --client (?:claude|codex) --seconds ${HOOK_SECONDS.most}`, Notification: 'npx telegram-agent-ui@latest hook notification --client claude' };

/**
 * True for a handler whose command is exactly one this installation writes for `event`, for
 * either client, or the earlier npx form. A pinned entry of another runtime or install, and any
 * other command, also one that names this package in a comment, stays another's: a
 * `PermissionRequest` handler that is not exactly ours refuses `hook init`.
 */
function ours(event: Event, handler: unknown, launcher: Launcher): boolean {
	if (!isRecord(handler) || !isString(handler.command)) return false;
	const { command } = handler;
	return HOOK_CLIENTS.some((client) => command === run(event, client, launcher)) || new RegExp(`^${EARLIER[event]}$`).test(command);
}

type Placed = { kind: 'ok'; next: UserConfig } | { kind: 'refused'; code: 'client-config' | 'other-hook'; reason: string };

/**
 * `config` with `groups` in its `hooks`, or why it cannot take them. Each handler of this
 * package leaves its group, a group it leaves empty goes, and the new group takes the place of
 * the first such group, else the end. Everything else stays where it was. A `PermissionRequest`
 * handler of anyone else refuses the whole edit with `other-hook`: both harnesses let its allow
 * stand when this hook gives no decision, so this hook gates only as the one handler that allows.
 */
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

/**
 * The first `PermissionRequest` handler in a parsed hook file other than the one `hook init`
 * writes. Every handler counts, this package's own too: `hook init` changes only its own file,
 * so an entry of this package elsewhere, such as an unpinned npx one, would stay active.
 */
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

/** Another file of hooks the harness loads for the working directory: JSON settings or a hooks file, or a TOML config with `[hooks]`. */
type Layer = { path: string; format: 'json' | 'toml' };

const exists = (path: string) => stat(path).then(() => true, () => false);

/** The nearest directory from `cwd` up that holds `.git`, where both harnesses find a repository root. */
async function repositoryRoot(cwd: string): Promise<string | undefined> {
	for (let dir = cwd; ; dir = dirname(dir)) {
		if (await exists(join(dir, '.git'))) return dir;
		if (dirname(dir) === dir) return undefined;
	}
}

/**
 * The other layers `client` loads hooks from for a session in `cwd`, beside the file `hook init`
 * writes. Claude Code: `.claude/settings.json` in `cwd`, and `.claude/settings.local.json` in
 * `cwd` and at the repository root (https://code.claude.com/docs/en/settings, "Settings files
 * and who they affect" and "Where Claude Code keeps the local file in a git repository"). Codex:
 * `config.toml` in $CODEX_HOME, and `hooks.json` and `config.toml` in the `.codex` of every
 * directory from the project root, the nearest one with `.git`, else `cwd`, down to `cwd`
 * (codex-rs/config/src/loader/mod.rs, `discover_project_layers`, at 59ac39add). Without `cwd`,
 * as for a caller with no working directory, only the user layers count.
 */
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

/** A layer's text as a parsed config, or undefined when it holds no object of its format. */
function parsedLayer(layer: Layer, text: string): UserConfig | undefined {
	if (layer.format === 'json') return parsedJson(text);
	try {
		return parseToml(text);
	} catch {
		return undefined;
	}
}

/** The version `claude --version` reports, as numbers, or undefined when it runs not or names none. */
async function claudeVersion(env: Env): Promise<number[] | undefined> {
	try {
		const { stdout } = await promisify(execFile)('claude', ['--version'], { env: { ...env }, timeout: 30_000 });
		const match = /(\d+)\.(\d+)\.(\d+)/.exec(stdout);
		return match ? match.slice(1).map(Number) : undefined;
	} catch {
		return undefined;
	}
}

/** True when `version` is `least` or later. */
function atLeast(version: readonly number[], least: readonly number[]): boolean {
	for (const [index, part] of least.entries()) {
		const own = version[index] ?? 0;
		if (own !== part) return own > part;
	}
	return true;
}

/**
 * Writes the hook entries of `client` into its user settings and prints `{ client, path,
 * hooks, changed, checked }`, after it logged that tool input leaves the machine and the groups
 * it adds; `checked` names every hook file it read for another handler. Refuses with
 * `npx-cache` when this installation lies in an npx cache, with `client-version` a Claude Code
 * older than 2.1.295, which lacks `onFailure`, with `other-hook` while the file it writes or
 * another layer the harness loads for `context.cwd` holds another `PermissionRequest` handler,
 * and with `client-config` a file that cannot take the entries with everything else kept, or a
 * layer it cannot read; a refusal writes nothing.
 *
 *   await hookInit('claude', context); // ~/.claude/settings.json gets hooks.PermissionRequest and hooks.Notification
 */
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
