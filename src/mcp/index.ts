// The MCP server of section 6: every command of the table that names a tool, over the store and
// without a listener of its own. A tool's input schema is the JSON Schema of its command's
// params, and the command's `invoke` checks the input, so a usage error is a tool result like
// any other. Every result is the command's JSON as text and as `structuredContent`, with
// `isError` for a failure. The progress and warnings that the CLI writes to stderr follow as a
// second text block.
//
// Files come from the roots the client reports plus `publishRoots`. A body file is an absolute
// path below them, given in place of the body as `bodyFile`. A client that reports no roots
// adds none, so with an empty `publishRoots` every path is refused.
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	CLIENT_CAPABILITIES_META_KEY,
	type CallToolResult,
	type InputRequiredResult,
	inputRequired,
	inputResponse,
	McpServer,
	type ServerContext,
	type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import type { Env } from '../commands/config.ts';
import type { Param } from '../commands/params.ts';
import { type Failure, failed, failureOf, printed, type Result } from '../commands/result.ts';
import { readBodyFile, rootsOf } from '../commands/session.ts';
import { type Command, commands } from '../commands/table.ts';
import { isRecord } from '../core/check.ts';

// The package's version, from its package.json two levels up from both src/mcp and dist/mcp.
const manifest: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const version = isRecord(manifest) && typeof manifest.version === 'string' ? manifest.version : '0.0.0';

// The key of the roots request inside an input-required result.
const ROOTS = 'roots';

/** The name of the path parameter that stands in for a file parameter: `bodyFile` for `body`. */
const fileKey = (param: Param) => `${param.name}File`;

/** The JSON Schema of one parameter. */
function paramSchema(param: Param): Record<string, unknown> {
	const { type } = param;
	const one = typeof type !== 'string' ? { type: 'string', enum: [...type] } : type === 'json' ? {} : { type };
	return { ...(param.many ? { type: 'array', items: one } : one), description: param.description };
}

/**
 * The input schema of a command's tool: its params without the CLI-only ones, and for each file
 * parameter a `<name>File` path beside it. Either of the two may be given, so neither is required.
 */
function inputSchema(params: readonly Param[]): Record<string, unknown> {
	const properties: Record<string, unknown> = {};
	const required: string[] = [];
	for (const param of params) {
		if (param.cli?.only) continue;
		properties[param.name] = paramSchema(param);
		if (param.cli?.file) {
			properties[fileKey(param)] = { type: 'string', description: `An absolute path below the roots whose text is the ${param.name}, in place of ${param.name}.` };
		} else if (param.required) required.push(param.name);
	}
	return { type: 'object', properties, ...(required.length > 0 ? { required } : {}), additionalProperties: false };
}

/** A Standard Schema that advertises `json` and lets every object through: the command's `invoke` checks it. */
function passThrough(json: Record<string, unknown>): StandardSchemaWithJSON<Record<string, unknown>, Record<string, unknown>> {
	return {
		'~standard': {
			version: 1,
			vendor: 'telegram-agent-ui',
			jsonSchema: { input: () => json, output: () => json },
			validate: (value) => (isRecord(value) ? { value } : { issues: [{ message: 'the arguments are no object' }] }),
		},
	};
}

/** A command's result as a tool result. */
function toolResult(result: Result, log: readonly string[]): CallToolResult {
	const json = printed(result);
	return {
		content: [{ type: 'text', text: JSON.stringify(json) }, ...(log.length > 0 ? [{ type: 'text' as const, text: log.join('\n') }] : [])],
		structuredContent: json,
		...(result.ok ? {} : { isError: true }),
	};
}

/** Whether the client declared the roots capability: per request on the 2026 protocol, at `initialize` on the 2025 one. */
function declaresRoots(server: McpServer, ctx: ServerContext): boolean {
	const envelope = ctx.mcpReq.envelope;
	const perRequest = isRecord(envelope) ? envelope[CLIENT_CAPABILITIES_META_KEY] : undefined;
	const capabilities = isRecord(perRequest) ? perRequest : server.server.getClientCapabilities();
	return capabilities?.roots !== undefined;
}

/**
 * The client's roots as paths, or the input-required result that asks for them. The SDK
 * fulfils it on both protocol eras and calls the handler again with the answer. A client
 * without the roots capability, or one whose answer holds no roots, has none.
 */
function clientRoots(server: McpServer, ctx: ServerContext): string[] | InputRequiredResult {
	const view = inputResponse(ctx.mcpReq.inputResponses, ROOTS);
	if (view.kind === 'roots') return view.roots.flatMap((root) => (root.uri.startsWith('file://') ? [fileURLToPath(root.uri)] : []));
	if (ctx.mcpReq.inputResponses !== undefined || !declaresRoots(server, ctx)) return [];
	return inputRequired({ inputRequests: { [ROOTS]: inputRequired.listRoots() } });
}

/**
 * The input of `command` from the tool arguments: each `<name>File` read under the roots into
 * its parameter, or the failure that refuses the call before anything is sent.
 */
async function inputOf(command: Command, args: Record<string, unknown>, roots: readonly string[], env: Env): Promise<{ ok: true; raw: Record<string, unknown> } | { ok: false; failure: Failure }> {
	const raw = { ...args };
	for (const param of command.params.filter((candidate) => candidate.cli?.file)) {
		const key = fileKey(param);
		const path = raw[key];
		delete raw[key];
		if (path === undefined) {
			if (param.required && raw[param.name] === undefined) return { ok: false, failure: { error: 'usage', message: `${param.name} or ${key} is required` } };
			continue;
		}
		if (raw[param.name] !== undefined) return { ok: false, failure: { error: 'usage', message: `${param.name} and ${key} exclude each other` } };
		if (typeof path !== 'string' || !isAbsolute(path)) return { ok: false, failure: { error: 'usage', message: `${key} needs an absolute path` } };
		const read = await readBodyFile(path, { roots: await rootsOf({ env, roots }), cwd: '/', env });
		if (!read.ok) return read;
		raw[param.name] = read.text;
	}
	return { ok: true, raw };
}

/**
 * An MCP server with one tool per command of the table that names one. `env` is the
 * environment its commands read, `process.env` by default.
 *
 *   const server = createServer();
 *   await server.connect(transport);
 */
export function createServer(options: { env?: Env } = {}): McpServer {
	const env = options.env ?? process.env;
	const server = new McpServer({ name: 'telegram-agent-ui', version });
	for (const command of commands) {
		if (command.tool === undefined) continue;
		server.registerTool(command.tool, { description: command.description, inputSchema: passThrough(inputSchema(command.params)) }, async (args, ctx) => {
			const roots = clientRoots(server, ctx);
			if (!Array.isArray(roots)) return roots;
			const log: string[] = [];
			try {
				const input = await inputOf(command, args, roots, env);
				if (!input.ok) return toolResult(failed(input.failure), log);
				const result = await command.invoke(input.raw, { env, roots, log: (line) => void log.push(line), signal: ctx.mcpReq.signal });
				return toolResult(result, log);
			} catch (error) {
				return toolResult(failed(failureOf(error)), log);
			}
		});
	}
	return server;
}

/**
 * Serves the tools over this process's stdin and stdout, on both protocol eras, until the
 * client closes stdin. Errors of the transport go to stderr, since stdout carries the protocol.
 */
export function serve(options: { env?: Env } = {}): StdioServerHandle {
	return serveStdio(() => createServer(options), { onerror: (error) => void process.stderr.write(`${error.message}\n`) });
}
