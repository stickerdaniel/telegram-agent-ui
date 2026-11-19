import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { isRecord } from '../core/check.ts';
import type { Json } from '../core/types.ts';
import type { Env } from './config.ts';
import { done, failed, type Result } from './result.ts';
import { canonical, parsedJson, readText, type UserConfig as Config, writeKept, writeTarget } from './user-file.ts';

export const MCP_CLIENTS = ['claude', 'cursor', 'vscode', 'codex', 'opencode'] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

const NAME = 'telegram-agent-ui';
const COMMAND = ['npx', 'telegram-agent-ui@latest', 'mcp'] as const;
const [command, ...args] = COMMAND;

type Placed = { kind: 'ok'; next: Config; entry: Json } | { kind: 'refused'; reason: string };

type Target =
	| { format: 'json'; path: string; place(config: Config): Placed; fresh?: Config }
	| { format: 'toml'; path: string; text: string };

function placeUnder(config: Config, key: string, entry: Json): Placed {
	const servers = config[key] ?? {};
	if (!isRecord(servers)) return { kind: 'refused', reason: `its ${key} is no object` };
	return { kind: 'ok', next: { ...config, [key]: { ...servers, [NAME]: entry } }, entry };
}

function placeOpencode(config: Config): Placed {
	const mcp = config.mcp ?? {};
	if (!isRecord(mcp)) return { kind: 'refused', reason: 'its mcp is no object' };
	const native = isRecord(mcp.servers) && typeof mcp.servers.type !== 'string' ? mcp.servers : undefined;
	if (!native) return placeUnder(config, 'mcp', { type: 'local', command: [...COMMAND], enabled: true });
	const entry: Json = { type: 'local', command: [...COMMAND] };
	const { [NAME]: _legacy, ...rest } = mcp;
	return { kind: 'ok', next: { ...config, mcp: { ...rest, servers: { ...native, [NAME]: entry } } }, entry };
}

export function mcpTarget(client: McpClient, env: Env): Target {
	const home = env.HOME || homedir();
	const xdg = env.XDG_CONFIG_HOME || join(home, '.config');
	switch (client) {
		case 'claude':
			return { format: 'json', path: join(env.CLAUDE_CONFIG_DIR || home, '.claude.json'), place: (config) => placeUnder(config, 'mcpServers', { type: 'stdio', command, args: [...args] }) };
		case 'cursor':
			return { format: 'json', path: join(home, '.cursor', 'mcp.json'), place: (config) => placeUnder(config, 'mcpServers', { type: 'stdio', command, args: [...args] }) };
		case 'vscode':
			return {
				format: 'json',
				path: join(env.COPILOT_HOME || join(home, '.copilot'), 'mcp-config.json'),
				place: (config) => placeUnder(config, 'mcpServers', { type: 'stdio', command, args: [...args], tools: ['*'] }),
			};
		case 'opencode':
			return { format: 'json', path: join(xdg, 'opencode', 'opencode.json'), place: placeOpencode, fresh: { $schema: 'https://opencode.ai/config.json' } };
		case 'codex':
			return {
				format: 'toml',
				path: join(env.CODEX_HOME || join(home, '.codex'), 'config.toml'),
				text: `[mcp_servers.${NAME}]\ncommand = ${JSON.stringify(command)}\nargs = [${args.map((arg) => JSON.stringify(arg)).join(', ')}]\n`,
			};
	}
}

function withoutEntry(config: Config): Config {
	const { mcp_servers: servers, ...others } = config;
	if (!isRecord(servers)) return config;
	const { [NAME]: _entry, ...rest } = servers;
	return Object.keys(rest).length > 0 ? { ...others, mcp_servers: rest } : others;
}

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

const HEADER = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${NAME}|"${NAME}"|'${NAME}')\\s*\\](?:\\s*#.*)?$`);

function replaceTable(lines: readonly string[], start: number, block: string): string {
	const next = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
	let end = next === -1 ? lines.length : next;
	while (end > start + 1 && lines[end - 1]?.trim() === '') end--;
	return [...lines.slice(0, start), ...block.trimEnd().split('\n'), ...lines.slice(end)].join('\n');
}

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
