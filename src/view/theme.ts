import { isRecord, isString } from '../core/check.ts';

export type CssVars = { theme?: Record<string, string>; light?: Record<string, string>; dark?: Record<string, string> };

const BLOCKS = ['theme', 'light', 'dark'] as const;
const NAME = /^[a-z0-9-]{1,64}$/;
const VALUE_LENGTH = 200;
const BREAKS = /[;{}<>\\]|\/\*/;

export function themeIssue(value: unknown): string | undefined {
	if (!isRecord(value)) return 'a theme is a cssVars object of theme, light and dark';
	for (const key of Object.keys(value)) if (!BLOCKS.some((block) => block === key)) return `a theme has no block ${key}: only theme, light and dark`;
	for (const block of BLOCKS) {
		const vars = value[block];
		if (vars === undefined) continue;
		if (!isRecord(vars)) return `the theme block ${block} is no object`;
		for (const [name, css] of Object.entries(vars)) {
			if (!NAME.test(name)) return `the theme variable "${name}" is not 1 to 64 characters of [a-z0-9-], without its leading --`;
			if (!isString(css) || css.trim() === '' || css.length > VALUE_LENGTH || BREAKS.test(css)) return `the theme value of ${name} is not 1 to ${VALUE_LENGTH} characters without ; { } < > /* or a backslash`;
		}
	}
	return undefined;
}

export function parseTheme(value: unknown): CssVars | undefined {
	if (themeIssue(value) !== undefined || !isRecord(value)) return undefined;
	const theme: CssVars = {};
	for (const block of BLOCKS) {
		const vars = value[block];
		if (isRecord(vars)) theme[block] = Object.fromEntries(Object.entries(vars).filter((entry): entry is [string, string] => isString(entry[1])));
	}
	return theme;
}
