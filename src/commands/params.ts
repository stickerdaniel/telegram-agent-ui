// The input schema of a command: a list of parameters, each with its JSON type and how the CLI
// spells it. The CLI parser reads the `cli` part, and the MCP tools of a later stage read the
// rest. A handler receives its input typed by `InputOf`, after `check` proved every field.
import { arrayOf, isBool, isInt, isJson, isRecord, isString } from '../core/check.ts';
import type { Json } from '../core/types.ts';

/** One input field of a command. `type` is a JSON type or a list of allowed strings. */
export type Param = {
	readonly name: string;
	readonly type: 'string' | 'integer' | 'boolean' | 'json' | readonly string[];
	readonly description: string;
	readonly required?: boolean;
	/** A list: the CLI flag may repeat. */
	readonly many?: boolean;
	readonly cli?: {
		/** Taken from the positional arguments instead of a flag. Optional ones fill from the left once the required ones have theirs. */
		readonly positional?: boolean;
		/** The argument is a path, `-` for stdin, and the value is the file's text. */
		readonly file?: boolean;
		/** The flag without dashes, when it is not the name in kebab case. */
		readonly flag?: string;
		/** A one-letter alias, such as `o` for `-o`. */
		readonly short?: string;
		/** Flags without a value that set one of the allowed strings, in place of a flag with a value: `{ 'yes-no': 'yesNo' }`. */
		readonly switches?: Readonly<Record<string, string>>;
		/** The value's name in the usage line. */
		readonly label?: string;
	};
};

type Scalar = { string: string; integer: number; boolean: boolean; json: Json };
type ValueOf<P extends Param> = P['type'] extends readonly (infer V extends string)[] ? V : P['type'] extends keyof Scalar ? Scalar[P['type']] : never;
type FieldOf<P extends Param> = P extends { many: true } ? ValueOf<P>[] : ValueOf<P>;

/** The typed input of a parameter list: a required parameter is a field, any other an optional field. */
export type InputOf<Ps extends readonly Param[]> = { [P in Ps[number] as P extends { required: true } ? P['name'] : never]: FieldOf<P> } & {
	[P in Ps[number] as P extends { required: true } ? never : P['name']]?: FieldOf<P>;
};

/** True when `value` has the JSON type of `param`, one item of it for a list. */
function itemFits(param: Param, value: unknown): boolean {
	const { type } = param;
	if (typeof type !== 'string') return isString(value) && type.includes(value);
	if (type === 'string') return isString(value);
	if (type === 'integer') return isInt(value);
	if (type === 'boolean') return isBool(value);
	return isJson(value);
}

/** Why `raw` is not an input of `params`, or undefined: an unknown field, a missing required one, or a value of another type. */
export function inputIssue(params: readonly Param[], raw: unknown): string | undefined {
	if (!isRecord(raw)) return 'the input is not an object';
	const known = new Set(params.map((param) => param.name));
	const unknown = Object.keys(raw).find((key) => !known.has(key));
	if (unknown !== undefined) return `unknown input ${unknown}`;
	for (const param of params) {
		const value = raw[param.name];
		if (value === undefined) {
			if (param.required) return `${param.name} is required`;
			continue;
		}
		const fits = param.many ? arrayOf((item: unknown): item is unknown => itemFits(param, item))(value) : itemFits(param, value);
		if (!fits) return `${param.name} needs ${describeType(param)}`;
	}
	return undefined;
}

/** `raw` as the typed input of `params`, once `inputIssue` found nothing. */
export function isInput<const Ps extends readonly Param[]>(params: Ps, raw: unknown): raw is InputOf<Ps> {
	return inputIssue(params, raw) === undefined;
}

/** The type of a parameter in words, for a usage error. */
export function describeType(param: Param): string {
	const one = typeof param.type === 'string' ? (param.type === 'json' ? 'JSON' : `a ${param.type}`) : `one of ${param.type.join(', ')}`;
	return param.many ? `a list of ${one.replace(/^an? /, '')}` : one;
}

/** A name in kebab case: `dryRun` to `dry-run`. */
export const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** The name of a parameter's value in the usage line and in a usage error: `file or -` for a file. */
export const labelOf = (param: Param) => param.cli?.label ?? (param.cli?.file ? 'file or -' : kebab(param.name));

/** The usage line of a command, such as `ask [-o <option>]... [--yes-no | --text] <file or ->`. */
export function usage(name: string, params: readonly Param[]): string {
	const parts = params.map((param) => {
		const { cli = {} } = param;
		const label = labelOf(param);
		if (cli.positional) return param.required ? `<${label}>` : `[<${label}>]`;
		if (cli.switches) return `[${Object.keys(cli.switches).map((flag) => `--${flag}`).join(' | ')}]`;
		const flag = cli.short ? `-${cli.short}` : `--${cli.flag ?? kebab(param.name)}`;
		const spelled = param.type === 'boolean' ? flag : `${flag} <${label}>`;
		const shown = param.required ? spelled : `[${spelled}]`;
		return param.many ? `${shown}...` : shown;
	});
	// Flags first, positionals last, as the CLI reads them.
	const positional = params.map((param, index) => (param.cli?.positional ? parts[index] : undefined)).filter((part) => part !== undefined);
	const flags = params.map((param, index) => (param.cli?.positional ? undefined : parts[index])).filter((part) => part !== undefined);
	return [name, ...flags, ...positional].join(' ');
}
