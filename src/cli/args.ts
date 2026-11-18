// The CLI's argument parser, read from a command's params: flags in kebab case (`--dry-run`),
// short aliases (`-o`), switches that set a value (`--yes-no`), repeated flags for a list, flags
// that take a pair of arguments (`--tab <label> <file>`), and positional arguments. A positional `file` parameter names a path, or `-` for stdin, which the
// caller reads.
import { describeType, kebab, labelOf, type Param } from '../commands/params.ts';

export type Parsed = { ok: true; raw: Record<string, unknown>; files: Map<string, string> } | { ok: false; message: string };

const flagOf = (param: Param) => `--${param.cli?.flag ?? kebab(param.name)}`;

/** One argument as the type of `param`, or why it is none. */
function convert(param: Param, text: string): { ok: true; value: unknown } | { ok: false; message: string } {
	const { type } = param;
	if (typeof type !== 'string') return type.includes(text) ? { ok: true, value: text } : { ok: false, message: `${flagOf(param)} needs ${describeType(param)}` };
	if (type === 'integer') {
		const value = Number(text);
		return /^-?\d+$/.test(text) && Number.isSafeInteger(value) ? { ok: true, value } : { ok: false, message: `${flagOf(param)} needs an integer, not "${text}"` };
	}
	if (type === 'json') {
		try {
			return { ok: true, value: JSON.parse(text) };
		} catch {
			return { ok: false, message: `${param.name} needs JSON, not "${text}"` };
		}
	}
	return { ok: true, value: text };
}

/**
 * The input `args` gives the command of `params`, as JSON for its `invoke`, and the paths of
 * its file parameters. Positional arguments fill the required parameters, and the optional ones
 * from the left as far as the arguments reach.
 *
 *   parseArgs(params, ['-o', 'Merge', '-o', 'Wait', 'question.md']);
 *   // { ok: true, raw: { options: ['Merge', 'Wait'] }, files: Map { 'body' => 'question.md' } }
 */
export function parseArgs(params: readonly Param[], args: readonly string[]): Parsed {
	const flags = new Map<string, Param>();
	const switches = new Map<string, { param: Param; value: string }>();
	for (const param of params) {
		const cli = param.cli ?? {};
		if (cli.positional) continue;
		if (cli.switches) {
			for (const [flag, value] of Object.entries(cli.switches)) switches.set(`--${flag}`, { param, value });
			continue;
		}
		flags.set(flagOf(param), param);
		if (cli.short) flags.set(`-${cli.short}`, param);
	}
	const raw: Record<string, unknown> = {};
	const files = new Map<string, string>();
	const positionals: string[] = [];
	const set = (param: Param, value: unknown): string | undefined => {
		const list = raw[param.name];
		if (param.many) raw[param.name] = Array.isArray(list) ? [...list, value] : [value];
		else if (param.name in raw) return `${flagOf(param)} is given twice`;
		else raw[param.name] = value;
		return undefined;
	};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? '';
		if (arg === '--') {
			positionals.push(...args.slice(index + 1));
			break;
		}
		if (!arg.startsWith('-') || arg === '-') {
			positionals.push(arg);
			continue;
		}
		const equals = arg.startsWith('--') ? arg.indexOf('=') : -1;
		const flag = equals === -1 ? arg : arg.slice(0, equals);
		const inline = equals === -1 ? undefined : arg.slice(equals + 1);
		const switched = switches.get(flag);
		if (switched) {
			const { param, value } = switched;
			if (inline !== undefined) return { ok: false, message: `${flag} takes no value` };
			if (param.name in raw && raw[param.name] !== value) return { ok: false, message: `${Object.keys(param.cli?.switches ?? {}).map((name) => `--${name}`).join(' and ')} exclude each other` };
			raw[param.name] = value;
			continue;
		}
		const param = flags.get(flag);
		if (!param) return { ok: false, message: `unknown flag ${flag}` };
		if (param.type === 'boolean') {
			if (inline !== undefined) return { ok: false, message: `${flag} takes no value` };
			const issue = set(param, true);
			if (issue) return { ok: false, message: issue };
			continue;
		}
		const pair = param.cli?.pair;
		if (pair) {
			const [first, second] = [args[index + 1], args[index + 2]];
			if (inline !== undefined || first === undefined || second === undefined) return { ok: false, message: `${flag} needs ${pair.map((name) => `<${name}>`).join(' ')}` };
			index += 2;
			const issue = set(param, { [pair[0]]: first, [pair[1]]: second });
			if (issue) return { ok: false, message: issue };
			continue;
		}
		const text = inline ?? args[++index];
		if (text === undefined) return { ok: false, message: `${flag} needs a value` };
		const converted = convert(param, text);
		if (!converted.ok) return converted;
		const issue = set(param, converted.value);
		if (issue) return { ok: false, message: issue };
	}

	const slots = params.filter((param) => param.cli?.positional);
	const required = slots.filter((param) => param.required);
	if (positionals.length < required.length) return { ok: false, message: `missing ${required.map(labelOf).join(' and ')}` };
	let optional = positionals.length - required.length;
	if (optional > slots.length - required.length) return { ok: false, message: `unexpected argument ${positionals.at(-1) ?? ''}` };
	const taken = slots.filter((param) => param.required || optional-- > 0);
	for (const [index, param] of taken.entries()) {
		const text = positionals[index] ?? '';
		if (param.cli?.file) {
			files.set(param.name, text);
			continue;
		}
		const converted = convert(param, text);
		if (!converted.ok) return converted;
		raw[param.name] = converted.value;
	}
	return { ok: true, raw, files };
}
