import { arrayOf, isBool, isInt, isJson, isRecord, isString } from '../core/check.ts';
import type { Json } from '../core/types.ts';

export type Param = {
	readonly name: string;
	readonly type: 'string' | 'integer' | 'boolean' | 'json' | readonly string[];
	readonly description: string;
	readonly required?: boolean;
	readonly many?: boolean;
	readonly schema?: Readonly<Record<string, unknown>>;
	readonly cli?: {
		readonly only?: boolean;
		readonly positional?: boolean;
		readonly file?: boolean;
		readonly flag?: string;
		readonly short?: string;
		readonly switches?: Readonly<Record<string, string>>;
		readonly label?: string;
		readonly pair?: readonly [string, string];
		readonly text?: boolean;
		readonly more?: boolean;
	};
};

type Scalar = { string: string; integer: number; boolean: boolean; json: Json };
type ValueOf<P extends Param> = P['type'] extends readonly (infer V extends string)[] ? V : P['type'] extends keyof Scalar ? Scalar[P['type']] : never;
type FieldOf<P extends Param> = P extends { many: true } ? ValueOf<P>[] : ValueOf<P>;

export type InputOf<Ps extends readonly Param[]> = { [P in Ps[number] as P extends { required: true } ? P['name'] : never]: FieldOf<P> } & {
	[P in Ps[number] as P extends { required: true } ? never : P['name']]?: FieldOf<P>;
};

function itemFits(param: Param, value: unknown): boolean {
	const { type } = param;
	if (typeof type !== 'string') return isString(value) && type.includes(value);
	if (type === 'string') return isString(value);
	if (type === 'integer') return isInt(value);
	if (type === 'boolean') return isBool(value);
	return isJson(value);
}

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

export function isInput<const Ps extends readonly Param[]>(params: Ps, raw: unknown): raw is InputOf<Ps> {
	return inputIssue(params, raw) === undefined;
}

export function describeType(param: Param): string {
	const one = typeof param.type === 'string' ? (param.type === 'json' ? 'JSON' : `a ${param.type}`) : `one of ${param.type.join(', ')}`;
	return param.many ? `a list of ${one.replace(/^an? /, '')}` : one;
}

export const kebab = (name: string) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

export const labelOf = (param: Param) => param.cli?.label ?? (param.cli?.file ? 'file or -' : kebab(param.name));

export function usage(name: string, params: readonly Param[]): string {
	const parts = params.map((param) => {
		const { cli = {} } = param;
		const label = labelOf(param);
		if (cli.positional) return param.required ? `<${label}>` : `[<${label}>]`;
		if (cli.switches) return `[${Object.keys(cli.switches).map((flag) => `--${flag}`).join(' | ')}]`;
		const flag = cli.short ? `-${cli.short}` : `--${cli.flag ?? kebab(param.name)}`;
		const spelled = param.type === 'boolean' ? flag : cli.pair ? `${flag} ${cli.pair.map((name) => `<${name}>`).join(' ')}${cli.more ? '...' : ''}` : `${flag} <${label}>`;
		const shown = param.required ? (cli.more ? `(${spelled})` : spelled) : `[${spelled}]`;
		return param.many ? `${shown}...` : shown;
	});
	const positional = params.map((param, index) => (param.cli?.positional ? parts[index] : undefined)).filter((part) => part !== undefined);
	const flags = params.map((param, index) => (param.cli?.positional ? undefined : parts[index])).filter((part) => part !== undefined);
	return [name, ...flags, ...positional].join(' ');
}
