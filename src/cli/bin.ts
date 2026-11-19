#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { type Command, commands, exitCode, findCommand, printed, usage } from '../commands/index.ts';
import { done, failed, failureOf, type Result } from '../commands/result.ts';
import { type Context, readBodyFile, rootsOf } from '../commands/session.ts';
import { parseArgs } from './args.ts';

const SERVE = { name: 'mcp', usage: 'mcp', description: 'Serves the tools over stdio for an MCP client. mcp init writes the client entry that starts it.' };

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	return Buffer.concat(chunks).toString('utf8');
}

function readLine(): Promise<string | undefined> {
	return new Promise((resolve) => {
		const lines = createInterface({ input: process.stdin });
		let line: string | undefined;
		lines.once('line', (text) => {
			line = text;
			lines.close();
		});
		lines.once('close', () => resolve(line));
	});
}

async function main(command: Command, rest: string[]): Promise<Result> {
	const parsed = parseArgs(command.params, rest);
	if (!parsed.ok) return failed({ error: 'usage', message: `${parsed.message}. Usage: telegram-agent-ui ${usage(command.name, command.params)}` });
	const env = process.env;
	const cwd = process.cwd();
	if (parsed.files.size > 0) {
		const roots = [...parsed.files.values()].some((path) => path !== '-') ? await rootsOf({ env, roots: [cwd] }) : [];
		for (const [name, path] of parsed.files) {
			if (path === '-') {
				parsed.raw[name] = await readStdin();
				continue;
			}
			const read = await readBodyFile(path, { roots, cwd, env });
			if (!read.ok) return failed(read.failure);
			parsed.raw[name] = read.text;
		}
	}
	const controller = new AbortController();
	for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort());
	const context: Context = {
		env,
		roots: [cwd],
		cwd,
		log: (line) => void process.stderr.write(`${line}\n`),
		signal: controller.signal,
		readLine,
		stdin: readStdin,
	};
	return command.invoke(parsed.raw, context);
}

async function resultOf(args: string[]): Promise<Result> {
	const found = findCommand(args);
	if (!found) {
		const list = [...commands.map((command) => ({ name: command.name, usage: usage(command.name, command.params), description: command.description })), SERVE];
		if (args[0] === 'help' || args[0] === '--help') return done({ commands: list });
		return failed({ error: 'usage', message: `${args[0] === undefined ? 'no command' : `unknown command ${args.slice(0, 2).join(' ')}`}. Commands: ${list.map((command) => command.name).join(', ')}` });
	}
	const ran = await main(found.command, found.rest).catch((error: unknown) => failed(failureOf(error)));
	const { failClosed } = found.command;
	return !ran.ok && failClosed ? done(failClosed(ran.failure)) : ran;
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === SERVE.name) {
	const { serve } = await import('../mcp/index.ts');
	serve({ env: process.env });
} else {
	const result = await resultOf(args);
	process.stdout.write(`${JSON.stringify(printed(result))}\n`, () => process.exit(exitCode(result)));
}
