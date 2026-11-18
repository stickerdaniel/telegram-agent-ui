// `mcp init --client <client>`: writes the entry `npx telegram-agent-ui@latest mcp` into the
// user config of one MCP client and installs nothing. The server holds no project state, and
// the config of 5.1 is one per machine user, so the entry goes where the client reads servers
// for every project. Each format below is the one the client documents or parses, as cited.
// A JSON config is read, given the entry and written back whole through a temp file. Codex's
// TOML keeps every byte outside the entry's own table, and the edit is written only when the
// parsed result holds every other setting unchanged. A linked config is written at its real
// path, and a link to a file that does not exist is refused. A config that cannot be edited so
// is refused and left untouched. A second run changes nothing.
import { chmod, lstat, mkdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { isRecord } from '../core/check.ts';
import type { Json } from '../core/types.ts';
import type { Env } from './config.ts';
import { done, failed, type Result } from './result.ts';

export const MCP_CLIENTS = ['claude', 'cursor', 'vscode', 'codex', 'opencode'] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

/** The name of the server in every client config. */
const NAME = 'telegram-agent-ui';
/** The command every entry starts: the latest release, fetched by npx. */
const COMMAND = ['npx', 'telegram-agent-ui@latest', 'mcp'] as const;
const [command, ...args] = COMMAND;

type Config = Record<string, unknown>;
/** A JSON config with the entry in place, or why the file cannot take it. */
type Placed = { kind: 'ok'; next: Config; entry: Json } | { kind: 'refused'; reason: string };

type Target =
	| { format: 'json'; path: string; place(config: Config): Placed; fresh?: Config }
	| { format: 'toml'; path: string; text: string };

/** `config` with `entry` under `config[key][NAME]`, or a refusal when `config[key]` is no object. */
function placeUnder(config: Config, key: string, entry: Json): Placed {
	const servers = config[key] ?? {};
	if (!isRecord(servers)) return { kind: 'refused', reason: `its ${key} is no object` };
	return { kind: 'ok', next: { ...config, [key]: { ...servers, [NAME]: entry } }, entry };
}

/**
 * OpenCode reads servers natively from `mcp.servers` and as the legacy `mcp.<name>`, and a
 * native entry wins over a legacy one of the same name. A config with native servers gets the
 * native entry and loses a legacy one of this name; any other config gets the legacy entry.
 * packages/core/src/config/normalize.ts and packages/schema/src/mcp.ts of sst/opencode at 7ca7b3f.
 */
function placeOpencode(config: Config): Placed {
	const mcp = config.mcp ?? {};
	if (!isRecord(mcp)) return { kind: 'refused', reason: 'its mcp is no object' };
	// A legacy server named "servers" carries its own `type`; native servers sit one level down.
	const native = isRecord(mcp.servers) && typeof mcp.servers.type !== 'string' ? mcp.servers : undefined;
	if (!native) return placeUnder(config, 'mcp', { type: 'local', command: [...COMMAND], enabled: true });
	const entry: Json = { type: 'local', command: [...COMMAND] };
	const { [NAME]: _legacy, ...rest } = mcp;
	return { kind: 'ok', next: { ...config, mcp: { ...rest, servers: { ...native, [NAME]: entry } } }, entry };
}

/** Where `client` reads its user-wide MCP servers, and how its entry is placed. */
export function mcpTarget(client: McpClient, env: Env): Target {
	const home = env.HOME || homedir();
	const xdg = env.XDG_CONFIG_HOME || join(home, '.config');
	switch (client) {
		case 'claude':
			// User scope lives in ~/.claude.json under `mcpServers`, and an entry without `type` is stdio.
			// CLAUDE_CONFIG_DIR moves the file. https://code.claude.com/docs/en/mcp (scopes) and
			// https://code.claude.com/docs/en/claude-directory (CLAUDE_CONFIG_DIR).
			return { format: 'json', path: join(env.CLAUDE_CONFIG_DIR || home, '.claude.json'), place: (config) => placeUnder(config, 'mcpServers', { type: 'stdio', command, args: [...args] }) };
		case 'cursor':
			// ~/.cursor/mcp.json, `mcpServers`, `type: "stdio"`. https://cursor.com/docs/context/mcp
			return { format: 'json', path: join(home, '.cursor', 'mcp.json'), place: (config) => placeUnder(config, 'mcpServers', { type: 'stdio', command, args: [...args] }) };
		case 'vscode':
			// Copilot Global, the destination that replaces the deprecated profile mcp.json: $COPILOT_HOME/mcp-config.json,
			// `mcpServers`, `type: "stdio"`, `tools: ["*"]` for every tool. https://code.visualstudio.com/docs/agents/reference/mcp-configuration
			return {
				format: 'json',
				path: join(env.COPILOT_HOME || join(home, '.copilot'), 'mcp-config.json'),
				place: (config) => placeUnder(config, 'mcpServers', { type: 'stdio', command, args: [...args], tools: ['*'] }),
			};
		case 'opencode':
			// The global config ~/.config/opencode/opencode.json, `type: "local"` with the command as one array.
			// https://opencode.ai/docs/mcp-servers
			return { format: 'json', path: join(xdg, 'opencode', 'opencode.json'), place: placeOpencode, fresh: { $schema: 'https://opencode.ai/config.json' } };
		case 'codex':
			// $CODEX_HOME/config.toml, default ~/.codex, table `[mcp_servers.<name>]` with `command` and `args`.
			// codex-rs/utils/home-dir/src/lib.rs, codex-rs/config/src/config_toml.rs and mcp_types.rs of openai/codex at 44de9d9.
			return {
				format: 'toml',
				path: join(env.CODEX_HOME || join(home, '.codex'), 'config.toml'),
				text: `[mcp_servers.${NAME}]\ncommand = ${JSON.stringify(command)}\nargs = [${args.map((arg) => JSON.stringify(arg)).join(', ')}]\n`,
			};
	}
}

/** The text of a file, or undefined when it does not exist. */
async function readText(path: string): Promise<string | undefined> {
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
async function writeTarget(path: string): Promise<{ kind: 'ok'; path: string } | { kind: 'refused'; reason: string }> {
	const real = await realpath(path).catch(() => undefined);
	if (real !== undefined) return { kind: 'ok', path: real };
	const found = await lstat(path).catch(() => undefined);
	if (!found?.isSymbolicLink()) return { kind: 'ok', path };
	return { kind: 'refused', reason: `is a link to ${await readlink(path)}, which does not exist. Create the target or remove the link, then run mcp init again` };
}

/** Writes `text` to the file `real`, which `writeTarget` found, through a temp file beside it. The mode stays, a new file gets 0600. */
async function writeKept(real: string, text: string): Promise<void> {
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

/** A parsed TOML value as text with sorted keys, so two documents compare by meaning. Dates print through `toJSON`. */
const canonical = (value: unknown) =>
	JSON.stringify(value, (_key, item: unknown) => (isRecord(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item));

/** A parsed Codex config without this server's entry: what an edit must keep. An `mcp_servers` left empty counts as absent. */
function withoutEntry(config: Config): Config {
	const { mcp_servers: servers, ...others } = config;
	if (!isRecord(servers)) return config;
	const { [NAME]: _entry, ...rest } = servers;
	return Object.keys(rest).length > 0 ? { ...others, mcp_servers: rest } : others;
}

/** The entry of this server in a parsed Codex config, when it runs the command this init writes. */
function holdsEntry(config: Config): boolean {
	const servers = config.mcp_servers;
	const entry = isRecord(servers) ? servers[NAME] : undefined;
	return isRecord(entry) && entry.command === command && canonical(entry.args) === canonical(args) && entry.enabled !== false;
}

const parsedToml = (text: string): Config | undefined => {
	try {
		return parseToml(text);
	} catch {
		return undefined;
	}
};

// A header of this server's table: bare, double or single quoted, with an optional comment after it.
const HEADER = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${NAME}|"${NAME}"|'${NAME}')\\s*\\](?:\\s*#.*)?$`);

/** `text` with the lines from line `start` to the next header replaced by `block`. The blank lines before the next header stay. */
function replaceTable(lines: readonly string[], start: number, block: string): string {
	const next = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
	let end = next === -1 ? lines.length : next;
	while (end > start + 1 && lines[end - 1]?.trim() === '') end--;
	return [...lines.slice(0, start), ...block.trimEnd().split('\n'), ...lines.slice(end)].join('\n');
}

/**
 * The Codex config `text` with this server's entry, or undefined when no edit keeps every other
 * setting. A config without the entry gets it appended. An entry in its own table is replaced
 * in place; each line that looks like its header is tried, since one may sit inside a string.
 * Every candidate is parsed and compared with the original before it counts.
 */
function withCodexEntry(text: string, block: string): string | undefined {
	const before = parsedToml(text);
	if (!before) return undefined;
	if (holdsEntry(before)) return text;
	const kept = canonical(withoutEntry(before));
	const servers = before.mcp_servers;
	const exists = isRecord(servers) && servers[NAME] !== undefined;
	const lines = text.split('\n');
	const trimmed = text.replace(/\n*$/, '');
	const candidates = exists ? lines.flatMap((line, index) => (HEADER.test(line) ? [replaceTable(lines, index, block)] : [])) : [trimmed === '' ? block : `${trimmed}\n\n${block}`];
	return candidates.find((candidate) => {
		const after = parsedToml(candidate);
		return after !== undefined && holdsEntry(after) && canonical(withoutEntry(after)) === kept;
	});
}

/** A JSON text as a config object: empty for no text, undefined for anything but an object. */
function parsedJson(text: string | undefined): Config | undefined {
	if (text === undefined || text.trim() === '') return {};
	try {
		const value: unknown = JSON.parse(text);
		return isRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Writes the server entry of `client` into its user config and prints `{ client, path, entry,
 * changed }`. Refuses with `client-config`, and writes nothing, when the file cannot take the
 * entry with everything else in it kept.
 *
 *   await mcpInit('cursor', process.env); // ~/.cursor/mcp.json gets mcpServers["telegram-agent-ui"]
 */
export async function mcpInit(client: McpClient, env: Env): Promise<Result> {
	const target = mcpTarget(client, env);
	const refuse = (reason: string, entry: string) => failed({ error: 'refused', code: 'client-config', message: `${target.path} ${reason}: nothing was written. Add the entry by hand: ${entry}` });
	const destination = await writeTarget(target.path);
	if (destination.kind === 'refused') {
		return failed({ error: 'refused', code: 'client-config', message: `${target.path} ${destination.reason}: nothing was written` });
	}
	const before = await readText(destination.path);
	if (target.format === 'toml') {
		const after = withCodexEntry(before ?? '', target.text);
		if (after === undefined) return refuse('is no TOML that this init can edit with every other setting kept', target.text);
		if (after !== before) await writeKept(destination.path, after);
		return done({ client, path: target.path, entry: target.text, changed: after !== before });
	}
	const config = parsedJson(before);
	const placed = config ? target.place(config) : { kind: 'refused' as const, reason: 'holds no JSON object' };
	if (placed.kind === 'refused') {
		const sample = target.place({});
		return refuse(placed.reason, sample.kind === 'ok' ? JSON.stringify({ [NAME]: sample.entry }) : NAME);
	}
	const fresh = before === undefined || before.trim() === '' ? (target.fresh ?? {}) : {};
	const text = `${JSON.stringify({ ...fresh, ...placed.next }, null, 2)}\n`;
	const changed = config === undefined || canonical(config) !== canonical(placed.next);
	if (changed) await writeKept(destination.path, text);
	return done({ client, path: target.path, entry: placed.entry, changed });
}
