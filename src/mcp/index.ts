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

const manifest: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const version = isRecord(manifest) && typeof manifest.version === 'string' ? manifest.version : '0.0.0';

const ROOTS = 'roots';

const fileKey = (param: Param) => `${param.name}File`;

function paramSchema(param: Param): Record<string, unknown> {
	const { type } = param;
	const one = param.schema ? { ...param.schema } : typeof type !== 'string' ? { type: 'string', enum: [...type] } : type === 'json' ? {} : { type };
	return { ...(param.many ? { type: 'array', items: one } : one), description: param.description };
}

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

function toolResult(result: Result, log: readonly string[]): CallToolResult {
	const json = printed(result);
	return {
		content: [{ type: 'text', text: JSON.stringify(json) }, ...(log.length > 0 ? [{ type: 'text' as const, text: log.join('\n') }] : [])],
		structuredContent: json,
		...(result.ok ? {} : { isError: true }),
	};
}

function declaresRoots(server: McpServer, ctx: ServerContext): boolean {
	const envelope = ctx.mcpReq.envelope;
	const perRequest = isRecord(envelope) ? envelope[CLIENT_CAPABILITIES_META_KEY] : undefined;
	const capabilities = isRecord(perRequest) ? perRequest : server.server.getClientCapabilities();
	return capabilities?.roots !== undefined;
}

function clientRoots(server: McpServer, ctx: ServerContext): string[] | InputRequiredResult {
	const view = inputResponse(ctx.mcpReq.inputResponses, ROOTS);
	if (view.kind === 'roots') return view.roots.flatMap((root) => (root.uri.startsWith('file://') ? [fileURLToPath(root.uri)] : []));
	if (ctx.mcpReq.inputResponses !== undefined || !declaresRoots(server, ctx)) return [];
	return inputRequired({ inputRequests: { [ROOTS]: inputRequired.listRoots() } });
}

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

export function serve(options: { env?: Env } = {}): StdioServerHandle {
	return serveStdio(() => createServer(options), { onerror: (error) => void process.stderr.write(`${error.message}\n`) });
}
