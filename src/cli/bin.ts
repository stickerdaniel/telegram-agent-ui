#!/usr/bin/env node
// The `telegram-agent-ui` command. It finds the command in the table, parses the arguments by
// its params, reads a body file or stdin, runs the command and prints one JSON object on stdout:
// the output, or `{ error, code?, message, ref? }`. Progress goes to stderr. The exit code is
// the one of section 5. SIGINT and SIGTERM stop `listen` and `init`.
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { commands, exitCode, findCommand, printed, usage } from '../commands/index.ts';
import { done, failed, failureOf, type Result } from '../commands/result.ts';
import { type Context, rootsOf } from '../commands/session.ts';
import { LIMITS } from '../core/shape.ts';
import { readTextInRoots } from '../files/roots.ts';
import { parseArgs } from './args.ts';

// A body has at most 32,768 characters, and a character at most 4 bytes of UTF-8.
const BODY_BYTES = LIMITS.body * 4;

/** All of stdin as text. */
async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	return Buffer.concat(chunks).toString('utf8');
}

/** The first line of stdin, or undefined once stdin ends without one. */
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

async function main(args: string[]): Promise<Result> {
	const found = findCommand(args);
	if (!found) {
		const list = commands.map((command) => ({ name: command.name, usage: usage(command.name, command.params), description: command.description }));
		if (args[0] === 'help' || args[0] === '--help') return done({ commands: list });
		return failed({ error: 'usage', message: `${args[0] === undefined ? 'no command' : `unknown command ${args[0]}`}. Commands: ${list.map((command) => command.name).join(', ')}` });
	}
	const { command, rest } = found;
	const parsed = parseArgs(command.params, rest);
	if (!parsed.ok) return failed({ error: 'usage', message: `${parsed.message}. Usage: telegram-agent-ui ${usage(command.name, command.params)}` });
	const env = process.env;
	const cwd = process.cwd();
	if (parsed.files.size > 0) {
		// A body file is read under the roots and refusals of 4.7, before anything is sent.
		const roots = [...parsed.files.values()].some((path) => path !== '-') ? await rootsOf({ env, cwd }) : [];
		for (const [name, path] of parsed.files) {
			if (path === '-') {
				parsed.raw[name] = await readStdin();
				continue;
			}
			const read = await readTextInRoots(path, { roots, cwd, home: env.HOME || homedir(), limit: BODY_BYTES });
			if (read.kind === 'refused') return failed({ error: 'refused', code: read.code, message: read.reason });
			parsed.raw[name] = read.text;
		}
	}
	const controller = new AbortController();
	for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => controller.abort());
	const context: Context = {
		env,
		cwd,
		log: (line) => void process.stderr.write(`${line}\n`),
		signal: controller.signal,
		readLine,
	};
	return command.invoke(parsed.raw, context);
}

const result = await main(process.argv.slice(2)).catch((error: unknown) => failed(failureOf(error)));
// A poll that was given up keeps a request open, so the process ends here once stdout is written.
process.stdout.write(`${JSON.stringify(printed(result))}\n`, () => process.exit(exitCode(result)));
