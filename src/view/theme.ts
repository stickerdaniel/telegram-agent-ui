// A view theme: a `cssVars` object in the shadcn registry format, `{ theme?, light?, dark? }`,
// each a map from a variable name without its leading `--` to a CSS value. `theme` applies in
// both colour schemes, `light` and `dark` in theirs, and all of them win over Telegram's colours.
// The shell writes the values into its document and in front of every page, inside a `<style>`
// block, so a value holds no character that could end a declaration, a rule or the block.
import { isRecord, isString } from '../core/check.ts';

export type CssVars = { theme?: Record<string, string>; light?: Record<string, string>; dark?: Record<string, string> };

const BLOCKS = ['theme', 'light', 'dark'] as const;
const NAME = /^[a-z0-9-]{1,64}$/;
const VALUE_LENGTH = 200;
const BREAKS = /[;{}<>\\]|\/\*/;

/** Why `value` is no theme, or undefined. */
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

/**
 * The theme in `value`, copied, or undefined when it breaks `themeIssue`.
 *
 *   const theme = parseTheme(JSON.parse(await readFile('theme.json', 'utf8')));
 */
export function parseTheme(value: unknown): CssVars | undefined {
	if (themeIssue(value) !== undefined || !isRecord(value)) return undefined;
	const theme: CssVars = {};
	for (const block of BLOCKS) {
		const vars = value[block];
		if (isRecord(vars)) theme[block] = Object.fromEntries(Object.entries(vars).filter((entry): entry is [string, string] => isString(entry[1])));
	}
	return theme;
}
